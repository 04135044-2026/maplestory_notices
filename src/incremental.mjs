import { createHash } from 'node:crypto';
import { imageKey } from './images.mjs';
import { methodContext } from './catalog.mjs';

export const fingerprint = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const sourceContent = ({ id, ...source }) => source;
export const sourceReferences = sources => Object.fromEntries(sources.map(source => [source.id, fingerprint(sourceContent(source))]));

export function summaryForDisplay(summary, sources) {
  if (!summary.references) return summary.facts;
  const current = new Map(sources.map(source => [fingerprint(sourceContent(source)), source.id]));
  return Object.fromEntries(Object.entries(summary.facts).map(([key, facts]) => [key, facts.map(fact => ({
    ...fact, source: current.get(summary.references[fact.source]),
  }))]));
}

export function methodFingerprint(item, method, images, provider = 'gemini', model = process.env.GEMINI_MODEL) {
  const sources = methodContext(item, method);
  const urls = [...new Set([...method.images, ...(item.sharedImages ?? [])])].sort();
  return fingerprint({
    template: item.template, prompt: 'method-summary-v1', provider, model,
    title: item.title, method: method.title, sources: sources.map(sourceContent),
    images: urls.map(url => {
      const image = images[imageKey(url)];
      return [url, image?.version ?? null, Boolean(image?.selected)];
    }),
  });
}
