// 連線自我診斷：key、模型可用性、WebSocket setup、麥克風收音。結果可複製回報。

import { MODEL } from './settings.js';
import { LiveSession } from './live.js';

const REST = 'https://generativelanguage.googleapis.com/v1beta';

export async function runDiagnostics(settings, onProgress) {
  const results = [];
  const push = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    onProgress?.(results);
  };

  const key = settings.apiKey?.trim();
  if (!key) {
    push('API key', false, '尚未設定');
    return results;
  }
  push('API key 格式', /^AIza[0-9A-Za-z_-]{20,}$/.test(key), key.slice(0, 6) + '…');

  try {
    const resp = await fetch(`${REST}/models?pageSize=1000&key=${encodeURIComponent(key)}`);
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { msg += `：${(await resp.json()).error?.message || ''}`; } catch { /* keep */ }
      push('key 有效性（REST）', false, msg.slice(0, 200));
      return results;
    }
    push('key 有效性（REST）', true, 'API 回應正常');
    const names = ((await resp.json()).models || []).map((m) => m.name.replace('models/', ''));
    const has = names.includes(MODEL);
    push(`模型 ${MODEL}`, has, has ? '此 key 可存取' : `清單中找不到（共 ${names.length} 個模型），此 preview 模型可能尚未開放給你的專案/地區`);
  } catch (err) {
    push('key 有效性（REST）', false, `網路錯誤：${err?.message || err}`);
  }

  await new Promise((resolve) => {
    const s = new LiveSession({ apiKey: key, target: settings.foreignLang || 'en', tag: 'diag' });
    const timer = setTimeout(() => {
      push('Live WebSocket 連線', false, '10 秒逾時');
      s.close(); resolve();
    }, 10000);
    s.addEventListener('status', (e) => {
      if (e.detail.state === 'open') {
        clearTimeout(timer);
        push('Live WebSocket 連線', true, `setup 成功（schema variant #${s.variantIndex + 1}）`);
        s.close(); resolve();
      }
    });
    s.addEventListener('fatal', (e) => {
      clearTimeout(timer);
      push('Live WebSocket 連線', false, `${e.detail.reason || ''}（code ${e.detail.code ?? '?'}）`);
      resolve();
    });
    s.connect();
  });

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
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
    push('麥克風收音', peak > 0.001, `峰值 RMS ${peak.toFixed(4)}`);
  } catch (err) {
    push('麥克風收音', false, `${err?.name || ''} ${err?.message || err}`);
  }

  return results;
}

export function formatDiagnostics(results) {
  return results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n');
}
