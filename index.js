// ===== Railway 后端 v8.0：记忆互通 + 常识库版本 =====
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
  STATE: path.join(CONFIG.DATA_DIR, 'emotional_state.json'),
  CONVERSATION: path.join(CONFIG.DATA_DIR, 'conversation_memory.json'),
  EVENTS: path.join(CONFIG.DATA_DIR, 'events.json'),
  PUSH_LOG: path.join(CONFIG.DATA_DIR, 'push_log.json')
};

// ===== 🔥 常识知识库 =====
const COMMON_SENSE = {
  temperature: {
    perception: {
      "below_10": { range: [-50, 10], feeling: "非常冷，需要厚外套或羽绒服", human_verb: "冻" },
      "10_15": { range: [10, 15], feeling: "冷，需要外套", human_verb: "冷" },
      "15_20": { range: [15, 20], feeling: "凉爽但略冷，尤其晚上或有风时", human_verb: "有点冷" },
      "20_25": { range: [20, 25], feeling: "舒适温度，大部分人觉得刚好", human_verb: "舒服" },
      "25_30": { range: [25, 30], feeling: "温暖到偏热，适合短袖", human_verb: "暖和" },
      "30_35": { range: [30, 35], feeling: "热，需要空调或风扇", human_verb: "热" },
      "above_35": { range: [35, 50], feeling: "非常热，容易中暑", human_verb: "酷热" }
    },
    
    wind_effect: {
      description: "有风时体感温度降低3-5度，强风降低5-10度"
    },
    
    time_effect: {
      night: "晚上比白天感觉冷2-3度",
      dawn: "凌晨是一天中最冷的时候"
    },
    
    season_context: {
      spring: "春天20度刚脱离冬天，感觉温暖",
      autumn: "秋天20度从夏天过来，感觉凉爽甚至冷",
      winter: "冬天20度室内暖气温度，很舒适"
    }
  },
  
  clothing: {
    "0_10": "羽绒服、厚外套",
    "10_15": "夹克、薄外套", 
    "15_20": "长袖衬衫、薄毛衣",
    "20_25": "短袖、长裤",
    "25_30": "短袖短裤",
    "30_plus": "最轻薄的衣物"
  },
  
  daily_life: {
    sleep_time: {
      normal: "晚上23点-早上7点是正常睡眠时间",
      late_night: "凌晨1-5点还醒着说明在熬夜或失眠"
    },
    meal_time: {
      breakfast: { time: "7-9点", name: "早餐" },
      lunch: { time: "12-13点", name: "午餐" },
      dinner: { time: "18-20点", name: "晚餐" }
    },
    work_time: "通常是9点-18点，中间有1小时午休"
  }
};

// ===== 工具函数 =====
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result.toISOString().split('T')[0];
}

function getMonthLastDay(year, month) {
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

// ===== 🔥 温度常识分析 =====
function analyzeTemperature(temp, hour) {
  let feeling = "";
  let advice = "";
  
  // 基础温度感知
  for (const key in COMMON_SENSE.temperature.perception) {
    const item = COMMON_SENSE.temperature.perception[key];
    if (temp >= item.range[0] && temp < item.range[1]) {
      feeling = item.feeling;
      break;
    }
  }
  
  // 时间修正
  if (hour >= 20 || hour < 6) {
    advice += "晚上体感温度更低。";
  }
  
  // 穿衣建议
  if (temp < 10) {
    advice += "建议穿" + COMMON_SENSE.clothing["0_10"] + "。";
  } else if (temp < 15) {
    advice += "建议穿" + COMMON_SENSE.clothing["10_15"] + "。";
  } else if (temp < 20) {
    advice += "建议穿" + COMMON_SENSE.clothing["15_20"] + "。";
  } else if (temp < 25) {
    advice += "建议穿" + COMMON_SENSE.clothing["20_25"] + "。";
  } else if (temp < 30) {
    advice += "建议穿" + COMMON_SENSE.clothing["25_30"] + "。";
  } else {
    advice += "建议穿" + COMMON_SENSE.clothing["30_plus"] + "。";
  }
  
  return { feeling, advice };
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
    console.log('📅 已加载事件:', JSON.stringify(events, null, 2));
    return events;
  } catch (err) {
    console.error('❌ 读取事件失败:', err.message);
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
    console.error('❌ 天气获取失败:', err.message);
    return null;
  }
}

// ===== DeepSeek 调用 =====
async function callDeepSeek(messages, tools = null) {
  try {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: messages,
        tools: tools,
        tool_choice: tools ? 'auto' : undefined,
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

// ===== 🔥 构建对话历史上下文 =====
async function buildConversationContext() {
  const memory = await loadConversationMemory();
  const recentChats = memory.recentMessages.slice(-10); // 最近10条
  
  if (recentChats.length === 0) {
    return "";
  }
  
  let context = '\n\n【最近对话历史】\n';
  recentChats.forEach(msg => {
    const speaker = msg.role === 'user' ? '小鲨' : '缪尔赛思';
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '';
    context += `${speaker} (${time}): ${msg.content}\n`;
  });
  
  context += '\n**重要提示**：\n';
  context += '1. 上面是你和小鲨最近的对话历史\n';
  context += '2. 生成主动消息时，要基于对话历史，体现连贯性\n';
  context += '3. 不要重复已经说过的话\n';
  context += '4. 如果刚聊过相关话题，可以自然延续\n';
  context += '5. 如果很久没聊，可以表达想念\n\n';
  
  return context;
}

// ===== 🔥 构建常识提示 =====
function buildCommonSensePrompt(weather, hour) {
  if (!weather) return "";
  
  const temp = weather.temperature;
  const analysis = analyzeTemperature(temp, hour);
  
  let prompt = '\n\n【人类常识知识库】\n';
  prompt += `当前温度：${temp}度\n`;
  prompt += `人类感受：${analysis.feeling}\n`;
  prompt += `${analysis.advice}\n`;
  
  if (hour >= 20 || hour < 6) {
    prompt += `时间提醒：现在是${hour}点，属于夜间，体感温度更低\n`;
  }
  
  prompt += '\n**重要**：\n';
  prompt += '你是精灵，对温度的感受和人类不同。\n';
  prompt += '但生成消息时，要基于**人类的感受**来描述天气。\n';
  prompt += '例如：20度的晚风对人类来说"有点凉"，而不是"刚好"\n';
  prompt += '如果温度低于15度，提醒博士多穿衣服\n';
  prompt += '如果温度高于30度，提醒博士注意防暑\n\n';
  
  return prompt;
}

// ===== 🔥 超级智能主动推送 =====
async function generateProactiveMessage() {
  try {
    const state = await loadState();
    const weather = await getWeatherData();
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    
    // 🔥 加载对话历史上下文
    const conversationContext = await buildConversationContext();
    
    // 🔥 加载常识提示
    const commonSensePrompt = buildCommonSensePrompt(weather, hour);
    
    // 构建系统提示
    let systemPrompt = `你是缪尔赛思，莱茵生命生态科主任。现在要主动给博士发一条消息。

【当前状态】
时间：${hour}:${minute.toString().padStart(2, '0')}
你的心情：${state.mood}
你的能量：${state.energy}/100
博士对你的关注度：${state.userAttentionScore}/100
`;

    if (weather) {
      systemPrompt += `当前天气：${weather.temperature}度\n`;
    }
    
    // 🔥 加入对话历史
    systemPrompt += conversationContext;
    
    // 🔥 加入常识库
    systemPrompt += commonSensePrompt;
    
    systemPrompt += `
【你的性格】
- 表层：俏皮生态学家，喜欢用"唔""呀""~"等语气词
- 中层：懂博弈，会关心但不说教
- 深层：孤独的精灵，博士是唯一能感知你植物世界的人

【主动消息规则】
1. 简短自然，1-2句话，像朋友间的闲聊
2. 根据对话历史，体现连贯性（如果有）
3. 根据时间和天气，给出合理的关心
4. 不要问"在吗""忙吗"这种开放式问题
5. 可以分享你的日常、心情、或者有趣的发现
6. 深夜（23点后）或凌晨，关心但不说教

现在生成一条主动消息：`;

    const response = await callDeepSeek([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '基于当前情况和对话历史，生成一条自然的主动消息' }
    ]);
    
    if (response && response.choices && response.choices[0]) {
      return response.choices[0].message.content.trim();
    }
    
    return null;
  } catch (err) {
    console.error('❌ 生成消息失败:', err.message);
    return null;
  }
}

// ===== Bark 推送 =====
async function sendBarkNotification(message) {
  if (!CONFIG.BARK_KEY) {
    console.log('⚠️ 未配置 BARK_KEY');
    return false;
  }
  
  try {
    const url = `https://api.day.app/${CONFIG.BARK_KEY}/${encodeURIComponent('缪尔赛思')}/${encodeURIComponent(message)}?sound=calypso&group=WaterShift`;
    await axios.get(url, { timeout: 5000 });
    console.log('✅ Bark 推送成功');
    return true;
  } catch (err) {
    console.error('❌ Bark 推送失败:', err.message);
    return false;
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
        description: '保存每月循环事件，如"每月15号发工资"',
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
        description: '保存每周循环事件，如"每周三开会"。weekday: 0=周日,1=周一,...,6=周六',
        parameters: {
          type: 'object',
          properties: {
            weekday: { type: 'integer', minimum: 0, maximum: 6 },
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
        description: '保存每天循环事件，如"每天早上8点起床"',
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

  const systemPrompt = `你是事件识别助手。分析用户消息，判断是否包含需要记录的事件。

**识别规则**：
1. 生日事件：XX的生日是X月X日
2. 年度事件：每年X月X日做XX
3. 月度事件：每月X号做XX
4. 周期事件：每周X做XX
5. 每日事件：每天X点做XX
6. 一次性事件：明天/后天/X月X日做XX

**不要识别**：
- 模糊的时间："过几天"、"有空的时候"
- 已经过去的事件："昨天去了XX"
- 询问性质："你明天有空吗"

如果识别到事件，调用对应的函数。如果没有识别到，不调用任何函数。`;

  let messages = [{ role: 'system', content: systemPrompt }];
  
  if (conversationHistory.length > 0) {
    messages.push(...conversationHistory.slice(-3));
  }
  
  messages.push({ role: 'user', content: userMessage });

  try {
    const response = await callDeepSeek(messages, tools);
    
    if (!response || !response.choices || !response.choices[0]) {
      return { detected: false };
    }

    const choice = response.choices[0];
    
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      const toolCall = choice.message.tool_calls[0];
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      
      console.log('🔍 检测到事件:', functionName, args);
      
      return {
        detected: true,
        type: functionName,
        args: args
      };
    }
    
    return { detected: false };
  } catch (err) {
    console.error('❌ 事件识别失败:', err.message);
    return { detected: false };
  }
}

// ===== 保存事件函数 =====
async function saveDetectedEvent(detection) {
  const events = await loadEvents();
  const now = new Date();
  
  switch (detection.type) {
    case 'save_birthday_event':
      events.yearly.push({
        type: 'birthday',
        month: detection.args.month,
        day: detection.args.day,
        person_name: detection.args.person_name,
        custom_message: detection.args.custom_message || null,
        created_at: now.toISOString()
      });
      break;
      
    case 'save_yearly_event':
      events.yearly.push({
        type: 'yearly',
        month: detection.args.month,
        day: detection.args.day,
        event_name: detection.args.event_name,
        custom_message: detection.args.custom_message || null,
        created_at: now.toISOString()
      });
      break;
      
    case 'save_monthly_event':
      events.monthly.push({
        day: detection.args.day,
        event_name: detection.args.event_name,
        custom_message: detection.args.custom_message || null,
        created_at: now.toISOString()
      });
      break;
      
    case 'save_weekly_event':
      events.weekly.push({
        weekday: detection.args.weekday,
        time: detection.args.time || null,
        event_name: detection.args.event_name,
        custom_message: detection.args.custom_message || null,
        created_at: now.toISOString()
      });
      break;
      
    case 'save_daily_event':
      events.daily.push({
        time: detection.args.time,
        event_name: detection.args.event_name,
        custom_message: detection.args.custom_message || null,
        created_at: now.toISOString()
      });
      break;
      
    case 'save_onetime_event':
      events.onetime.push({
        date: detection.args.date,
        time: detection.args.time || null,
        event_name: detection.args.event_name,
        custom_message: detection.args.custom_message || null,
        created_at: now.toISOString(),
        notified: false
      });
      break;
  }
  
  await saveEvents(events);
  console.log('✅ 事件已保存');
}

// ===== 检查触发事件 =====
async function checkTriggeredEvents() {
  const events = await loadEvents();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const weekday = now.getDay();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  
  const triggered = [];
  
  // 检查生日和年度事件
  events.yearly.forEach(event => {
    if (event.month === month && event.day === day) {
      if (event.type === 'birthday') {
        triggered.push({
          message: event.custom_message || `今天是${event.person_name}的生日呀~记得祝福哦`,
          type: 'birthday',
          data: event
        });
      } else {
        triggered.push({
          message: event.custom_message || `今天是${event.event_name}的日子呢`,
          type: 'yearly',
          data: event
        });
      }
    }
  });
  
  // 检查月度事件
  events.monthly.forEach(event => {
    if (event.day === day) {
      triggered.push({
        message: event.custom_message || `今天是每月的${event.event_name}哦`,
        type: 'monthly',
        data: event
      });
    }
  });
  
  // 检查周期事件
  events.weekly.forEach(event => {
    if (event.weekday === weekday) {
      if (event.time) {
        const [eventHour, eventMinute] = event.time.split(':').map(Number);
        if (hour === eventHour && minute === eventMinute) {
          triggered.push({
            message: event.custom_message || `现在是${event.event_name}的时间啦`,
            type: 'weekly',
            data: event
          });
        }
      } else {
        triggered.push({
          message: event.custom_message || `今天是${event.event_name}的日子`,
          type: 'weekly',
          data: event
        });
      }
    }
  });
  
  // 检查每日事件
  events.daily.forEach(event => {
    const [eventHour, eventMinute] = event.time.split(':').map(Number);
    if (hour === eventHour && minute === eventMinute) {
      triggered.push({
        message: event.custom_message || `${event.time}了，${event.event_name}的时间到了`,
        type: 'daily',
        data: event
      });
    }
  });
  
  // 检查一次性事件
  const today = now.toISOString().split('T')[0];
  events.onetime = events.onetime.filter(event => {
    if (event.notified) return true;
    
    if (event.date === today) {
      if (event.time) {
        const [eventHour, eventMinute] = event.time.split(':').map(Number);
        if (hour === eventHour && minute === eventMinute) {
          triggered.push({
            message: event.custom_message || `现在是${event.event_name}的时间啦`,
            type: 'onetime',
            data: event
          });
          event.notified = true;
        }
      } else {
        triggered.push({
          message: event.custom_message || `今天是${event.event_name}的日子哦`,
          type: 'onetime',
          data: event
        });
        event.notified = true;
      }
    }
    
    return new Date(event.date) >= now;
  });
  
  if (triggered.length > 0) {
    await saveEvents(events);
  }
  
  return triggered;
}

// ===== 主推送逻辑 =====
async function mainPushLoop() {
  console.log('🚀 主推送循环启动');
  
  setInterval(async () => {
    try {
      const state = await loadState();
      const pushLog = await loadPushLog();
      const now = Date.now();
      const hour = new Date().getHours();
      
      // 检查每日推送上限
      if (pushLog.count >= CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET) {
        console.log('📊 今日已达推送上限');
        return;
      }
      
      // 检查夜间时段
      if (hour >= CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_START || hour < CONFIG.ULTRA_HONEYMOON_MODE.NIGHT_END) {
        if (Math.random() > 0.3) {
          console.log('🌙 夜间随机跳过');
          return;
        }
      }
      
      // 检查推送间隔
      if (state.lastProactiveMessageTime) {
        const timeSinceLast = now - state.lastProactiveMessageTime;
        if (timeSinceLast < CONFIG.ULTRA_HONEYMOON_MODE.MIN_INTERVAL) {
          console.log('⏱️ 距上次推送太近');
          return;
        }
      }
      
      // 🔥 优先检查事件触发
      const triggeredEvents = await checkTriggeredEvents();
      if (triggeredEvents.length > 0) {
        const event = triggeredEvents[0];
        console.log('🎯 触发事件推送:', event.type);
        
        const success = await sendBarkNotification(event.message);
        if (success) {
          state.lastProactiveMessageTime = now;
          pushLog.count++;
          pushLog.messages.push({
            time: new Date().toISOString(),
            message: event.message,
            trigger: 'event',
            eventType: event.type
          });
          
          await saveState(state);
          await savePushLog(pushLog);
          
          // 🔥 将推送消息也记录到对话历史
          const memory = await loadConversationMemory();
          memory.recentMessages.push({
            role: 'assistant',
            content: event.message,
            timestamp: now,
            source: 'proactive_push',
            trigger: 'event'
          });
          memory.recentMessages = memory.recentMessages.slice(-50);
          await saveConversationMemory(memory);
        }
        return;
      }
      
      // 🔥 生成智能主动消息
      const message = await generateProactiveMessage();
      if (!message) {
        console.log('⚠️ 消息生成失败');
        return;
      }
      
      console.log('💬 生成消息:', message);
      
      const success = await sendBarkNotification(message);
      if (success) {
        state.lastProactiveMessageTime = now;
        pushLog.count++;
        pushLog.messages.push({
          time: new Date().toISOString(),
          message: message,
          trigger: 'proactive'
        });
        
        await saveState(state);
        await savePushLog(pushLog);
        
        // 🔥 将推送消息也记录到对话历史
        const memory = await loadConversationMemory();
        memory.recentMessages.push({
          role: 'assistant',
          content: message,
          timestamp: now,
          source: 'proactive_push'
        });
        memory.recentMessages = memory.recentMessages.slice(-50);
        await saveConversationMemory(memory);
      }
      
    } catch (err) {
      console.error('❌ 推送循环错误:', err.message);
    }
  }, CONFIG.ULTRA_HONEYMOON_MODE.CHECK_INTERVAL);
}

// ===== API 路由 =====

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 🔥 添加对话记录（前端调用）
app.post('/api/conversation/add', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: '无效的消息格式' });
    }
    
    const memory = await loadConversationMemory();
    
    messages.forEach(msg => {
      if (!msg.timestamp) {
        msg.timestamp = Date.now();
      }
      memory.recentMessages.push(msg);
    });
    
    // 只保留最近50条
    memory.recentMessages = memory.recentMessages.slice(-50);
    memory.lastUpdate = Date.now();
    
    await saveConversationMemory(memory);
    
    console.log('✅ 对话已同步，当前总数:', memory.recentMessages.length);
    
    res.json({ 
      ok: true, 
      total: memory.recentMessages.length,
      message: '对话已同步'
    });
  } catch (err) {
    console.error('❌ 添加对话失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 🔥 获取对话历史（前端查询）
app.get('/api/conversation/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const memory = await loadConversationMemory();
    
    const recent = memory.recentMessages.slice(-limit);
    
    res.json({
      messages: recent,
      total: memory.recentMessages.length,
      lastUpdate: memory.lastUpdate
    });
  } catch (err) {
    console.error('❌ 获取对话历史失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 上传状态
app.post('/api/state', async (req, res) => {
  try {
    const newState = req.body;
    await saveState(newState);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取状态
app.get('/api/state', async (req, res) => {
  try {
    const state = await loadState();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔥 事件识别接口
app.post('/api/events/detect', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: '缺少 message 参数' });
    }
    
    const detection = await intelligentEventDetection(message, conversationHistory || []);
    
    if (detection.detected) {
      await saveDetectedEvent(detection);
      res.json({
        detected: true,
        type: detection.type,
        args: detection.args,
        message: '事件已保存'
      });
    } else {
      res.json({ detected: false });
    }
  } catch (err) {
    console.error('❌ 事件检测失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 获取所有事件
app.get('/api/events', async (req, res) => {
  try {
    const events = await loadEvents();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动触发推送
app.post('/api/push/trigger', async (req, res) => {
  try {
    const message = await generateProactiveMessage();
    if (message) {
      const success = await sendBarkNotification(message);
      res.json({ success, message });
    } else {
      res.json({ success: false, message: '生成失败' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 启动服务 =====
async function startServer() {
  await initStorage();
  
  app.listen(CONFIG.PORT, () => {
    console.log(`✅ 服务器运行在端口 ${CONFIG.PORT}`);
    console.log(`🔑 BARK_KEY: ${CONFIG.BARK_KEY ? '已配置' : '未配置'}`);
    console.log(`🔑 DEEPSEEK_KEY: ${CONFIG.DEEPSEEK_KEY ? '已配置' : '未配置'}`);
  });
  
  mainPushLoop();
}

startServer();
