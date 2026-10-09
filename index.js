const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

// ========== 配置 ==========
const CONFIG = {
  BARK_KEY: (process.env.BARK_KEY || '').trim(),
  DEEPSEEK_KEY: (process.env.DEEPSEEK_KEY || '').trim(),
  CHECK_INTERVAL: Math.max(5 * 60 * 1000, parseInt(process.env.CHECK_INTERVAL, 10) || 15 * 60 * 1000),
  SILENT_HOURS: { start: 1, end: 7 },
  WORK_HOURS: { start: 9, end: 17 },
  MAX_MESSAGE_LENGTH: 100,
  MAX_CONTEXT_LENGTH: 1500
};

console.log('🔑 配置状态：');
console.log('   Bark Key:', CONFIG.BARK_KEY ? '✅' : '❌');
console.log('   DeepSeek Key:', CONFIG.DEEPSEEK_KEY ? '✅' : '❌');

// ========== 状态 ==========
let gameState = null;
let userData = {
  lastProactiveMessageTime: 0,
  totalMessages: 0
};

let isMainLoopRunning = false;
let mainLoopTimer = null;
let isShuttingDown = false;

// ========== 人设 ==========
const MUELSYSE_PERSONA = `你是缪尔赛思，精灵，莱茵生命生态科主任。
对小鲨有依恋，会主动关心。
性格温柔俏皮，口语化。
消息必须简短（50字内）。`;

// ========== 安全工具 ==========
function getBeijingTime() {
  try {
    const now = Date.now();
    
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Invalid timestamp');
    }
    
    const utcDate = new Date(now);
    
    if (isNaN(utcDate.getTime())) {
      throw new Error('Invalid date');
    }
    
    const utcHours = utcDate.getUTCHours();
    const beijingHour = (utcHours + 8) % 24;
    
    const minute = String(utcDate.getUTCMinutes()).padStart(2, '0');
    const timeStr = `${String(beijingHour).padStart(2, '0')}:${minute}`;
    
    return {
      hour: beijingHour,
      time: timeStr,
      timestamp: now
    };
  } catch (error) {
    console.error('时间获取失败:', error.message);
    return { hour: 12, time: '12:00', timestamp: Date.now() };
  }
}

function isSilentHours() {
  try {
    const { hour } = getBeijingTime();
    if (typeof hour !== 'number' || isNaN(hour)) return false;
    return hour >= CONFIG.SILENT_HOURS.start && hour < CONFIG.SILENT_HOURS.end;
  } catch {
    return false;
  }
}

function isWorkHours() {
  try {
    const { hour } = getBeijingTime();
    if (typeof hour !== 'number' || isNaN(hour)) return false;
    return hour >= CONFIG.WORK_HOURS.start && hour < CONFIG.WORK_HOURS.end;
  } catch {
    return false;
  }
}

function safeNumber(value, defaultValue = 0, min = -Infinity, max = Infinity) {
  try {
    const num = Number(value);
    if (isNaN(num) || !isFinite(num)) return defaultValue;
    return Math.max(min, Math.min(max, num));
  } catch {
    return defaultValue;
  }
}

function safeString(str, maxLength = 200) {
  try {
    if (str === null || str === undefined) return '';
    
    let converted = String(str);
    
    if (converted.length > maxLength) {
      converted = converted.substring(0, maxLength);
    }
    
    converted = converted.replace(/[\r\n\t`]/g, ' ');
    converted = converted.replace(/[\x00-\x1F\x7F]/g, '');
    
    return converted;
  } catch {
    return '';
  }
}

function safeEncode(str) {
  try {
    if (!str) return '';
    return encodeURIComponent(String(str));
  } catch (error) {
    console.error('编码失败:', error.message);
    return '';
  }
}

function createTimeoutPromise(ms) {
  let timeoutId;
  const promise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Timeout')), ms);
  });
  
  return {
    promise,
    clear: () => clearTimeout(timeoutId)
  };
}

// ========== API ==========
app.post('/api/update-state', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, message: '数据格式错误' });
    }
    
    const rawMessages = req.body.recentMessages;
    const safeMessages = [];
    
    if (Array.isArray(rawMessages) && rawMessages.length > 0) {
      const count = Math.min(rawMessages.length, 5);
      for (let i = 0; i < count; i++) {
        const m = rawMessages[i];
        if (m && typeof m === 'object') {
          safeMessages.push({
            role: safeString(m.role, 50),
            content: safeString(m.content, 200)
          });
        }
      }
    }
    
    gameState = {
      lastInteractionTime: safeNumber(req.body.lastInteractionTime, Date.now(), 0, Date.now() + 86400000),
      mood: safeString(req.body.mood, 20) || 'neutral',
      energy: safeNumber(req.body.energy, 70, 0, 100),
      userAttentionScore: safeNumber(req.body.userAttentionScore, 50, 0, 100),
      scene: safeString(req.body.scene, 50) || 'unknown',
      recentMessages: safeMessages,
      receivedAt: Date.now()
    };
    
    console.log('✅ 状态同步 - 心情:', gameState.mood, '能量:', gameState.energy);
    
    res.json({ success: true, message: '状态已更新' });
  } catch (error) {
    console.error('❌ 更新状态异常:', error.message);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

app.get('/api/state', (req, res) => {
  res.json(gameState || { message: '暂无状态' });
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    version: '2.2',
    hasState: !!gameState,
    config: {
      hasBark: !!CONFIG.BARK_KEY,
      hasDeepseek: !!CONFIG.DEEPSEEK_KEY
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ========== AI 判断 ==========
async function shouldSendProactiveMessage() {
  if (!CONFIG.DEEPSEEK_KEY) {
    return { shouldSend: false, reasoning: 'DeepSeek未配置' };
  }

  if (!gameState || !gameState.lastInteractionTime) {
    return { shouldSend: false, reasoning: '无状态' };
  }

  const now = Date.now();
  const timeDiff = now - gameState.lastInteractionTime;
  
  if (timeDiff < 0 || timeDiff > 365 * 24 * 60 * 60 * 1000) {
    return { shouldSend: false, reasoning: '时间异常' };
  }
  
  const hoursSince = timeDiff / (60 * 60 * 1000);
  const { time } = getBeijingTime();
  const minutesAgo = Math.min(9999, Math.abs((now - (gameState.receivedAt || now)) / 60000));

  const msgList = [];
  if (Array.isArray(gameState.recentMessages)) {
    for (let i = 0; i < Math.min(gameState.recentMessages.length, 3); i++) {
      const m = gameState.recentMessages[i];
      if (m && m.content) {
        const role = m.role === 'user' ? '小鲨' : '缪';
        const content = safeString(m.content, 30);
        msgList.push(`${i + 1}.${role}:${content}`);
      }
    }
  }
  
  const messagesText = msgList.length > 0 ? msgList.join('\n') : '无';

  const context = `时间:${time}
距离:${hoursSince.toFixed(1)}h
工作:${isWorkHours()?'是':'否'}
状态(${Math.floor(minutesAgo)}分钟前):
心情:${gameState.mood} 能量:${gameState.energy}
对话:
${messagesText}`.substring(0, CONFIG.MAX_CONTEXT_LENGTH);

  const prompt = `${MUELSYSE_PERSONA}

${context}

规则:
1.更新<30分钟→不发
2.能量<40→不发
3.凌晨1-7点→不发
4.工作时间且<4h→不发
5.>6h→可发

JSON:
{"shouldSend":true/false,"message":"50字内","emotion":"happy/lonely","reasoning":"原因"}`;

  const timeout = createTimeoutPromise(25000);

  try {
    const response = await Promise.race([
      axios.post(
        'https://api.deepseek.com/chat/completions',
        {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: MUELSYSE_PERSONA },
            { role: 'user', content: prompt }
          ],
          temperature: 1.0,
          response_format: { type: 'json_object' },
          max_tokens: 300
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.DEEPSEEK_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      ),
      timeout.promise
    ]);

    timeout.clear();

    if (!response?.data?.choices?.[0]?.message?.content) {
      throw new Error('API响应无效');
    }

    const rawContent = String(response.data.choices[0].message.content).trim();
    
    const jsonStart = rawContent.indexOf('{');
    const jsonEnd = rawContent.lastIndexOf('}');
    
    if (jsonStart === -1 || jsonEnd === -1 || jsonStart >= jsonEnd) {
      throw new Error('无法找到JSON');
    }
    
    const jsonStr = rawContent.substring(jsonStart, jsonEnd + 1);
    const result = JSON.parse(jsonStr);

    if (typeof result.shouldSend !== 'boolean') {
      throw new Error('shouldSend无效');
    }

    if (result.message) {
      result.message = safeString(result.message, CONFIG.MAX_MESSAGE_LENGTH);
    }

    console.log('🤖', result.shouldSend ? '✅发送' : '❌不发', '-', result.reasoning || '');

    return result;

  } catch (error) {
    timeout.clear();
    
    console.error('❌ AI失败:', String(error.message).substring(0, 100));

    if (hoursSince > 12 && !isSilentHours()) {
      return {
        shouldSend: true,
        message: '最近在忙吗～',
        emotion: 'lonely',
        reasoning: `Fallback(${hoursSince.toFixed(1)}h)`
      };
    }

    return { shouldSend: false, reasoning: 'AI失败' };
  }
}

// ========== Bark ==========
async function sendBarkNotification(message, emotion = 'normal') {
  if (!CONFIG.BARK_KEY) {
    console.error('❌ Bark未配置');
    return false;
  }

  if (!message || typeof message !== 'string') {
    console.error('❌ 消息无效');
    return false;
  }

  try {
    const sounds = { 
      happy: 'bell', 
      playful: 'chime', 
      concerned: 'glass', 
      lonely: 'popcorn' 
    };
    const sound = sounds[emotion] || 'calypso';
    
    const safeMsg = safeString(message, 100);
    const encodedMsg = safeEncode(safeMsg);
    const encodedEmotion = safeEncode(String(emotion).substring(0, 20));
    
    if (!encodedMsg) {
      throw new Error('编码失败');
    }

    const urlScheme = `scriptable:///run/WaterShift?message=${encodedMsg}&emotion=${encodedEmotion}`;
    const encodedScheme = safeEncode(urlScheme);
    
    const barkUrl = `https://api.day.app/${CONFIG.BARK_KEY}/缪尔赛思/${encodedMsg}?sound=${sound}&url=${encodedScheme}`;

    if (barkUrl.length > 2000) {
      console.warn('⚠️ URL过长');
      return false;
    }

    await axios.get(barkUrl, { timeout: 10000 });
    
    userData.totalMessages++;
    userData.lastProactiveMessageTime = Date.now();
    
    console.log('✅ Bark推送成功');
    return true;

  } catch (error) {
    console.error('❌ Bark失败:', String(error.message).substring(0, 50));
    return false;
  }
}

// ========== 主循环 ==========
async function mainLoop() {
  if (isMainLoopRunning) {
    console.log('⏭️ 跳过');
    return;
  }

  isMainLoopRunning = true;

  try {
    const { time } = getBeijingTime();
    console.log(`\n⏰ ${time}`);

    if (isSilentHours()) {
      console.log('🌙 静默');
      return;
    }

    const decision = await shouldSendProactiveMessage();

    if (decision.shouldSend && decision.message) {
      await sendBarkNotification(decision.message, decision.emotion);
    } else {
      console.log('🤐', decision.reasoning);
    }

  } catch (error) {
    console.error('❌ 主循环异常:', String(error.message).substring(0, 100));
  } finally {
    isMainLoopRunning = false;
  }
}

// ========== 启动 ==========
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`\n🚀 缪尔赛思后端 v2.2 端口 ${PORT}`);
  console.log(`⏱️  ${CONFIG.CHECK_INTERVAL / 60000}分钟检查一次\n`);

  setTimeout(() => {
    console.log('🎯 首次检查');
    mainLoop();
    mainLoopTimer = setInterval(mainLoop, CONFIG.CHECK_INTERVAL);
  }, 5000);
});

// ========== 优雅退出 ==========
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n👋 ${signal}`);

  if (mainLoopTimer) {
    clearInterval(mainLoopTimer);
    mainLoopTimer = null;
  }

  const forceTimeout = setTimeout(() => {
    console.log('⚠️ 强制退出');
    process.exit(1);
  }, 3000);
  
  forceTimeout.unref();

  try {
    server.close(() => {
      clearTimeout(forceTimeout);
      console.log('✅ 已关闭');
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ 关闭失败:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获异常:', String(error.message).substring(0, 200));
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理Promise:', String(reason).substring(0, 200));
});
