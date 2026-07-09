// 音訊來源擷取：麥克風、分頁/系統音訊（會議模式）、或 app 內播放的媒體元素（影片模式），
// 經 AudioWorklet 輸出 16kHz PCM16 chunks（onChunk({int16, rms})）。
//
// context 由 pipeline 傳入並與口譯播放共用（iOS 上單一 context 才穩定，見 playback.js）。
// capture 不建立、也不關閉 context —— 生命週期由 pipeline 管理。
//
// processing:
//   'voice' — 對話/我說：開回音消除+降噪（避免收到自己播的口譯聲）
//   'raw'   — 聆聽/會議/影片：全關。AEC 會把「同一台裝置播放的聲音」當回音消掉。
//
// source:  'mic' | 'display' | { node, context, duckGain }（影片模式傳入現成的音訊圖）

export class AudioCapture {
  constructor({ source = 'mic', processing = 'voice', context, onChunk, onEnded }) {
    this.source = source;
    this.processing = processing;
    this.ctx = context; // 一律由 pipeline 提供
    this.onChunk = onChunk;
    this.onEnded = onEnded;
    this.stream = null;
    this.node = null;
    this.duckGain = null; // 存在時，pipeline 會在口譯播放時自動壓低它
    this.external = typeof source === 'object' && source !== null;
  }

  async start() {
    if (this.node) return;
    await this.ctx.resume().catch(() => {});

    if (this.external) {
      // 影片模式：來源節點已在共用 context 上建好
      this.duckGain = this.source.duckGain || null;
      await this.addWorklet();
      this.source.node.connect(this.node);
      return;
    }

    if (this.source === 'display') {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: true,
        },
      });
      if (this.stream.getAudioTracks().length === 0) {
        this.stopStream();
        throw new Error('NO_TAB_AUDIO');
      }
      for (const t of this.stream.getVideoTracks()) t.enabled = false;
    } else {
      const voice = this.processing === 'voice';
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: voice, noiseSuppression: voice, autoGainControl: voice },
      });
    }

    for (const t of this.stream.getAudioTracks()) {
      t.addEventListener('ended', () => this.onEnded?.());
    }

    await this.addWorklet();
    const src = this.ctx.createMediaStreamSource(this.stream);
    src.connect(this.node);

    // 分頁本身被靜音成功時 → 由我們代播，並掛上 duckGain 供自動壓低
    if (this.source === 'display') {
      const settings = this.stream.getAudioTracks()[0].getSettings?.() || {};
      if (settings.suppressLocalAudioPlayback) {
        this.duckGain = this.ctx.createGain();
        src.connect(this.duckGain).connect(this.ctx.destination);
      }
    }
  }

  async addWorklet() {
    await this.ctx.audioWorklet.addModule(new URL('./worklets/capture-processor.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.node.port.onmessage = (e) => {
      this.onChunk?.({ int16: new Int16Array(e.data.pcm), rms: e.data.rms });
    };
  }

  stopStream() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  async stop() {
    this.stopStream();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    // context 由 pipeline 管理，這裡不關閉
    this.duckGain = null;
  }
}
