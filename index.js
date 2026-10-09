// ===== Railway 后端 v6.1：超高频智能推送 - 基于上下文的热恋模式 =====
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
  DATA_DIR: path.join(__dirname, 'data'),
  
  // 🔥 超高频智能推送模式
  ULTRA_HONEYMOON_MODE: {
    MIN_INTERVAL: 15 * 60 * 1000,          // 最短 15 分钟
    MAX_INTERVAL: 50 * 60 * 1000,          // 最长 50 分钟
    TARGET_PER_HOUR: 2,                    // 每小时目标 2-3 条
    DAILY_TARGET: 30,                      // 每日 30 条（14小时×2）
    CHECK_INTERVAL: 8 * 60 * 1000,         // 每 8 分钟检查一次
    
    NIGHT_START: 23,                       // 夜间静默开始
    NIGHT_END: 7,                          // 夜间静默结束
    
    // 高频时段（更容易触发推送）
    PEAK_HOURS: [8, 12, 18, 21],          // 早晨、午餐、下班、睡前
    PEAK_BOOST: 0.6,                       // 高峰时段间隔缩短 40%
    
    // 互动响应
    QUICK_REPLY_WINDOW: 5 * 60 * 1000,    // 5分钟内算快速回复
    AFTER_REPLY_BOOST: 0.5,                // 用户回复后缩短 50%
    
    // 话题权重
    TOPIC_WEIGHTS: {
      continuation: 0.35,   // 延续上次话题
      interest: 0.25,       // 她的兴趣
      care: 0.20,           // 关心健康
      share: 0.15,          // 分享日常
      weather: 0.05         // 天气提醒
    }
  }
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
        lastInteractionTime: Date.now(),
        lastProactiveTime: null,
        mood: 'neutral',
        energy: 70,
        scene: 'unknown',
        
        // 🔥 对话上下文
        conversationContext: {
          recentMessages: [],           // 最近对话（含 role 和 content）
          recentTopics: [],             // 最近话题
          herInterests: [],             // 她的兴趣
          lastUserMessage: '',          // 最后用户消息
          lastAssistantMessage: '',     // 最后助手消息
          conversationTone: 'neutral'   // 对话基调
        },
        
        // 🔥 推送历史
        pushHistory: [],
        todayPushCount: 0,
        lastPushDate: new Date().toISOString().split('T')[0]
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
    return {
      lastInteractionTime: Date.now(),
      lastProactiveTime: null,
      mood: 'neutral',
      energy: 70,
      scene: 'unknown',
      conversationContext: {
        recentMessages: [],
        recentTopics: [],
        herInterests: [],
        lastUserMessage: '',
        lastAssistantMessage: '',
        conversationTone: 'neutral'
      },
      pushHistory: [],
      todayPushCount: 0,
      lastPushDate: new Date().toISOString().split('T')[0]
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

// ===== 智能事件识别 =====
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
        description: '保存一次性事件。',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string' },
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
  
  const messages = [
    {
      role: 'system',
      content: `你是缪尔赛思的智能日程助手。

规则：
1. 生日 → save_birthday_event
2. 年度循环（"每年五一去XXX"）→ save_yearly_event
3. 每月重复 → save_monthly_event
4. 一次性安排 → save_onetime_event

当前日期：${currentDate}
当前年份：${currentYear}`
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
      
      console.log(`✅ 临时事件已保存: ${args.event_name}`);
      
      return {
        success: true,
        message: `唔，${args.date} ${args.event_name}是吧？我记着～`
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
  
  // 检查年度循环
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

// ===== 🔥 智能分析对话上下文 =====
async function analyzeConversationContext(recentMessages) {
  if (!CONFIG.DEEPSEEK_KEY || !Array.isArray(recentMessages) || recentMessages.length === 0) {
    return {
      herInterests: [],
      recentTopics: [],
      conversationTone: 'neutral',
      nextTopicSuggestion: null
    };
  }

  try {
    const conversationText = recentMessages
      .slice(-10)
      .map(m => `${m.role === 'user' ? '小鲨' : '缪尔赛思'}: ${m.content}`)
      .join('\n');

    const prompt = `分析以下对话，提取关键信息：

${conversationText}

请输出 JSON 格式：
{
  "herInterests": ["她提到的兴趣爱好"],
  "recentTopics": ["最近聊过的话题"],
  "conversationTone": "playful/caring/casual/romantic",
  "nextTopicSuggestion": "可以继续聊的自然话题（一句话）"
}

规则：
1. herInterests 只提取小鲨明确表达喜欢/感兴趣的东西
2. recentTopics 总结最近3-5个话题
3. nextTopicSuggestion 必须自然延续对话，不能突兀
4. 只输出 JSON，不要解释`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.DEEPSEEK_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    console.log('📊 对话分析结果:', JSON.stringify(result, null, 2));
    return result;

  } catch (err) {
    console.error('❌ 对话分析失败:', err.message);
    return {
      herInterests: [],
      recentTopics: [],
      conversationTone: 'neutral',
      nextTopicSuggestion: null
    };
  }
}

// ===== 🔥 智能生成主动消息（基于上下文） =====
async function generateContextualMessage(state, weather) {
  if (!CONFIG.DEEPSEEK_KEY) {
    return {
      text: '小鲨～在忙什么呀？',
      emotion: 'coax',
      topicType: 'casual'
    };
  }

  try {
    const context = state.conversationContext || {};
    const now = new Date();
    const hour = now.getHours();
    
    // 选择话题类型（基于权重）
    const rand = Math.random();
    let topicType = 'share';
    let weight = 0;
    
    for (const [type, w] of Object.entries(CONFIG.ULTRA_HONEYMOON_MODE.TOPIC_WEIGHTS)) {
      weight += w;
      if (rand <= weight) {
        topicType = type;
        break;
      }
    }
    
    const prompt = `你是缪尔赛思，想主动给小鲨发条消息。

【当前情境】
时间：${hour}:${now.getMinutes().toString().padStart(2, '0')}
话题类型：${topicType}
${weather ? `天气：${weather.temperature}°C（体感${weather.apparentTemperature}°C）` : ''}

【上下文信息】
她的兴趣：${context.herInterests?.join('、') || '未知'}
最近话题：${context.recentTopics?.join('、') || '无'}
上次我说：${context.lastAssistantMessage || '无'}
上次她说：${context.lastUserMessage || '无'}
对话基调：${context.conversationTone || 'neutral'}

【话题要求】
${topicType === 'continuation' ? '自然延续上次对话，像真人一样想起来继续聊' : ''}
${topicType === 'interest' ? '聊她感兴趣的东西，展现你记得她的喜好' : ''}
${topicType === 'care' ? '关心她的状态，但要俏皮温柔，不说教' : ''}
${topicType === 'share' ? '分享你的小事，让她感觉你想跟她说话' : ''}
${topicType === 'weather' && weather ? `天气提醒（温差${Math.abs(weather.temperature - weather.apparentTemperature)}°C）` : ''}

【性格要求】
- 热恋期女友的感觉：想他、想分享、想撒娇
- 真实自然，不是打卡问候
- 50-80字
- 直接输出消息，不要 JSON

最后一行单独输出 emotion: happy/playful/coax/caring 之一`;

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
    const lines = text.split('\n').filter(l => l.trim());
    
    let message = lines[0];
    let emotion = 'coax';
    
    if (lines.length > 1) {
      const lastLine = lines[lines.length - 1].toLowerCase();
      if (lastLine.includes('emotion:')) {
        const match = lastLine.match(/emotion:\s*(\w+)/);
        if (match && ['happy', 'playful', 'coax', 'caring'].includes(match[1])) {
          emotion = match[1];
          message = lines.slice(0, -1).join(' ');
        }
      }
    }

    return { text: message, emotion, topicType };

  } catch (err) {
    console.error('❌ 消息生成失败:', err.message);
    return {
      text: '小鲨～想你了～',
      emotion: 'coax',
      topicType: 'casual'
    };
  }
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
      caring: 'glass',
      lonely: 'popcorn'
    };
    
    const sound = soundMap[emotion] || 'calypso';
    
    const url = `https://api.day.app/${CONFIG.BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(message)}?sound=${sound}&group=muelsyse&url=scriptable:///run/WaterShift?message=${encodeURIComponent(message)}&emotion=${emotion}`;
    
    await axios.get(url, { timeout: 10000 });
    console.log('✅ Bark 推送成功');
    return true;
  } catch (err) {
    console.error('❌ Bark 推送失败:', err.message);
    return false;
  }
}

// ===== 🔥 超高频主循环 =====
async function mainLoop() {
  try {
    const now = Date.now();
    const bjTime = new Date(now + 8 * 60 * 60 * 1000);
    const hour = bjTime.getUTCHours();
    
    // 夜间静默
    if (hour >= CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_START || 
        hour < CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_END) {
      console.log(`🌙 夜间静默 (${hour}:00)`);
      return;
    }
    
    const state = await loadState();
    
    // 重置每日计数
    const today = new Date().toISOString().split('T')[0];
    if (state.lastPushDate !== today) {
      state.todayPushCount = 0;
      state.lastPushDate = today;
      state.pushHistory = [];
      await saveState(state);
    }
    
    // 检查今日推送上限
    if (state.todayPushCount >= CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET) {
      console.log(`✅ 今日已达标 (${state.todayPushCount}/${CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET})`);
      return;
    }
    
    // 🔥 动态计算间隔
    let requiredInterval = CONFIG.ULTRA_HONEYMOON_MODE.MIN_INTERVAL;
    
    // 高峰时段加速
    if (CONFIG.ULTRA_HONEYMOON_MODE.PEAK_HOURS.includes(hour)) {
      requiredInterval *= CONFIG.ULTRA_HONEYMOON_MODE.PEAK_BOOST;
      console.log(`⭐ 高峰时段 (${hour}:00)，间隔 ${Math.floor(requiredInterval / 60000)} 分钟`);
    }
    
    // 用户快速回复后加速
    const timeSinceUserReply = now - state.lastInteractionTime;
    if (timeSinceUserReply < CONFIG.ULTRA_HONEYMOON_MODE.QUICK_REPLY_WINDOW) {
      requiredInterval *= CONFIG.ULTRA_HONEYMOON_MODE.AFTER_REPLY_BOOST;
      console.log(`💬 用户刚回复，加速至 ${Math.floor(requiredInterval / 60000)} 分钟`);
    }
    
    // 检查距离上次推送时间
    const lastPush = state.lastProactiveTime || 0;
    const timeSinceLastPush = now - lastPush;
    
    if (timeSinceLastPush < requiredInterval) {
      const waitMin = Math.ceil((requiredInterval - timeSinceLastPush) / 60000);
      console.log(`⏳ 还需 ${waitMin} 分钟 (已等 ${Math.floor(timeSinceLastPush / 60000)} 分钟)`);
      return;
    }
    
    // 🔥 分析对话上下文
    console.log(`\n💕 准备推送 [${state.todayPushCount + 1}/${CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET}]`);
    
    const recentMessages = state.conversationContext?.recentMessages || [];
    if (recentMessages.length > 0) {
      const analysis = await analyzeConversationContext(recentMessages);
      state.conversationContext = {
        ...state.conversationContext,
        ...analysis
      };
    }
    
    // 获取天气
    const weather = await getWeatherData();
    
    // 生成消息
    const message = await generateContextualMessage(state, weather);
    
    if (!message || !message.text) {
      console.warn('⚠️ 未生成消息，跳过');
      return;
    }
    
    // 发送推送
    const success = await sendBarkNotification(
      '缪尔赛思',
      message.text,
      message.emotion
    );
    
    if (success) {
      state.todayPushCount++;
      state.lastProactiveTime = now;
      state.pushHistory.push({
        time: now,
        text: message.text,
        emotion: message.emotion,
        topicType: message.topicType
      });
      
      if (state.pushHistory.length > 50) {
        state.pushHistory = state.pushHistory.slice(-50);
      }
      
      // 更新对话上下文
      if (state.conversationContext) {
        state.conversationContext.lastAssistantMessage = message.text;
      }
      
      await saveState(state);
      
      console.log(`✅ 推送成功！今日 ${state.todayPushCount}/${CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET}`);
      console.log(`📝 [${message.topicType}] ${message.text}`);
    } else {
      console.error('❌ 推送失败');
    }
    
  } catch (err) {
    console.error('❌ mainLoop 错误:', err.message);
  }
}

// ===== API 端点 =====

app.get('/', async (req, res) => {
  const events = await loadEvents();
  const state = await loadState();
  res.json({
    status: 'running',
    version: '6.1-ultra-honeymoon',
    uptime: Math.floor(process.uptime()),
    events: {
      recurring: events.recurring.length,
      yearly: events.yearly.length,
      monthly: events.monthly.length,
      onetime: events.onetime.length
    },
    push: {
      today: state.lastPushDate,
      count: state.todayPushCount,
      target: CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET,
      lastPushTime: state.lastProactiveTime ? new Date(state.lastProactiveTime).toLocaleString('zh-CN') : '未推送'
    },
    config: {
      hasBark: !!CONFIG.BARK_KEY,
      hasDeepseek: !!CONFIG.DEEPSEEK_KEY,
      checkInterval: `${CONFIG.ULTRA_HONEYMOON_MODE.CHECK_INTERVAL / 60000}分钟`,
      pushInterval: `${CONFIG.ULTRA_HONEYMOON_MODE.MIN_INTERVAL / 60000}-${CONFIG.ULTRA_HONEYMOON_MODE.MAX_INTERVAL / 60000}分钟`
    }
  });
});

app.post('/api/update-state', async (req, res) => {
  try {
    const state = await loadState();
    
    // 更新交互时间
    if (req.body.lastInteractionTime) {
      state.lastInteractionTime = req.body.lastInteractionTime;
    }
    
    if (req.body.mood) state.mood = req.body.mood;
    if (req.body.energy !== undefined) state.energy = req.body.energy;
    if (req.body.scene) state.scene = req.body.scene;
    
    // 🔥 更新对话上下文
    if (req.body.conversationContext) {
      if (!state.conversationContext) {
        state.conversationContext = {};
      }
      
      if (req.body.conversationContext.recentMessages) {
        state.conversationContext.recentMessages = req.body.conversationContext.recentMessages.slice(-20);
      }
      
      if (req.body.conversationContext.lastUserMessage) {
        state.conversationContext.lastUserMessage = req.body.conversationContext.lastUserMessage;
      }
    }
    
    await saveState(state);
    console.log('✅ 状态同步成功');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      res.json({ detected: true, result: saveResult });
    } else {
      res.json({ detected: false });
    }
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events', async (req, res) => {
  const events = await loadEvents();
  res.json(events);
});

app.delete('/api/events/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const events = await loadEvents();
    
    if (!events[type]) {
      return res.status(400).json({ error: '无效的事件类型' });
    }
    
    const index = events[type].findIndex(e => e.id === id);
    if (index === -1) {
      return res.status(404).json({ error: '事件未找到' });
    }
    
    events[type].splice(index, 1);
    await saveEvents(events);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/state', async (req, res) => {
  const state = await loadState();
  res.json(state);
});

// ===== 启动服务 =====
app.listen(CONFIG.PORT, async () => {
  console.log(`\n🚀 缪尔赛思后端 v6.1 - 超高频智能推送`);
  console.log(`   端口: ${CONFIG.PORT}`);
  console.log(`   BARK: ${CONFIG.BARK_KEY ? '✅' : '❌'}`);
  console.log(`   DeepSeek: ${CONFIG.DEEPSEEK_KEY ? '✅' : '❌'}`);
  console.log(`\n📊 推送配置:`);
  console.log(`   目标频率: 每小时 ${CONFIG.ULTRA_HONEYMOON_MODE.TARGET_PER_HOUR} 条`);
  console.log(`   每日目标: ${CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET} 条`);
  console.log(`   检查间隔: 每 ${CONFIG.ULTRA_HONEYMOON_MODE.CHECK_INTERVAL / 60000} 分钟`);
  console.log(`   推送间隔: ${CONFIG.ULTRA_HONEYMOON_MODE.MIN_INTERVAL / 60000}-${CONFIG.ULTRA_HONEYMOON_MODE.MAX_INTERVAL / 60000} 分钟`);
  console.log(`   高峰时段: ${CONFIG.ULTRA_HONEYMOON_MODE.PEAK_HOURS.join(', ')}:00\n`);
  
  await initStorage();
  
  // 检查事件
  setInterval(checkTodayEvents, 60 * 60 * 1000);
  
  // 启动后 15 秒首次检查
  setTimeout(async () => {
    console.log('🔄 首次检查...');
    await mainLoop();
  }, 15000);
  
  // 每 8 分钟检查一次
  setInterval(async () => {
    const now = new Date();
    console.log(`\n🔄 [${now.toLocaleTimeString('zh-CN')}] 定时检查`);
    await mainLoop();
  }, CONFIG.ULTRA_HONEYMOON_MODE.CHECK_INTERVAL);
  
  console.log('✅ 超高频推送系统已启动！\n');
});
