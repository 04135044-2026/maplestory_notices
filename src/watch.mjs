import { fingerprint } from './incremental.mjs';
import { methodContext } from './catalog.mjs';

export function watchKey({ item, method, reward }) {
  return reward ? fingerprint([item.id, method.id, reward.name.normalize('NFKC'), reward.group]) : item.id;
}

export function watchVersion({ item, method, reward }) {
  const sources = reward ? methodContext(item, method) : item.sources;
  return fingerprint(sources.map(({ text, rows }) => [text, rows]));
}
