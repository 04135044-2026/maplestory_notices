import { fingerprint } from './incremental.mjs';
import { sourceRoute } from './notice-analysis.mjs';
import { originalBlocks } from './original-source.mjs';
import { Problem } from './notice.mjs';

export const defaultEmbeddingModel = 'embeddinggemma';

export function semanticDocuments(entries) {
  const documents = [];
  for (const entry of entries) {
    let section = '';
    for (const block of originalBlocks(entry.html, entry.url)) {
      if (block.heading) section = block.text;
      if (block.table || block.image || !block.text) continue;
      for (const passage of block.text.match(/[\s\S]{1,900}/gu)) {
        const label = section || entry.title;
        const text = [entry.title, section && section !== entry.title ? section : '', passage].filter(Boolean).join('\n');
        documents.push({ key: fingerprint(text), text, passage, label,
          href: sourceRoute(entry.id, entry.snapshot) + '#' + block.id });
      }
    }
  }
  return documents;
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
