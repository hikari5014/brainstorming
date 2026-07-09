// 音訊來源擷取：麥克風、分頁/系統音訊（會議模式）、或 app 內播放的媒體元素（影片模式），
// 經 AudioWorklet 輸出 16kHz PCM16 chunks（onChunk({int16, rms})）。
//
// processing:
//   'voice' — 對話/我說：開回音消除+降噪（避免收到自己播的口譯聲）
//   'raw'   — 聆聽/會議：全關。AEC 會把「同一台裝置播放的影片聲音」當回音消掉，
//             這正是聆聽模式聽不到裝置播放內容的主因。
//
// source:
//   'mic' | 'display' | { node, context, duckGain }  （影片模式傳入現成的音訊圖）
//
// 會議模式（display）：要求 suppressLocalAudioPlayback —— 讓被擷取的分頁本身靜音，
// 改由我們代播（經 duckGain），口譯說話時就能自動壓低影片音量。

export class AudioCapture {
  constructor({ source = 'mic', processing = 'voice', onChunk, onEnded }) {
    this.source = source;
    this.processing = processing;
    this.onChunk = onChunk;
    this.onEnded = onEnded;
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.duckGain = null; // 存在時，pipeline 會在口譯播放時自動壓低它
    this.external = typeof source === 'object' && source !== null;
  }

  async start() {
    if (this.node) return;

    if (this.external) {
      // 影片模式：使用外部建好的 AudioContext 與來源節點
      this.ctx = this.source.context;
      this.duckGain = this.source.duckGain || null;
      await this.ctx.resume().catch(() => {});
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

    this.ctx = new AudioContext();
    await this.ctx.resume();
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
    if (this.ctx && !this.external) {
      await this.ctx.close().catch(() => {});
    }
    // 外部 context（影片模式）留給擁有者：影片繼續正常出聲
    this.ctx = null;
    this.duckGain = null;
  }
}
