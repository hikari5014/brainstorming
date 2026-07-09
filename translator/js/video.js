// 影片模式：在 app 內播放影片（本機檔案或直連網址），
// 用 MediaElementAudioSourceNode 完全掌控音訊 —— 這是在 iPhone 上也成立的
// 「翻譯裝置播放內容 + 自動壓低原音」唯一路徑（網頁無法擷取其他 app/分頁的聲音）。
//
// 音訊圖（常駐，只建一次；一個 <video> 元素一輩子只能綁一個 MediaElementSource）：
//   videoEl → srcNode ─┬→ duckGain → destination   （使用者聽到的原音，口譯時被壓低）
//                      └→ (pipeline 的 capture worklet)（送去翻譯）

export class VideoSource {
  constructor(videoEl) {
    this.el = videoEl;
    this.ctx = null;
    this.srcNode = null;
    this.duckGain = null;
  }

  // 回傳給 pipeline 的 externalSource
  async ensureGraph() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.srcNode = this.ctx.createMediaElementSource(this.el);
      this.duckGain = this.ctx.createGain();
      this.srcNode.connect(this.duckGain).connect(this.ctx.destination);
    }
    await this.ctx.resume().catch(() => {});
    return { node: this.srcNode, context: this.ctx, duckGain: this.duckGain };
  }

  get hasMedia() {
    return Boolean(this.el.currentSrc || this.el.src);
  }

  loadFile(file) {
    if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
    this._blobUrl = URL.createObjectURL(file);
    this.el.src = this._blobUrl;
    this.el.play().catch(() => {});
  }

  // 直連網址需要 CORS 允許，否則瀏覽器會把經過 WebAudio 的聲音靜音（安全限制）
  loadUrl(url) {
    this.el.crossOrigin = 'anonymous';
    this.el.src = url;
    this.el.play().catch(() => {});
  }
}
