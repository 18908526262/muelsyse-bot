// ===== Railway 后端 v5.1：支持每月循环事件（经期等）=====
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

// ===== 配置 =====
const CONFIG = {
  BARK_KEY: process.env.BARK_KEY || '',
  DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',
  PORT: process.env.PORT || 8080,
  CHECK_INTERVAL: 5 * 60 * 1000,
  MESSAGE_COOLDOWN: 30 * 60 * 1000,
  MAX_MESSAGES_PER_DAY: 8,
  DATA_DIR: path.join(__dirname, 'data')
};

const FILES = {
  STATE: path.join(CONFIG.DATA_DIR, 'state.json'),
  EVENTS: path.join(CONFIG.DATA_DIR, 'events.json')
};

// ===== 初始化存储 =====
async function initStorage() {
  try {
    await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
    
    // 初始化状态文件
    try {
      await fs.access(FILES.STATE);
    } catch {
      await fs.writeFile(FILES.STATE, JSON.stringify({
        lastInteractionTime: null,
        mood: 'neutral',
        energy: 70,
        userAttentionScore: 50,
        scene: 'unknown',
        recentMessages: [],
        messagesSentToday: 0,
        lastMessageDate: null,
        lastMessageTime: null
      }, null, 2));
    }
    
    // 初始化事件文件
    try {
      await fs.access(FILES.EVENTS);
    } catch {
      await fs.writeFile(FILES.EVENTS, JSON.stringify({
        recurring: [],  // 每年重复（生日）
        monthly: [],    // 每月重复（经期、还款日）
        onetime: []     // 一次性（回学校）
      }, null, 2));
    }
    
    console.log('✅ 存储初始化完成');
  } catch (err) {
    console.error('❌ 存储初始化失败:', err.message);
  }
}

// ===== 读写函数 =====
async function loadState() {
  try {
    const data = await fs.readFile(FILES.STATE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('⚠️ 读取状态失败:', err.message);
    return {
      lastInteractionTime: null,
      mood: 'neutral',
      energy: 70,
      userAttentionScore: 50,
      scene: 'unknown',
      recentMessages: [],
      messagesSentToday: 0,
      lastMessageDate: null,
      lastMessageTime: null
    };
  }
}

async function saveState(state) {
  try {
    await fs.writeFile(FILES.STATE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('❌ 保存状态失败:', err.message);
  }
}

async function loadEvents() {
  try {
    const data = await fs.readFile(FILES.EVENTS, 'utf-8');
    const events = JSON.parse(data);
    
    // 确保所有数组都存在
    if (!events.recurring) events.recurring = [];
    if (!events.monthly) events.monthly = [];
    if (!events.onetime) events.onetime = [];
    
    return events;
  } catch (err) {
    console.error('⚠️ 读取事件失败:', err.message);
    return { recurring: [], monthly: [], onetime: [] };
  }
}

async function saveEvents(events) {
  try {
    await fs.writeFile(FILES.EVENTS, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error('❌ 保存事件失败:', err.message);
  }
}

// ===== DeepSeek Function Calling 调用 =====
async function callDeepSeekWithTools(messages, tools) {
  if (!CONFIG.DEEPSEEK_KEY) {
    console.error('❌ DEEPSEEK_KEY 未配置');
    return null;
  }

  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: messages,
        tools: tools,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.DEEPSEEK_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );
    
    return response.data;
  } catch (err) {
    console.error('❌ DeepSeek 调用失败:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// ===== 智能事件识别 =====
async function intelligentEventDetection(userMessage, conversationHistory = []) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'save_birthday_event',
        description: '保存生日事件（每年重复）。当用户提到生日信息时调用。',
        parameters: {
          type: 'object',
          properties: {
            month: {
              type: 'integer',
              description: '月份（1-12）',
              minimum: 1,
              maximum: 12
            },
            day: {
              type: 'integer',
              description: '日期（1-31）',
              minimum: 1,
              maximum: 31
            },
            person_name: {
              type: 'string',
              description: '生日的主人公，例如"博士"、"小明"、"妈妈"'
            },
            custom_message: {
              type: 'string',
              description: '可选的自定义提醒文案'
            }
          },
          required: ['month', 'day', 'person_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_monthly_event',
        description: '保存每月重复事件。当用户提到每月固定日期的事件时调用，例如"经期每月8-9号"、"信用卡每月15号还款"、"月租每月1号"。',
        parameters: {
          type: 'object',
          properties: {
            day: {
              type: 'integer',
              description: '每月的日期（1-31）',
              minimum: 1,
              maximum: 31
            },
            event_name: {
              type: 'string',
              description: '事件名称，例如"经期"、"信用卡还款"、"月租"'
            },
            custom_message: {
              type: 'string',
              description: '可选的自定义提醒文案'
            }
          },
          required: ['day', 'event_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_onetime_event',
        description: '保存一次性事件。当用户提到临时安排时调用。',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: '日期，格式必须是 YYYY-MM-DD'
            },
            event_name: {
              type: 'string',
              description: '事件名称，例如"回学校"、"开会"'
            },
            custom_message: {
              type: 'string',
              description: '可选的自定义提醒文案'
            }
          },
          required: ['date', 'event_name']
        }
      }
    }
  ];
  
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();
  
  const messages = [
    {
      role: 'system',
      content: `你是缪尔赛思的智能日程助手。分析用户消息，判断是否包含需要记录的事件。

规则：
1. 生日信息 → 调用 save_birthday_event
2. 每月重复事件（经期、还款日、月租等）→ 调用 save_monthly_event
3. 一次性临时安排（回学校、开会、约会等）→ 调用 save_onetime_event
4. 如果用户只是随便聊天，不调用任何工具

日期解析规范：
- "12月20日" → month=12, day=20
- "每月8号" → day=8 (用于 save_monthly_event)
- "每月8-9号" → 选择第一个日期 day=8
- "6月15号" → 如果今年6月15日已过，则年份用 ${currentYear + 1}，否则用 ${currentYear}，格式为 ${currentYear}-06-15
- "明天" → 计算明天的日期后转为 YYYY-MM-DD
- "下周一" → 计算下周一的日期后转为 YYYY-MM-DD

当前日期：${currentDate}
当前年份：${currentYear}

重要：
- date 参数必须是完整的 YYYY-MM-DD 格式
- monthly event 只需要 day（1-31），会每月重复触发`
    }
  ];
  
  // 添加对话历史（最近3轮）
  if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    messages.push(...conversationHistory.slice(-6));
  }
  
  // 添加当前用户消息
  messages.push({
    role: 'user',
    content: userMessage
  });
  
  const result = await callDeepSeekWithTools(messages, tools);
  
  if (!result || !result.choices || !result.choices[0]) {
    return { shouldSave: false };
  }
  
  const message = result.choices[0].message;
  
  // 检查模型是否决定调用工具
  if (message.tool_calls && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const toolCall = message.tool_calls[0];
    const functionName = toolCall.function.name;
    
    let functionArgs;
    try {
      functionArgs = JSON.parse(toolCall.function.arguments);
    } catch (err) {
      console.error('❌ 工具参数解析失败:', toolCall.function.arguments);
      return { shouldSave: false };
    }
    
    console.log(`🎯 AI 识别到事件：${functionName}`, functionArgs);
    
    return {
      shouldSave: true,
      functionName: functionName,
      arguments: functionArgs
    };
  }
  
  return { shouldSave: false };
}

// ===== 执行事件保存 =====
async function executeEventSave(functionName, args) {
  try {
    const events = await loadEvents();
    
    if (functionName === 'save_birthday_event') {
      // 验证参数
      if (!args.month || !args.day || !args.person_name) {
        return { success: false, message: '生日信息不完整' };
      }
      
      if (args.month < 1 || args.month > 12 || args.day < 1 || args.day > 31) {
        return { success: false, message: '日期格式错误' };
      }
      
      const newEvent = {
        id: `recurring_${Date.now()}`,
        name: `${args.person_name}的生日`,
        month: parseInt(args.month),
        day: parseInt(args.day),
        message: args.custom_message || `生日快乐${args.person_name}～🎂今天是你的特别日子！`
      };
      
      events.recurring.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 生日事件已保存: ${newEvent.name} - ${args.month}月${args.day}日`);
      
      return {
        success: true,
        message: `好哒～${args.month}月${args.day}日是${args.person_name}的生日，我已经记下来了！到时候一定会提醒你的～`
      };
    }
    
    if (functionName === 'save_monthly_event') {
      // 验证参数
      if (!args.day || !args.event_name) {
        return { success: false, message: '事件信息不完整' };
      }
      
      if (args.day < 1 || args.day > 31) {
        return { success: false, message: '日期格式错误' };
      }
      
      const newEvent = {
        id: `monthly_${Date.now()}`,
        name: args.event_name,
        day: parseInt(args.day),
        message: args.custom_message || `小鲨，今天是${args.event_name}的日子哦～`
      };
      
      events.monthly.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 每月循环事件已保存: ${args.event_name} - 每月${args.day}号`);
      
      return {
        success: true,
        message: `好哒～每月${args.day}号${args.event_name}，我已经记下来了！到时候会提醒你的～`
      };
    }
    
    if (functionName === 'save_onetime_event') {
      // 验证参数
      if (!args.date || !args.event_name) {
        return { success: false, message: '事件信息不完整' };
      }
      
      // 验证日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        return { success: false, message: '日期格式错误，应为 YYYY-MM-DD' };
      }
      
      const newEvent = {
        id: `onetime_${Date.now()}`,
        name: args.event_name,
        date: args.date,
        message: args.custom_message || `小鲨今天要${args.event_name}啦～记得准时哦！`
      };
      
      events.onetime.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 临时事件已保存: ${args.event_name} - ${args.date}`);
      
      return {
        success: true,
        message: `唔，${args.date} ${args.event_name}是吧？我帮你记着～`
      };
    }
    
    return { success: false, message: '未知的事件类型' };
    
  } catch (err) {
    console.error('❌ 事件保存异常:', err.message);
    return { success: false, message: '保存时出错了' };
  }
}

// ===== 事件检查与推送 =====
async function checkTodayEvents() {
  const now = Date.now();
  const bjTime = new Date(now + 8 * 60 * 60 * 1000); // 北京时间
  
  const year = bjTime.getUTCFullYear();
  const month = bjTime.getUTCMonth() + 1;
  const day = bjTime.getUTCDate();
  const hour = bjTime.getUTCHours();
  
  // 只在早晨 7-8 点检查
  if (hour < 7 || hour >= 8) return;
  
  const events = await loadEvents();
  const triggered = [];
  
  // 检查生日（每年重复）
  if (Array.isArray(events.recurring)) {
    events.recurring.forEach(event => {
      if (event.month === month && event.day === day) {
        triggered.push({
          type: 'recurring',
          name: event.name,
          message: event.message
        });
      }
    });
  }
  
  // 检查每月循环事件（经期、还款日等）
  if (Array.isArray(events.monthly)) {
    events.monthly.forEach(event => {
      if (event.day === day) {
        triggered.push({
          type: 'monthly',
          name: event.name,
          message: event.message
        });
      }
    });
  }
  
  // 检查临时事件并自动删除
  const todayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  
  if (Array.isArray(events.onetime)) {
    events.onetime = events.onetime.filter(event => {
      if (event.date === todayStr) {
        triggered.push({
          type: 'onetime',
          name: event.name,
          message: event.message
        });
        return false; // 自动删除已触发的事件
      }
      return true;
    });
  }
  
  // 保存更新后的事件列表
  if (triggered.length > 0) {
    await saveEvents(events);
    
    // 发送推送通知
    for (const event of triggered) {
      const emotion = event.type === 'recurring' ? 'happy' : 
                      event.type === 'monthly' ? 'concerned' : 'playful';
      await sendBarkNotification(
        `📅 ${event.name}`,
        event.message,
        emotion
      );
      console.log(`✅ 事件提醒已发送: ${event.name}`);
    }
  }
}

// ===== Bark 推送 =====
async function sendBarkNotification(title, message, emotion = 'happy') {
  if (!CONFIG.BARK_KEY) {
    console.warn('⚠️ BARK_KEY 未配置，跳过推送');
    return false;
  }

  try {
    const soundMap = {
      happy: 'bell',
      playful: 'chime',
      concerned: 'glass',
      lonely: 'popcorn'
    };
    
    const sound = soundMap[emotion] || 'calypso';
    
    const url = `https://api.day.app/${CONFIG.BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(message)}?sound=${sound}&group=muelsyse&url=scriptable:///run/WaterShift?message=${encodeURIComponent(message)}&emotion=${emotion}`;
    
    if (url.length > 2000) {
      console.warn('⚠️ URL 过长，截断消息');
      message = message.substring(0, 100) + '...';
    }
    
    await axios.get(url, { timeout: 10000 });
    console.log('✅ Bark 推送成功');
    return true;
  } catch (err) {
    console.error('❌ Bark 推送失败:', err.message);
    return false;
  }
}

// ===== 主循环 =====
async function mainLoop() {
  try {
    await checkTodayEvents();
    // 这里可以继续添加天气检查、智能提醒等逻辑
  } catch (err) {
    console.error('❌ 主循环异常:', err.message);
  }
}

// ===== API 端点 =====

app.get('/', async (req, res) => {
  const events = await loadEvents();
  res.json({
    status: 'running',
    version: '5.1-monthly-events',
    uptime: Math.floor(process.uptime()),
    events: {
      recurring: events.recurring.length,
      monthly: events.monthly.length,
      onetime: events.onetime.length
    },
    config: {
      hasBark: !!CONFIG.BARK_KEY,
      hasDeepseek: !!CONFIG.DEEPSEEK_KEY
    }
  });
});

// 更新游戏状态
app.post('/api/update-state', async (req, res) => {
  try {
    const state = await loadState();
    
    if (req.body.lastInteractionTime) state.lastInteractionTime = req.body.lastInteractionTime;
    if (req.body.mood) state.mood = req.body.mood;
    if (req.body.energy !== undefined) state.energy = req.body.energy;
    if (req.body.userAttentionScore !== undefined) state.userAttentionScore = req.body.userAttentionScore;
    if (req.body.scene) state.scene = req.body.scene;
    if (req.body.recentMessages) state.recentMessages = req.body.recentMessages;
    
    await saveState(state);
    console.log('✅ 状态同步成功');
    res.json({ success: true });
  } catch (err) {
    console.error('❌ 状态更新失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 智能事件识别端点（供 Scriptable 调用）
app.post('/api/intelligent-event-detection', async (req, res) => {
  try {
    const { userMessage, conversationHistory } = req.body;
    
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ error: '缺少 userMessage 参数' });
    }
    
    const detection = await intelligentEventDetection(
      userMessage,
      conversationHistory || []
    );
    
    if (detection.shouldSave) {
      const saveResult = await executeEventSave(
        detection.functionName,
        detection.arguments
      );
      res.json({
        detected: true,
        result: saveResult
      });
    } else {
      res.json({ detected: false });
    }
    
  } catch (err) {
    console.error('❌ 智能识别失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 查询所有事件
app.get('/api/events', async (req, res) => {
  const events = await loadEvents();
  res.json(events);
});

// 删除事件
app.delete('/api/events/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const events = await loadEvents();
    
    if (type === 'recurring' && Array.isArray(events.recurring)) {
      const originalLength = events.recurring.length;
      events.recurring = events.recurring.filter(e => e.id !== id);
      
      if (events.recurring.length < originalLength) {
        await saveEvents(events);
        res.json({ success: true, message: '生日事件已删除' });
      } else {
        res.status(404).json({ error: '事件不存在' });
      }
    } else if (type === 'monthly' && Array.isArray(events.monthly)) {
      const originalLength = events.monthly.length;
      events.monthly = events.monthly.filter(e => e.id !== id);
      
      if (events.monthly.length < originalLength) {
        await saveEvents(events);
        res.json({ success: true, message: '每月循环事件已删除' });
      } else {
        res.status(404).json({ error: '事件不存在' });
      }
    } else if (type === 'onetime' && Array.isArray(events.onetime)) {
      const originalLength = events.onetime.length;
      events.onetime = events.onetime.filter(e => e.id !== id);
      
      if (events.onetime.length < originalLength) {
        await saveEvents(events);
        res.json({ success: true, message: '临时事件已删除' });
      } else {
        res.status(404).json({ error: '事件不存在' });
      }
    } else {
      res.status(400).json({ error: '无效的事件类型' });
    }
  } catch (err) {
    console.error('❌ 删除事件失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('❌ 服务器错误:', err.message);
  res.status(500).json({ error: '服务器内部错误' });
});

// 优雅退出
process.on('SIGTERM', () => {
  console.log('📴 收到 SIGTERM 信号，准备关闭...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 收到 SIGINT 信号，准备关闭...');
  process.exit(0);
});

// 启动服务
async function start() {
  await initStorage();
  
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 缪尔赛思后端 v5.1 每月循环事件版`);
    console.log(`   端口: ${CONFIG.PORT}`);
    console.log(`   Bark: ${CONFIG.BARK_KEY ? '已配置' : '未配置'}`);
    console.log(`   DeepSeek: ${CONFIG.DEEPSEEK_KEY ? '已配置' : '未配置'}`);
    
    // 启动定时任务
    setInterval(mainLoop, CONFIG.CHECK_INTERVAL);
    mainLoop(); // 立即执行一次
  });
}

start().catch(err => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});
