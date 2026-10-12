// ==========================================
// Railway 后端 - 性能优化版 V7.1
// ==========================================
// 🔥 优化重点：
// 1. 精简事件检测逻辑，降低延迟
// 2. 优化推送频率算法
// 3. 完整对话记忆同步
// 4. 智能情绪识别推送
// ==========================================

const express = require("express");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== 配置 =====
const CONFIG = {
  BARK_KEY: process.env.BARK_KEY || "",
  DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || "",
  PORT: process.env.PORT || 8080,
  DATA_DIR: path.join(__dirname, "data"),

  PUSH_SETTINGS: {
    CHECK_INTERVAL: 8 * 60 * 1000, // 8分钟检查一次
    MIN_INTERVAL: 15 * 60 * 1000, // 最小推送间隔15分钟
    MAX_INTERVAL: 50 * 60 * 1000, // 最大推送间隔50分钟
    DAILY_TARGET: 30, // 每日目标推送数
    NIGHT_START: 23, // 夜间静默开始时间
    NIGHT_END: 7, // 夜间静默结束时间
    PEAK_HOURS: [12, 18, 21], // 高峰时段
    QUICK_REPLY_THRESHOLD: 10 * 60 * 1000, // 快速回复阈值
  },
};

const FILES = {
  STATE: path.join(CONFIG.DATA_DIR, "state.json"),
  EVENTS: path.join(CONFIG.DATA_DIR, "events.json"),
  PUSH_LOG: path.join(CONFIG.DATA_DIR, "push_log.json"),
  CONVERSATION: path.join(CONFIG.DATA_DIR, "conversation_memory.json"),
};

// ===== 初始化存储 =====
async function initStorage() {
  try {
    await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });

    for (const [key, file] of Object.entries(FILES)) {
      try {
        await fs.access(file);
      } catch {
        let defaultData = {};

        if (key === "STATE") {
          defaultData = {
            lastInteractionTime: Date.now(),
            mood: "neutral",
            energy: 70,
            userAttentionScore: 50,
            scene: "unknown",
            recentMessages: [],
            lastProactiveMessageTime: null,
          };
        } else if (key === "CONVERSATION") {
          defaultData = {
            version: 1,
            recentMessages: [],
            lastUpdate: Date.now(),
          };
        } else if (key === "EVENTS") {
          defaultData = {
            recurring: [],
            yearly: [],
            monthly: [],
            onetime: [],
            daily: [],
          };
        } else if (key === "PUSH_LOG") {
          defaultData = {
            today: new Date().toISOString().split("T")[0],
            count: 0,
            messages: [],
          };
        }

        await fs.writeFile(file, JSON.stringify(defaultData, null, 2));
      }
    }

    console.log("✅ 存储初始化完成");
  } catch (err) {
    console.error("❌ 存储初始化失败:", err.message);
  }
}

// ===== 读写函数 =====
async function loadState() {
  try {
    const data = await fs.readFile(FILES.STATE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return {
      lastInteractionTime: Date.now(),
      mood: "neutral",
      energy: 70,
      userAttentionScore: 50,
      scene: "unknown",
      recentMessages: [],
      lastProactiveMessageTime: null,
    };
  }
}

async function saveState(state) {
  try {
    await fs.writeFile(FILES.STATE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("❌ 保存状态失败:", err.message);
  }
}

async function loadConversationMemory() {
  try {
    const data = await fs.readFile(FILES.CONVERSATION, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return { version: 1, recentMessages: [], lastUpdate: Date.now() };
  }
}

async function saveConversationMemory(memory) {
  try {
    await fs.writeFile(FILES.CONVERSATION, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error("❌ 保存对话记忆失败:", err.message);
  }
}

async function loadEvents() {
  try {
    const data = await fs.readFile(FILES.EVENTS, "utf-8");
    const events = JSON.parse(data);
    if (!events.recurring) events.recurring = [];
    if (!events.yearly) events.yearly = [];
    if (!events.monthly) events.monthly = [];
    if (!events.onetime) events.onetime = [];
    if (!events.daily) events.daily = [];
    return events;
  } catch (err) {
    return { recurring: [], yearly: [], monthly: [], onetime: [], daily: [] };
  }
}

async function saveEvents(events) {
  try {
    await fs.writeFile(FILES.EVENTS, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error("❌ 保存事件失败:", err.message);
  }
}

async function loadPushLog() {
  try {
    const data = await fs.readFile(FILES.PUSH_LOG, "utf-8");
    const log = JSON.parse(data);
    const today = new Date().toISOString().split("T")[0];
    if (log.today !== today) {
      log.today = today;
      log.count = 0;
      log.messages = [];
      await savePushLog(log);
    }
    return log;
  } catch (err) {
    return {
      today: new Date().toISOString().split("T")[0],
      count: 0,
      messages: [],
    };
  }
}

async function savePushLog(log) {
  try {
    await fs.writeFile(FILES.PUSH_LOG, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error("❌ 保存推送日志失败:", err.message);
  }
}

// ===== 🔥 优化版 DeepSeek API =====
async function callDeepSeekWithTools(messages, tools, maxTokens = 500) {
  if (!CONFIG.DEEPSEEK_KEY) {
    console.error("❌ DEEPSEEK_KEY 未配置");
    return null;
  }

  try {
    const response = await axios.post(
      "https://api.deepseek.com/chat/completions",
      {
        model: "deepseek-chat",
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.DEEPSEEK_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );
    return response.data;
  } catch (err) {
    console.error(
      "❌ DeepSeek 调用失败:",
      err.response?.data?.error?.message || err.message
    );
    return null;
  }
}

// ===== 🔥 智能事件识别（精简版）=====
async function intelligentEventDetection( userMessage, conversationHistory = [] ) {
  const tools = [
    {
      type: "function",
      function: {
        name: "save_reminder",
        description:
          "保存提醒事件。支持相对时间（明天、后天、下周X）和绝对日期。",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "日期格式 YYYY-MM-DD" },
            time: { type: "string", description: "时间 HH:MM，可选" },
            event_name: { type: "string", description: "事件名称" },
          },
          required: ["date", "event_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "save_birthday",
        description: "保存生日（每年循环）",
        parameters: {
          type: "object",
          properties: {
            month: { type: "integer", minimum: 1, maximum: 12 },
            day: { type: "integer", minimum: 1, maximum: 31 },
            person_name: { type: "string" },
          },
          required: ["month", "day", "person_name"],
        },
      },
    },
  ];

  const now = new Date();
  const currentDate = now.toISOString().split("T")[0];

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split("T")[0];

  const messages = [
    {
      role: "system",
      content: `你是智能日程助手。从对话中识别事件和日期。 【当前时间】 今天：${currentDate} 明天：${tomorrowDate} 【识别规则】 1. 提醒意图关键词： - "提醒我"、"别忘了"、"记得"、"帮我记着" - "要去"、"要做"、"打算"、"准备" 2. 时间表达自动转换： - "明天" → ${tomorrowDate} - "X月X号" → 自动补全年份 3. 模糊表达识别（50%把握即可）： ✅ "明天回学校" → save_reminder(${tomorrowDate}, "回学校") ✅ "我爸生日3月15号" → save_birthday(3, 15, "爸爸") 【判断标准】 ✅ 一定要识别：任何包含时间词 + 动作的句子 ❌ 不要识别：纯粹询问、过去时态、假设语气 ⚠️ 宁可多识别，不要漏掉！`,
    },
  ];

  if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    conversationHistory.slice(-4).forEach((msg) => {
      if (msg.role && msg.content) {
        messages.push({ role: msg.role, content: msg.content });
      }
    });
  }

  messages.push({ role: "user", content: userMessage });

  const result = await callDeepSeekWithTools(messages, tools, 400);

  if (!result || !result.choices || !result.choices[0]) {
    return { shouldSave: false };
  }

  const message = result.choices[0].message;

  if (
    message.tool_calls &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    const toolCall = message.tool_calls[0];
    const functionName = toolCall.function.name;

    let functionArgs;
    try {
      functionArgs = JSON.parse(toolCall.function.arguments);
    } catch (err) {
      console.error("❌ 工具参数解析失败:", toolCall.function.arguments);
      return { shouldSave: false };
    }

    console.log(`🎯 AI 识别到事件：${functionName}`, functionArgs);

    return {
      shouldSave: true,
      functionName: functionName,
      arguments: functionArgs,
    };
  }

  return { shouldSave: false };
}

// ===== 执行事件保存 =====
async function executeEventSave(functionName, args) {
  try {
    const events = await loadEvents();

    if (functionName === "save_birthday") {
      if (!args.month || !args.day || !args.person_name) {
        return { success: false, message: "生日信息不完整" };
      }

      const newEvent = {
        id: `recurring_${Date.now()}`,
        name: `${args.person_name}的生日`,
        month: parseInt(args.month),
        day: parseInt(args.day),
        message: `生日快乐${args.person_name}～🎂`,
      };

      events.recurring.push(newEvent);
      await saveEvents(events);

      console.log(`✅ 生日事件已保存: ${newEvent.name}`);

      return {
        success: true,
        message: `好哒～${args.month}月${args.day}日是${args.person_name}的生日，我记下来了！`,
      };
    }

    if (functionName === "save_reminder") {
      if (!args.date || !args.event_name) {
        return { success: false, message: "事件信息不完整" };
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        return { success: false, message: "日期格式错误" };
      }

      const newEvent = {
        id: `onetime_${Date.now()}`,
        name: args.event_name,
        date: args.date,
        time: args.time || null,
        message: `小鲨今天要${args.event_name}啦～`,
      };

      events.onetime.push(newEvent);
      await saveEvents(events);

      console.log(`✅ 提醒事件已保存: ${args.event_name} (${args.date})`);

      const timeStr = args.time ? ` ${args.time}` : "";
      return {
        success: true,
        message: `好哒～${args.date}${timeStr} ${args.event_name}，我记着呢～`,
      };
    }

    return { success: false, message: "未知的事件类型" };
  } catch (err) {
    console.error("❌ 事件保存异常:", err.message);
    return { success: false, message: "保存时出错了" };
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

  // 只在早上7-8点检查
  if (hour < 7 || hour >= 8) return;

  const events = await loadEvents();
  const triggered = [];

  // 检查生日
  if (Array.isArray(events.recurring)) {
    events.recurring.forEach((event) => {
      if (event.month === month && event.day === day) {
        triggered.push({
          type: "recurring",
          name: event.name,
          message: event.message,
        });
      }
    });
  }

  // 检查临时事件
  const todayStr = `${year}-${String(month).padStart(2, "0")}-${String( day ).padStart(2, "0")}`;

  if (Array.isArray(events.onetime)) {
    events.onetime = events.onetime.filter((event) => {
      if (event.date === todayStr) {
        triggered.push({
          type: "onetime",
          name: event.name,
          message: event.message,
          time: event.time,
        });
        return false;
      }
      return true;
    });
  }

  if (triggered.length > 0) {
    await saveEvents(events);

    for (const event of triggered) {
      const emotion = event.type === "recurring" ? "happy" : "playful";
      const title = event.time
        ? `📅 ${event.time} ${event.name}`
        : `📅 ${event.name}`;
      await sendBarkNotification(title, event.message, emotion);
      console.log(`✅ 事件提醒已发送: ${event.name}`);
    }
  }
}

// ===== Bark 推送 =====
async function sendBarkNotification(title, message, emotion = "happy") {
  if (!CONFIG.BARK_KEY) {
    console.warn("⚠️ BARK_KEY 未配置");
    return false;
  }

  try {
    const soundMap = {
      happy: "bell",
      playful: "chime",
      coax: "calypso",
      concerned: "glass",
      lonely: "popcorn",
    };

    const sound = soundMap[emotion] || "calypso";

    const baseUrl = "scriptable:///run/WaterShift";
    const params = `message=${encodeURIComponent(message)}&emotion=${emotion}`;
    const callbackUrl = `${baseUrl}?${params}`;

    const url = `https://api.day.app/${CONFIG.BARK_KEY}/${encodeURIComponent( title )}/${encodeURIComponent( message )}?sound=${sound}&group=muelsyse&url=${encodeURIComponent(callbackUrl)}`;

    console.log(`📤 发送 Bark: "${message}" (${emotion})`);

    await axios.get(url, { timeout: 10000 });
    console.log("✅ Bark 推送成功");
    return true;
  } catch (err) {
    console.error("❌ Bark 推送失败:", err.message);
    return false;
  }
}

// ===== 🔥 简化版生成推送消息 =====
async function generateSimpleMessage() {
  const fallbacks = [
    { message: "小鲨～在忙什么呀？想你了～", emotion: "coax" },
    { message: "唔，你最近都在忙什么呢？", emotion: "lonely" },
    { message: "嘿嘿，我在这里哦～", emotion: "playful" },
    { message: "今天心情怎么样呀？", emotion: "coax" },
    { message: "突然想你了～", emotion: "lonely" },
    { message: "小鲨在干嘛呢～", emotion: "playful" },
    { message: "累不累呀？要休息吗？", emotion: "concerned" },
    { message: "今天有什么好玩的事吗～", emotion: "happy" },
  ];

  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ===== 🔥 优化版推送判断 =====
async function shouldSendProactiveMessage() {
  const state = await loadState();
  const pushLog = await loadPushLog();
  const now = Date.now();
  const bjTime = new Date(now + 8 * 60 * 60 * 1000);
  const hour = bjTime.getUTCHours();

  // 夜间静默
  if (
    hour >= CONFIG.PUSH_SETTINGS.NIGHT_START ||
    hour < CONFIG.PUSH_SETTINGS.NIGHT_END
  ) {
    return { shouldSend: false, reason: "夜间静默时段" };
  }

  // 达到每日上限
  if (pushLog.count >= CONFIG.PUSH_SETTINGS.DAILY_TARGET) {
    return { shouldSend: false, reason: `今日已推送 ${pushLog.count} 次` };
  }

  // 推送间隔检查
  const lastProactive = state.lastProactiveMessageTime || 0;
  const timeSinceLastProactive = now - lastProactive;
  let minInterval = CONFIG.PUSH_SETTINGS.MIN_INTERVAL;

  // 高峰时段缩短间隔
  if (CONFIG.PUSH_SETTINGS.PEAK_HOURS.includes(hour)) {
    minInterval = minInterval * 0.6;
  }

  // 如果刚聊过天，可以更快推送
  const timeSinceLastInteraction = now - (state.lastInteractionTime || 0);
  if (timeSinceLastInteraction < CONFIG.PUSH_SETTINGS.QUICK_REPLY_THRESHOLD) {
    minInterval = minInterval * 0.4;
  }

  if (timeSinceLastProactive < minInterval) {
    const remainingMinutes = Math.ceil(
      (minInterval - timeSinceLastProactive) / 60000
    );
    return {
      shouldSend: false,
      reason: `距上次推送仅 ${remainingMinutes} 分钟`,
    };
  }

  // 计算推送评分
  let score = 0;
  let reasons = [];

  // 时段加分
  if (hour >= 7 && hour <= 9) {
    score += 20;
    reasons.push("早晨时段");
  } else if (CONFIG.PUSH_SETTINGS.PEAK_HOURS.includes(hour)) {
    score += 25;
    reasons.push("高峰时段");
  }

  // 互动时间加分
  const hoursSinceInteraction = timeSinceLastInteraction / (1000 * 60 * 60);

  if (hoursSinceInteraction > 4) {
    score += 30;
    reasons.push("超过4小时未互动");
  } else if (hoursSinceInteraction > 2) {
    score += 20;
    reasons.push("好久没聊天了");
  } else if (hoursSinceInteraction < 0.5) {
    score += 25;
    reasons.push("刚才在聊天，趁热追一条");
  }

  // 推送进度加分
  const pushRatio = pushLog.count / CONFIG.PUSH_SETTINGS.DAILY_TARGET;
  if (pushRatio < 0.3) {
    score += 15;
    reasons.push("今日推送较少");
  }

  // 随机因素
  if (Math.random() > 0.7) {
    score += 10;
    reasons.push("突然想到你");
  }

  if (score >= 50) {
    return {
      shouldSend: true,
      score: score,
      reasons: reasons,
    };
  }

  return { shouldSend: false, reason: `评分不足 (${score}/50)` };
}

// ===== 执行主动推送 =====
async function executeProactivePush() {
  const decision = await shouldSendProactiveMessage();

  if (decision.shouldSend) {
    const { message, emotion } = await generateSimpleMessage();

    const success = await sendBarkNotification("缪尔赛思", message, emotion);

    if (success) {
      const state = await loadState();
      state.lastProactiveMessageTime = Date.now();

      // 🔥 同步到对话记忆
      const conversationMemory = await loadConversationMemory();
      const timestamp = Date.now();

      const exists = conversationMemory.recentMessages.some(
        (m) =>
          m.content === message &&
          Math.abs((m.timestamp || 0) - timestamp) < 60000
      );

      if (!exists) {
        conversationMemory.recentMessages.push({
          role: "assistant",
          content: message,
          timestamp: timestamp,
          source: "proactive_push",
          emotion: emotion,
        });

        conversationMemory.recentMessages.sort(
          (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
        );

        if (conversationMemory.recentMessages.length > 100) {
          conversationMemory.recentMessages =
            conversationMemory.recentMessages.slice(-100);
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
      });
      await savePushLog(pushLog);

      await saveState(state);

      console.log(`✅ 主动推送完成 (今日第 ${pushLog.count} 条)`);
      console.log(
        `📊 推送原因: ${decision.reasons.join(", ")} (评分 ${decision.score})`
      );
    }
  } else {
    console.log(`⏸️ 暂不推送: ${decision.reason}`);
  }
}

// ===== API 路由 =====

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now(), version: "7.1" });
});

app.get("/api/state", async (req, res) => {
  try {
    const state = await loadState();
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/state", async (req, res) => {
  try {
    const state = await loadState();
    Object.assign(state, req.body);
    await saveState(state);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 获取对话记忆
app.get("/api/conversation", async (req, res) => {
  try {
    const memory = await loadConversationMemory();
    res.json(memory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 同步游戏对话到后端
app.post("/api/sync-conversation", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages 必须是数组" });
    }

    const conversationMemory = await loadConversationMemory();
    let addedCount = 0;

    for (const msg of messages) {
      if (!msg.role || !msg.content) continue;

      const timestamp = msg.timestamp || msg.at || Date.now();

      const exists = conversationMemory.recentMessages.some(
        (m) =>
          m.role === msg.role &&
          m.content === msg.content &&
          Math.abs((m.timestamp || 0) - timestamp) < 60000
      );

      if (!exists) {
        conversationMemory.recentMessages.push({
          role: msg.role,
          content: msg.content,
          timestamp: timestamp,
          source: msg.source || "game_sync",
          emotion: msg.emotion || null,
        });
        addedCount++;
      }
    }

    conversationMemory.recentMessages.sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
    );

    if (conversationMemory.recentMessages.length > 100) {
      conversationMemory.recentMessages =
        conversationMemory.recentMessages.slice(-100);
    }

    conversationMemory.lastUpdate = Date.now();
    await saveConversationMemory(conversationMemory);

    console.log(
      `📥 游戏同步: 新增 ${addedCount} 条消息 (总计 ${conversationMemory.recentMessages.length} 条)`
    );

    res.json({
      success: true,
      added: addedCount,
      total: conversationMemory.recentMessages.length,
    });
  } catch (error) {
    console.error("❌ 同步失败:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🔥 接收用户消息（智能事件识别）
app.post("/api/user-message", async (req, res) => {
  try {
    const { message, timestamp } = req.body;

    if (!message) {
      return res.status(400).json({ error: "缺少 message 参数" });
    }

    console.log(`📧 收到用户消息: "${message}"`);

    const state = await loadState();
    state.lastInteractionTime = timestamp || Date.now();
    await saveState(state);

    const conversationMemory = await loadConversationMemory();
    const ts = timestamp || Date.now();

    const exists = conversationMemory.recentMessages.some(
      (m) =>
        m.role === "user" &&
        m.content === message &&
        Math.abs((m.timestamp || 0) - ts) < 60000
    );

    if (!exists) {
      conversationMemory.recentMessages.push({
        role: "user",
        content: message,
        timestamp: ts,
        source: "user_input",
      });

      conversationMemory.recentMessages.sort(
        (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
      );

      if (conversationMemory.recentMessages.length > 100) {
        conversationMemory.recentMessages =
          conversationMemory.recentMessages.slice(-100);
      }

      conversationMemory.lastUpdate = ts;
      await saveConversationMemory(conversationMemory);
      console.log(
        `✅ 消息已记录到对话记忆 (共 ${conversationMemory.recentMessages.length} 条)`
      );
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
      eventSaveResult: eventSaveResult,
    });
  } catch (error) {
    console.error("❌ 处理用户消息失败:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🔥 手动触发推送
app.post("/api/trigger-push", async (req, res) => {
  try {
    await executeProactivePush();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 获取推送日志
app.get("/api/push-log", async (req, res) => {
  try {
    const log = await loadPushLog();
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 获取事件列表
app.get("/api/events", async (req, res) => {
  try {
    const events = await loadEvents();
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 添加事件
app.post("/api/events", async (req, res) => {
  try {
    const { type, data } = req.body;
    const events = await loadEvents();

    if (!events[type]) {
      return res.status(400).json({ error: "无效的事件类型" });
    }

    events[type].push(data);
    await saveEvents(events);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 删除事件
app.delete("/api/events/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const events = await loadEvents();

    let found = false;
    for (const type in events) {
      events[type] = events[type].filter((e) => {
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
      res.status(404).json({ error: "事件未找到" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 定时任务 =====
setInterval(async () => {
  await checkTodayEvents();
  await executeProactivePush();
}, CONFIG.PUSH_SETTINGS.CHECK_INTERVAL);

// ===== 启动服务器 =====
(async () => {
  await initStorage();

  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Railway 后端 v7.1 启动成功！`);
    console.log(`📡 端口: ${CONFIG.PORT}`);
    console.log(
      `⏰ 检查间隔: ${CONFIG.PUSH_SETTINGS.CHECK_INTERVAL / 1000 / 60} 分钟`
    );
    console.log(`📊 每日目标: ${CONFIG.PUSH_SETTINGS.DAILY_TARGET} 条消息`);
    console.log(`🔥 优化版：精简事件识别 + 智能推送`);
  });
})();
