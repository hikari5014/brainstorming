// 設定：全部存 localStorage，BYOK —— API key 只留在這台裝置。

const KEY = 'kouyiji.settings.v1';

export const MODEL = 'gemini-3.5-live-translate-preview';

const DEFAULTS = {
  apiKey: '',
  foreignLang: 'en',
  demoMode: false,
  fontScale: 1,
  idleDisconnectMin: 5, // 幾分鐘沒對話就斷線省額度（按鈕按下自動重連）
};

let cached = null;

export function loadSettings() {
  if (cached) return cached;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* fresh */ }
  cached = { ...DEFAULTS, ...stored };
  return cached;
}

export function saveSettings(patch) {
  cached = { ...loadSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cached));
  return cached;
}
