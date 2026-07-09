// 連線自我診斷：逐項檢查 key、模型、WebSocket setup、麥克風收音，
// 讓「不能用」變成可以回報的具體錯誤。

import { ENGINES } from './settings.js';
import { LiveSession } from './live/client.js';

const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function runDiagnostics(settings, onProgress) {
  const results = [];
  const push = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    onProgress?.(results);
  };

  // 1. key 基本檢查
  const key = settings.apiKey?.trim();
  if (!key) {
    push('API key', false, '尚未設定（設定 → Gemini API key）');
    return results;
  }
  push('API key 格式', /^AIza[0-9A-Za-z_-]{20,}$/.test(key), key.slice(0, 6) + '…');

  // 2. REST：key 是否有效、模型是否可見
  const engineDef = ENGINES[settings.engine] || ENGINES.translate;
  try {
    const resp = await fetch(`${REST_BASE}/models?pageSize=1000&key=${encodeURIComponent(key)}`);
    if (!resp.ok) {
      const body = await resp.text();
      let msg = `HTTP ${resp.status}`;
      try { msg += `：${JSON.parse(body).error?.message || ''}`; } catch { /* keep */ }
      push('key 有效性（REST）', false, msg.slice(0, 200));
      return results;
    }
    push('key 有效性（REST）', true, 'API 回應正常');
    const data = await resp.json();
    const names = (data.models || []).map((m) => m.name.replace('models/', ''));
    const hasModel = names.includes(engineDef.model);
    push(
      `模型 ${engineDef.model}`,
      hasModel,
      hasModel ? '此 key 可存取' : `此 key 的模型清單中找不到（共 ${names.length} 個模型）。可能地區/專案尚未開放此 preview 模型，可到設定換引擎。`
    );
  } catch (err) {
    push('key 有效性（REST）', false, `網路錯誤：${err?.message || err}`);
  }

  // 3. WebSocket setup 實測
  await new Promise((resolve) => {
    const session = new LiveSession({
      apiKey: key,
      engine: engineDef.id,
      model: engineDef.model,
      target: settings.myLang || 'zh-Hant',
      echoTargetLanguage: false,
      tag: 'diag',
    });
    const timer = setTimeout(() => {
      push('Live WebSocket 連線', false, '10 秒內未完成 setup（逾時）');
      session.close();
      resolve();
    }, 10000);
    session.addEventListener('status', (e) => {
      if (e.detail.state === 'open') {
        clearTimeout(timer);
        push('Live WebSocket 連線', true, `setup 成功（schema variant #${session.variantIndex + 1}）`);
        session.close();
        resolve();
      }
    });
    session.addEventListener('fatal', (e) => {
      clearTimeout(timer);
      push('Live WebSocket 連線', false, `${e.detail.reason || ''}（code ${e.detail.code ?? '?'}）`);
      resolve();
    });
    session.connect();
  });

  // 4. 麥克風收音
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const t0 = Date.now();
    await new Promise((r) => {
      const iv = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        peak = Math.max(peak, Math.sqrt(sum / buf.length));
        if (Date.now() - t0 > 1800) { clearInterval(iv); r(); }
      }, 100);
    });
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close().catch(() => {});
    const vadThreshold = settings.vadThreshold ?? 0.012;
    push(
      '麥克風收音',
      peak > 0.001,
      `峰值 RMS ${peak.toFixed(4)}${peak < vadThreshold ? `（低於 VAD 門檻 ${vadThreshold}，請說話測試或調低靈敏度）` : ''}`
    );
  } catch (err) {
    push('麥克風收音', false, `${err?.name || ''} ${err?.message || err}`);
  }

  return results;
}

export function formatDiagnostics(results) {
  return results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n');
}
