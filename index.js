// ===== Railway 后端 v6.4：完整版 + 改进相对时间识别 =====
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '2mb' }));

// ===== 配置 =====
const CONFIG = {
  BARK_KEY: process.env.BARK_KEY || '',
  DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',
  PORT: process.env.PORT || 8080,
  DATA_DIR: path.join(__dirname, 'data'),
  
  // 🔥 超热恋模式配置
  ULTRA_HONEYMOON_MODE: {
    CHECK_INTERVAL: 8 * 60 * 1000,           // 每 8 分钟检查一次
    MIN_INTERVAL: 15 * 60 * 1000,            // 最短间隔 15 分钟
    MAX_INTERVAL: 50 * 60 * 1000,            // 最长间隔 50 分钟
    DAILY_TARGET: 30,                         // 每日目标 30 条
    NIGHT_START: 23,
    NIGHT_END: 7,
    PEAK_HOURS: [12, 18, 21],                // 高峰时段
    QUICK_REPLY_THRESHOLD: 10 * 60 * 1000   // 10分钟内回复=热聊
  }
};

const FILES = {
  STATE: path.join(CONFIG.DATA_DIR, 'state.json'),
  EVENTS: path.join(CONFIG.DATA_DIR, 'events.json'),
  PUSH_LOG: path.join(CONFIG.DATA_DIR, 'push_log.json'),
  CONVERSATION: path.join(CONFIG.DATA_DIR, 'conversation_memory.json')
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
        lastInteractionTime: Date.now(),
        mood: 'neutral',
        energy: 70,
        userAttentionScore: 50,
        scene: 'unknown',
        recentMessages: [],
        lastProactiveMessageTime: null,
        userChatSessions: [],
        conversationContext: {
          recentMessages: [],
          lastSyncTime: null
        }
      }, null, 2));
    }
    
    // 初始化对话记忆文件
    try {
      await fs.access(FILES.CONVERSATION);
    } catch {
      await fs.writeFile(FILES.CONVERSATION, JSON.stringify({
        version: 1,
        recentMessages: [],
        lastUpdate: Date.now()
      }, null, 2));
    }
    
    // 初始化事件文件
    try {
      await fs.access(FILES.EVENTS);
    } catch {
      await fs.writeFile(FILES.EVENTS, JSON.stringify({
        recurring: [],
        yearly: [],
        monthly: [],
        onetime: []
      }, null, 2));
    }
    
    // 初始化推送日志
    try {
      await fs.access(FILES.PUSH_LOG);
    } catch {
      await fs.writeFile(FILES.PUSH_LOG, JSON.stringify({
        today: new Date().toISOString().split('T')[0],
        count: 0,
        messages: []
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
    const state = JSON.parse(data);
    
    // 确保 conversationContext 存在
    if (!state.conversationContext) {
      state.conversationContext = {
        recentMessages: [],
        lastSyncTime: null
      };
    }
    
    return state;
  } catch (err) {
    return {
      lastInteractionTime: Date.now(),
      mood: 'neutral',
      energy: 70,
      userAttentionScore: 50,
      scene: 'unknown',
      recentMessages: [],
      lastProactiveMessageTime: null,
      userChatSessions: [],
      conversationContext: {
        recentMessages: [],
        lastSyncTime: null
      }
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

async function loadConversationMemory() {
  try {
    const data = await fs.readFile(FILES.CONVERSATION, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return {
      version: 1,
      recentMessages: [],
      lastUpdate: Date.now()
    };
  }
}

async function saveConversationMemory(memory) {
  try {
    await fs.writeFile(FILES.CONVERSATION, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error('❌ 保存对话记忆失败:', err.message);
  }
}

async function loadEvents() {
  try {
    const data = await fs.readFile(FILES.EVENTS, 'utf-8');
    const events = JSON.parse(data);
    
    if (!events.recurring) events.recurring = [];
    if (!events.yearly) events.yearly = [];
    if (!events.monthly) events.monthly = [];
    if (!events.onetime) events.onetime = [];
    
    return events;
  } catch (err) {
    return { recurring: [], yearly: [], monthly: [], onetime: [] };
  }
}

async function saveEvents(events) {
  try {
    await fs.writeFile(FILES.EVENTS, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error('❌ 保存事件失败:', err.message);
  }
}

async function loadPushLog() {
  try {
    const data = await fs.readFile(FILES.PUSH_LOG, 'utf-8');
    const log = JSON.parse(data);
    
    const today = new Date().toISOString().split('T')[0];
    if (log.today !== today) {
      log.today = today;
      log.count = 0;
      log.messages = [];
      await savePushLog(log);
    }
    
    return log;
  } catch (err) {
    return {
      today: new Date().toISOString().split('T')[0],
      count: 0,
      messages: []
    };
  }
}

async function savePushLog(log) {
  try {
    await fs.writeFile(FILES.PUSH_LOG, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error('❌ 保存推送日志失败:', err.message);
  }
}

// ===== 获取天气数据 =====
async function getWeatherData() {
  try {
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: 39.9042,
        longitude: 116.4074,
        current: 'temperature_2m,weather_code,apparent_temperature',
        timezone: 'Asia/Shanghai'
      },
      timeout: 8000
    });
    
    return {
      temperature: response.data.current.temperature_2m,
      apparentTemperature: response.data.current.apparent_temperature,
      weatherCode: response.data.current.weather_code
    };
  } catch (err) {
    console.error('⚠️ 天气获取失败:', err.message);
    return null;
  }
}

// ===== DeepSeek Function Calling =====
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

// ===== 🔥 改进版：智能事件识别（支持相对时间）=====
async function intelligentEventDetection(userMessage, conversationHistory = []) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'save_birthday_event',
        description: '保存生日事件（每年重复）。',
        parameters: {
          type: 'object',
          properties: {
            month: { type: 'integer', minimum: 1, maximum: 12 },
            day: { type: 'integer', minimum: 1, maximum: 31 },
            person_name: { type: 'string' },
            custom_message: { type: 'string' }
          },
          required: ['month', 'day', 'person_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_yearly_event',
        description: '保存年度循环事件。例如"每年五一去看音律联觉"、"每年春节回家"。',
        parameters: {
          type: 'object',
          properties: {
            month: { type: 'integer', minimum: 1, maximum: 12 },
            day: { type: 'integer', minimum: 1, maximum: 31 },
            event_name: { type: 'string' },
            custom_message: { type: 'string' }
          },
          required: ['month', 'day', 'event_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_monthly_event',
        description: '保存每月重复事件。',
        parameters: {
          type: 'object',
          properties: {
            day: { type: 'integer', minimum: 1, maximum: 31 },
            event_name: { type: 'string' },
            custom_message: { type: 'string' }
          },
          required: ['day', 'event_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_onetime_event',
        description: '保存一次性事件。支持相对时间（明天、后天）和绝对日期。',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: '日期格式 YYYY-MM-DD' },
            event_name: { type: 'string' },
            custom_message: { type: 'string' }
          },
          required: ['date', 'event_name']
        }
      }
    }
  ];
  
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();
  
  // 计算明天和后天的日期
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];
  
  const dayAfterTomorrow = new Date(now);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
  const dayAfterTomorrowDate = dayAfterTomorrow.toISOString().split('T')[0];
  
  const messages = [
    {
      role: 'system',
      content: `你是缪尔赛思的智能日程助手。

规则：
1. 生日 → save_birthday_event
2. 年度循环（"每年五一去XXX"）→ save_yearly_event
3. 每月重复 → save_monthly_event
4. 一次性安排 → save_onetime_event

【🔥 重要】相对时间转换：
- "明天" → ${tomorrowDate}
- "后天" → ${dayAfterTomorrowDate}
- "今天" → ${currentDate}

【当前时间信息】
当前日期：${currentDate}
当前年份：${currentYear}
明天日期：${tomorrowDate}
后天日期：${dayAfterTomorrowDate}

【识别示例】
✅ "明天我要回学校" → save_onetime_event { date: "${tomorrowDate}", event_name: "回学校" }
✅ "提醒我后天开会" → save_onetime_event { date: "${dayAfterTomorrowDate}", event_name: "开会" }
✅ "5月20日回学校" → save_onetime_event { date: "${currentYear}-05-20", event_name: "回学校" }
✅ "我爸爸生日是3月15号" → save_birthday_event { month: 3, day: 15, person_name: "爸爸" }
✅ "每年五一去看音律联觉" → save_yearly_event { month: 5, day: 1, event_name: "去看音律联觉" }

【判断标准】
- 包含"提醒"、"记得"、"别忘了" → 很可能是事件
- 包含时间词 + 动作 → 很可能是事件
- 只是聊天提及某件事，没有提醒意图 → 不是事件`
    }
  ];
  
  if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    messages.push(...conversationHistory.slice(-6));
  }
  
  messages.push({ role: 'user', content: userMessage });
  
  const result = await callDeepSeekWithTools(messages, tools);
  
  if (!result || !result.choices || !result.choices[0]) {
    return { shouldSave: false };
  }
  
  const message = result.choices[0].message;
  
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
      if (!args.month || !args.day || !args.person_name) {
        return { success: false, message: '生日信息不完整' };
      }
      
      const newEvent = {
        id: `recurring_${Date.now()}`,
        name: `${args.person_name}的生日`,
        month: parseInt(args.month),
        day: parseInt(args.day),
        message: args.custom_message || `生日快乐${args.person_name}～🎂`
      };
      
      events.recurring.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 生日事件已保存: ${newEvent.name}`);
      
      return {
        success: true,
        message: `好哒～${args.month}月${args.day}日是${args.person_name}的生日，我记下来了！`
      };
    }
    
    if (functionName === 'save_yearly_event') {
      if (!args.month || !args.day || !args.event_name) {
        return { success: false, message: '事件信息不完整' };
      }
      
      const newEvent = {
        id: `yearly_${Date.now()}`,
        name: args.event_name,
        month: parseInt(args.month),
        day: parseInt(args.day),
        message: args.custom_message || `小鲨，今天是${args.event_name}的日子哦～`
      };
      
      events.yearly.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 年度循环事件已保存: ${args.event_name}`);
      
      return {
        success: true,
        message: `好哒～每年${args.month}月${args.day}日${args.event_name}，我记着呢～`
      };
    }
    
    if (functionName === 'save_monthly_event') {
      if (!args.day || !args.event_name) {
        return { success: false, message: '事件信息不完整' };
      }
      
      const newEvent = {
        id: `monthly_${Date.now()}`,
        name: args.event_name,
        day: parseInt(args.day),
        message: args.custom_message || `小鲨，今天是${args.event_name}的日子哦～`
      };
      
      events.monthly.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 每月循环事件已保存: ${args.event_name}`);
      
      return {
        success: true,
        message: `好哒～每月${args.day}号${args.event_name}，我帮你记着～`
      };
    }
    
    if (functionName === 'save_onetime_event') {
      if (!args.date || !args.event_name) {
        return { success: false, message: '事件信息不完整' };
      }
      
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        return { success: false, message: '日期格式错误' };
      }
      
      const newEvent = {
        id: `onetime_${Date.now()}`,
        name: args.event_name,
        date: args.date,
        message: args.custom_message || `小鲨今天要${args.event_name}啦～`
      };
      
      events.onetime.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 临时事件已保存: ${args.event_name} (${args.date})`);
      
      return {
        success: true,
        message: `好哒～${args.date} ${args.event_name}，我记着呢～`
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
  const bjTime = new Date(now + 8 * 60 * 60 * 1000);
  
  const year = bjTime.getUTCFullYear();
  const month = bjTime.getUTCMonth() + 1;
  const day = bjTime.getUTCDate();
  const hour = bjTime.getUTCHours();
  
  if (hour < 7 || hour >= 8) return;
  
  const events = await loadEvents();
  const triggered = [];
  
  // 检查生日
  if (Array.isArray(events.recurring)) {
    events.recurring.forEach(event => {
      if (event.month === month && event.day === day) {
        triggered.push({ type: 'recurring', name: event.name, message: event.message });
      }
    });
  }
  
  // 检查年度循环事件
  if (Array.isArray(events.yearly)) {
    events.yearly.forEach(event => {
      if (event.month === month && event.day === day) {
        triggered.push({ type: 'yearly', name: event.name, message: event.message });
      }
    });
  }
  
  // 检查每月循环
  if (Array.isArray(events.monthly)) {
    events.monthly.forEach(event => {
      if (event.day === day) {
        triggered.push({ type: 'monthly', name: event.name, message: event.message });
      }
    });
  }
  
  // 检查临时事件
  const todayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  
  if (Array.isArray(events.onetime)) {
    events.onetime = events.onetime.filter(event => {
      if (event.date === todayStr) {
        triggered.push({ type: 'onetime', name: event.name, message: event.message });
        return false;
      }
      return true;
    });
  }
  
  if (triggered.length > 0) {
    await saveEvents(events);
    
    for (const event of triggered) {
      const emotion = event.type === 'recurring' ? 'happy' : 
                      event.type === 'yearly' ? 'playful' :
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

// ===== 🔥 分析对话上下文 =====
async function analyzeConversationContext() {
  const state = await loadState();
  const conversationMemory = await loadConversationMemory();
  
  // 获取最近 20 条消息
  const recentMessages = conversationMemory.recentMessages.slice(-20);
  
  if (recentMessages.length === 0) {
    return {
      userInterests: [],
      recentTopics: [],
      emotionalTone: 'neutral',
      needsCare: false
    };
  }
  
  // 简单关键词提取
  const allText = recentMessages.map(m => m.content).join(' ');
  
  const interests = [];
  const topics = [];
  
  // 兴趣检测
  if (/咖啡|薄荷茶|甜品|蛋糕/.test(allText)) interests.push('美食');
  if (/猫|狗|动物|宠物/.test(allText)) interests.push('动物');
  if (/植物|花|园子|生态/.test(allText)) interests.push('植物');
  if (/音乐|电影|书|游戏/.test(allText)) interests.push('娱乐');
  if (/工作|加班|项目/.test(allText)) topics.push('工作');
  if (/累|困|休息|睡觉/.test(allText)) topics.push('健康');
  
  const needsCare = /累|困|难过|压力|焦虑/.test(allText);
  
  return {
    userInterests: interests,
    recentTopics: topics,
    emotionalTone: needsCare ? 'concerned' : 'neutral',
    needsCare: needsCare
  };
}

// ===== 🔥 生成上下文相关消息（修复版）=====
async function generateContextualMessage(context, analysis) {
  // 定义有效的 emotion 列表
  const VALID_EMOTIONS = ['happy', 'playful', 'coax', 'lonely', 'concerned'];
  
  // Fallback 消息池
  const fallbacks = [
    { message: '小鲨～在忙什么呀？想你了～', emotion: 'coax', type: 'miss' },
    { message: '唔，你最近都在忙什么呢？', emotion: 'lonely', type: 'greeting' },
    { message: '嘿嘿，我在这里哦～', emotion: 'playful', type: 'greeting' },
    { message: '今天心情怎么样呀？', emotion: 'coax', type: 'care' },
    { message: '突然想你了～', emotion: 'lonely', type: 'miss' }
  ];
  
  if (!CONFIG.DEEPSEEK_KEY) {
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  try {
    const bjTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const hour = bjTime.getUTCHours();
    
    // 话题类型权重
    const topicWeights = {
      continuation: 35,  // 延续话题
      interest: 25,      // 兴趣相关
      care: 20,          // 关心健康
      share: 15,         // 分享日常
      weather: 5         // 天气相关
    };
    
    const rand = Math.random() * 100;
    let topicType = 'continuation';
    let cumulative = 0;
    
    for (const [type, weight] of Object.entries(topicWeights)) {
      cumulative += weight;
      if (rand < cumulative) {
        topicType = type;
        break;
      }
    }
    
    const prompt = `你是缪尔赛思，正处于热恋期，想主动给小鲨发条消息。

【当前情境】
时间：${hour}点
触发原因：${context.reasons.join('、')}
${context.weather ? `天气：${context.weather.temperature}°C（体感${context.weather.apparentTemperature}°C）` : ''}
话题类型：${topicType}

【用户分析】
兴趣爱好：${analysis.userInterests.join('、') || '未知'}
最近话题：${analysis.recentTopics.join('、') || '未知'}
是否需要关心：${analysis.needsCare ? '是' : '否'}

【话题类型说明】
- continuation: 延续最近聊过的话题（"对了，你上次说的XXX怎么样了？"）
- interest: 结合她的兴趣（"刚看到XXX，突然想到你喜欢这个"）
- care: 关心她的状态（"最近累不累呀？要注意休息哦～"）
- share: 分享自己的日常（"刚才在生态园看到XXX，好有趣～"）
- weather: 天气相关（"今天天气XXX，记得穿暖和点～"）

【角色要求】
你是热恋期的女友，想主动联系男友的那种感觉：
- 真情实感，不是打卡式问候
- 可以分享自己的小事、想法、感受
- 可以关心对方，但用俏皮温柔的方式
- 可以撒娇、想念、期待见面
- 绝对不要像AI助手（"需要我帮你什么吗"这种话）

【消息类型示例】
✅ [continuation] "小鲨～你上次说要去的那个地方去了吗？好不好玩呀～"
✅ [interest] "刚路过甜品店看到海盐焦糖布丁，突然想起你喜欢这个味道～"
✅ [care] "最近看你好像很忙呀，记得按时吃饭哦～我可记着呢"
✅ [share] "唔，今天生态园的新品多肉到了，超可爱的～给你拍了照片"
✅ [weather] "今天降温了哎，你那边冷不冷？记得多穿点～"

【输出格式】
第一行：消息内容（50-80字）
第二行：emotion（从 happy/playful/coax/lonely/concerned 中选一个）

示例：
小鲨～今天天气好好呀，想和你一起出去走走～
playful`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.1,
        max_tokens: 200
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.DEEPSEEK_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    
    const text = response.data.choices[0].message.content.trim();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    
    console.log('🤖 AI 原始返回:', text);
    
    // 🔥 修复：更严格的解析逻辑
    let message = '';
    let emotion = 'coax';
    
    if (lines.length === 0) {
      console.warn('⚠️ AI 返回为空，使用 fallback');
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    if (lines.length === 1) {
      const singleLine = lines[0].toLowerCase();
      // 如果只有一行且是 emotion，使用 fallback
      if (VALID_EMOTIONS.includes(singleLine)) {
        console.warn('⚠️ AI 只返回了 emotion，使用 fallback');
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
      // 如果只有一行且不是 emotion，当作消息内容
      message = lines[0];
      emotion = 'coax';
    } else {
      // 多行情况：最后一行可能是 emotion
      const lastLine = lines[lines.length - 1].toLowerCase();
      
      if (VALID_EMOTIONS.includes(lastLine)) {
        // 最后一行是 emotion
        emotion = lastLine;
        message = lines.slice(0, -1).join(' ');
      } else {
        // 最后一行不是 emotion，全部当作消息
        message = lines.join(' ');
        emotion = 'coax';
      }
    }
    
    // 🔥 最终验证：消息内容必须合法
    message = message.trim();
    
    // 检查消息是否太短或者包含无效内容
    if (message.length < 5) {
      console.warn('⚠️ 消息太短，使用 fallback');
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    // 检查消息是否误包含了 emotion 关键词（单独出现）
    if (VALID_EMOTIONS.includes(message.toLowerCase())) {
      console.warn('⚠️ 消息内容是 emotion 关键词，使用 fallback');
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    // 检查消息是否以 emotion 关键词开头（误把 emotion 当消息）
    if (VALID_EMOTIONS.some(e => message.toLowerCase().startsWith(e))) {
      console.warn('⚠️ 消息以 emotion 开头，清理后使用');
      // 尝试移除开头的 emotion
      for (const e of VALID_EMOTIONS) {
        if (message.toLowerCase().startsWith(e)) {
          message = message.substring(e.length).trim();
          break;
        }
      }
      // 如果清理后太短，使用 fallback
      if (message.length < 5) {
        console.warn('⚠️ 清理后消息太短，使用 fallback');
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
    }
    
    console.log(`✅ AI 生成消息: "${message}" (${emotion})`);
    return { message, emotion, type: topicType };
    
  } catch (err) {
    console.error('❌ 生成消息失败:', err.message);
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

// ===== 🔥 超高频智能推送系统 =====
async function shouldSendProactiveMessage() {
  const state = await loadState();
  const weather = await getWeatherData();
  const pushLog = await loadPushLog();
  const now = Date.now();
  const bjTime = new Date(now + 8 * 60 * 60 * 1000);
  const hour = bjTime.getUTCHours();
  
  // 夜间静默
  if (hour >= CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_START || hour < CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_END) {
    return { shouldSend: false, reason: '夜间静默时段' };
  }
  
  // 检查今日推送次数
  if (pushLog.count >= CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET) {
    return { shouldSend: false, reason: `今日已推送 ${pushLog.count} 次` };
  }
  
  // 最后一次主动推送时间
  const lastProactive = state.lastProactiveMessageTime || 0;
  const timeSinceLastProactive = now - lastProactive;
  
  // 动态间隔计算
  let minInterval = CONFIG.ULTRA_HONEYMOON_MODE.MIN_INTERVAL;
  
  // 🔥 高峰时段缩短间隔
  if (CONFIG.ULTRA_HONEYMOON_MODE.PEAK_HOURS.includes(hour)) {
    minInterval = minInterval * 0.6;  // 缩短 40%
  }
  
  // 🔥 用户刚回复过，快速跟进
  const timeSinceLastInteraction = now - (state.lastInteractionTime || 0);
  if (timeSinceLastInteraction < CONFIG.ULTRA_HONEYMOON_MODE.QUICK_REPLY_THRESHOLD) {
    minInterval = minInterval * 0.4;  // 缩短 60%
  }
  
  // 最短间隔检查
  if (timeSinceLastProactive < minInterval) {
    const remainingMinutes = Math.ceil((minInterval - timeSinceLastProactive) / 60000);
    return { shouldSend: false, reason: `距上次主动推送仅 ${remainingMinutes} 分钟` };
  }
  
  // 智能评分系统
  let score = 0;
  let reasons = [];
  
  // 天气因素 (20%)
  if (weather) {
    if (Math.abs(weather.temperature - weather.apparentTemperature) > 5) {
      score += 20;
      reasons.push('温差大，需要提醒穿衣');
    }
    if (weather.temperature < 5 || weather.temperature > 35) {
      score += 15;
      reasons.push('极端天气');
    }
  }
  
  // 时间因素 (25%)
  if (hour >= 7 && hour <= 9) {
    score += 20;
    reasons.push('早晨时段');
  } else if (CONFIG.ULTRA_HONEYMOON_MODE.PEAK_HOURS.includes(hour)) {
    score += 25;
    reasons.push('高峰时段');
  }
  
  // 互动因素 (30%)
  const hoursSinceInteraction = timeSinceLastInteraction / (1000 * 60 * 60);
  
  if (hoursSinceInteraction > 4) {
    score += 30;
    reasons.push('超过4小时未互动');
  } else if (hoursSinceInteraction > 2) {
    score += 20;
    reasons.push('好久没聊天了');
  } else if (hoursSinceInteraction < 0.5) {
    score += 25;
    reasons.push('刚才在聊天，趁热追一条');
  }
  
  // 推送频率因素 (15%)
  const pushRatio = pushLog.count / CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET;
  if (pushRatio < 0.3) {
    score += 15;
    reasons.push('今日推送较少');
  }
  
  // 随机因素 (10%)
  if (Math.random() > 0.7) {
    score += 10;
    reasons.push('突然想到你');
  }
  
  // 决策阈值：50分（降低阈值，增加推送频率）
  if (score >= 50) {
    return {
      shouldSend: true,
      score: score,
      reasons: reasons,
      weather: weather
    };
  }
  
  return { shouldSend: false, reason: `评分不足 (${score}/50)` };
}

// ===== Bark 推送 =====
async function sendBarkNotification(title, message, emotion = 'happy') {
  if (!CONFIG.BARK_KEY) {
    console.warn('⚠️ BARK_KEY 未配置');
    return false;
  }

  try {
    const soundMap = {
      happy: 'bell',
      playful: 'chime',
      coax: 'calypso',
      concerned: 'glass',
      lonely: 'popcorn'
    };
    
    const sound = soundMap[emotion] || 'calypso';
    
    // 🔥 正确编码 URL 参数
    const baseUrl = 'scriptable:///run/WaterShift';
    const params = `message=${encodeURIComponent(message)}&emotion=${emotion}`;
    const callbackUrl = `${baseUrl}?${params}`;
    
    const url = `https://api.day.app/${CONFIG.BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(message)}?sound=${sound}&group=muelsyse&url=${encodeURIComponent(callbackUrl)}`;
    
    console.log(`📤 发送 Bark: "${message}" (${emotion})`);
    
    await axios.get(url, { timeout: 10000 });
    console.log('✅ Bark 推送成功');
    return true;
  } catch (err) {
    console.error('❌ Bark 推送失败:', err.message);
    return false;
  }
}

// ===== 🔥 主动推送消息并记录 =====
async function executeProactivePush() {
  const decision = await shouldSendProactiveMessage();
  
  if (decision.shouldSend) {
    // 分析对话上下文
    const analysis = await analyzeConversationContext();
    
    // 生成上下文相关消息
    const { message, emotion, type } = await generateContextualMessage(decision, analysis);
    
    const success = await sendBarkNotification('缪尔赛思', message, emotion);
    
    if (success) {
      const state = await loadState();
      state.lastProactiveMessageTime = Date.now();
      
      // 🔥 记录主动推送到对话记忆（添加去重）
      const conversationMemory = await loadConversationMemory();
      const timestamp = Date.now();
      
      // 检查是否已存在（60秒内相同内容算重复）
      const exists = conversationMemory.recentMessages.some(m => 
        m.content === message && 
        Math.abs((m.timestamp || 0) - timestamp) < 60000
      );
      
      if (!exists) {
        conversationMemory.recentMessages.push({
          role: 'assistant',
          content: message,
          timestamp: timestamp,
          source: 'proactive_push',
          emotion: emotion,
          type: type
        });
        
        // 按时间排序
        conversationMemory.recentMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        
        // 保留最近 80-100 条
        if (conversationMemory.recentMessages.length > 100) {
          conversationMemory.recentMessages = conversationMemory.recentMessages.slice(-100);
        }
        
        conversationMemory.lastUpdate = timestamp;
        await saveConversationMemory(conversationMemory);
        console.log(`✅ 消息已记录到对话记忆 (共 ${conversationMemory.recentMessages.length} 条)`);
      }
      
      // 更新推送日志
      const pushLog = await loadPushLog();
      pushLog.count++;
      pushLog.messages.push({
        time: new Date(timestamp).toISOString(),
        message: message,
        emotion: emotion,
        type: type
      });
      await savePushLog(pushLog);
      
      await saveState(state);
      
      console.log(`✅ 主动推送完成 [${type}] (今日第 ${pushLog.count} 条)`);
    }
  } else {
    console.log(`⏸️  暂不推送: ${decision.reason}`);
  }
}

// ===== API 路由 =====

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// 获取状态
app.get('/api/state', async (req, res) => {
  try {
    const state = await loadState();
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 更新状态
app.post('/api/state', async (req, res) => {
  try {
    const state = await loadState();
    Object.assign(state, req.body);
    await saveState(state);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取完整对话记忆
app.get('/api/conversation', async (req, res) => {
  try {
    const memory = await loadConversationMemory();
    res.json(memory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 游戏同步对话记忆到 Railway
app.post('/api/sync-conversation', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages 必须是数组' });
    }
    
    const conversationMemory = await loadConversationMemory();
    let addedCount = 0;
    
    for (const msg of messages) {
      if (!msg.role || !msg.content) continue;
      
      const timestamp = msg.timestamp || msg.at || Date.now();
      
      // 🔥 去重：60秒内相同内容+角色算重复
      const exists = conversationMemory.recentMessages.some(m => 
        m.role === msg.role &&
        m.content === msg.content && 
        Math.abs((m.timestamp || 0) - timestamp) < 60000
      );
      
      if (!exists) {
        conversationMemory.recentMessages.push({
          role: msg.role,
          content: msg.content,
          timestamp: timestamp,
          source: msg.source || 'game_sync',
          emotion: msg.emotion || null
        });
        addedCount++;
      }
    }
    
    // 排序 + 保留最近 100 条
    conversationMemory.recentMessages.sort((a, b) => 
      (a.timestamp || 0) - (b.timestamp || 0)
    );
    
    if (conversationMemory.recentMessages.length > 100) {
      conversationMemory.recentMessages = conversationMemory.recentMessages.slice(-100);
    }
    
    conversationMemory.lastUpdate = Date.now();
    await saveConversationMemory(conversationMemory);
    
    console.log(`📥 游戏同步: 新增 ${addedCount} 条消息 (总计 ${conversationMemory.recentMessages.length} 条)`);
    
    res.json({
      success: true,
      added: addedCount,
      total: conversationMemory.recentMessages.length
    });
  } catch (error) {
    console.error('❌ 同步失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🔥 用户消息接收（触发状态更新 + 事件识别）
app.post('/api/user-message', async (req, res) => {
  try {
    const { message, timestamp } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: '缺少 message 参数' });
    }
    
    console.log(`📧 收到用户消息: "${message}"`);
    
    // 更新状态
    const state = await loadState();
    state.lastInteractionTime = timestamp || Date.now();
    await saveState(state);
    
    // 记录到对话记忆
    const conversationMemory = await loadConversationMemory();
    const ts = timestamp || Date.now();
    
    const exists = conversationMemory.recentMessages.some(m => 
      m.role === 'user' &&
      m.content === message && 
      Math.abs((m.timestamp || 0) - ts) < 60000
    );
    
    if (!exists) {
      conversationMemory.recentMessages.push({
        role: 'user',
        content: message,
        timestamp: ts,
        source: 'user_input'
      });
      
      conversationMemory.recentMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      
      if (conversationMemory.recentMessages.length > 100) {
        conversationMemory.recentMessages = conversationMemory.recentMessages.slice(-100);
      }
      
      conversationMemory.lastUpdate = ts;
      await saveConversationMemory(conversationMemory);
      console.log(`✅ 消息已记录到对话记忆 (共 ${conversationMemory.recentMessages.length} 条)`);
    }
    
    // 🔥 智能事件识别
    const detectionResult = await intelligentEventDetection(
      message, 
      conversationMemory.recentMessages.slice(-10)
    );
    
    let eventSaveResult = null;
    
    if (detectionResult.shouldSave) {
      eventSaveResult = await executeEventSave(
        detectionResult.functionName, 
        detectionResult.arguments
      );
      
      if (eventSaveResult.success) {
        console.log(`✅ 事件已保存: ${eventSaveResult.message}`);
      }
    }
    
    res.json({
      success: true,
      eventDetected: detectionResult.shouldSave,
      eventSaveResult: eventSaveResult
    });
    
  } catch (error) {
    console.error('❌ 处理用户消息失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 手动触发主动推送
app.post('/api/trigger-push', async (req, res) => {
  try {
    await executeProactivePush();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取推送日志
app.get('/api/push-log', async (req, res) => {
  try {
    const log = await loadPushLog();
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取事件列表
app.get('/api/events', async (req, res) => {
  try {
    const events = await loadEvents();
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 添加事件
app.post('/api/events', async (req, res) => {
  try {
    const { type, data } = req.body;
    const events = await loadEvents();
    
    if (!events[type]) {
      return res.status(400).json({ error: '无效的事件类型' });
    }
    
    events[type].push(data);
    await saveEvents(events);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除事件
app.delete('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const events = await loadEvents();
    
    let found = false;
    for (const type in events) {
      events[type] = events[type].filter(e => {
        if (e.id === id) {
          found = true;
          return false;
        }
        return true;
      });
    }
    
    if (found) {
      await saveEvents(events);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '事件未找到' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 定时任务 =====
setInterval(async () => {
  await checkTodayEvents();
  await executeProactivePush();
}, CONFIG.ULTRA_HONEYMOON_MODE.CHECK_INTERVAL);

// ===== 启动服务器 =====
(async () => {
  await initStorage();
  
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Railway 后端启动成功！`);
    console.log(`📡 端口: ${CONFIG.PORT}`);
    console.log(`⏰ 检查间隔: ${CONFIG.ULTRA_HONEYMOON_MODE.CHECK_INTERVAL / 1000 / 60} 分钟`);
    console.log(`📊 每日目标: ${CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET} 条消息`);
    console.log(`🌙 静默时段: ${CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_START}:00 - ${CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_END}:00`);
  });
})();
