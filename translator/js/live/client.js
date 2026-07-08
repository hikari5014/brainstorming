// Gemini Live API 原生 WebSocket 客戶端（零依賴）。
// 事件：status / input-transcription / output-transcription / audio /
//       interrupted / turn-complete / go-away / fatal
// 自動處理：斷線重連（指數退避）、session resumption、goAway 預先續連、
//           setup schema variant 降級重試。

import { WS_URL_BASE, buildSetupVariants } from './engines.js';

const MAX_RECONNECT = 5;

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

export class LiveSession extends EventTarget {
  constructor({ apiKey, engine, model, target, echoTargetLanguage = false, tag = 'main' }) {
    super();
    this.apiKey = apiKey;
    this.engine = engine;
    this.model = model;
    this.target = target;
    this.echoTargetLanguage = echoTargetLanguage;
    this.tag = tag;

    this.ws = null;
    this.state = 'idle';
    this.setupDone = false;
    this.variantIndex = 0;
    this.resumeHandle = undefined;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    this.connectedAt = 0;
    this.sentSeconds = 0; // 實際送出的音訊秒數（用量統計）
  }

  emit(type, detail) {
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
    const url = `${WS_URL_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      const variants = buildSetupVariants({
        engine: this.engine,
        model: this.model,
        target: this.target,
        echoTargetLanguage: this.echoTargetLanguage,
        resumeHandle: this.resumeHandle,
      });
      const variant = variants[Math.min(this.variantIndex, variants.length - 1)];
      ws.send(JSON.stringify(variant));
    };

    ws.onmessage = async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) {
        this.setState('closed');
        return;
      }
      if (!this.setupDone) {
        this.handleSetupRejected(ev);
        return;
      }
      this.scheduleReconnect(ev);
    };

    ws.onerror = () => {
      /* onclose 會接手 */
    };
  }

  handleSetupRejected(ev) {
    const variants = buildSetupVariants({
      engine: this.engine, model: this.model, target: this.target,
      echoTargetLanguage: this.echoTargetLanguage, resumeHandle: this.resumeHandle,
    });
    // 1007/1008 多半是 schema 或參數錯誤 → 換下一個 variant；1006 也可能是 setup 被斷 → 一併嘗試
    if (this.variantIndex < variants.length - 1) {
      this.variantIndex += 1;
      this.openSocket();
      return;
    }
    const reason = ev.reason || `WebSocket closed (code ${ev.code})`;
    this.setState('error');
    this.emit('fatal', { reason, code: ev.code });
  }

  scheduleReconnect(ev) {
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      this.setState('error');
      this.emit('fatal', { reason: ev.reason || '多次重連失敗', code: ev.code });
      return;
    }
    const delay = 500 * 2 ** this.reconnectAttempts;
    this.reconnectAttempts += 1;
    this.setState('reconnecting', { attempt: this.reconnectAttempts, delay });
    setTimeout(() => {
      if (!this.closedByUser) this.openSocket();
    }, delay);
  }

  handleMessage(msg) {
    if (msg.setupComplete !== undefined) {
      this.setupDone = true;
      this.reconnectAttempts = 0;
      this.connectedAt = Date.now();
      this.setState('open');
      return;
    }
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.resumeHandle = u.newHandle;
      return;
    }
    if (msg.goAway) {
      // 伺服器即將收線（如 15 分鐘上限）→ 主動無縫續連
      this.emit('go-away', { timeLeft: msg.goAway.timeLeft });
      const ws = this.ws;
      this.ws = null;
      ws?.close();
      this.openSocket();
      return;
    }
    const c = msg.serverContent;
    if (!c) return;
    if (c.interrupted) this.emit('interrupted', {});
    if (c.inputTranscription?.text) {
      this.emit('input-transcription', {
        text: c.inputTranscription.text,
        languageCode: c.inputTranscription.languageCode,
      });
    }
    if (c.outputTranscription?.text) {
      this.emit('output-transcription', {
        text: c.outputTranscription.text,
        languageCode: c.outputTranscription.languageCode,
      });
    }
    if (c.modelTurn?.parts) {
      for (const part of c.modelTurn.parts) {
        if (part.inlineData?.data) this.emit('audio', { base64: part.inlineData.data });
        // flashLive 引擎的譯文以文字 part 回來，視同 output transcription
        if (part.text) this.emit('output-transcription', { text: part.text, languageCode: this.target });
      }
    }
    if (c.turnComplete || c.generationComplete) this.emit('turn-complete', {});
  }

  sendAudio(int16) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupDone) return false;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: int16ToBase64(int16), mimeType: 'audio/pcm;rate=16000' },
        },
      })
    );
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
