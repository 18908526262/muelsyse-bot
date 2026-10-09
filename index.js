// ===== Railway 后端 v6.0：热恋模式 - 智能高频互动 =====
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
  
  // 🔥 热恋模式配置（基于研究数据）
  HONEYMOON_MODE: {
    MIN_INTERVAL: 2 * 60 * 60 * 1000,      // 最短间隔 2 小时
    MAX_INTERVAL: 4 * 60 * 60 * 1000,      // 最长间隔 4 小时
    DAILY_TARGET: 6,                       // 每日目标消息数（不含用户触发）
    NIGHT_START: 23,                       // 夜间静默开始（23点）
    NIGHT_END: 7,                          // 夜间静默结束（7点）
    WEATHER_WEIGHT: 0.3,                   // 天气因素权重
    EMOTION_WEIGHT: 0.4,                   // 情绪因素权重
    TIME_WEIGHT: 0.3                       // 时间因素权重
  }
};

const FILES = {
  STATE: path.join(CONFIG.DATA_DIR, 'state.json'),
  EVENTS: path.join(CONFIG.DATA_DIR, 'events.json'),
  PUSH_LOG: path.join(CONFIG.DATA_DIR, 'push_log.json')
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
        lastProactiveMessageTime: null,  // 最后一次主动消息时间
        userChatSessions: []              // 用户聊天记录（不影响推送）
      }, null, 2));
    }
    
    // 初始化事件文件
    try {
      await fs.access(FILES.EVENTS);
    } catch {
      await fs.writeFile(FILES.EVENTS, JSON.stringify({
        recurring: [],  // 每年重复（生日）
        yearly: [],     // 年度循环（五一去看音律联觉）
        monthly: [],    // 每月重复（经期、还款日）
        onetime: []     // 一次性（回学校）
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
    return JSON.parse(data);
  } catch (err) {
    return {
      lastInteractionTime: Date.now(),
      mood: 'neutral',
      energy: 70,
      userAttentionScore: 50,
      scene: 'unknown',
      recentMessages: [],
      lastProactiveMessageTime: null,
      userChatSessions: []
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
  
  // 🔥 检查年度循环事件
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

// ===== 🔥 热恋模式智能推送系统 =====
async function shouldSendProactiveMessage() {
  const state = await loadState();
  const weather = await getWeatherData();
  const pushLog = await loadPushLog();
  const now = Date.now();
  const bjTime = new Date(now + 8 * 60 * 60 * 1000);
  const hour = bjTime.getUTCHours();
  
  // 夜间静默
  if (hour >= CONFIG.HONEYMOON_MODE.NIGHT_START || hour < CONFIG.HONEYMOON_MODE.NIGHT_END) {
    return { shouldSend: false, reason: '夜间静默时段' };
  }
  
  // 检查今日推送次数
  if (pushLog.count >= CONFIG.HONEYMOON_MODE.DAILY_TARGET) {
    return { shouldSend: false, reason: `今日已推送 ${pushLog.count} 次` };
  }
  
  // 🔥 关键：不因用户聊天而重置计时
  const lastProactive = state.lastProactiveMessageTime || 0;
  const timeSinceLastProactive = now - lastProactive;
  
  // 最短间隔检查（2小时）
  if (timeSinceLastProactive < CONFIG.HONEYMOON_MODE.MIN_INTERVAL) {
    const remainingMinutes = Math.ceil((CONFIG.HONEYMOON_MODE.MIN_INTERVAL - timeSinceLastProactive) / 60000);
    return { shouldSend: false, reason: `距上次主动推送仅 ${remainingMinutes} 分钟` };
  }
  
  // 智能评分系统
  let score = 0;
  let reasons = [];
  
  // 天气因素 (30%)
  if (weather) {
    if (Math.abs(weather.temperature - weather.apparentTemperature) > 5) {
      score += 30;
      reasons.push('温差大，需要提醒穿衣');
    }
    if (weather.temperature < 5 || weather.temperature > 35) {
      score += 20;
      reasons.push('极端天气');
    }
  }
  
  // 时间因素 (30%)
  if (hour >= 7 && hour <= 9) {
    score += 25;
    reasons.push('早晨时段，适合问候');
  } else if (hour >= 11 && hour <= 13) {
    score += 20;
    reasons.push('午餐时间');
  } else if (hour >= 17 && hour <= 19) {
    score += 20;
    reasons.push('晚餐时间');
  } else if (hour >= 21 && hour <= 22) {
    score += 15;
    reasons.push('睡前时段');
  }
  
  // 情绪因素 (40%)
  const hoursSinceInteraction = state.lastInteractionTime 
    ? (now - state.lastInteractionTime) / (1000 * 60 * 60) 
    : 999;
  
  if (hoursSinceInteraction > 6) {
    score += 40;
    reasons.push('超过6小时未互动，想你了');
  } else if (hoursSinceInteraction > 4) {
    score += 25;
    reasons.push('好久没聊天了');
  }
  
  // 随机因素（营造真实感）
  if (Math.random() > 0.7) {
    score += 15;
    reasons.push('突然想到你');
  }
  
  // 决策阈值：60分
  if (score >= 60) {
    return {
      shouldSend: true,
      score: score,
      reasons: reasons,
      weather: weather
    };
  }
  
  return { shouldSend: false, reason: `评分不足 (${score}/60)` };
}

// ===== 生成主动消息 =====
async function generateProactiveMessage(context) {
  if (!CONFIG.DEEPSEEK_KEY) {
    return {
      message: '小鲨～在忙什么呀？',
      emotion: 'coax'
    };
  }

  try {
    const state = await loadState();
    const bjTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const hour = bjTime.getUTCHours();
    
    const prompt = `你是缪尔赛思，正处于热恋期，想主动给小鲨发条消息。

【当前情境】
时间：${hour}点
触发原因：${context.reasons.join('、')}
${context.weather ? `天气：${context.weather.temperature}°C（体感${context.weather.apparentTemperature}°C）` : ''}
上次聊天：${state.lastInteractionTime ? Math.floor((Date.now() - state.lastInteractionTime) / 60000) + '分钟前' : '很久了'}

【角色要求】
你是热恋期的女友，想主动联系男友的那种感觉：
- 真情实感，不是打卡式问候
- 可以分享自己的小事、想法、感受
- 可以关心对方，但用俏皮温柔的方式
- 可以撒娇、想念、期待见面
- 绝对不要像AI助手（"需要我帮你什么吗"这种话）

【消息类型示例】
✅ "唔…刚才看到一只好可爱的猫，突然想起你了"
✅ "小鲨～今天的阳光超好，要不要出来散步呀？"
✅ "在吗在吗，我发现生态园里有新品种的多肉，想带你看～"
✅ "哎呀，你最近都不来找我，是不是把我忘了呀"
✅ "刚才路过咖啡馆，想起上次和你一起喝薄荷茶的时候…"

【输出要求】
1. 一条消息，50-80字
2. 自然、真实、有情感温度
3. 符合缪尔赛思性格（温柔俏皮、会撒娇）
4. 根据时间和天气自然融入场景
5. 直接输出消息内容，不要 JSON 格式

emotion 选择：happy/playful/coax/lonely 中的一个（单独一行输出）`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.0,
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
    
    // 尝试解析 emotion
    if (lines.length > 1) {
      const lastLine = lines[lines.length - 1].toLowerCase();
      if (['happy', 'playful', 'coax', 'lonely'].includes(lastLine)) {
        emotion = lastLine;
        message = lines.slice(0, -1).join(' ');
      }
    }
    
    return { message, emotion };
    
  } catch (err) {
    console.error('❌ 生成消息失败:', err.message);
    
    // Fallback
    const hour = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
    const fallbacks = [
      { message: '小鲨～在忙什么呀？想你了～', emotion: 'coax' },
      { message: '唔，你最近都在忙什么呢？', emotion: 'lonely' },
      { message: '嘿嘿，我在这里哦～', emotion: 'playful' },
      { message: '小鲨，记得按时吃饭哦～', emotion: 'happy' }
    ];
    
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
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

// ===== 主循环 =====
async function mainLoop() {
  try {
    // 检查固定事件
    await checkTodayEvents();
    
    // 🔥 热恋模式主动推送
    const decision = await shouldSendProactiveMessage();
    
    if (decision.shouldSend) {
      const { message, emotion } = await generateProactiveMessage(decision);
      
      const success = await sendBarkNotification('缪尔赛思', message, emotion);
      
      if (success) {
        const state = await loadState();
        state.lastProactiveMessageTime = Date.now();
        await saveState(state);
        
        const pushLog = await loadPushLog();
        pushLog.count++;
        pushLog.messages.push({
          time: new Date().toISOString(),
          message: message,
          emotion: emotion,
          score: decision.score,
          reasons: decision.reasons
        });
        await savePushLog(pushLog);
        
        console.log(`💕 主动推送成功 [${pushLog.count}/${CONFIG.HONEYMOON_MODE.DAILY_TARGET}] - ${message.substring(0, 20)}...`);
      }
    } else {
      console.log(`⏸️ 暂不推送 - ${decision.reason}`);
    }
    
  } catch (err) {
    console.error('❌ 主循环异常:', err.message);
  }
}

// ===== API 端点 =====

app.get('/', async (req, res) => {
  const events = await loadEvents();
  const pushLog = await loadPushLog();
  res.json({
    status: 'running',
    version: '6.0-honeymoon-mode',
    uptime: Math.floor(process.uptime()),
    events: {
      recurring: events.recurring.length,
      yearly: events.yearly.length,
      monthly: events.monthly.length,
      onetime: events.onetime.length
    },
    push: {
      today: pushLog.today,
      count: pushLog.count,
      target: CONFIG.HONEYMOON_MODE.DAILY_TARGET
    },
    config: {
      hasBark: !!CONFIG.BARK_KEY,
      hasDeepseek: !!CONFIG.DEEPSEEK_KEY
    }
  });
});

app.post('/api/update-state', async (req, res) => {
  try {
    const state = await loadState();
    
    // 🔥 关键：用户聊天不重置 lastProactiveMessageTime
    if (req.body.lastInteractionTime) state.lastInteractionTime = req.body.lastInteractionTime;
    if (req.body.mood) state.mood = req.body.mood;
    if (req.body.energy !== undefined) state.energy = req.body.energy;
    if (req.body.userAttentionScore !== undefined) state.userAttentionScore = req.body.userAttentionScore;
    if (req.body.scene) state.scene = req.body.scene;
    if (req.body.recentMessages) state.recentMessages = req.body.recentMessages;
    
    // 记录用户聊天会话（不影响主动推送）
    if (!state.userChatSessions) state.userChatSessions = [];
    state.userChatSessions.push({
      time: Date.now(),
      messageCount: req.body.recentMessages?.length || 0
    });
    state.userChatSessions = state.userChatSessions.slice(-20);
    
    await saveState(state);
    console.log('✅ 状态同步成功（不影响主动推送计时）');
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
    
    const validTypes = ['recurring', 'yearly', 'monthly', 'onetime'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: '无效的事件类型' });
    }
    
    if (Array.isArray(events[type])) {
      const originalLength = events[type].length;
      events[type] = events[type].filter(e => e.id !== id);
      
      if (events[type].length < originalLength) {
        await saveEvents(events);
        res.json({ success: true, message: '事件已删除' });
      } else {
        res.status(404).json({ error: '事件不存在' });
      }
    } else {
      res.status(400).json({ error: '事件类型不存在' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/push-log', async (req, res) => {
  const log = await loadPushLog();
  res.json(log);
});

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
  console.log('📴 收到 SIGTERM 信号');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 收到 SIGINT 信号');
  process.exit(0);
});

// 启动服务
async function start() {
  await initStorage();
  
  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 缪尔赛思后端 v6.0 热恋模式`);
    console.log(`   端口: ${CONFIG.PORT}`);
    console.log(`   推送间隔: 2-4 小时`);
    console.log(`   每日目标: ${CONFIG.HONEYMOON_MODE.DAILY_TARGET} 条`);
    console.log(`   Bark: ${CONFIG.BARK_KEY ? '已配置' : '未配置'}`);
    console.log(`   DeepSeek: ${CONFIG.DEEPSEEK_KEY ? '已配置' : '未配置'}`);
    
    // 每 30 分钟检查一次
    setInterval(mainLoop, 30 * 60 * 1000);
    mainLoop();
  });
}

start().catch(err => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});
