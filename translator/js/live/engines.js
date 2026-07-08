// 每個引擎的 setup 訊息建構。
// 主引擎 gemini-3.5-live-translate-preview 的欄位位置依官方 raw WebSocket 範例：
// transcription 與 translationConfig 都在 generationConfig 內。
// 備用引擎 gemini-3.1-flash-live-preview 是通用 Live 模型，transcription 傳統上在 setup 頂層。
// 每個引擎提供多個 schema variant：若 setup 被伺服器拒絕（setupComplete 前斷線），
// 客戶端會自動換下一個 variant 重試，以容忍 preview API 的欄位搬動。

export const WS_URL_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function interpreterInstruction(targetLanguageCode) {
  return (
    `You are a professional simultaneous interpreter. Translate everything you hear ` +
    `into the language with BCP-47 code "${targetLanguageCode}". ` +
    `Output ONLY the translation text, nothing else. Do not answer questions, ` +
    `do not add commentary, do not omit content. If the audio is already in the ` +
    `target language, output nothing.`
  );
}

export function buildSetupVariants({ engine, model, target, echoTargetLanguage, resumeHandle }) {
  const resumption = resumeHandle === undefined ? {} : { handle: resumeHandle };

  if (engine === 'flashLive') {
    const base = {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['TEXT'] },
      systemInstruction: { parts: [{ text: interpreterInstruction(target) }] },
    };
    return [
      { setup: { ...base, inputAudioTranscription: {}, sessionResumption: resumption } },
      { setup: { ...base, inputAudioTranscription: {} } },
      { setup: { ...base } },
    ];
  }

  // translate 引擎
  const genCfg = {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    translationConfig: {
      targetLanguageCode: target,
      echoTargetLanguage: Boolean(echoTargetLanguage),
    },
  };
  return [
    // 官方文件範例 + session resumption
    { setup: { model: `models/${model}`, generationConfig: genCfg, sessionResumption: resumption } },
    // 不帶 resumption（若 preview 模型不支援）
    { setup: { model: `models/${model}`, generationConfig: genCfg } },
    // 傳統位置：transcription 在 setup 頂層
    {
      setup: {
        model: `models/${model}`,
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
