import { reviewDocument } from './review.mjs';
import { fingerprint } from './incremental.mjs';

const clean = value => value.normalize('NFKC').replace(/\s+/g, '');
const section = /^[一二三四五六七八九十]+[、.．]\s*/;
const numbered = /^\d+[.．、)]\s*/;
const known = /^(?:目前)?已知問題(?:事項|說明|列表|清單)?[：:]?$/;
const fixed = /^(?:已修復問題|已修正問題|問題修復|修正\s*(?:[&＆與及]\s*改善)?事項|修復事項)[：:]?$/;

export function issueMentions(html) {
  const mentions = [];
  let state;
  let headingText;
  let current;
  for (const block of reviewDocument(html).blocks) {
    const text = block.text.trim();
    if (!text) continue;
    const heading = text.replace(section, '').trim();
    if (known.test(heading) || fixed.test(heading)) {
      state = known.test(heading) ? 'known' : 'fixed';
      headingText = text;
      current = undefined;
      continue;
    }
    if (section.test(text) || /^【新楓之谷台灣官方/.test(text)) {
      state = undefined;
      current = undefined;
    }
    if (!state) continue;
    if (numbered.test(text) || !current) {
      current = { text: text.replace(numbered, '').trim(), state, heading: headingText };
      mentions.push(current);
    } else current.text += '\n' + text;
  }
  return mentions.filter(mention => !/^(?:無|目前無|無已知問題|無修正事項)[。.]?$/.test(mention.text) &&
    (mention.state === 'known' || /問題|修復|修正|異常|錯誤|補償|未正常/.test(mention.text)))
    .map(mention => mention.state === 'fixed' && /(?:預計|後續|將於|將在).*(?:修正|修復)|尚未修復/.test(mention.text) ?
      { ...mention, state: 'known' } : mention);
}

export function issueIndex(snapshots, activities) {
  const grouped = new Map();
  for (const snapshot of snapshots) {
    for (const mention of issueMentions(snapshot.html)) {
      const id = fingerprint(clean(mention.text)).slice(0, 24);
      if (!grouped.has(id)) grouped.set(id, { id, text: mention.text, history: [] });
      const history = grouped.get(id).history;
      if (!history.some(entry => entry.url === snapshot.url && entry.snapshot === snapshot.snapshot && entry.state === mention.state)) {
        history.push({ title: snapshot.title, url: snapshot.url, date: snapshot.date, snapshot: snapshot.snapshot,
          notice: snapshot.id, checkedAt: snapshot.checkedAt, text: mention.text, state: mention.state, heading: mention.heading });
      }
    }
  }
  const bulletinId = url => Number(new URL(url).searchParams.get('bid') ?? 0);
  return [...grouped.values()].map(issue => {
    issue.history.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') ||
      bulletinId(b.url) - bulletinId(a.url) || (b.checkedAt ?? '').localeCompare(a.checkedAt ?? ''));
    const normalized = clean(issue.text);
    const direct = activities.filter(item => clean(item.title).length >= 4 && normalized.includes(clean(item.title)));
    const quoted = [...normalized.matchAll(/[<【〖「]([^>】〗」]+)[>】〗」]/g)].map(match => match[1]);
    const byMethod = activities.filter(item => (item.methods ?? []).some(method =>
      quoted.some(name => name.length >= 4 && clean(method.title) === name + '應援')));
    return { ...issue, state: issue.history[0].state, date: issue.history[0].date,
      activities: direct.length ? direct : byMethod.length === 1 ? byMethod : [] };
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}
