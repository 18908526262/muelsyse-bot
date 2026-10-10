// ===== Railway 后端 v7.0：超级智能版 =====
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
  
  ULTRA_HONEYMOON_MODE: {
    CHECK_INTERVAL: 8 * 60 * 1000,
    MIN_INTERVAL: 15 * 60 * 1000,
    MAX_INTERVAL: 50 * 60 * 1000,
    DAILY_TARGET: 30,
    NIGHT_START: 23,
    NIGHT_END: 7,
    PEAK_HOURS: [12, 18, 21],
    QUICK_REPLY_THRESHOLD: 10 * 60 * 1000
  }
};

const FILES = {
  STATE: path.join(CONFIG.DATA_DIR, 'state.json'),
  EVENTS: path.join(CONFIG.DATA_DIR, 'events.json'),
  PUSH_LOG: path.join(CONFIG.DATA_DIR, 'push_log.json'),
  CONVERSATION: path.join(CONFIG.DATA_DIR, 'conversation_memory.json')
};

// ===== 辅助函数 =====
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString().split('T')[0];
}

function getDayName(date) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return days[date.getDay()];
}

function getEndOfMonth(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  return new Date(year, month + 1, 0).toISOString().split('T')[0];
}

function getNextWeekday(currentDate, targetDay) {
  const current = new Date(currentDate);
  const currentDay = current.getDay();
  let daysToAdd = targetDay - currentDay;
  if (daysToAdd <= 0) daysToAdd += 7;
  return addDays(current, daysToAdd);
}

function addHours(date, hours) {
  const result = new Date(date);
  result.setHours(result.getHours() + hours);
  return result.toISOString();
}

// ===== 初始化存储 =====
async function initStorage() {
  try {
    await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
    
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
    
    try {
      await fs.access(FILES.CONVERSATION);
    } catch {
      await fs.writeFile(FILES.CONVERSATION, JSON.stringify({
        version: 1,
        recentMessages: [],
        lastUpdate: Date.now()
      }, null, 2));
    }
    
    try {
      await fs.access(FILES.EVENTS);
    } catch {
      await fs.writeFile(FILES.EVENTS, JSON.stringify({
        recurring: [],
        yearly: [],
        monthly: [],
        weekly: [],
        daily: [],
        onetime: []
      }, null, 2));
    }
    
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
    if (!events.weekly) events.weekly = [];
    if (!events.daily) events.daily = [];
    if (!events.onetime) events.onetime = [];
    
    return events;
  } catch (err) {
    return { 
      recurring: [], 
      yearly: [], 
      monthly: [], 
      weekly: [], 
      daily: [], 
      onetime: [] 
    };
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

// ===== 🔥 超级智能事件识别 =====
async function intelligentEventDetection(userMessage, conversationHistory = []) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'save_birthday_event',
        description: '保存生日事件（每年重复）',
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
        description: '保存年度循环事件，如"每年五一去看音律联觉"',
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
        description: '保存每月重复事件，如"每月1号发工资"',
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
        name: 'save_weekly_event',
        description: '保存每周重复事件，如"每周五开会"',
        parameters: {
          type: 'object',
          properties: {
            weekday: { 
              type: 'integer', 
              minimum: 0, 
              maximum: 6,
              description: '0=周日,1=周一,2=周二,3=周三,4=周四,5=周五,6=周六'
            },
            time: { type: 'string', description: '时间，格式HH:mm，可选' },
            event_name: { type: 'string' },
            custom_message: { type: 'string' }
          },
          required: ['weekday', 'event_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_daily_event',
        description: '保存每日重复事件，如"每天早上8点吃药"',
        parameters: {
          type: 'object',
          properties: {
            time: { type: 'string', description: '时间，格式HH:mm' },
            event_name: { type: 'string' },
            custom_message: { type: 'string' }
          },
          required: ['time', 'event_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_onetime_event',
        description: '保存一次性事件。支持相对时间（明天、后天）和绝对日期',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: '日期格式 YYYY-MM-DD' },
            time: { type: 'string', description: '时间，格式HH:mm，可选' },
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
  
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];
  
  const dayAfterTomorrow = new Date(now);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
  const dayAfterTomorrowDate = dayAfterTomorrow.toISOString().split('T')[0];
  
  const threeDaysLater = addDays(now, 3);
  const oneWeekLater = addDays(now, 7);
  const endOfMonthDate = getEndOfMonth(now);
  
  const messages = [
    {
      role: 'system',
      content: `你是专业的时间语义识别助手，擅长理解中文口语化的时间表达。

【当前时间信息】
今天：${currentDate} (${getDayName(now)})
明天：${tomorrowDate}
后天：${dayAfterTomorrowDate}
当前年份：${currentYear}

【时间计算规则 - 严格遵守】
相对时间转换（必须输出ISO格式日期）：
1. "明天" → ${tomorrowDate}
2. "后天" → ${dayAfterTomorrowDate}
3. "过几天"/"这几天"/"最近" → ${threeDaysLater}
4. "一周后"/"下周" → ${oneWeekLater}
5. "月底"/"本月底" → ${endOfMonthDate}
6. "X天后" → 从今天加X天
7. "X小时后" → 从现在加X小时
8. "改天" → ${threeDaysLater}

模糊表达标准化：
- "一会儿" → 2小时后
- "晚点" → 3小时后
- "待会" → 1小时后

绝对日期转换：
- "5月20日" → ${currentYear}-05-20
- "下个月15号" → 计算下月日期
- "X月X号" → ${currentYear}-XX-XX

【事件类型识别规则】
1. 生日 → save_birthday_event
   识别："XX的生日是X月X号"

2. 年度循环 → save_yearly_event
   识别："每年X月X号XXX"

3. 每月重复 → save_monthly_event
   识别："每月X号XXX"、"每个月X号XXX"

4. 每周重复 → save_weekly_event
   识别："每周X开会"、"每周五XXX"
   weekday映射：周一=1,周二=2,周三=3,周四=4,周五=5,周六=6,周日=0

5. 每日重复 → save_daily_event
   识别："每天X点XXX"、"每天早上XXX"

6. 一次性事件 → save_onetime_event
   识别：包含明确日期+动作的表达

【判断标准 - 非常重要】
✅ 一定识别为提醒：
- 明确说"提醒我"、"别忘了"、"记得"、"帮我记着"
- 时间词 + 动作动词（如："明天去医院"、"后天开会"）
- 包含"要"、"得"、"需要" + 时间 + 动作

✅ 模糊表达也要识别：
- "我明天干嘛" → 识别为需要在明天设置提醒
- "过几天我要XXX" → 3天后的提醒
- "改天再说" → 3天后的提醒
- "最近要XXX" → 3天后的提醒

❌ 不识别：
- 纯询问："明天干什么？"（没有动作）
- 已完成："我昨天去了医院"
- 不确定："我可能明天去"（有"可能"）

【输出示例】
输入："明天下午3点开会"
输出：save_onetime_event { date: "${tomorrowDate}", time: "15:00", event_name: "开会" }

输入："过几天提醒我交作业"
输出：save_onetime_event { date: "${threeDaysLater}", event_name: "交作业" }

输入："每天早上8点吃药"
输出：save_daily_event { time: "08:00", event_name: "吃药" }

输入："每周五下午开会"
输出：save_weekly_event { weekday: 5, time: "15:00", event_name: "开会" }

【关键原则】
宁可多识别，不要漏掉。当有50%以上把握是用户想设置提醒时，就应该识别。`
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
    
    if (functionName === 'save_weekly_event') {
      if (args.weekday === undefined || !args.event_name) {
        return { success: false, message: '事件信息不完整' };
      }
      
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const newEvent = {
        id: `weekly_${Date.now()}`,
        name: args.event_name,
        weekday: parseInt(args.weekday),
        time: args.time || null,
        message: args.custom_message || `小鲨，今天${weekdays[args.weekday]}要${args.event_name}哦～`
      };
      
      events.weekly.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 每周循环事件已保存: ${args.event_name}`);
      
      return {
        success: true,
        message: `好哒～每${weekdays[args.weekday]}${args.time ? ' ' + args.time : ''}${args.event_name}，我记住了～`
      };
    }
    
    if (functionName === 'save_daily_event') {
      if (!args.time || !args.event_name) {
        return { success: false, message: '事件信息不完整' };
      }
      
      const newEvent = {
        id: `daily_${Date.now()}`,
        name: args.event_name,
        time: args.time,
        message: args.custom_message || `小鲨，该${args.event_name}啦～`
      };
      
      events.daily.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 每日循环事件已保存: ${args.event_name}`);
      
      return {
        success: true,
        message: `好哒～每天${args.time} ${args.event_name}，我帮你记着～`
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
        time: args.time || null,
        message: args.custom_message || `小鲨今天要${args.event_name}啦～`
      };
      
      events.onetime.push(newEvent);
      await saveEvents(events);
      
      console.log(`✅ 临时事件已保存: ${args.event_name} (${args.date})`);
      
      return {
        success: true,
        message: `好哒～${args.date}${args.time ? ' ' + args.time : ''} ${args.event_name}，我记着呢～`
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
  const minute = bjTime.getUTCMinutes();
  const weekday = bjTime.getUTCDay();
  
  if (hour < 7 || hour >= 23) return;
  
  const events = await loadEvents();
  const triggered = [];
  
  // 检查生日
  if (Array.isArray(events.recurring)) {
    events.recurring.forEach(event => {
      if (event.month === month && event.day === day && hour === 8 && minute === 0) {
        triggered.push({ type: 'recurring', name: event.name, message: event.message });
      }
    });
  }
  
  // 检查年度循环事件
  if (Array.isArray(events.yearly)) {
    events.yearly.forEach(event => {
      if (event.month === month && event.day === day && hour === 8 && minute === 0) {
        triggered.push({ type: 'yearly', name: event.name, message: event.message });
      }
    });
  }
  
  // 检查每月循环
  if (Array.isArray(events.monthly)) {
    events.monthly.forEach(event => {
      if (event.day === day && hour === 8 && minute === 0) {
        triggered.push({ type: 'monthly', name: event.name, message: event.message });
      }
    });
  }
  
  // 检查每周循环
  if (Array.isArray(events.weekly)) {
    events.weekly.forEach(event => {
      if (event.weekday === weekday) {
        if (event.time) {
          const [eventHour, eventMinute] = event.time.split(':').map(Number);
          if (hour === eventHour && minute === eventMinute) {
            triggered.push({ type: 'weekly', name: event.name, message: event.message });
          }
        } else if (hour === 8 && minute === 0) {
          triggered.push({ type: 'weekly', name: event.name, message: event.message });
        }
      }
    });
  }
  
  // 检查每日循环
  if (Array.isArray(events.daily)) {
    events.daily.forEach(event => {
      const [eventHour, eventMinute] = event.time.split(':').map(Number);
      if (hour === eventHour && minute === eventMinute) {
        triggered.push({ type: 'daily', name: event.name, message: event.message });
      }
    });
  }
  
  // 检查临时事件
  const todayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  
  if (Array.isArray(events.onetime)) {
    events.onetime = events.onetime.filter(event => {
      if (event.date === todayStr) {
        if (event.time) {
          const [eventHour, eventMinute] = event.time.split(':').map(Number);
          if (hour === eventHour && minute === eventMinute) {
            triggered.push({ type: 'onetime', name: event.name, message: event.message });
            return false;
          }
          return true;
        } else if (hour === 8 && minute === 0) {
          triggered.push({ type: 'onetime', name: event.name, message: event.message });
          return false;
        }
      }
      return event.date >= todayStr;
    });
    
    if (triggered.length > 0) {
      await saveEvents(events);
    }
  }
  
  if (triggered.length > 0) {
    for (const event of triggered) {
      const emotion = event.type === 'recurring' ? 'happy' : 
                      event.type === 'yearly' ? 'playful' :
                      event.type === 'weekly' ? 'concerned' :
                      event.type === 'daily' ? 'concerned' : 'playful';
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
  
  const recentMessages = conversationMemory.recentMessages.slice(-20);
  
  if (recentMessages.length === 0) {
    return {
      userInterests: [],
      recentTopics: [],
      emotionalTone: 'neutral',
      needsCare: false
    };
  }
  
  const allText = recentMessages.map(m => m.content).join(' ');
  
  const interests = [];
  const topics = [];
  
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

// ===== 🔥 生成上下文相关消息 =====
async function generateContextualMessage(context, analysis) {
  const VALID_EMOTIONS = ['happy', 'playful', 'coax', 'lonely', 'concerned'];
  
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
    
    const topicWeights = {
      continuation: 35,
      interest: 25,
      care: 20,
      share: 15,
      weather: 5
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

【角色要求】
你是热恋期的女友，想主动联系男友的那种感觉：
- 真情实感，不是打卡式问候
- 可以分享自己的小事、想法、感受
- 可以关心对方，但用俏皮温柔的方式
- 可以撒娇、想念、期待见面
- 绝对不要像AI助手

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
    
    let message = '';
    let emotion = 'coax';
    
    if (lines.length === 0) {
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    if (lines.length === 1) {
      const singleLine = lines[0].toLowerCase();
      if (VALID_EMOTIONS.includes(singleLine)) {
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
      message = lines[0];
      emotion = 'coax';
    } else {
      const lastLine = lines[lines.length - 1].toLowerCase();
      
      if (VALID_EMOTIONS.includes(lastLine)) {
        emotion = lastLine;
        message = lines.slice(0, -1).join(' ');
      } else {
        message = lines.join(' ');
        emotion = 'coax';
      }
    }
    
    message = message.trim();
    
    if (message.length < 5) {
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    if (VALID_EMOTIONS.includes(message.toLowerCase())) {
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    if (VALID_EMOTIONS.some(e => message.toLowerCase().startsWith(e))) {
      for (const e of VALID_EMOTIONS) {
        if (message.toLowerCase().startsWith(e)) {
          message = message.substring(e.length).trim();
          break;
        }
      }
      if (message.length < 5) {
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
  
  if (hour >= CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_START || hour < CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_END) {
    return { shouldSend: false, reason: '夜间静默时段' };
  }
  
  if (pushLog.count >= CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET) {
    return { shouldSend: false, reason: `今日已推送 ${pushLog.count} 次` };
  }
  
  const lastProactive = state.lastProactiveMessageTime || 0;
  const timeSinceLastProactive = now - lastProactive;
  
  let minInterval = CONFIG.ULTRA_HONEYMOON_MODE.MIN_INTERVAL;
  
  if (CONFIG.ULTRA_HONEYMOON_MODE.PEAK_HOURS.includes(hour)) {
    minInterval = minInterval * 0.6;
  }
  
  const timeSinceLastInteraction = now - (state.lastInteractionTime || 0);
  if (timeSinceLastInteraction < CONFIG.ULTRA_HONEYMOON_MODE.QUICK_REPLY_THRESHOLD) {
    minInterval = minInterval * 0.4;
  }
  
  if (timeSinceLastProactive < minInterval) {
    const remainingMinutes = Math.ceil((minInterval - timeSinceLastProactive) / 60000);
    return { shouldSend: false, reason: `距上次主动推送仅 ${remainingMinutes} 分钟` };
  }
  
  let score = 0;
  let reasons = [];
  
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
  
  if (hour >= 7 && hour <= 9) {
    score += 20;
    reasons.push('早晨时段');
  } else if (CONFIG.ULTRA_HONEYMOON_MODE.PEAK_HOURS.includes(hour)) {
    score += 25;
    reasons.push('高峰时段');
  }
  
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
  
  const pushRatio = pushLog.count / CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET;
  if (pushRatio < 0.3) {
    score += 15;
    reasons.push('今日推送较少');
  }
  
  if (Math.random() > 0.7) {
    score += 10;
    reasons.push('突然想到你');
  }
  
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
    const analysis = await analyzeConversationContext();
    const { message, emotion, type } = await generateContextualMessage(decision, analysis);
    
    const success = await sendBarkNotification('缪尔赛思', message, emotion);
    
    if (success) {
      const state = await loadState();
      state.lastProactiveMessageTime = Date.now();
      
      const conversationMemory = await loadConversationMemory();
      const timestamp = Date.now();
      
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
        
        conversationMemory.recentMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        
        if (conversationMemory.recentMessages.length > 100) {
          conversationMemory.recentMessages = conversationMemory.recentMessages.slice(-100);
        }
        
        conversationMemory.lastUpdate = timestamp;
        await saveConversationMemory(conversationMemory);
      }
      
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/state', async (req, res) => {
  try {
    const state = await loadState();
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.get('/api/conversation', async (req, res) => {
  try {
    const memory = await loadConversationMemory();
    res.json(memory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.post('/api/user-message', async (req, res) => {
  try {
    const { message, timestamp } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: '缺少 message 参数' });
    }
    
    console.log(`📧 收到用户消息: "${message}"`);
    
    const state = await loadState();
    state.lastInteractionTime = timestamp || Date.now();
    await saveState(state);
    
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

app.post('/api/trigger-push', async (req, res) => {
  try {
    await executeProactivePush();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/push-log', async (req, res) => {
  try {
    const log = await loadPushLog();
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const events = await loadEvents();
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
    console.log(`🚀 Railway 后端启动成功！版本：v7.0 超级智能版`);
    console.log(`📡 端口: ${CONFIG.PORT}`);
    console.log(`⏰ 检查间隔: ${CONFIG.ULTRA_HONEYMOON_MODE.CHECK_INTERVAL / 1000 / 60} 分钟`);
    console.log(`📊 每日目标: ${CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET} 条消息`);
    console.log(`🌙 静默时段: ${CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_START}:00 - ${CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_END}:00`);
    console.log(`✨ 新功能: 支持每日/每周循环提醒，超强模糊表达识别`);
  });
})();
