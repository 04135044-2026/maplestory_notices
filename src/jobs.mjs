export const SOURCE_BATCH = 24;
export const METHOD_BATCH = 3;
export const SOURCE_RETRY_MS = 300;

export function jobFailure(error, stage) {
  const message = error.message;
  const label = stage === 'source' ? '來源取得失敗' : stage === 'image' ? '圖片不足' :
    error.status === 429 ? '模型額度或頻率受限' :
      /無效|格式|結構|漏掉|來源有誤|缺少來源|INVALID_MODEL_OUTPUT/.test(message + (error.code ?? '')) ?
        '模型輸出無效' : '模型服務失敗';
  return { state: 'failed', label, message, usage: error.usage ?? null };
}

export async function sourceAttempt(action, wait = delay => new Promise(resolve => setTimeout(resolve, delay))) {
  try { return { value: await action(), attempts: 1 }; }
  catch (first) {
    if (![502, 503, 504].includes(first.status)) return { error: first, attempts: 1 };
    await wait(SOURCE_RETRY_MS);
    try { return { value: await action(), attempts: 2 }; }
    catch (error) { return { error, attempts: 2 }; }
  }
}
