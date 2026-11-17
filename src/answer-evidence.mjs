import { methodContext } from './catalog.mjs';
import { fingerprint } from './incremental.mjs';
import { normalizeSearch } from './search-terms.mjs';

const contextLabel = /資格|期間|期限|截止|開領|重置|初始化|首個週|官方更正/u;
const genericTerms = new Set(['請問', '這個', '什麼', '怎麼', '如何', '可以', '知道', '哪些', '活動', '問題']);

function splitTable(source) {
  if (!source.rows?.length) return [source];
  const firstBody = source.cells?.findIndex(row => !row.length || !row.every(cell => cell.heading)) ?? 0;
  const levelHeader = source.rows[0].some(cell => /Lv\s*\d+\s*(以上|以下)/iu.test(cell));
  const headerCount = Math.max(firstBody, levelHeader ? 2 : 1);
  // A rowspan that crosses into the body would change the meaning of a sliced row.
  if (source.cells?.some((row, index) => row.some(cell => cell.rowspan === 0 ||
      (cell.rowspan ?? 1) > 1 && index + cell.rowspan > headerCount))) return [source];
  const headers = source.rows.slice(0, headerCount);
  const rows = source.rows.slice(headerCount);
  if (rows.length < 2) return [source];
  const cells = source.cells?.length === source.rows.length ? source.cells : undefined;
  return rows.map((row, index) => ({
    ...source, rows: [...headers, row],
    cells: cells ? [...cells.slice(0, headerCount), cells[headerCount + index]] : undefined,
    text: [...headers, row].map(cells => cells.join(' | ')).join('\n'),
  }));
}

function queryTerms(query) {
  const input = normalizeSearch(query);
  const words = input.match(/[a-z]+\d*|\d+|[\p{Script=Han}]{2,}/gu) ?? [];
  const terms = words.flatMap(word => /^[\p{Script=Han}]+$/u.test(word)
    ? [...word].slice(1).map((char, index) => word[index] + char)
    : [word]);
  return [...new Set(terms.filter(term => !genericTerms.has(term)))];
}

function keywordScore(text, terms) {
  const normalized = normalizeSearch(text);
  return terms.reduce((score, term) => {
    if (/^(?:lv)?\d+$/u.test(term)) {
      return score + (new RegExp('(?<!\\d)' + term + '(?!\\d)', 'u').test(normalized) ? 4 : 0);
    }
    return score + (normalized.includes(term) ? 1 : 0);
  }, 0);
}

export async function selectAnswerEvidence(item, question, imageSources, rankEvidence) {
  const methods = item.methods.filter(method => method.kind === 'method');
  const methodSources = methods.map(method => ({ method, ids: new Set(methodContext(item, method).map(source => source.id)) }));
  const normalizedQuestion = normalizeSearch(question);
  const named = methodSources.filter(({ method }) => normalizeSearch(method.title).length >= 2 &&
    normalizedQuestion.includes(normalizeSearch(method.title)));
  const candidates = [...item.sources, ...imageSources].flatMap(source => {
    const owners = methodSources.filter(({ method, ids }) => ids.has(source.id) || source.methodId === method.id);
    if (named.length && owners.length && !named.some(method => owners.includes(method))) return [];
    return splitTable(source).map(part => {
      const keywords = [part.scope, part.text].join('\n');
      const text = [item.title, ...owners.map(({ method }) => method.title), keywords].join('\n').slice(0, 1200);
      const key = fingerprint([item.id, source.id, keywords, text]);
      return { key, text, keywords, source: part };
    });
  });
  // Small notes fit in one request, including rules without literal query terms.
  if (candidates.length <= 12 && candidates.reduce((size, candidate) => size + candidate.keywords.length, 0) <= 18000) {
    return candidates.map(({ source }) => source);
  }
  const terms = queryTerms(question);
  const ranked = candidates.map(candidate => ({ candidate, score: keywordScore(candidate.keywords, terms) }))
    .sort((a, b) => b.score - a.score);
  const hits = ranked.filter(({ score }) => score > 0);
  const selected = new Set(hits.slice(0, 10).map(({ candidate }) => candidate));
  if (rankEvidence && candidates.length > selected.size && (!hits.length || hits[0].score < 4)) {
    for (const candidate of await rankEvidence(candidates.filter(entry => !selected.has(entry)), question)) {
      selected.add(candidate);
      if (selected.size >= 10) break;
    }
  }

  const relevant = named.length ? named : methodSources.filter(({ method, ids }) =>
    [...selected].some(({ source }) => ids.has(source.id) || source.methodId === method.id));
  const ownContext = new Set(relevant.flatMap(({ method }) => [...method.sourceIds, ...method.sharedSourceIds]));
  const base = new Set(item.local.map(source => source.id));
  const corrections = candidates.filter(({ source }) => source.scope === '已核對官方更正');
  const context = candidates.filter(({ source }) => !source.rows &&
    (ownContext.has(source.id) || base.has(source.id) || source.scope.startsWith('版本共用期間')) &&
    contextLabel.test(source.scope + ' ' + source.text));
  let budget = 28000;
  return [...new Set([...corrections, ...context.slice(0, 8), ...selected])].flatMap(({ source }) => {
    if (source.text.length > budget) return [];
    budget -= source.text.length;
    return [source];
  });
}
