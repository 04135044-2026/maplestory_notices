import { CODEX_MODEL } from './codex.mjs';
import { generateSummary, Problem } from './notice.mjs';

export const providerLabels = { gemini: 'Gemini', codex: '訂閱 Codex', ollama: 'Ollama' };
export const isProvider = name => typeof name === 'string' && Object.hasOwn(providerLabels, name);
export const modelFields = ['geminiModel', 'codexModel', 'ollamaModel'];
export function publicModelSettings(input) {
  return {
    provider: isProvider(input?.provider) ? input.provider : 'gemini',
    ...Object.fromEntries(modelFields.filter(field => typeof input?.[field] === 'string').map(field => [field, input[field]])),
  };
}

export function modelName(provider, settings) {
  if (provider === 'codex') return settings.codexModel || CODEX_MODEL;
  if (provider === 'ollama') return settings.ollamaModel;
  return settings.geminiModel || process.env.GEMINI_MODEL;
}

export function generateWith(provider, settings, codexGenerate, fetchImpl = fetch) {
  return async (instruction, input, properties, media = []) => {
    const model = modelName(provider, settings);
    const schema = { type: 'object', properties, required: Object.keys(properties) };
    if (provider === 'codex') {
      if (media.some(part => !['image/png', 'image/jpeg', 'image/webp'].includes(part.inlineData?.mimeType))) {
        throw new Problem('Codex 圖片辨識支援 PNG、JPEG、WebP。請在公告管理切換至能讀取此圖片格式的模型後重試。', 422);
      }
      const output = await codexGenerate({ instruction, model: settings.codexModel,
        parts: [{ text: JSON.stringify(input) }, ...media], schema });
      return { result: output.result, metadata: { provider, model: output.model, usage: output.usage } };
    }
    if (provider !== 'ollama') {
      return generateSummary(instruction, input, properties, media, {
        key: settings.geminiKey ?? null, model, fetchImpl,
      });
    }
    if (!model) throw new Problem('請先選擇本機 Ollama 模型。');
    const message = { role: 'user', content: JSON.stringify(input) };
    if (media.length) message.images = media.map(part => part.inlineData.data);
    let response;
    try {
      response = await fetchImpl('http://127.0.0.1:11434/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ model, stream: false, format: schema,
          messages: [{ role: 'system', content: instruction }, message] }),
      });
    } catch {
      throw new Problem('Ollama 連線失敗，請先啟動本機服務。', 502);
    }
    if (response.status === 404) throw new Problem('Ollama 找不到指定模型，請確認模型已安裝。', 422);
    if (response.status === 429) throw new Problem('Ollama 呼叫頻率受限，請稍後重試。', 429);
    if (!response.ok) throw new Problem('Ollama 未能完成工作，請核對模型及服務狀態。', 502);
    try {
      const payload = await response.json();
      return { result: JSON.parse(payload.message.content), metadata: { provider, model,
        usage: { promptTokenCount: payload.prompt_eval_count ?? null, candidatesTokenCount: payload.eval_count ?? null } } };
    } catch {
      throw new Problem('Ollama 未回傳有效的結構化結果。', 422);
    }
  };
}
