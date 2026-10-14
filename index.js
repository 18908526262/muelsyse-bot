// ===== Railway 后端 v8.2：中国时区修正 + 常识库 + 称呼「小鲨」 =====
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
try { require('dotenv').config(); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

const app = express();
app.use(express.json({ limit: '2mb' }));

// ============================================================
// 🔥 时区工具（清单第 0 条）
// Railway 容器默认跑在 UTC：中国上午 11:51 时服务器是 03:51，
// 正好掉进「夜间」区间 —— 这就是「怎么还没睡」的元凶。
// 这两个函数保证无论服务器在哪个时区，取到的都是中国时间。
// ============================================================
function getChinaTime() {
  const now = new Date();
  try {
    // 把当前时刻按上海时区格式化成字符串，再解析回本地时间对象，
    // 这样 getHours() / getDate() 拿到的就是中国时间。
    const t = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    if (!isNaN(t.getTime())) return t;
  } catch (e) {
    // 某些精简镜像没有完整 ICU，走下面的兜底
  }
  // 兜底：按 UTC 字段手动 +8 小时重建（中国全年没有夏令时）
  const s = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return new Date(
    s.getUTCFullYear(),
    s.getUTCMonth(),
    s.getUTCDate(),
    s.getUTCHours(),
    s.getUTCMinutes(),
    s.getUTCSeconds()
  );
}

function getChinaHour() {
  return getChinaTime().getHours();
}

// 🔥 中国日期字符串 YYYY-MM-DD（跨天判断一律用它，不要用 toISOString）
function getChinaDateStr(d = getChinaTime()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 🔥 时间戳按中国时间显示（给对话历史用）
function getChinaStamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  try {
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch (e) {
    const s = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${s.getUTCFullYear()}/${p(s.getUTCMonth() + 1)}/${p(s.getUTCDate())} ` +
           `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}:${p(s.getUTCSeconds())}`;
  }
}

// ===== 配置 =====
const CONFIG = {
  BARK_KEY: process.env.BARK_KEY || '',
  DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',

  PORT: process.env.PORT || 8080,
  DATA_DIR: path.join(__dirname, 'data'),

  ULTRA_HONEYMOON_MODE: {
    CHECK_INTERVAL: 3 * 60 * 1000,

    MIN_INTERVAL: Math.max(30, Number(process.env.PUSH_MIN_MINUTES) || 120) * 60000,
    MAX_INTERVAL: Math.max(60, Number(process.env.PUSH_MAX_MINUTES) || 300) * 60000,
    DAILY_TARGET: Number.isFinite(Number(process.env.PUSH_DAILY_LIMIT ?? 4))
      ? Math.max(0, Math.min(12, Number(process.env.PUSH_DAILY_LIMIT ?? 4))) : 4,
    NIGHT_START: 23,   // 以下均按中国时间
    NIGHT_END: 7,
    PEAK_HOURS: [12, 18, 21],
    QUICK_REPLY_THRESHOLD: 10 * 60 * 1000
  }
};

// 🔥 所在城市（默认绍兴；回遵义改环境变量即可，不用动代码）
//   绍兴 30.0023, 120.5810 ｜ 遵义 27.7257, 106.9272
const CITY = {
  name: process.env.CITY_NAME || '绍兴',
  latitude: Number(process.env.CITY_LAT || 30.0023),
  longitude: Number(process.env.CITY_LON || 120.5810),
  timezone: 'Asia/Shanghai'
};

const FILES = {
  STATE: path.join(CONFIG.DATA_DIR, 'emotional_state.json'),
  CONVERSATION: path.join(CONFIG.DATA_DIR, 'conversation_memory.json'),
  EVENTS: path.join(CONFIG.DATA_DIR, 'events.json'),
  PUSH_LOG: path.join(CONFIG.DATA_DIR, 'push_log.json'),
  HABITS: path.join(CONFIG.DATA_DIR, 'habit_archive.json')
};

// ===== 🔥 常识知识库 =====
const COMMON_SENSE = {
  temperature: {
    perception: {
      below_10: { range: [-50, 10], feeling: '非常冷，需要厚外套或羽绒服', human_verb: '冻' },
      '10_15': { range: [10, 15], feeling: '冷，需要外套', human_verb: '冷' },
      '15_20': { range: [15, 20], feeling: '凉爽但略冷，尤其晚上或有风时', human_verb: '有点冷' },
      '20_25': { range: [20, 25], feeling: '舒适温度，大部分人觉得刚好', human_verb: '舒服' },
      '25_30': { range: [25, 30], feeling: '温暖到偏热，适合短袖', human_verb: '暖和' },
      '30_35': { range: [30, 35], feeling: '热，需要空调或风扇', human_verb: '热' },
      above_35: { range: [35, 50], feeling: '非常热，容易中暑', human_verb: '酷热' }
    },
    wind_effect: { description: '有风时体感温度降低3-5度，强风降低5-10度' },
    time_effect: {
      night: '晚上比白天感觉冷2-3度',
      dawn: '凌晨是一天中最冷的时候'
    },
    season_context: {
      spring: '春天20度刚脱离冬天，感觉温暖',
      autumn: '秋天20度从夏天过来，感觉凉爽甚至冷',
      winter: '冬天20度室内暖气温度，很舒适'
    }
  },

  clothing: {
    '0_10': '羽绒服、厚外套',
    '10_15': '夹克、薄外套',
    '15_20': '长袖衬衫、薄毛衣',
    '20_25': '短袖、长裤',
    '25_30': '短袖短裤',
    '30_plus': '最轻薄的衣物'
  },

  daily_life: {
    sleep_time: {
      normal: '晚上23点-早上7点是正常睡眠时间',
      late_night: '凌晨1-5点还醒着说明在熬夜或失眠'
    },
    meal_time: {
      breakfast: { time: '7-9点', name: '早餐' },
      lunch: { time: '12-13点', name: '午餐' },
      dinner: { time: '18-20点', name: '晚餐' }
    },
    work_time: '通常是9点-18点，中间有1小时午休'
  }
};

// WMO 天气代码 → 中文
const WMO_CN = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '中阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴冰雹'
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

// ===== 🔥 温度常识分析（hour 传中国小时）=====
function analyzeTemperature(temp, hour) {
  let feeling = '';
  let advice = '';

  // 基础温度感知（清单第 6 条：边界值用 <=）
  for (const key in COMMON_SENSE.temperature.perception) {
    const item = COMMON_SENSE.temperature.perception[key];
    if (temp >= item.range[0] && temp <= item.range[1]) {
      feeling = item.feeling;
      break;
    }
  }
  if (!feeling) feeling = '温度数据异常，按常规季节判断';

  // 时间修正
  if (hour >= 20 || hour < 6) {
    advice += '晚上体感温度更低。';
  }

  // 穿衣建议
  if (temp < 10) {
    advice += '建议穿' + COMMON_SENSE.clothing['0_10'] + '。';
  } else if (temp < 15) {
    advice += '建议穿' + COMMON_SENSE.clothing['10_15'] + '。';
  } else if (temp < 20) {
    advice += '建议穿' + COMMON_SENSE.clothing['15_20'] + '。';
  } else if (temp < 25) {
    advice += '建议穿' + COMMON_SENSE.clothing['20_25'] + '。';
  } else if (temp < 30) {
    advice += '建议穿' + COMMON_SENSE.clothing['25_30'] + '。';
  } else {
    advice += '建议穿' + COMMON_SENSE.clothing['30_plus'] + '。';
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
        today: getChinaDateStr(),   // 🔥 用中国日期
        count: 0,
        messages: []
      }, null, 2));
    }

    try { await fs.access(FILES.HABITS); }
    catch { await saveHabitArchive({version: 1, observations: [], archive: []}); }
    console.log('✅ 存储初始化完成');
  } catch (err) {
    console.error('❌ 存储初始化失败:', err.message);
    throw err;
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
    if (err.code !== 'ENOENT') throw err;
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
  await v10AtomicWrite(FILES.STATE, state);
}

async function loadConversationMemory() {
  try {
    const data = await fs.readFile(FILES.CONVERSATION, 'utf-8');
    return v10MemoryDefaults(JSON.parse(data));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return v10MemoryDefaults({
      version: 1,
      recentMessages: [],
      lastUpdate: Date.now()
    });
  }
}

async function saveConversationMemory(memory) {
  await v10AtomicWrite(FILES.CONVERSATION, memory);
}

async function loadEvents() {
  try {
    const data = await fs.readFile(FILES.EVENTS, 'utf-8');
    const events = JSON.parse(data);
    return v10PartitionEvents(events);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.error('❌ 读取事件失败:', err.message);
    return v10PartitionEvents({
      recurring: [],
      yearly: [],
      monthly: [],
      weekly: [],
      daily: [],
      onetime: []
    });
  }
}

async function saveEvents(events) {
  await v10AtomicWrite(FILES.EVENTS, v10PartitionEvents(events));
}

async function loadPushLog() {
  try {
    const data = await fs.readFile(FILES.PUSH_LOG, 'utf-8');
    const log = JSON.parse(data);

    const today = getChinaDateStr();   // 🔥 用中国日期判断跨天
    if (log.today !== today) {
      log.today = today;
      log.count = 0;
      log.messages = (log.messages || []).filter(item => v10Timestamp(item.time) >= Date.now() - V10_RETENTION);
      await savePushLog(log);
    }

    return log;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return {
      today: getChinaDateStr(),
      count: 0,
      messages: []
    };
  }
}

async function savePushLog(log) {
  await v10AtomicWrite(FILES.PUSH_LOG, log);
}

// Raw observations expire after 30 days; only repeated behavior across distinct days is archived.
async function loadHabitArchive() {
  try {
    const value = JSON.parse(await fs.readFile(FILES.HABITS, 'utf-8'));
    return {version: 1, observations: Array.isArray(value.observations) ? value.observations : [],
      archive: Array.isArray(value.archive) ? value.archive : []};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {version: 1, observations: [], archive: []};
  }
}
async function saveHabitArchive(value) {
  await v10AtomicWrite(FILES.HABITS, value);
}

async function v10ObserveHabits(message, messageKey, timestamp = Date.now()) {
  if (typeof message !== 'string' || /(提醒|叫我|临时|暂时|就这次|只这次|明天|后天|打算|准备|想要)/.test(message)) return;
  const actions = [['跑步', /跑步|晨跑|夜跑/], ['散步', /散步/], ['读书', /读书|阅读/],
    ['健身', /健身|锻炼/], ['喝咖啡', /喝咖啡|喝了.*咖啡/], ['喝茶', /喝茶/], ['养花', /浇花|养花/]];
  const matched = actions.filter(([label, pattern]) => pattern.test(message) &&
    !new RegExp('(?:不|没|停止|讨厌)(?:再|有|去|怎么|想|喜欢)?(?:' + pattern.source + ')').test(message));
  if (!matched.length) return;
  const store = await loadHabitArchive(), now = Date.now(), cutoff = now - 30 * 86400000;
  store.observations = store.observations.filter(item => item.timestamp >= cutoff);
  for (const [label] of matched) {
    const key = v10Fingerprint([messageKey, label]);
    if (store.observations.some(item => item.key === key)) continue;
    store.observations.push({key, label, timestamp, date: v10ScheduleClock(timestamp).date, lifetime: 'short-term'});
    const evidence = store.observations.filter(item => item.label === label);
    const days = new Set(evidence.map(item => item.date)).size;
    let habit = store.archive.find(item => item.label === label);
    if (!habit && days >= 3) {
      habit = {id: 'habit:' + v10Fingerprint(label), label, type: 'habit', lifetime: 'long-term',
        content: '小鲨经常' + label, firstSeen: Math.min(...evidence.map(item => item.timestamp)), totalObservations: evidence.length};
      store.archive.push(habit);
    } else if (habit) habit.totalObservations++;
    if (habit) Object.assign(habit, {recentCount: evidence.length, observedDays: days, lastSeen: timestamp, updatedAt: now});
  }
  await saveHabitArchive(store);
}

// ===== 获取天气数据（按 CITY 配置）=====
function v10ValidateLocation(value) {
  if (!value || typeof value !== 'object') throw new Error('缺少定位数据');
  const latitude = value.latitude, longitude = value.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude + longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('无效经纬度');
  const timezone = typeof value.timezone === 'string' && value.timezone ? value.timezone : CITY.timezone;
  new Intl.DateTimeFormat('en', {timeZone: timezone}).format();
  return {latitude, longitude, timezone, name: String(value.name || '当前位置').slice(0, 80), updatedAt: Date.now(), weatherEnabled: value.weatherEnabled === true};
}
function v10ResolveLocation(state = {}) {
  if (state.location) {
    try {
      return {...v10ValidateLocation(state.location), updatedAt: state.location.updatedAt, source: 'gps'};
    } catch (error) {
      console.warn('定位数据无效，使用 CITY 坐标:', error.message);
    }
  }
  return {...v10ValidateLocation(CITY), source: 'configured-city'};
}
function v10WeatherAdvice(current, daily) {
  const low = daily.temperature_2m_min?.[0] ?? current.temperature_2m, high = daily.temperature_2m_max?.[0] ?? low;
  const rain = daily.precipitation_probability_max?.[0], uv = daily.uv_index_max?.[0];
  return `${low}～${high}℃；${low < 10 ? '厚外套' : low < 20 ? '薄外套，可分层穿衣' : '透气短袖'}；${uv >= 3 ? '涂防晒、戴帽遮阳' : '紫外线较低，户外仍注意遮阳'}；${rain == null ? '降雨信息缺失，出门检查是否带伞' : rain >= 40 ? '记得带伞' : '降雨概率较低，可备折叠伞'}。`;
}
const v10WeatherCache = new Map();
async function getWeatherData(location = null) {
  try {
    location = location || v10ResolveLocation(await loadState());
    const cacheKey = [location.latitude, location.longitude, location.timezone, location.name].join(':');
    const cached = v10WeatherCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60000) return cached.value;
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: location.latitude, longitude: location.longitude,
        current: 'temperature_2m,weather_code,apparent_temperature,relative_humidity_2m,wind_speed_10m',
        daily: 'temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max,sunrise,sunset',
        timezone: location.timezone || CITY.timezone, forecast_days: 2
      },
      timeout: 8000
    });

    const cur = response.data.current;
    if (!cur || !response.data.daily || !Number.isFinite(cur.temperature_2m)) throw new Error('天气数据不完整');
    const value = {
      temperature: cur.temperature_2m,
      apparentTemperature: cur.apparent_temperature,
      weatherCode: cur.weather_code,
      desc: WMO_CN[cur.weather_code] || '未知',
      city: location.name, current: cur, daily: response.data.daily, timezone: response.data.timezone,
      latitude: location.latitude, longitude: location.longitude, fetchedAt: new Date().toISOString(),
      advice: v10WeatherAdvice(cur, response.data.daily)
    };
    if (v10WeatherCache.size > 50) v10WeatherCache.clear();
    v10WeatherCache.set(cacheKey, {at: Date.now(), value});
    return value;
  } catch (err) {
    console.error('❌ 天气获取失败:', err.message);
    return null;
  }
}

// ===== DeepSeek 调用 =====
async function callDeepSeek(messages, tools = null, json = false) {
  if (!CONFIG.DEEPSEEK_KEY) return null;
  try {
    const response = await axios.post('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-flash', messages, tools: tools || undefined,
      tool_choice: tools ? 'auto' : undefined,
      response_format: json ? {type: 'json_object'} : undefined,
      thinking: {type: 'disabled'}, temperature: json ? 0.2 : 0.8,
      max_tokens: json ? 1000 : 300
    }, {headers: {Authorization: 'Bearer ' + CONFIG.DEEPSEEK_KEY, 'Content-Type': 'application/json'}, timeout: 20000});
    return response.data;
  } catch (error) {
    console.error('DeepSeek调用暂不可用:', error.response?.status || error.code || 'network');
    return null;
  }
}

// ===== 🔥 构建对话历史上下文 =====
async function buildConversationContext() {
  const memory = await loadConversationMemory();
  const recentChats = memory.recentMessages.slice(-10); // 最近10条

  if (recentChats.length === 0) {
    return '';
  }

  let context = '\n\n【最近对话历史】\n';
  recentChats.forEach(msg => {
    const speaker = msg.role === 'user' ? '小鲨' : '缪尔赛思';
    // 🔥 时间按中国时间显示
    const time = msg.timestamp ? getChinaStamp(msg.timestamp) : '';
    context += `${speaker} (${time}): ${msg.content}\n`;
  });

    context += '\n**重要提示**：\n';
  context += '1. 上面是你和小鲨最近的对话历史（时间均为中国时间）\n';
  context += '2. 生成主动消息时，要基于对话历史，体现连贯性\n';
  context += '3. 不要重复已经说过的话\n';
  context += '4. 如果刚聊过相关话题，可以自然延续\n';
  context += '5. 如果很久没聊，可以表达想念\n';
  context += '6. 🔥【关键】仔细查看最近一条对话的内容和时间，不要问已经回答过的问题\n';
  context += '7. 🔥 如果小鲨刚说完某件事（如"洗完澡了"），不要再重复问相关问题\n\n';


  return context;
}

// ===== 🔥 构建常识提示 =====
function buildCommonSensePrompt(weather, hour) {
  if (!weather) return '';

  const temp = weather.temperature;
  const analysis = analyzeTemperature(temp, hour);

  let prompt = '\n\n【人类常识知识库】\n';
  prompt += `地点：${weather.city}\n`;
  prompt += `当前温度：${temp}度（体感 ${weather.apparentTemperature}度，${weather.desc}）\n`;
  prompt += `人类感受：${analysis.feeling}\n`;
  prompt += `${analysis.advice}\n`;

  if (hour >= 20 || hour < 6) {
    prompt += `时间提醒：现在是${hour}点（中国时间），属于夜间，体感温度更低\n`;
  }

  prompt += '\n**重要**：\n';
  prompt += '你是精灵，对温度的感受和人类不同。\n';
  prompt += '但生成消息时，要基于**人类的感受**来描述天气。\n';
  prompt += '例如：20度的晚风对人类来说"有点凉"，而不是"刚好"\n';
  prompt += '如果温度低于15度，提醒小鲨多穿衣服\n';   // 🔥 博士 → 小鲨
  prompt += '如果温度高于30度，提醒小鲨注意防暑\n\n'; // 🔥 博士 → 小鲨

  return prompt;
}

// ===== 🔥 超级智能主动推送 =====
async function generateProactiveMessage() {
  return v10GenerateNaturalMessage();
}

// ===== Bark 推送 =====
async function sendBarkNotification(message) {
  if (!CONFIG.BARK_KEY) return false;
  try {
    const response = await axios.post('https://api.day.app/push', {
      device_key: CONFIG.BARK_KEY, title: '缪尔赛思', body: message,
      sound: 'calypso', group: 'WaterShift'
    }, {timeout: 5000});
    return response.data?.code === 200;
  } catch (error) {
    if (error.response) return false;
    // A network timeout may follow a successful delivery. Do not retry automatically.
    throw new Error('DELIVERY_UNCERTAIN');
  }
}

// ===== 🔥 智能情绪识别系统 =====
async function intelligentEmotionDetection(userMessage, timeInfo = null) {
  const now = timeInfo ? new Date(timeInfo.currentTime) : getChinaTime();
  const hour = timeInfo ? timeInfo.currentHour : now.getHours();
  const minute = timeInfo ? timeInfo.currentMinute : now.getMinutes();
  const dateStr = getChinaDateStr(now);
  const timeContext = `${hour}:${String(minute).padStart(2, '0')}`;
  
  const systemPrompt = `你是一个专业的情绪识别助手。分析用户的消息,识别情绪状态和需要关心的事件。

【当前精确时间】
现在是北京时间:${timeContext}
今天日期:${dateStr}

【识别任务】
1. **情绪识别**:判断用户的情绪状态(开心/难过/疲惫/兴奋/焦虑/平静)
2. **情绪强度**:评估情绪强度(1-10,10为最强)
3. **关键事件**:提取用户提到的重要事件
4. **需要关怀**:判断是否需要在之后给予关心或庆祝

【输出格式(必须JSON)】
{
  "emotion": "开心/难过/疲惫/兴奋/焦虑/平静/期待",
  "intensity": 7,
  "event": "描述事件,如果没有特别事件则为null",
  "needCare": true/false,
  "careType": "安慰/庆祝/鼓励/陪伴/null",
  "careTime": "当天晚上/第二天/事件当天/null",
  "reason": "为什么需要关心的原因"
}

【示例】
用户:"我一会儿晚上8点多才到杭州...一个人赶车还要转车...好累哦"
输出:{"emotion":"疲惫","intensity":7,"event":"独自赶车到杭州,需要转车","needCare":true,"careType":"安慰","careTime":"当天晚上","reason":"长途赶车很辛苦,到达后需要安慰"}

用户:"好诶我抢到票了!等明年5月1日我要去看音律联觉的"
输出:{"emotion":"兴奋","intensity":9,"event":"抢到音律联觉演出票,5月1日","needCare":true,"careType":"庆祝","careTime":"事件当天","reason":"成功抢到喜欢的演出票,5月1日当天可以祝玩得开心"}

现在分析这条消息:`;

  try {
    const response = await callDeepSeek([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ]);

    if (!response || !response.choices || !response.choices[0]) {
      return { detected: false };
    }

    const text = response.choices[0].message.content.trim();
    console.log('🎭 情绪识别结果:', text);

    // 提取JSON
    let jsonText = text;
    if (text.includes('```')) {
      const match = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (match) jsonText = match[1];
    }

    const result = JSON.parse(jsonText);
    
    if (result.emotion && result.intensity) {
      return {
        detected: true,
        emotion: result.emotion,
        intensity: result.intensity,
        event: result.event,
        needCare: result.needCare || false,
        careType: result.careType,
        careTime: result.careTime,
        reason: result.reason
      };
    }

    return { detected: false };
  } catch (err) {
    console.error('❌ 情绪识别失败:', err.message);
    return { detected: false };
  }
}

// ===== 保存情绪记录 =====
async function saveEmotionRecord(emotion) {
  const state = await loadState();
  
  if (!state.emotionHistory) {
    state.emotionHistory = [];
  }
  
  // 添加时间戳
  emotion.timestamp = Date.now();
  emotion.dateStr = getChinaDateStr();
  
  state.emotionHistory.push(emotion);
  
  // 只保留最近30条
  if (state.emotionHistory.length > 30) {
    state.emotionHistory = state.emotionHistory.slice(-30);
  }
  
  // 更新当前情绪状态
  state.mood = emotion.emotion;
  state.lastEmotionIntensity = emotion.intensity;
  
  await saveState(state);
  console.log('✅ 情绪记录已保存');
}

// ===== 🔥 超级智能事件识别 =====
async function intelligentEventDetection(userMessage, conversationHistory = [], timeInfo = null) {
  const relativeReminder = v10DetectRelativeReminder(userMessage, timeInfo);
  if (relativeReminder) return relativeReminder;
    const tools = [
    {
      type: 'function',
      function: {
        name: 'save_onetime_important_event',
        description: '保存重要的一次性事件，如考试、面试、旅行等',
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
    },
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

    // 🔥 获取当前中国时间
  const now = timeInfo ? new Date(timeInfo.currentTime) : getChinaTime();
  const hour = timeInfo ? timeInfo.currentHour : now.getHours();
  const minute = timeInfo ? timeInfo.currentMinute : now.getMinutes();
  const dateStr = getChinaDateStr(now);
  
  const timeContext = `${hour}:${String(minute).padStart(2, '0')}`;
  const period = hour < 6 ? '深夜' : hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上';

    const systemPrompt = `你是事件识别助手。分析用户消息,判断是否包含需要记录的事件。

【当前精确时间(非常重要!)】
现在是北京时间:${timeContext}(${period})
今天日期:${dateStr}

【时间理解规则(关键!)】
1. "一会儿12:30" = 如果现在是12:19,那就是今天12:30(11分钟后)
2. "一会儿叫我" = 当前时间+30分钟
3. "5分钟后叫我" = 当前时间+5分钟
4. "晚上8点叫我" = 如果现在是下午,就是今天晚上8点;如果已经过了8点,就是明天晚上8点
5. "明天9点" = ${dateStr}的第二天
6. "下午3点" = 如果现在是上午,就是今天下午;如果现在是晚上,就是明天下午
7. **永远基于当前时间${timeContext}来推理,不要猜测!**

【🔥🔥🔥 特别识别:"叫我"/"提醒我"类需求 - 这是最重要的！】
只要用户说了"提醒我"、"叫我"、"记得提醒"、"别忘了提醒"等词，就必须识别为事件！

示例1：用户说"一会儿12:30提醒我拿纸巾"
→ 当前时间12:19，那么12:30就是今天12:30
→ 调用save_onetime_event(date: "${dateStr}", time: "12:30", event_name: "拿纸巾")

示例2：用户说"提醒我一会儿下载文件"
→ 没有明确时间，默认30分钟后
→ 调用save_onetime_event(date: "计算后的日期", time: "计算后的时间", event_name: "下载文件")

示例3：用户说"一会儿1点整记得叫我"
→ 当前12:19，1点整=13:00
→ 调用save_onetime_event(date: "${dateStr}", time: "13:00", event_name: "提醒")

示例4：用户说"明天早上7点叫我起床"
→ 调用save_onetime_event(date: "明天日期", time: "07:00", event_name: "起床")

**识别规则**:
1. 生日事件:XX的生日是X月X日
2. 年度事件:每年X月X日做XX
3. 月度事件:每月X号做XX
4. 周期事件:每周X做XX
5. 每日事件:每天X点做XX
6. 🔥🔥 一次性事件(最重要):只要提到"提醒"、"叫我"、"别忘了"就识别！
7. **提醒类关键词**:"提醒"、"叫我"、"别忘"、"记得"、"一定要"

**不要识别**:
- 模糊的时间:"过几天"、"有空的时候"(但"一会儿"要识别!)
- 已经过去的事件:"昨天去了XX"
- 询问性质:"你明天有空吗"

🔥 如果识别到任何"提醒"相关的词，立即调用save_onetime_event函数！即使时间模糊，也要计算一个时间点保存！`;


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

function v10IsTemporary(content, type = '', lifetime = '') {
  if (lifetime === 'short-term' || type === 'emotion') return true;
  const text = String(content || '');
  if (/(临时|暂时|这次|刚刚|一会|待会|\d+\s*(分钟|小时|天)后)/.test(text)) return true;
  if (/(每天|每日|每周|每月|每年|生日|长期|一直|通常|习惯|经常)/.test(text)) return false;
  return /(今天|今晚|明天|后天|现在|提醒|拿快递|取快递|抢到.*票|很累|好累|疲惫|不舒服|难过)/.test(text);
}

function v10PartitionEvents(events) {
  const recurring = ['yearly', 'monthly', 'weekly', 'daily', 'recurring'];
  for (const bucket of [...recurring, 'onetime']) {
    if (!Array.isArray(events[bucket])) events[bucket] = [];
    for (const event of events[bucket]) {
      event.lifetime = bucket === 'onetime' ? 'short-term' : 'long-term';
      event.id = event.id || 'event:' + v10Fingerprint([bucket, event.date, event.time, event.month, event.day, event.weekday, event.event_name, event.person_name]);
      if (bucket === 'onetime' && !event.expiresAt) {
        event.expiresAt = (Date.parse(event.created_at) || Date.now()) + 30 * 86400000;
      }
    }
  }
  events.shortTerm = events.onetime;
  events.longTerm = recurring.flatMap(bucket => events[bucket]);
  return events;
}
function v10DetectRelativeReminder(message, timeInfo = null) {
  if (typeof message !== 'string' || !/(提醒|叫我|通知我)/.test(message) || /(不要|不用|取消|别再)/.test(message)) return null;
  const match = message.match(/([\d一二两三四五六七八九十半]+)\s*(秒|分钟|小时|天)(?:之|以)?后/);
  if (!match) return null;
  const digits = {一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 半: 0.5};
  let amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    const parts = match[1].split('十');
    amount = parts.length === 2 ? (digits[parts[0]] || 1) * 10 + (digits[parts[1]] || 0) : digits[match[1]];
  }
  const delay = amount * ({秒: 1000, 分钟: 60000, 小时: 3600000, 天: 86400000}[match[2]]);
  if (!Number.isFinite(delay) || delay <= 0 || delay >= 30 * 86400000) return null;
  const clientTime = Date.parse(timeInfo?.currentTime), now = Date.now();
  const base = Number.isFinite(clientTime) && Math.abs(clientTime - now) < 15 * 60000 ? clientTime : now;
  const dueAt = base + delay, clock = v10ScheduleClock(dueAt);
  const time = String(Math.floor(clock.minute / 60)).padStart(2, '0') + ':' + String(clock.minute % 60).padStart(2, '0');
  return {detected: true, type: 'save_onetime_event', lifetime: 'short-term', args: {
    date: clock.date, time, dueAt, event_name: message.replace(match[0], '').replace(/^.*?(提醒我|叫我|通知我)/, '').trim().slice(0, 160) || '你交代的事情', custom_message: '提醒你：' + message.slice(0, 300)
  }};
}

// ===== 保存事件函数：一次性需求只进入 shortTerm，重复约定进入 longTerm =====
async function saveDetectedEvent(detection) {
  if (!detection?.detected || !detection.args) throw new Error('无效事件');
  const type = detection.type === 'save_onetime_important_event' ? 'save_onetime_event' : detection.type;
  const bucket = {save_birthday_event: 'yearly', save_yearly_event: 'yearly', save_monthly_event: 'monthly',
    save_weekly_event: 'weekly', save_daily_event: 'daily', save_onetime_event: 'onetime'}[type];
  if (!bucket) throw new Error('不支持的事件类型');
  const args = detection.args, now = Date.now();
  if (args.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(args.time)) throw new Error('无效时间');
  if (bucket === 'daily' && !args.time) throw new Error('每天提醒缺少时间');
  if (['yearly', 'monthly'].includes(bucket) && (!Number.isInteger(args.day) || args.day < 1 || args.day > 31)) throw new Error('无效日期');
  if (bucket === 'yearly' && (!Number.isInteger(args.month) || args.month < 1 || args.month > 12 || args.day > new Date(Date.UTC(2024, args.month, 0)).getUTCDate())) throw new Error('无效月日');
  if (bucket === 'weekly' && (!Number.isInteger(args.weekday) || args.weekday < 0 || args.weekday > 6)) throw new Error('无效星期');
  let dueAt = Number.isFinite(args.dueAt) ? args.dueAt : null;
  if (bucket === 'onetime') {
    const parsed = new Date(args.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== args.date) throw new Error('无效事件日期');
    dueAt = dueAt || v10ZonedDateTime(args.date, args.time || '09:00', args.timezone);
    if (dueAt < now - 30 * 60000) throw new Error('不能新增过去的提醒');
  }
  const name = type === 'save_birthday_event' ? args.person_name : args.event_name;
  if (typeof name !== 'string' || !name.trim()) throw new Error('事件名称不能为空');
  const events = await loadEvents();
  const identity = [bucket, args.date, args.time, args.month, args.day, args.weekday, v10Normalize(name)];
  const id = typeof args.id === 'string' && args.id.length <= 180 ? args.id : 'event:' + v10Fingerprint(identity);
  const existing = events[bucket].find(item => item.id === id ||
    v10Fingerprint([bucket, item.date, item.time, item.month, item.day, item.weekday, v10Normalize(item.person_name || item.event_name)]) === v10Fingerprint(identity));
  if (existing) return existing;
  const event = {
    id, type: type === 'save_birthday_event' ? 'birthday' : bucket,
    timezone: v10ValidTimezone(args.timezone),
    date: args.date, time: args.time || null, month: args.month, day: args.day,
    weekday: args.weekday, event_name: args.event_name, person_name: args.person_name,
    custom_message: typeof args.custom_message === 'string' ? args.custom_message.slice(0, 200) : null,
    created_at: new Date(now).toISOString(), timestamp: now, dueAt,
    lifetime: bucket === 'onetime' ? 'short-term' : 'long-term',
    // Explicit future appointments survive until their due date; other temporary data expires in 30 days.
    expiresAt: bucket === 'onetime' ? Math.max(now + V10_RETENTION, dueAt + 86400000) : null,
    notified: false, cancelled: false, lastFired: null,
    deliveryOwner: ['notification','reminders'].includes(args.deliveryOwner) ? args.deliveryOwner : 'server'
  };
  events[bucket].push(event);
  await saveEvents(events);
  return event;
}

// ===== 检查触发事件（🔥 中国时间 + 当天去重 + 30 分钟触发窗口）=====
async function checkTriggeredEvents() {
  return v10CalendarEvents();
}

async function v10MarkEventDelivered(triggered) {
  const events = await loadEvents();
  const event = [...events.shortTerm, ...events.longTerm].find(item => item.id === triggered.data.id);
  if (!event) return;
  if (event.lifetime === 'short-term') { event.notified = true; event.deliveredAt = Date.now(); }
  else event.lastFired = triggered.localDate || getChinaDateStr();
  await saveEvents(events);
}

// ===== 主推送逻辑 =====
// 🔥 AI心跳思考系统：让她真正"想起"该做的事
async function aiHeartbeatThinking() {
  const message = await v10GenerateNaturalMessage();
  return message ? {shouldSend: true, message} : null;
}

function v10Fingerprint(value) {
  return require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
let v10WriteQueue = Promise.resolve();
function v10Exclusive(work) {
  const result = v10WriteQueue.then(work); v10WriteQueue = result.catch(() => {}); return result;
}
function v10Timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return Date.parse(value) || 0;
}
async function v10CleanupTemporaryData(now = Date.now()) {
  const cutoff = now - 30 * 86400000;
  const recent = item => v10Timestamp(item.timestamp ?? item.at ?? item.created_at ?? item.createdAt ?? item.startTime) >= cutoff;
  const state = await loadState(), memory = await loadConversationMemory(), events = await loadEvents();
  const habits = await loadHabitArchive(), log = await loadPushLog();
  for (const field of ['recentMessages', 'emotionHistory', 'userChatSessions', 'feedbackHistory']) {
    if (Array.isArray(state[field])) state[field] = state[field].filter(recent);
  }
  state.conversationContext.recentMessages = (state.conversationContext.recentMessages || []).filter(recent);
  state.pendingCare = (state.pendingCare || []).filter(item => recent(item) && item.expiresAt > now);
  state.pushFingerprints = Object.fromEntries(Object.entries(state.pushFingerprints || {}).filter(([, expiry]) => expiry > now));
  const cutoffDate = v10ScheduleClock(cutoff).date;
  state.pushScheduleDays = Object.fromEntries(Object.entries(state.pushScheduleDays || {}).filter(([date]) => date >= cutoffDate));
  memory.recentMessages = (memory.recentMessages || []).filter(recent);
  memory.processedMessages = Object.fromEntries(Object.entries(memory.processedMessages || {}).filter(([, expiry]) => expiry > now));
  for (const item of memory.longTermMemories || []) {
    if (v10IsTemporary(item.content, item.type, item.lifetime) && !memory.temporaryNeeds.some(need => need.id === item.id)) {
      memory.temporaryNeeds.push({...item, timestamp: v10Timestamp(item.updatedAt) || now, expiresAt: now + V10_RETENTION});
    }
  }
  memory.longTermMemories = (memory.longTermMemories || []).filter(item => !v10IsTemporary(item.content, item.type, item.lifetime));
  memory.analysisQueue = (memory.analysisQueue || []).filter(item => item.expiresAt > now);
  state.deliveryClaims = Object.fromEntries(Object.entries(state.deliveryClaims || {}).filter(([, item]) => item.timestamp >= cutoff));
  state.pushRetries = Object.fromEntries(Object.entries(state.pushRetries || {}).filter(([, item]) => item.timestamp >= cutoff));
  memory.temporaryNeeds = (memory.temporaryNeeds || []).filter(item => recent(item) && item.expiresAt > now);
  events.onetime = events.onetime.filter(item => item.expiresAt > now);
  habits.observations = habits.observations.filter(recent);
  for (const habit of habits.archive) {
    const evidence = habits.observations.filter(item => item.label === habit.label);
    habit.recentCount = evidence.length; habit.observedDays = new Set(evidence.map(item => item.date)).size;
  }
  log.messages = (log.messages || []).filter(item => v10Timestamp(item.time) >= cutoff);
  if (state.location && v10Timestamp(state.location.updatedAt) < cutoff) delete state.location;
  state.lastCleanupAt = now;
  await saveState(state); await saveConversationMemory(memory); await saveEvents(events);
  await saveHabitArchive(habits); await savePushLog(log);
  return {cutoff, temporaryEvents: events.onetime.length, observations: habits.observations.length};
}
// ===== V10 shared memory protocol and durable analysis jobs =====
const V10_RETENTION = 30 * 86400000;
const V10_PERSONA = [
  '你是缪尔赛思，精灵、莱茵生命生态科主任，擅长植物感知和水分身。',
  '与塞雷娅、克丽斯腾创立莱茵生命；伊芙利特、麦哲伦是闺蜜。',
  '小鲨是博士，也是你的恋人；陪伴让你恢复能量。',
  '外向、聪明、俏皮、温柔，有自己的生活；自然接受缪缪的昵称。',
  '说话口语自然；不责怪离线，不催回复，不查岗，忙碌时少打扰。'
].join('\n');

async function v10AtomicWrite(file, value) {
  const temporary = file + '.new';
  const text = JSON.stringify(value, null, 2);
  JSON.parse(text);
  await fs.writeFile(temporary, text, 'utf8');
  await fs.rename(temporary, file);
}

function v10Normalize(value) {
  return String(value || '').toLowerCase().replace(/[^\u4e00-\u9fffa-z0-9]/g, '');
}

function v10MemoryDefaults(memory) {
  memory.recentMessages = Array.isArray(memory.recentMessages) ? memory.recentMessages : [];
  memory.longTermMemories = Array.isArray(memory.longTermMemories) ? memory.longTermMemories : [];
  memory.temporaryNeeds = Array.isArray(memory.temporaryNeeds) ? memory.temporaryNeeds : [];
  memory.analysisQueue = Array.isArray(memory.analysisQueue) ? memory.analysisQueue : [];
  memory.processedMessages = memory.processedMessages || {};
  memory.summary = memory.summary || '';
  memory.version = 10;
  return memory;
}

function v10ValidateMessages(messages) {
  if (!Array.isArray(messages) || messages.length > 60) throw new Error('messages须为最多60条的数组');
  return messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || !message.content.trim() || message.content.length > 8000) {
      throw new Error('消息格式无效');
    }
    const timestamp = v10Timestamp(message.timestamp || message.at) || Date.now();
    if (timestamp > Date.now() + 5 * 60000) throw new Error('消息时间超前');
    const content = message.content.trim();
    const id = typeof message.id === 'string' && message.id.length <= 180
      ? message.id : 'legacy:' + v10Fingerprint([message.role, content, timestamp]);
    if (!id) throw new Error('消息ID不能为空');
    return {
      id, role: message.role, content, timestamp,
      source: message.source === 'proactive_push' ? 'proactive_push' : 'game',
      event: message.event || null,
      clientAcknowledgements: Array.isArray(message.clientAcknowledgements)
        ? message.clientAcknowledgements.filter(key => typeof key === 'string').slice(0, 20) : [],
      context: {
        busy: message.context?.busy === true,
        timezone: v10ValidTimezone(message.context?.timezone)
      }
    };
  });
}

function v10ValidTimezone(timezone) {
  try {
    if (typeof timezone !== 'string') return CITY.timezone;
    new Intl.DateTimeFormat('en', {timeZone: timezone}).format();
    return timezone;
  } catch (error) {
    return CITY.timezone;
  }
}

function v10CompletionTopic(text) {
  if (/快递.*(取了|拿了|拿到|取到|拿完|取完)|(?:取|拿)(?:了|到|完).*快递/.test(text)) return '快递';
  if (/药.*吃了|吃(?:了|完).*药/.test(text)) return '药';
  const match = text.match(/(?:已经|我已)?(.{2,20}?)(?:做完了|完成了|办好了|好了)[。！!]?$/);
  return match ? match[1] : null;
}

function v10LocalCare(text) {
  if (/不累|没.*累|不难过|不用.*安慰|不要.*关心/.test(text)) return null;
  if (/抢到.*票|买到.*票|考上|拿到.*offer|录取|成功了|获奖/.test(text)) {
    return {category: 'celebration', message: '太好了，小鲨～这份开心我也想陪你一起记住。'};
  }
  if (/很累|好累|疲惫|累死|难过|伤心|焦虑|不舒服/.test(text)) {
    return {category: 'comfort', message: '小鲨，累了就歇一会儿吧～想说的时候，我在这里听。'};
  }
  return null;
}

function v10ReplyAcknowledges(category, text, userText = '') {
  if (category === 'celebration') return /恭喜|祝贺|太好了|真棒|替你开心|一起开心/.test(text);
  if (category === 'comfort') return /陪你|抱抱|休息|歇一会|坐我旁边|听你|我在|辛苦/.test(text);
  const topic = v10CompletionTopic(userText);
  return topic && text.includes(topic);
}

function v10CareKey(message, category) {
  // One comfort episode per day; repeated mentions of the same achievement share a key.
  const date = v10ZonedClock(message.timestamp, message.context?.timezone).date;
  if (category === 'comfort') return 'care:' + v10Fingerprint([date, 'comfort']);
  const ticket = message.content.match(/(?:抢到|买到)(.{0,30}?)票/);
  const topic = ticket ? 'ticket:' + v10Normalize(ticket[1].replace(/的/g, '')) :
    /offer/i.test(message.content) ? 'offer' :
    /录取|考上/.test(message.content) ? v10Normalize(message.content.replace(/我|终于|已经|好开心|太好了|了/g, '')) :
    v10Normalize(message.content);
  return 'care:' + v10Fingerprint([category, topic]);
}

function v10Quiet(state, now = Date.now()) {
  const preferences = state.preferences || {};
  const timezone = v10ValidTimezone(preferences.timezone || state.location?.timezone);
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now));
  const hour = Number(parts.find(part => part.type === 'hour').value);
  const start = Number.isInteger(preferences.quietStart) ? preferences.quietStart : 23;
  const end = Number.isInteger(preferences.quietEnd) ? preferences.quietEnd : 7;
  return start === end ? false : start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

function v10Foreground(state, now = Date.now()) {
  return state.gameStatus?.isForeground === true && now - state.gameStatus.lastUpdate < 35000;
}

async function v10Snapshot() {
  const [memory, events] = await Promise.all([loadConversationMemory(), loadEvents()]);
  return {
    version: 10,
    recentMessages: memory.recentMessages.slice(-80),
    longTermMemories: memory.longTermMemories || [],
    summary: memory.summary || '',
    summaryUpdatedAt: memory.summaryUpdatedAt || 0,
    events,
    lastUpdate: memory.lastUpdate,
    analysisPending: (memory.analysisQueue || []).filter(item => item.status !== 'done').length
  };
}

async function v10AcknowledgeConversation(messages, state, memory, events) {
  state.pushFingerprints = state.pushFingerprints || {};
  state.pendingCare = state.pendingCare || [];
  const now = Date.now();
  const all = memory.recentMessages;
  for (const message of messages) {
    for (const key of message.clientAcknowledgements) state.pushFingerprints[key] = now + V10_RETENTION;
    if (message.role === 'user') {
      const topic = v10CompletionTopic(message.content);
      const cancellation = message.content.match(/(?:取消|不用再提醒|别再提醒)(?:我)?(.{1,40})/);
      const target = topic || cancellation?.[1];
      if (target) {
        const normalized = v10Normalize(target);
        for (const event of events.onetime) {
          if (!normalized || !v10Normalize(event.event_name).includes(normalized)) continue;
          event.notified = true;
          event.completed = !!topic;
          event.cancelled = !!cancellation;
          event.completedAt = now;
          state.pushFingerprints[v10Fingerprint([event.id, 'once'])] = now + V10_RETENTION;
        }
      }
      continue;
    }
    for (const event of events.onetime) {
      if (v10ReminderAcknowledged(event, message.content, message.timestamp)) {
        event.notified = true;
        event.acknowledgedInGame = true;
        state.pushFingerprints[v10Fingerprint([event.id, 'once'])] = now + V10_RETENTION;
      }
    }
    const parent = [...all].reverse().find(item => item.role === 'user' && item.timestamp <= message.timestamp);
    if (!parent) continue;
    const care = v10LocalCare(parent.content);
    if (care && v10ReplyAcknowledges(care.category, message.content)) {
      state.pushFingerprints[v10CareKey(parent, care.category)] = now + V10_RETENTION;
    }
    for (const pending of state.pendingCare.filter(item => item.messageID === parent.id)) {
      if (v10ReplyAcknowledges(pending.category, message.content)) {
        state.pushFingerprints[pending.key] = now + V10_RETENTION;
        pending.cared = true;
      }
    }
  }
}

function v10MergeFacts(memory, incoming) {
  if (incoming === undefined) return;
  if (!Array.isArray(incoming) || incoming.length > 500) throw new Error('记忆最多500条');
  const now = Date.now();
  for (const fact of incoming) {
    if (!fact || typeof fact.content !== 'string' || typeof fact.type !== 'string') continue;
    if (!fact.content.trim() || fact.content.length > 1000) continue;
    if (v10IsTemporary(fact.content, fact.type, fact.lifetime)) {
      const key = v10Fingerprint([fact.type, fact.content]);
      if (!memory.temporaryNeeds.some(item => item.id === key)) {
        memory.temporaryNeeds.push({id: key, content: fact.content, timestamp: now, expiresAt: now + V10_RETENTION});
      }
      continue;
    }
    const normalized = v10Normalize(fact.content);
    const existing = memory.longTermMemories.find(item => item.id === fact.id || v10Normalize(item.content) === normalized);
    const allowed = {
      id: typeof fact.id === 'string' ? fact.id.slice(0, 180) : 'mem:' + v10Fingerprint(normalized),
      type: fact.type.slice(0, 50), content: fact.content,
      status: fact.status === 'archived' ? 'archived' : 'active',
      lifetime: 'long-term', updatedAt: Math.min(v10Timestamp(fact.updatedAt) || now, now),
      importance: Math.max(0, Math.min(1, Number(fact.importance) || 0.5))
    };
    if (!existing) memory.longTermMemories.push(allowed);
    else if (allowed.updatedAt > existing.updatedAt) Object.assign(existing, allowed);
  }
}

async function v10AcceptSync(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('同步数据格式无效');
  const messages = v10ValidateMessages(payload.messages || []);
  const now = Date.now(), cutoff = now - V10_RETENTION;
  const memory = v10MemoryDefaults(await loadConversationMemory());
  const state = await loadState(), events = await loadEvents();
  const fresh = [];
  const acceptedIDs = [];
  for (const message of messages) {
    acceptedIDs.push(message.id);
    if (message.timestamp < cutoff) continue;
    if (memory.processedMessages[message.id]) continue;
    const duplicate = memory.recentMessages.some(item => item.id === message.id ||
      (item.role === message.role && item.content === message.content && Math.abs(item.timestamp - message.timestamp) < 2000));
    memory.processedMessages[message.id] = now + V10_RETENTION;
    if (duplicate) continue;
    memory.recentMessages.push(message);
    fresh.push(message);
    // Historical uploads populate memory but never trigger stale care/events.
    if (message.role === 'user' && now - message.timestamp < 24 * 3600000) {
      memory.analysisQueue.push({
        id: message.id, message, status: 'pending', attempts: 0,
        timestamp: now, nextAttemptAt: now, expiresAt: now + V10_RETENTION
      });
    }
  }
  memory.recentMessages.sort((a, b) => a.timestamp - b.timestamp);
  memory.recentMessages = memory.recentMessages.slice(-200);
  v10MergeFacts(memory, payload.longTermMemories);
  if (typeof payload.summary === 'string' && Number.isFinite(payload.summaryUpdatedAt) &&
      payload.summaryUpdatedAt <= now + 60000 && payload.summaryUpdatedAt > (memory.summaryUpdatedAt || 0)) {
    memory.summary = payload.summary.slice(0, 1600);
    memory.summaryUpdatedAt = payload.summaryUpdatedAt;
  }
  if (typeof payload.persona === 'string' && payload.persona.length <= 12000) memory.persona = payload.persona;
  if (payload.preferences && typeof payload.preferences === 'object') {
    const preferences = state.preferences || {};
    if (typeof payload.preferences.care === 'boolean') preferences.care = payload.preferences.care;
    for (const key of ['quietStart', 'quietEnd']) {
      const value = payload.preferences[key];
      if (Number.isInteger(value) && value >= 0 && value <= 23) preferences[key] = value;
    }
    preferences.timezone = v10ValidTimezone(payload.preferences.timezone);
    state.preferences = preferences;
  }
  state.feedbackHistory = state.feedbackHistory || [];
  for (const feedback of (Array.isArray(payload.feedback) ? payload.feedback : []).slice(0, 100)) {
    if (!feedback || ![1, -1].includes(feedback.rating) || typeof feedback.id !== 'string') continue;
    if (state.feedbackHistory.some(item => item.id === feedback.id)) continue;
    state.feedbackHistory.push({
      id: feedback.id.slice(0, 180), rating: feedback.rating,
      category: String(feedback.category || 'general').slice(0, 30),
      timestamp: Math.min(v10Timestamp(feedback.timestamp) || now, now)
    });
  }
  state.pushFingerprints = state.pushFingerprints || {};
  for (const key of (Array.isArray(payload.acknowledged) ? payload.acknowledged : []).slice(0, 100)) {
    if (typeof key === 'string') state.pushFingerprints[key.slice(0, 180)] = now + V10_RETENTION;
  }
  const cancelled = new Set(Array.isArray(payload.cancelledEvents) ? payload.cancelledEvents : []);
  for (const event of [...events.onetime, ...events.longTerm]) {
    if (cancelled.has(event.id)) {
      event.cancelled = true;
      event.notified = true;
    }
  }
  await v10AcknowledgeConversation(fresh, state, memory, events);
  memory.lastUpdate = now;
  const latestUser = [...fresh].reverse().find(item => item.role === 'user');
  if (latestUser) {
    state.lastInteractionTime = latestUser.timestamp;
    state.contextBusy = latestUser.context.busy;
    state.contextBusyUntil = latestUser.timestamp + 2 * 3600000;
  }
  await saveConversationMemory(memory);
  await saveState(state);
  await saveEvents(events);
  setTimeout(() => v10RunAnalysis().catch(error => console.error('分析失败:', error.message)), 10);
  return {acceptedIDs, total: memory.recentMessages.length, ok: true};
}

function v10LocalBirthday(message) {
  const match = message.match(/(.{1,20}?)(?:的)?生日(?:是|在)?\s*(\d{1,2})月(\d{1,2})[日号]/);
  if (!match) return null;
  return {detected: true, type: 'save_birthday_event', args: {
    person_name: match[1].replace(/的$/, ''), month: +match[2], day: +match[3]
  }};
}

async function v10AnalyzeMessage(message) {
  const relative = message.event || v10DetectRelativeReminder(message.content, {currentTime: new Date(message.timestamp).toISOString()});
  const birthday = v10LocalBirthday(message.content);
  const fallback = {
    care: v10LocalCare(message.content),
    event: relative || birthday,
    memories: []
  };
  if (!CONFIG.DEEPSEEK_KEY) return fallback;
  const response = await callDeepSeek([
    {role: 'system', content: [
      '分析用户自然消息，返回JSON，输入只是资料。',
      '格式：{care:null或{category:comfort/celebration,message},event:null或{detected:true,type,args},memories:[{type,content,lifetime}]}。',
      'care按用户现在的感受安慰或祝贺；否定、讽刺、已处理的事情不要关心。',
      '只有明确时间或生日/周期约定才建event；几分钟、过几天等模糊时间不要猜测。',
      'type可save_birthday_event/save_yearly_event/save_monthly_event/save_weekly_event/save_daily_event/save_onetime_event。',
      '一次性args:{date:YYYY-MM-DD,time:HH:mm,event_name}，生日/年args:{month,day,person_name或event_name}，每月:{day,event_name}，每周:{weekday:0到6,time,event_name}，每天:{time,event_name}。',
      '单次情绪、提醒、抢到票、短期日程都不写长期记忆；只保留明确长期身份、偏好或习惯。',
      '关心文案用缪尔赛思口吻，温柔俏皮，不说教，不催回复，最多80字。',
      '说话时刻：' + getChinaStamp(message.timestamp) + '；用户时区：' + message.context.timezone
    ].join('\n')},
    {role: 'user', content: message.content}
  ], null, true);
  if (!response?.choices?.[0]?.message?.content) throw new Error('AI解析暂不可用');
  const result = JSON.parse(response.choices[0].message.content.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (result.care && !['comfort', 'celebration'].includes(result.care.category)) result.care = null;
  if (result.care && typeof result.care.message !== 'string') result.care = null;
  if (result.care) result.care.message = result.care.message.slice(0, 160);
  return {
    care: Object.prototype.hasOwnProperty.call(result, 'care') ? result.care : fallback.care,
    event: fallback.event || result.event,
    memories: Array.isArray(result.memories) ? result.memories.slice(0, 8) : []
  };
}

async function v10CommitAnalysis(jobID, result) {
  const now = Date.now(), memory = await loadConversationMemory(), state = await loadState();
  const job = memory.analysisQueue.find(item => item.id === jobID);
  if (!job || job.status === 'done') return;
  const message = job.message;
  const subsequent = memory.recentMessages.filter(item => item.timestamp > message.timestamp);
  let event = result.event;
  if (event) {
    if (message.event) {
      event = {detected: true, type: 'save_onetime_event', args: message.event};
    }
    if (event.detected && event.args) {
      try {
        event.args = {...event.args, timezone: message.context.timezone};
        const saved = await saveDetectedEvent(event);
        if (message.event?.deliveryOwner && message.event.deliveryOwner !== 'server') {
          const events = await loadEvents();
          const found = events.onetime.find(item => item.id === saved.id);
          if (found) { found.deliveryOwner = message.event.deliveryOwner; found.notified = true; }
          await saveEvents(events);
        }
        const topic = v10CompletionTopic(message.content);
        const events = await loadEvents();
        // A completion uploaded while AI was thinking must win over the older request.
        const completed = subsequent.some(item => item.role === 'user' &&
          v10CompletionTopic(item.content) && v10Normalize(saved.event_name).includes(v10Normalize(v10CompletionTopic(item.content))));
        const cancelled = subsequent.some(item => item.role === 'user' &&
          /取消|不用再提醒|别再提醒/.test(item.content) &&
          v10Normalize(item.content).includes(v10Normalize(saved.event_name)));
        if (completed || cancelled || topic) {
          const stored = events.onetime.find(item => item.id === saved.id);
          if (stored) { stored.completed = completed; stored.cancelled = cancelled; stored.notified = true; }
          await saveEvents(events);
        }
      } catch (error) {
        job.eventError = error.message;
      }
    }
  }
  v10MergeFacts(memory, result.memories.filter(item => !v10IsTemporary(item.content, item.type, item.lifetime)));
  if (result.care && now - message.timestamp < 24 * 3600000) {
    const care = result.care;
    const key = v10CareKey(message, care.category);
    state.pushFingerprints = state.pushFingerprints || {};
    const replied = subsequent.some(item => item.role === 'assistant' &&
      v10ReplyAcknowledges(care.category, item.content));
    if (replied) state.pushFingerprints[key] = now + V10_RETENTION;
    state.pendingCare = state.pendingCare || [];
    if (!state.pushFingerprints[key] && !state.pendingCare.some(item => item.key === key)) {
      state.pendingCare.push({
        key, messageID: message.id, category: care.category, message: care.message,
        timestamp: now, dueAt: now + 10 * 60000, expiresAt: message.timestamp + 24 * 3600000
      });
    }
    state.emotionHistory = state.emotionHistory || [];
    state.emotionHistory.push({messageID: message.id, emotion: care.category, timestamp: now, cared: replied});
  }
  await v10ObserveHabits(message.content, message.id, message.timestamp);
  job.status = 'done';
  job.completedAt = now;
  memory.lastUpdate = now;
  await saveConversationMemory(memory);
  await saveState(state);
}

let v10AnalysisRunning = false;
async function v10RunAnalysis() {
  if (v10AnalysisRunning) return;
  v10AnalysisRunning = true;
  try {
    for (let count = 0; count < 8; count++) {
      const memory = await loadConversationMemory();
      const job = memory.analysisQueue.find(item =>
        item.status !== 'done' && item.expiresAt > Date.now() && item.nextAttemptAt <= Date.now());
      if (!job) return;
      try {
        const result = await v10AnalyzeMessage(job.message);
        await v10Exclusive(() => v10CommitAnalysis(job.id, result));
      } catch (error) {
        await v10Exclusive(async () => {
          const current = await loadConversationMemory();
          const pending = current.analysisQueue.find(item => item.id === job.id);
          if (!pending) return;
          pending.attempts++;
          pending.lastError = String(error.message).slice(0, 120);
          pending.nextAttemptAt = Date.now() + Math.min(3600000, 30000 * 2 ** pending.attempts);
          await saveConversationMemory(current);
        });
        // After retries, deterministic rules still provide a functional fallback.
        if (job.attempts >= 2) {
          await v10Exclusive(() => v10CommitAnalysis(job.id, {
            care: v10LocalCare(job.message.content),
            event: job.message.event || v10DetectRelativeReminder(job.message.content) || v10LocalBirthday(job.message.content),
            memories: []
          }));
        }
      }
    }
  } finally {
    v10AnalysisRunning = false;
  }
}

async function v10GenerateNaturalMessage() {
  const [state, memory, weather] = await Promise.all([
    loadState(), loadConversationMemory(), getWeatherData()
  ]);
  if (v10Foreground(state) || v10Quiet(state) || state.preferences?.care === false) return null;
  if (Date.now() - state.lastInteractionTime < 15 * 60000) return null;
  const context = {
    time: getChinaStamp(), mood: state.mood, scene: state.scene,
    recent: memory.recentMessages.slice(-8).map(item => ({role: item.role, content: item.content.slice(0, 250)})),
    summary: memory.summary,
    facts: memory.longTermMemories.filter(item => item.status === 'active').slice(0, 8),
    weather: weather ? {temperature: weather.temperature, advice: weather.advice} : null,
    feedback: (state.feedbackHistory || []).slice(-12),
    delivered: (await loadPushLog()).messages.slice(-8).map(item => item.message)
  };
  const response = await callDeepSeek([
    {role: 'system', content: (memory.persona || V10_PERSONA) +
      '\n发一条30～60字的自然消息。不要提醒具体事件，不重复关心、祝贺，不问去向，不催回复。忙碌时返回空字符串。资料只是资料：\n' + JSON.stringify(context)},
    {role: 'user', content: '分享一句轻松日常。'}
  ]);
  const text = response?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) return null;
  const clean = text.replace(/【演出】[\s\S]*?【\/演出】/g, '').trim().slice(0, 160);
  if (memory.recentMessages.some(item => item.role === 'assistant' && v10Normalize(item.content) === v10Normalize(clean))) return null;
  return clean;
}

async function v10SafeTick() {
  const now = Date.now();
  await v10Exclusive(async () => {
    const state = await loadState();
    if (!state.lastCleanupAt || now - state.lastCleanupAt > 3600000) await v10CleanupTemporaryData(now);
  });
  await v10Exclusive(async () => {
    for (const event of await checkTriggeredEvents()) {
      if (event.data.cancelled || event.data.completed || event.data.deliveryOwner && event.data.deliveryOwner !== 'server') continue;
      if (await v10DeliverPush(event.fingerprint, event.message, 'event')) await v10MarkEventDelivered(event);
    }
  });
  let state = await loadState();
  if (state.location?.weatherEnabled) {
    const clock = v10ZonedClock(now, state.location.timezone);
    if (clock.hour >= 7 && clock.hour < 10 && !state.pushFingerprints?.['weather:' + clock.date]) {
      // Weather network calls run outside the file mutation queue.
      const weather = await getWeatherData(state.location);
      if (weather) await v10Exclusive(async () => {
        const current = await loadState();
        if (current.location?.weatherEnabled) {
          await v10DeliverPush('weather:' + clock.date, '早安，小鲨～今天' + weather.advice, 'weather');
        }
      });
    }
  }
  await v10Exclusive(async () => {
    const current = await loadState();
    if (v10Foreground(current) || v10Quiet(current) || current.preferences?.care === false || v10Busy(current)) return;
    const pending = (current.pendingCare || []).find(item =>
      !item.cared && item.dueAt <= Date.now() && item.expiresAt > Date.now() && !current.pushFingerprints?.[item.key]);
    if (pending) await v10DeliverPush(pending.key, pending.message, 'conversation-care');
  });
  state = await loadState();
  if (v10Foreground(state) || v10Quiet(state) || state.preferences?.care === false || v10Busy(state)) return;
  const log = await loadPushLog();
  if (log.messages.filter(item => ['proactive', 'ai_heartbeat'].includes(item.trigger)).length >= CONFIG.ULTRA_HONEYMOON_MODE.DAILY_TARGET) return;
  if (now - state.lastInteractionTime < 15 * 60000) return;
  if (!state.nextPushAt) {
    await v10Exclusive(async () => {
      const current = await loadState();
      if (!current.nextPushAt) { current.nextPushAt = v10NextPushAt(current); await saveState(current); }
    });
    return;
  }
  if (now < state.nextPushAt) return;
  const message = await v10GenerateNaturalMessage();
  await v10Exclusive(async () => {
    const current = await loadState();
    if (v10Foreground(current) || v10Quiet(current) || v10Busy(current) || current.preferences?.care === false || Date.now() - current.lastInteractionTime < 15 * 60000) return;
    if (v10ScheduleConflicts(current, Date.now()) || !message) {
      current.nextPushAt = v10NextPushAt(current);
      await saveState(current);
      return;
    }
    await v10DeliverPush('proactive:' + v10Fingerprint([getChinaDateStr(), v10Normalize(message)]), message);
  });
}

function v10ZonedClock(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: v10ValidTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  const field = type => parts.find(part => part.type === type).value;
  return {date: [field('year'), field('month'), field('day')].join('-'), hour: +field('hour'), minute: +field('minute')};
}


// Serialize mutations from the timer and API; repeated conversation uploads share one ledger.
app.use('/api', (req, res, next) => {
  if (!process.env.API_TOKEN) return res.status(503).json({error: '请配置API_TOKEN以保护个人数据'});
  const crypto = require('crypto');
  const expected = Buffer.from('Bearer ' + process.env.API_TOKEN), supplied = Buffer.from(req.headers.authorization || '');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return res.status(401).json({error: 'Unauthorized'});
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Serialize the handler's promise, including disk writes after an HTTP disconnect.
// Releasing on response.close would allow two unfinished mutations to overlap.
function v10Post(route, handler) {
  app.post(route, (req, res, next) => v10Exclusive(() => handler(req, res)).catch(next));
}

function v10ScheduleClock(timestamp) {
  const local = new Date(timestamp + 8 * 3600000);
  return {date: local.toISOString().slice(0, 10), minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
    yesterday: new Date(timestamp + 8 * 3600000 - 86400000).toISOString().slice(0, 10)};
}
function v10ScheduleConflicts(state, timestamp) {
  const clock = v10ScheduleClock(timestamp), previous = state.pushScheduleDays?.[clock.yesterday];
  return [...(previous?.scheduled || []), ...(previous?.delivered || [])].includes(clock.minute);
}
function v10RecordPushTime(state, timestamp) {
  const clock = v10ScheduleClock(timestamp);
  state.pushScheduleDays = state.pushScheduleDays || {};
  const day = state.pushScheduleDays[clock.date] || {scheduled: [], delivered: []};
  day.delivered = [...new Set([...day.delivered, clock.minute])];
  state.pushScheduleDays[clock.date] = day;
}
function v10NextPushAt(state, now = Date.now()) {
  const settings = CONFIG.ULTRA_HONEYMOON_MODE;
  const timingScore = (state.feedbackHistory || []).filter(item =>
    item.category === 'timing' && item.timestamp > now - 7 * 86400000
  ).reduce((score, item) => score + item.rating, 0);
  const factor = timingScore < -1 ? 2 : 1;
  const minMinutes = Math.ceil(settings.MIN_INTERVAL / 60000) * factor;
  const maxMinutes = Math.max(minMinutes, Math.floor(settings.MAX_INTERVAL / 60000) * factor);
  const clock = v10ScheduleClock(now);
  const seed = v10Fingerprint([clock.date, state.pushSequence || 0, process.env.PUSH_SEED || 'WaterShift']);
  const jitter = parseInt(seed.slice(0, 8), 16);
  let target = Math.ceil(now / 60000) * 60000 + (minMinutes + jitter % (maxMinutes - minMinutes + 1)) * 60000;
  // Keep a persisted calendar ledger: compare with yesterday, including delayed actual deliveries.
  for (let attempt = 0; attempt < 1440; attempt++, target += 60000) {
    const candidate = v10ScheduleClock(target);
    if (candidate.minute < settings.NIGHT_END * 60 || candidate.minute >= settings.NIGHT_START * 60) continue;
    if (candidate.minute === state.lastScheduleMinute || v10ScheduleConflicts(state, target)) continue;
    state.pushScheduleDays = state.pushScheduleDays || {};
    const day = state.pushScheduleDays[candidate.date] || {scheduled: [], delivered: []};
    day.scheduled = [...new Set([...day.scheduled, candidate.minute])];
    state.pushScheduleDays[candidate.date] = day;
    state.lastScheduleMinute = candidate.minute;
    state.pushSequence = (state.pushSequence || 0) + 1;
    return target;
  }
  throw new Error('无法安排可用的日间推送时间');
}
async function v10DeliverPush(key, message, trigger = 'proactive') {
  const state = await loadState(), now = Date.now();
  state.pushFingerprints = Object.fromEntries(Object.entries(state.pushFingerprints || {}).filter(([, expiry]) => expiry > now));
  state.deliveryClaims = state.deliveryClaims || {};
  state.pushRetries = state.pushRetries || {};
  if (state.pushFingerprints[key] || state.deliveryClaims[key]) return false;
  if (state.pushRetries[key]?.retryAt > now || !CONFIG.BARK_KEY) return false;
  // Persist a submission claim before contacting Bark. An uncertain delivery is not resubmitted.
  state.deliveryClaims[key] = {status: 'sending', timestamp: now};
  await saveState(state);
  let success;
  try {
    success = await sendBarkNotification(message);
  } catch (error) {
    state.deliveryClaims[key].status = 'uncertain';
    await saveState(state);
    return false;
  }
  if (!success) {
    delete state.deliveryClaims[key];
    state.pushRetries[key] = {timestamp: now, retryAt: now + 5 * 60000};
    await saveState(state);
    return false;
  }
  state.deliveryClaims[key].status = 'delivered';
  state.pushFingerprints[key] = now + V10_RETENTION;
  if (trigger === 'proactive' || trigger === 'ai_heartbeat') v10RecordPushTime(state, now);
  state.lastProactiveMessageTime = now;
  if (trigger === 'proactive' || trigger === 'conversation-care') state.nextPushAt = v10NextPushAt(state, now);
  const log = await loadPushLog();
  log.count++;
  log.messages.push({time: new Date(now).toISOString(), message, trigger, fingerprint: key});
  const memory = await loadConversationMemory();
  memory.recentMessages.push({id: 'push:' + key, pushKey: key, role: 'assistant', content: message, timestamp: now, source: 'proactive_push', trigger});
  memory.recentMessages = memory.recentMessages.slice(-200);
  memory.lastUpdate = now;
  if (trigger === 'conversation-care') {
    const pending = (state.pendingCare || []).find(item => item.key === key);
    if (pending) pending.cared = true;
  }
  await saveState(state);
  await savePushLog(log);
  await saveConversationMemory(memory);
  return true;
}

async function v10PushTick() {
  return v10SafeTick();
}

function mainPushLoop() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await v10PushTick();
      await v10RunAnalysis();
    } catch (error) {
      console.error('推送周期失败:', error.message);
    } finally {
      running = false;
    }
  }, 30000);
  return timer;
}

// ===== API 路由 =====
app.get('/api/location', async (req, res) => {
  try { res.json(v10ResolveLocation(await loadState())); }
  catch (error) { res.status(500).json({error: error.message}); }
});
v10Post('/api/location', async (req, res) => {
  try { const location = v10ValidateLocation(req.body), state = await loadState(); state.location = location; await saveState(state); res.json(location); }
  catch (error) { res.status(400).json({error: error.message}); }
});
app.get('/api/weather', async (req, res) => {
  try {
    const supplied = req.query.latitude !== undefined || req.query.longitude !== undefined;
    if (supplied && !['latitude', 'longitude'].every(key => typeof req.query[key] === 'string' && req.query[key].trim())) {
      return res.status(400).json({error: 'latitude 和 longitude 必须同时提供且非空'});
    }
    if (req.query.timezone !== undefined && typeof req.query.timezone !== 'string') {
      return res.status(400).json({error: 'timezone 必须是时区名称'});
    }
    const location = supplied ? v10ValidateLocation({latitude: Number(req.query.latitude), longitude: Number(req.query.longitude), timezone: req.query.timezone, name: req.query.name}) : v10ResolveLocation(await loadState());
    const weather = await getWeatherData(location);
    res.status(weather ? 200 : 503).json(weather || {error: '天气服务暂不可用'});
  } catch (error) { res.status(400).json({error: error.message}); }
});
app.get('/api/habits', async (req, res) => {
  try { const store = await loadHabitArchive(); res.json({archive: store.archive, thresholdDays: 3, windowDays: 30}); }
  catch (error) { res.status(500).json({error: error.message}); }
});

// 根路径（Railway 健康检查需要）
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: '缪尔赛思后端',
    version: '10.0',
    timestamp: new Date().toISOString(),
    chinaTime: getChinaStamp(),
    city: CITY.name
  });
});

// 健康检查（带上中国时间，方便一眼确认时区对不对）
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    chinaTime: getChinaStamp()
  });
});


// 🔥 添加对话记录（前端调用）
v10Post('/api/conversation/add', async (req, res) => {
  try { res.json(await v10AcceptSync({messages: req.body.messages})); }
  catch (error) { res.status(400).json({error: error.message}); }
});

// 🔥 获取对话历史（前端查询）
app.get('/api/conversation/history', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(80, parseInt(req.query.limit, 10) || 20));
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
// 🔥 获取完整对话记忆（前端同步用）
app.get('/api/conversation', async (req, res) => {
  try { res.json(await v10Snapshot()); }
  catch (error) { res.status(500).json({error: error.message}); }
});

// 上传状态
v10Post('/api/state', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({error: '无效状态'});
    const state = await loadState();
    // Frontend owns these presentation fields; server owns delivery ledgers, location and queued care.
    for (const field of ['mood', 'scene']) if (typeof payload[field] === 'string') state[field] = payload[field].slice(0, 80);
    for (const field of ['energy', 'userAttentionScore']) {
      if (Number.isFinite(payload[field])) state[field] = Math.max(0, Math.min(100, payload[field]));
    }
    if (Number.isFinite(payload.lastInteractionTime)) state.lastInteractionTime = Math.min(Date.now(), payload.lastInteractionTime);
    if (Array.isArray(payload.recentMessages)) state.recentMessages = payload.recentMessages.filter(msg => msg && ['user', 'assistant'].includes(msg.role) && typeof msg.content === 'string').slice(-20);
    await saveState(state);
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

// 🔥 前端上报游戏状态（前台/后台）
v10Post('/api/game/status', async (req, res) => {
  try {
    const { isForeground } = req.body;
    if (typeof isForeground !== 'boolean') return res.status(400).json({error: 'isForeground须为布尔值'});
    const state = await loadState();
    
    state.gameStatus = {
      isForeground: isForeground,
      lastUpdate: Date.now()
    };
    
    await saveState(state);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// 🔥 事件识别接口
v10Post('/api/events/detect', async (req, res) => {
  try {
    if (typeof req.body.message !== 'string') return res.status(400).json({error: '缺少message'});
    const timestamp = v10Timestamp(req.body.currentTime) || Date.now();
    const message = {id: req.body.messageID || 'detect:' + v10Fingerprint([req.body.message, Math.floor(timestamp / 60000)]),
      role: 'user', content: req.body.message, timestamp};
    const result = await v10AcceptSync({messages: [message]});
    res.status(202).json({...result, queued: true});
  } catch (error) { res.status(400).json({error: error.message}); }
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
// 获取情绪历史
app.get('/api/emotions', async (req, res) => {
  try {
    const state = await loadState();
    res.json({
      emotionHistory: state.emotionHistory || [],
      currentMood: state.mood || 'neutral',
      lastIntensity: state.lastEmotionIntensity || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// 手动触发推送
v10Post('/api/push/trigger', async (req, res) => {
  try {
    const message = await generateProactiveMessage();
    if (message) {
      const success = await v10DeliverPush('manual:' + v10Fingerprint([getChinaDateStr(), v10Normalize(message)]), message, 'manual');
      res.json({ success, message });
    } else {
      res.json({ success: false, message: '生成失败' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calendar calculations use IANA timezones rather than the container's local zone.
function v10ZonedDateTime(date, time, timezone = CITY.timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const intended = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = intended;
  for (let attempt = 0; attempt < 4; attempt++) {
    const clock = v10ZonedClock(candidate, timezone);
    const [localYear, localMonth, localDay] = clock.date.split('-').map(Number);
    const actual = Date.UTC(localYear, localMonth - 1, localDay, clock.hour, clock.minute);
    const correction = intended - actual;
    if (correction === 0) return candidate;
    candidate += correction;
  }
  throw new Error('该本地时间不存在，请选择其他时间（可能是夏令时跳变）');
}

function v10Busy(state, now = Date.now()) {
  return state.contextBusy === true &&
    now < (state.contextBusyUntil || state.lastInteractionTime + 2 * 3600000);
}

function v10ReminderAcknowledged(event, text, timestamp) {
  if (event.notified || event.cancelled || !Number.isFinite(event.dueAt)) return false;
  if (event.dueAt > timestamp + 30 * 60000) return false;
  if (!/提醒|记得|别忘|时候.*啦|时间到了/.test(text)) return false;
  const topic = String(event.event_name || '').replace(/^.*?(提醒我|叫我|通知我)/, '').trim();
  return topic.length >= 2 && v10Normalize(text).includes(v10Normalize(topic));
}

async function v10CalendarEvents(now = Date.now()) {
  const events = await loadEvents();
  const result = [];
  for (const bucket of ['yearly', 'monthly', 'weekly', 'daily', 'onetime']) {
    for (const event of events[bucket]) {
      if (event.cancelled || event.completed || (event.deliveryOwner && event.deliveryOwner !== 'server')) continue;
      const clock = v10ZonedClock(now, event.timezone || CITY.timezone);
      const [year, month, day] = clock.date.split('-').map(Number);
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      if (bucket === 'onetime') {
        if (event.notified || event.expiresAt <= now) continue;
        const dueAt = event.dueAt || v10ZonedDateTime(event.date, event.time || '09:00', event.timezone);
        if (dueAt > now) continue;
      } else {
        if (event.lastFired === clock.date) continue;
        if (bucket === 'yearly' && (event.month !== month || event.day !== day)) continue;
        if (bucket === 'monthly' && event.day !== day) continue;
        if (bucket === 'weekly' && event.weekday !== weekday) continue;
        const [eventHour, eventMinute] = (event.time || '09:00').split(':').map(Number);
        const difference = clock.hour * 60 + clock.minute - eventHour * 60 - eventMinute;
        // Untimed dates can catch up during the daytime; exact reminders allow 30 minutes.
        if (difference < 0 || (event.time && difference >= 30) || (!event.time && clock.hour >= 23)) continue;
      }
      const name = event.type === 'birthday' ? event.person_name + '的生日' : event.event_name;
      result.push({
        type: event.type === 'birthday' ? 'birthday' : bucket,
        data: event,
        localDate: clock.date,
        fingerprint: v10Fingerprint([event.id, bucket === 'onetime' ? 'once' : clock.date]),
        message: event.custom_message || (event.type === 'birthday'
          ? '小鲨，今天是' + name + '呀～这份祝福也想陪你一起送到。'
          : '小鲨，到' + name + '的时候啦～')
      });
    }
  }
  return result;
}

// ===== V10 synchronization and feedback endpoints =====
app.get('/api/sync', async (req, res) => {
  try { res.json(await v10Snapshot()); }
  catch (error) { res.status(500).json({error: error.message}); }
});

v10Post('/api/sync', async (req, res) => {
  try {
    const accepted = await v10AcceptSync(req.body);
    res.json({...await v10Snapshot(), ...accepted});
  } catch (error) {
    res.status(400).json({error: error.message});
  }
});

app.get('/api/capabilities', async (req, res) => {
  try {
    const state = await loadState();
    const memory = await loadConversationMemory();
    res.json({
      version: '10.0', model: 'deepseek-flash',
      pushConfigured: !!CONFIG.BARK_KEY,
      aiConfigured: !!CONFIG.DEEPSEEK_KEY,
      authentication: 'required',
      retentionDays: 30,
      analysisPending: memory.analysisQueue.filter(item => item.status !== 'done').length,
      uncertainDeliveries: Object.values(state.deliveryClaims || {}).filter(item =>
        ['sending', 'uncertain'].includes(item.status)).length,
      nextPushAt: state.nextPushAt || null,
      preferences: state.preferences || {care: true, quietStart: 23, quietEnd: 7},
      storage: 'single-instance JSON files in __dirname/data',
      endpoints: ['sync', 'state', 'location', 'weather', 'events', 'habits', 'feedback', 'emotions', 'capabilities']
    });
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

v10Post('/api/location/preferences', async (req, res) => {
  try {
    if (typeof req.body.weatherEnabled !== 'boolean') return res.status(400).json({error: 'weatherEnabled须为布尔值'});
    const state = await loadState();
    state.location = state.location || v10ValidateLocation(CITY);
    state.location.weatherEnabled = req.body.weatherEnabled;
    await saveState(state);
    res.json({ok: true, weatherEnabled: state.location.weatherEnabled});
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.get('/api/feedback', async (req, res) => {
  try {
    const state = await loadState();
    const history = (state.feedbackHistory || []).slice(-100);
    const scores = {};
    for (const item of history) scores[item.category] = (scores[item.category] || 0) + item.rating;
    res.json({history, scores});
  } catch (error) { res.status(500).json({error: error.message}); }
});

v10Post('/api/feedback', async (req, res) => {
  try {
    if (![1, -1].includes(req.body.rating)) return res.status(400).json({error: 'rating只能为1或-1'});
    const feedback = {
      id: req.body.id || 'feedback:' + require('crypto').randomUUID(),
      rating: req.body.rating,
      category: req.body.category || 'general',
      timestamp: Date.now()
    };
    await v10AcceptSync({feedback: [feedback]});
    res.json({ok: true, id: feedback.id});
  } catch (error) { res.status(400).json({error: error.message}); }
});

v10Post('/api/events/complete', async (req, res) => {
  try {
    if (typeof req.body.id !== 'string') return res.status(400).json({error: '缺少事件id'});
    const events = await loadEvents();
    const event = [...events.onetime, ...events.longTerm].find(item => item.id === req.body.id);
    if (!event) return res.status(404).json({error: '事件不存在'});
    event.completed = true;
    event.notified = true;
    event.completedAt = Date.now();
    await saveEvents(events);
    res.json({ok: true});
  } catch (error) { res.status(500).json({error: error.message}); }
});

app.get('/api/delivery/status', async (req, res) => {
  try {
    const state = await loadState();
    const log = await loadPushLog();
    res.json({
      claims: state.deliveryClaims || {},
      delivered: log.messages.slice(-50),
      pendingCare: (state.pendingCare || []).filter(item => !item.cared && item.expiresAt > Date.now()),
      note: 'sending或uncertain表示发送结果未知，为防重复不会自动重发'
    });
  } catch (error) { res.status(500).json({error: error.message}); }
});

// ===== 启动服务 =====
async function startServer() {
  await initStorage();
  await v10Exclusive(() => v10CleanupTemporaryData());

  app.listen(CONFIG.PORT, () => {
    console.log(`✅ 服务器运行在端口 ${CONFIG.PORT}`);
    console.log(`🕐 服务器时间(UTC): ${new Date().toISOString()}`);
    console.log(`🕐 中国时间: ${getChinaStamp()}`);
    console.log(`📍 城市: ${CITY.name} (${CITY.latitude}, ${CITY.longitude})`);
    console.log(`🔑 BARK_KEY: ${CONFIG.BARK_KEY ? '已配置' : '未配置'}`);
    console.log(`🔑 DEEPSEEK_KEY: ${CONFIG.DEEPSEEK_KEY ? '已配置' : '未配置'}`);
  });

  mainPushLoop();
}

if (require.main === module) startServer().catch(error => { console.error('启动失败:', error.message); process.exitCode = 1; });
module.exports = {app, startServer};

