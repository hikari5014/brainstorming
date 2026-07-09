# 隨身口譯 — Gemini Live 即時翻譯 PWA

一個**純前端、零後端**的即時語音翻譯 app。以 Google 官方的
[`gemini-3.5-live-translate-preview`](https://ai.google.dev/gemini-api/docs/live-api/live-translate)
模型為引擎：來源語言自動偵測（70+ 種）、同步口譯式語音輸出（保留語調節奏）、
雙語字幕即時顯示。可安裝為桌面與手機的 PWA。

## 四種模式

| 模式 | 場景 | 音訊來源 | 預設輸出 |
|---|---|---|---|
| **對話** | 面對面雙向交談（旅遊、接待） | 麥克風 | 字幕＋語音 |
| **聆聽** | 聽演講、看影片、環境對話 | 麥克風 | 字幕 |
| **我說** | 對方聽不懂你，翻給對方看/聽 | 麥克風 | 大字幕＋語音（畫面可 180° 翻轉面向對方） |
| **影片** | 翻譯本裝置播放的影片（手機/電腦皆可） | app 內播放的影片檔或直連網址（`MediaElementSource`） | 字幕＋口譯語音，口譯時**自動壓低影片原音** |
| **會議** | 線上會議/任意分頁即時翻譯（桌機限定） | 分頁/系統音訊（`getDisplayMedia` + `suppressLocalAudioPlayback` 代播） | 字幕（可開口譯語音，開啟時自動壓低原音） |

對話模式有兩種子模式：

- **手動切換**（預設，省額度）：單一連線，中央「⇄」鈕切換翻譯方向。
- **自動雙向**：兩條並行連線（各以你的語言、對方語言為目標），
  搭配 `echoTargetLanguage: false` 自動判斷誰在說話。輸入音訊雙倍計量。

## 快速開始

1. 到 [Google AI Studio](https://aistudio.google.com/apikey) 免費申請 Gemini API key（有免費層）。
2. 打開 app 網址（見下方部署），首次使用會引導你貼上 key——**key 只存在你裝置的
   localStorage，瀏覽器直連 Google，不經過任何第三方伺服器**。
3. 按「開始」，允許麥克風權限。
4. 安裝為 App：
   - **桌機 Chrome/Edge**：網址列右側安裝圖示，或 app 內的「⤓」鈕。
   - **Android**：Chrome 選單 →「加到主畫面」。
   - **iOS**：Safari 分享 →「加入主畫面」（iOS 不支援自動安裝提示）。

沒有 key 也能玩：首次導引裡的「**Demo 模式**」用內建假引擎跑完整介面，不連網、不耗額度。

## 部署到 GitHub Pages

repo 已含 `.github/workflows/pages.yml`：push 到部署分支（或手動 Run workflow）就會
自動啟用 Pages 並把 `translator/` 發布成站台根目錄，網址
`https://<你的帳號>.github.io/brainstorming/`。

注意：**免費方案的 GitHub Pages 只支援公開 repo**。若 repo 是私人的，先到
Settings → General → Danger Zone → Change visibility 改為 Public，再重跑 workflow。
repo 公開沒有安全疑慮：頁面本身不含任何 key，別人打開也用不了你的額度。

也可部署到 Vercel（repo 已含 `vercel.json`，`outputDirectory` 指向 `translator/`），
私人 repo 亦可。

## 省額度設計

Live API 按「送出＋收到的音訊時長」計費（音訊 25 tokens/秒），因此：

- **本地 VAD 靜音閘門**：沒偵測到人聲就不送音訊（含 400ms pre-roll 防句首被切）。
- **待機自動斷線**：靜音超過 N 分鐘自動關閉連線，說話或點擊即喚醒。
- **用量儀表**：頂欄即時顯示今日音訊分鐘數與付費層估算費用，可設每日警示門檻。
- **省額度引擎**：設定中可切換 `gemini-3.1-flash-live-preview`（僅字幕、回合制、較便宜）。

付費層參考價（2026-07）：輸入 $0.0053/分、輸出 $0.0315/分——連續口譯一小時約 US$2。

## 本地開發與測試

```bash
cd translator
python3 -m http.server 8080     # http://localhost:8080（localhost 免 HTTPS 即可測 PWA）

# 冒煙測試（假麥克風 + Demo 引擎跑完整 UI 管線，19 項檢查）
npm install playwright-core
CHROME_PATH=/path/to/chrome node tests/smoke.mjs
```

## 架構

```
index.html / css/app.css     單頁雙版面：沉浸式字幕機（手機預設）⇄ 工具儀表板（桌機預設）
manifest.webmanifest / sw.js PWA：離線 shell 快取（網路優先，改版即時生效）
js/
  main.js                    啟動、模式路由、控制列、設定/逐字稿面板、PWA 安裝
  pipeline.js                共用引擎：音訊來源 → VAD → 1..2 條 Live session → 事件流
  modes.js                   四模式宣告式設定 + 字幕面板路由
  settings.js / languages.js localStorage 設定、78 種語言表
  audio/                     AudioWorklet 16kHz 擷取、24kHz 播放佇列（barge-in）、RMS VAD
  live/
    client.js                原生 WebSocket 客戶端（零依賴）：自動重連、session resumption、
                             goAway 無縫續連、setup schema 降級重試
    engines.js               各引擎 setup 訊息建構
    mock.js                  Demo 假引擎（測試與試玩）
  ui/                        字幕分段器、用量儀表、IndexedDB 逐字稿（.txt/.srt 匯出）
```

## 音訊設計細節

- **半雙工閘門**：對話/我說模式在口譯語音播放期間暫停送音並緩衝（播畢立即補送），
  防止伺服器把口譯聲當成插話而中斷生成（語音講一半被切斷的主因）。
- **收音配置**：對話/我說開回音消除（避免收到自己播的口譯聲）；聆聽/會議/影片全關
  ——AEC 會把「同裝置播放的聲音」當回音消掉，這是聆聽模式聽不到裝置播放內容的常見原因。
- **iPhone 限制**：iOS 網頁無法擷取其他 app/分頁的聲音、也無法控制其他 app 音量，
  所以「翻譯裝置播放內容＋自動壓低原音」在 iPhone 上唯一可行的路徑就是影片模式
  （把影片拿進 app 內播）。另注意 iOS 啟用麥克風時，系統常會暫停其他 app 的音訊。
- **疑難排解**：設定 → 「執行連線診斷」會逐項檢查 key、模型可用性、
  WebSocket setup、麥克風收音，結果可一鍵複製。

## 已知限制

- `gemini-3.5-live-translate-preview` 是 **preview** 模型：欄位可能變動
  （客戶端已內建 setup schema 降級重試），免費層限額以
  [AI Studio](https://aistudio.google.com/) 顯示為準。
- 會議模式需要桌機 Chrome/Edge 的分頁音訊擷取；分享時記得勾「同時分享分頁音訊」。
- 純音訊 session 約 15 分鐘上限，app 會透過 session resumption 自動續連，
  續連瞬間可能掉一兩個字。
- iOS Safari 的背景執行限制較嚴，長時間聆聽建議保持螢幕開啟。
