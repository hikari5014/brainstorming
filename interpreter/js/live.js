// Gemini Live Translate 的 WebSocket 客戶端（零依賴）＋ Demo 假引擎。
// 協定沿用前一代已驗證的實作：
//   - setup schema variants：preview API 欄位搬動時自動降級重試
//   - session resumption + goAway 無縫續連（純音訊 session 約 15 分鐘上限）
//   - 斷線指數退避重連
// 事件：status / input-text / output-text / audio / turn-complete / fatal

import { MODEL } from './settings.js';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MAX_RECONNECT = 5;

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 官方 raw WebSocket 範例的欄位位置為主，備援兩種變體
function setupVariants(target, resumeHandle) {
  const resumption = resumeHandle === undefined ? {} : { handle: resumeHandle };
  const genCfg = {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    translationConfig: { targetLanguageCode: target, echoTargetLanguage: false },
  };
  return [
    { setup: { model: `models/${MODEL}`, generationConfig: genCfg, sessionResumption: resumption } },
    { setup: { model: `models/${MODEL}`, generationConfig: genCfg } },
    {
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: genCfg.translationConfig,
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    },
  ];
}

export class LiveSession extends EventTarget {
  constructor({ apiKey, target, tag }) {
    super();
    this.apiKey = apiKey;
    this.target = target;
    this.tag = tag;
    this.ws = null;
    this.state = 'idle';
    this.setupDone = false;
    this.variantIndex = 0;
    this.resumeHandle = undefined;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    this.sentSeconds = 0;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { ...detail, tag: this.tag } }));
  }

  setState(state, extra) {
    this.state = state;
    this.emit('status', { state, ...extra });
  }

  connect() {
    this.closedByUser = false;
    this.openSocket();
  }

  openSocket() {
    this.setupDone = false;
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.apiKey)}`);
    this.ws = ws;

    ws.onopen = () => {
      const variants = setupVariants(this.target, this.resumeHandle);
      ws.send(JSON.stringify(variants[Math.min(this.variantIndex, variants.length - 1)]));
    };

    ws.onmessage = async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      this.handleMessage(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) { this.setState('closed'); return; }
      if (!this.setupDone) { this.handleSetupRejected(ev); return; }
      this.scheduleReconnect(ev);
    };
    ws.onerror = () => { /* onclose 接手 */ };
  }

  handleSetupRejected(ev) {
    if (this.variantIndex < setupVariants(this.target).length - 1) {
      this.variantIndex += 1;
      this.openSocket();
      return;
    }
    this.setState('error');
    this.emit('fatal', { reason: ev.reason || `WebSocket closed (code ${ev.code})`, code: ev.code });
  }

  scheduleReconnect(ev) {
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      this.setState('error');
      this.emit('fatal', { reason: ev.reason || '多次重連失敗', code: ev.code });
      return;
    }
    const delay = 500 * 2 ** this.reconnectAttempts;
    this.reconnectAttempts += 1;
    this.setState('reconnecting', { attempt: this.reconnectAttempts });
    setTimeout(() => { if (!this.closedByUser) this.openSocket(); }, delay);
  }

  handleMessage(msg) {
    if (msg.setupComplete !== undefined) {
      this.setupDone = true;
      this.reconnectAttempts = 0;
      this.setState('open');
      return;
    }
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.resumeHandle = u.newHandle;
      return;
    }
    if (msg.goAway) {
      const ws = this.ws;
      this.ws = null;
      ws?.close();
      this.openSocket(); // 主動無縫續連
      return;
    }
    const c = msg.serverContent;
    if (!c) return;
    if (c.inputTranscription?.text) {
      this.emit('input-text', { text: c.inputTranscription.text, languageCode: c.inputTranscription.languageCode });
    }
    if (c.outputTranscription?.text) {
      this.emit('output-text', { text: c.outputTranscription.text, languageCode: c.outputTranscription.languageCode });
    }
    if (c.modelTurn?.parts) {
      for (const part of c.modelTurn.parts) {
        if (part.inlineData?.data) this.emit('audio', { base64: part.inlineData.data });
      }
    }
    if (c.turnComplete || c.generationComplete) this.emit('turn-complete', {});
  }

  sendAudio(int16) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupDone) return false;
    this.ws.send(JSON.stringify({
      realtimeInput: { audio: { data: int16ToBase64(int16), mimeType: 'audio/pcm;rate=16000' } },
    }));
    this.sentSeconds += int16.length / 16000;
    return true;
  }

  close() {
    this.closedByUser = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setState('closed');
  }
}

/* ---------- Demo 假引擎：不連網、不需 key，用來試玩與自動化測試 ---------- */

const DEMO = {
  toForeign: [
    { src: '請問這附近有推薦的餐廳嗎？', dst: 'Excuse me, is there a restaurant you would recommend nearby?' },
    { src: '我想要兩張到台北的票。', dst: 'I would like two tickets to Taipei, please.' },
  ],
  toMine: [
    { src: 'Hello! Where would you like to go today?', dst: '哈囉！你今天想去哪裡呢？' },
    { src: 'The next train arrives in five minutes.', dst: '下一班列車五分鐘後抵達。' },
  ],
};

function beepBase64() {
  const n = Math.floor(24000 * 0.4);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 400, (n - i) / 2400);
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 523 * i) / 24000) * 0.22 * env * 0x7fff);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class MockSession extends EventTarget {
  constructor({ tag }) {
    super();
    this.tag = tag;
    this.state = 'idle';
    this.chunks = 0;
    this.idx = 0;
    this.gapTimer = null;
    this.sentSeconds = 0;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { ...detail, tag: this.tag } }));
  }

  connect() {
    this.state = 'connecting';
    this.emit('status', { state: 'connecting' });
    setTimeout(() => { this.state = 'open'; this.emit('status', { state: 'open' }); }, 250);
  }

  sendAudio(int16) {
    if (this.state !== 'open') return false;
    this.sentSeconds += int16.length / 16000;
    this.chunks += 1;
    clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => {
      if (this.chunks >= 3) this.playPhrase();
      this.chunks = 0;
    }, 500);
    return true;
  }

  async playPhrase() {
    const list = this.tag === 'toMine' ? DEMO.toMine : DEMO.toForeign;
    const phrase = list[this.idx++ % list.length];
    const typeOut = async (text, type) => {
      const step = Math.max(2, Math.ceil(text.length / 6));
      for (let i = 0; i < text.length; i += step) {
        this.emit(type, { text: text.slice(i, i + step) });
        await new Promise((r) => setTimeout(r, 80));
      }
    };
    await typeOut(phrase.src, 'input-text');
    this.emit('audio', { base64: beepBase64() });
    await typeOut(phrase.dst, 'output-text');
    this.emit('turn-complete');
  }

  close() {
    clearTimeout(this.gapTimer);
    this.state = 'closed';
    this.emit('status', { state: 'closed' });
  }
}
