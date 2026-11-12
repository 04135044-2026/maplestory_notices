import { methodContext } from './catalog.mjs';
import { fingerprint, summaryForDisplay } from './incremental.mjs';

export function editKey(item, method) {
  return fingerprint([item.id, method.id]);
}

export function editEvidence(item, method, summary, field) {
  const sources = methodContext(item, method);
  const facts = summary ? summaryForDisplay(summary, sources)[field] ?? [] : [];
  return {
    version: fingerprint(sources.map(({ text, rows }) => [text, rows])),
    facts: facts.map(fact => fact.text),
    sources: sources.map(source => source.text).filter(Boolean),
  };
}

export function editChanged(baseline, current) {
  return baseline.version !== current.version || JSON.stringify(baseline.facts) !== JSON.stringify(current.facts);
}
