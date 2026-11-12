import { createHash } from 'node:crypto';
import { imageKey } from './images.mjs';
import { methodContext } from './catalog.mjs';

export const fingerprint = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

export function methodFingerprint(item, method, images, provider = 'gemini', model = process.env.GEMINI_MODEL) {
  const sources = methodContext(item, method);
  const urls = [...new Set([...method.images, ...(item.sharedImages ?? [])])].sort();
  return fingerprint({
    template: item.template, prompt: 'method-summary-v1', provider, model,
    title: item.title, method: method.title, sources,
    images: urls.map(url => [url, images[imageKey(url)]?.version ?? null]),
  });
}
