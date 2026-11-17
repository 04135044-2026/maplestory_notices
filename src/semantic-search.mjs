import { fingerprint } from './incremental.mjs';
import { methodContext } from './catalog.mjs';
import { searchCatalog } from './search.mjs';
import { rewardAvailability } from './periods.mjs';
import { Problem } from './notice.mjs';
import { semanticKeywords } from './search-terms.mjs';

export const defaultEmbeddingModel = 'embeddinggemma';
export function semanticDocuments(items, now, images) {
  return searchCatalog(items, { query: '' }, now, images, { includeMethods: true })
    .filter(({ state }) => ['進行中', '仍可領獎'].includes(state))
    .map(entry => ({ ...entry, availability: entry.reward ? rewardAvailability(entry.periods, now) : null }))
    .filter(entry => !entry.reward || entry.availability)
    .map(entry => {
      const { item, method, reward } = entry;
      const details = method ? methodContext(item, method).map(source => source.text).join('\n') : '';
      const text = [item.title, method?.title, reward?.name, reward?.category, reward?.condition,
        details.slice(0, 900)].filter(Boolean).join('\n');
      const key = fingerprint([item.id, method?.id, reward?.name, reward?.group, text]);
      return { key, text, entry };
    });
}

export async function ollamaEmbeddings(model, input, fetchImpl = fetch) {
  if (!/^[\w.:/-]{1,160}$/.test(model) || /(?:-cloud|:cloud)$/i.test(model)) throw new Problem('Ollama 向量模型設定有誤。');
  let response;
  try {
    response = await fetchImpl('http://127.0.0.1:11434/api/embed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, truncate: false }), signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Problem('請先啟動本機 Ollama。', 502);
  }
  if (response.status === 404) throw new Problem('請先在 Ollama 下載向量模型 ' + model + '。', 422);
  if (!response.ok) throw new Problem('Ollama 向量模型目前無法處理查詢。', 502);
  const { embeddings } = await response.json().catch(() => ({}));
  const size = embeddings?.[0]?.length;
  if (!Array.isArray(embeddings) || embeddings.length !== input.length || !size || size > 8192 ||
    !embeddings.every(vector => Array.isArray(vector) && vector.length === size &&
      vector.every(Number.isFinite) && vector.some(value => value !== 0 && Math.abs(value) >= 1e-35))) {
    throw new Problem('Ollama 回傳的向量格式無效。', 422);
  }
  return embeddings;
}

export async function semanticSearch(store, documents, query, model, fetchImpl) {
  const matches = semanticKeywords(documents, query);
  if (matches.length) return matches;
  return rankByEmbedding(store, documents, query, model, fetchImpl);
}

export async function rankByEmbedding(store, documents, query, model, fetchImpl) {
  if (!documents.length) return [];
  if (!store?.vectorSearch) throw new Problem('這個網站需要以 PostgreSQL 模式啟動。', 422);
  const unique = new Map();
  for (const document of documents) if (!unique.has(document.key)) unique.set(document.key, document);
  const [vector] = await ollamaEmbeddings(model, [query], fetchImpl);
  const entries = [...unique.values()];
  const keys = await store.vectorSearch(model, entries, vector,
    async input => {
      const vectors = await ollamaEmbeddings(model, input, fetchImpl);
      if (vectors.some(embedding => embedding.length !== vector.length)) throw new Problem('向量模型維度不一致。', 422);
      return vectors;
    });
  return keys.map(key => unique.get(key)).filter(Boolean);
}
