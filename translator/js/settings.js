// 全部設定存在 localStorage，純前端 BYOK：API key 只留在這台裝置。

const STORAGE_KEY = 'liveTranslator.settings.v1';

export const ENGINES = {
  translate: {
    id: 'translate',
    model: 'gemini-3.5-live-translate-preview',
    label: 'Gemini 3.5 Live Translate（口譯，語音+字幕）',
  },
  flashLive: {
    id: 'flashLive',
    model: 'gemini-3.1-flash-live-preview',
    label: 'Gemini 3.1 Flash Live（省額度，僅字幕，回合制）',
  },
};

const DEFAULTS = {
  apiKey: '',
  myLang: 'zh-Hant',
  theirLang: 'en',
  engine: 'translate',
  voiceOutput: true,
  conversationMode: 'manual', // 'manual' 省額度單連線 | 'auto' 雙連線自動辨向
  vadEnabled: true,
  vadThreshold: 0.012, // RMS 門檻（0–1）
  vadHangoverMs: 900, // 語音結束後继续送出的緩衝時間
  holdVoice: false, // 交替口譯：等說話者停頓後才播口譯語音
  holdReleaseSec: 1.0, // 停頓多久判定「說完了」（可調延遲程度）
  idleDisconnectMin: 2, // 靜音幾分鐘後自動斷線省額度（0 = 不斷線）
  dailyBudgetMin: 60, // 每日用量警示門檻（分鐘，0 = 不提醒）
  layout: 'auto', // 'auto' | 'immersive' | 'dashboard'
  demoMode: false,
  fontScale: 1,
};

let cached = null;

export function loadSettings() {
  if (cached) return cached;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    stored = {};
  }
  cached = { ...DEFAULTS, ...stored };
  return cached;
}

export function saveSettings(patch) {
  cached = { ...loadSettings(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: cached }));
  return cached;
}

export function hasApiKey() {
  return Boolean(loadSettings().apiKey?.trim());
}

// 偏好的實際版面：auto 時手機→沉浸、桌機→儀表板
export function resolveLayout(settings = loadSettings()) {
  if (settings.layout !== 'auto') return settings.layout;
  const isMobile = matchMedia('(max-width: 768px), (pointer: coarse) and (max-width: 1024px)').matches;
  return isMobile ? 'immersive' : 'dashboard';
}
