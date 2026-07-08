// 音訊來源擷取：麥克風或分頁/系統音訊（會議模式），
// 經 AudioWorklet 輸出 16kHz PCM16 chunks（onChunk({int16, rms})）。

export class AudioCapture {
  constructor({ source = 'mic', onChunk, onEnded }) {
    this.source = source;
    this.onChunk = onChunk;
    this.onEnded = onEnded;
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }

  async start() {
    if (this.ctx) return;
    if (this.source === 'display') {
      // 會議模式：擷取分頁/視窗音訊（桌機 Chrome/Edge）。video track 必須要求但立即停用。
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (this.stream.getAudioTracks().length === 0) {
        this.stopStream();
        throw new Error('NO_TAB_AUDIO');
      }
      for (const t of this.stream.getVideoTracks()) t.enabled = false;
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }

    for (const t of this.stream.getAudioTracks()) {
      t.addEventListener('ended', () => this.onEnded?.());
    }

    this.ctx = new AudioContext();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL('./worklets/capture-processor.js', import.meta.url));
    const src = this.ctx.createMediaStreamSource(this.stream);
    // 混成單聲道再進 worklet
    const mono = this.ctx.createGain();
    src.connect(mono);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    mono.connect(this.node);
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
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
