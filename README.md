# 口譯機 — 對講機式即時口譯（iOS 優先 PWA）

**按住說話、放開翻譯。** 以官方
[`gemini-3.5-live-translate-preview`](https://ai.google.dev/gemini-api/docs/live-api/live-translate)
為引擎的純前端即時口譯 app，可在 iPhone 加入主畫面作為桌面 app 使用。

網址：**https://hikari5014.github.io/brainstorming/**

## 使用方式（v4：面對面雙向對話）

通話隱喻：首頁按「開始對話」才開啟麥克風與連線。手機平放兩人中間——
畫面上下分區（上半面向對方、旋轉 180°），各自按住自己那側的「按住說話」鈕，
說完放開，譯文大字顯示＋語音播出，原文小字參考；中控列可開逐字稿、結束通話。
另有「聆聽」模式（演講/導覽）：單連線、點按開始/停止、字幕為主。
結束後自動進入逐字稿檢視（本機留存，可複製/分享/匯出 .txt）。
支援台灣人最常用的 10 種外語：英・日・韓・越・泰・印尼・菲律賓・馬來・西・法。

首次使用：貼上你的 Gemini API key（[免費申請](https://aistudio.google.com/apikey)，
只存在裝置本機、直連 Google），或先用 Demo 模式試玩。

**iOS 安裝**：Safari 開網址 → 分享 → 加入主畫面。

## 架構原則（第一代 app 的失敗教訓 → 設計對策）

| 第一代的失敗 | 本代的架構對策 |
|---|---|
| 全雙工同步口譯：喇叭的譯文被麥克風收回去 → 翻譯迴圈、伺服器誤判插話砍語音 | **對講機回合制**：聲音只在「按住」時送出、放開才播譯文，說與聽永不重疊——整類問題在架構上不存在 |
| 兩個 AudioContext（收音/播放分開）→ iOS 暫停其中一個 → 語音凍結、狀態卡死 | **單一共用 AudioContext**，第一次按鈕手勢中建立＋200ms 保活看門狗 |
| 用音訊時鐘判斷「播放中」→ context 被凍結就永久卡死 | 一律用**真實時鐘**（performance.now）判斷 |
| 靠 VAD 自動判斷說話起訖 → 環境噪音誤判、參數難調 | **按住＝在說**，人手就是最準的 VAD；RMS 只做音量視覺回饋 |
| 五種模式、大量介面 → 複雜度失控 | **只做口譯一件事**，兩顆大按鈕 |
| iOS 聚焦輸入框自動放大、雙擊縮放 → 版面跑掉 | viewport 鎖縮放＋表單一律 ≥16px＋`touch-action: manipulation` |
| 靜音鍵吐槽：WebAudio 被靜音開關消音 | 麥克風全程開啟 → iOS 進入「錄音+播放」音訊類別，不受靜音鍵影響 |
| 只看「翻譯文字」停止就開播 → 文字比語音先到完，長句開播時語音只到一半 → 尾段邊下載邊播、斷斷續續（v9 根因） | 開播閘門改為**文字與語音資料都靜止**才放行；回收連線需連續安靜且 1 秒內無語音資料，不會砍斷還在送語音的連線 |
| 斷音原因只能用猜的 | **語音記錄**（設定 → 🎧）：每條語音的網路到達/實際播放雙軌時間軸＋缺口標紅＋自動診斷結論 |
| 自動判斷「翻譯完整」總有失手的時候 | **語音接收指示器**（對話中即時顯示已收 N 條/幾秒、下載中或已靜止）＋**手動開播模式**（放開後由使用者按 ▶ 播放），皆可在設定開關 |

其他沿用已驗證的部分：raw WebSocket 協定（setup schema 三段降級重試、
session resumption、goAway 無縫續連）、內建連線診斷（設定 → 🩺）、
閒置自動斷線省額度、Demo 假引擎、Wake Lock 螢幕保持喚醒。

## 開發

```
interpreter/
  index.html / css/app.css      單頁 UI（對講雙鈕 + 氣泡對話流）
  js/main.js                    回合狀態機（核心）
  js/audio.js                   單一 AudioContext 音訊引擎（收音 worklet + 播放）
  js/live.js                    Gemini Live WS 客戶端 + Demo 假引擎
  js/langs.js / settings.js / diag.js / voicelog.js
  sw.js / manifest.webmanifest / icons/
  tests/smoke.mjs               冒煙測試（16 項，含單一 context 不變式）
```

```bash
cd interpreter
python3 -m http.server 8080          # 本地預覽
npm i playwright-core && node tests/smoke.mjs   # 測試
```

部署：push 本分支即由 GitHub Actions 把 `interpreter/` 推成 `gh-pages` 分支發布。
