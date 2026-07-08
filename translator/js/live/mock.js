// Demo 模式假引擎：介面與 LiveSession 相同，不連網、不需 API key。
// 收到足夠的語音 chunks 後停頓 → 逐字吐出一組示範原文/譯文 + 一小段提示音，
// 讓整條 UI 管線（字幕流、語音播放、用量統計）都能被測試與展示。

const PHRASES = {
  'zh-Hant': [
    { src: 'Hello! Where would you like to go today?', srcLang: 'en', dst: '哈囉！你今天想去哪裡呢？' },
    { src: 'The next train arrives in five minutes.', srcLang: 'en', dst: '下一班列車五分鐘後抵達。' },
    { src: 'すみません、駅はどこですか？', srcLang: 'ja', dst: '不好意思，請問車站在哪裡？' },
  ],
  en: [
    { src: '請問這附近有推薦的餐廳嗎？', srcLang: 'zh-Hant', dst: 'Excuse me, is there a restaurant you would recommend nearby?' },
    { src: '我想要兩張到台北的票。', srcLang: 'zh-Hant', dst: 'I would like two tickets to Taipei, please.' },
    { src: '謝謝你的幫忙！', srcLang: 'zh-Hant', dst: 'Thank you so much for your help!' },
  ],
};

function beepBase64() {
  // 0.35 秒 440Hz 提示音 @24kHz PCM16
  const n = Math.floor(24000 * 0.35);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 500, (n - i) / 2000);
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 0.25 * env * 0x7fff);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class MockSession extends EventTarget {
  constructor({ target = 'zh-Hant', tag = 'main' } = {}) {
    super();
    this.target = target;
    this.tag = tag;
    this.state = 'idle';
    this.voicedChunks = 0;
    this.gapTimer = null;
    this.phraseIndex = 0;
    this.busy = false;
    this.sentSeconds = 0;
    this.resumeHandle = undefined;
    this.connectedAt = 0;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { ...detail, tag: this.tag } }));
  }

  connect() {
    this.state = 'connecting';
    this.emit('status', { state: 'connecting' });
    setTimeout(() => {
      this.state = 'open';
      this.connectedAt = Date.now();
      this.emit('status', { state: 'open' });
    }, 300);
  }

  sendAudio(int16) {
    if (this.state !== 'open') return false;
    this.sentSeconds += int16.length / 16000;
    this.voicedChunks += 1;
    // 連續音訊（VAD 關閉或環境持續有聲）：每 ~2.5 秒觸發一句
    if (this.voicedChunks >= 25 && !this.busy) {
      this.voicedChunks = 0;
      clearTimeout(this.gapTimer);
      this.playPhrase();
      return true;
    }
    // 一般情況：講完停頓 0.6 秒觸發
    clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => {
      if (this.voicedChunks >= 4 && !this.busy) this.playPhrase();
      this.voicedChunks = 0;
    }, 600);
    return true;
  }

  async playPhrase() {
    this.busy = true;
    const list = PHRASES[this.target] || PHRASES.en;
    const phrase = list[this.phraseIndex % list.length];
    this.phraseIndex += 1;

    const typeOut = async (text, type, languageCode) => {
      const step = Math.max(2, Math.ceil(text.length / 8));
      for (let i = 0; i < text.length; i += step) {
        this.emit(type, { text: text.slice(i, i + step), languageCode });
        await new Promise((r) => setTimeout(r, 90));
      }
    };

    await typeOut(phrase.src, 'input-transcription', phrase.srcLang);
    await new Promise((r) => setTimeout(r, 250));
    this.emit('audio', { base64: beepBase64() });
    await typeOut(phrase.dst, 'output-transcription', this.target);
    this.emit('turn-complete');
    this.busy = false;
  }

  close() {
    clearTimeout(this.gapTimer);
    this.state = 'closed';
    this.emit('status', { state: 'closed' });
  }
}
