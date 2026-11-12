import { load } from 'cheerio';
import { fingerprint } from './incremental.mjs';
import { Problem } from './notice.mjs';

const clean = value => value.replace(/\s+/g, ' ').trim();
const hosts = new Set(['maplestory.beanfun.com', 'maplestory-event.beanfun.com', 'beanfun-event.beanfun.com']);

export function officialCorrectionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Problem('請輸入有效的官方公告網址。'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.has(url.hostname)
      || !/^(?:\/bulletin|\/EventAD_Mobile\/EventAD|\/eventad\/eventad)\/?$/i.test(url.pathname)) {
    throw new Problem('請使用新楓之谷官方公告網址。');
  }
  url.hash = '';
  return url.href;
}

export async function fetchCorrection(value) {
  let url = officialCorrectionUrl(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!response) throw new Problem('官方公告讀取失敗，已保存的期限不受影響。', 502);
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = officialCorrectionUrl(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (!response.ok) throw new Problem('官方公告暫時無法讀取。', 502);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 3_000_000) throw new Problem('公告內容過大，請選擇直接對應的公告。');
      chunks.push(chunk);
    }
    return { url, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Problem('官方公告轉址過多。', 502);
}

export function verifiedSource(item, form, source, now) {
  const kind = form.get('kind');
  const field = form.get('field');
  const quote = clean(form.get('quote') ?? '');
  const endText = clean(form.get('end') ?? '');
  const $ = load(source.html);
  $('script, style, noscript').remove();
  const text = clean($('body').text());
  if (!['correction', 'supplement'].includes(kind) || !['participation', 'claim'].includes(field) ||
      quote.length < 6 || quote.length > 1500 || !text.includes(quote)) {
    throw new Problem('請貼上官方公告中的完整依據，並選擇對應欄位。');
  }
  if (kind === 'correction') {
    const match = /^(\d{4})\/(\d{2})\/(\d{2})(?: ([01]\d|2[0-3]):([0-5]\d))?$/.exec(endText);
    const date = match ? match.slice(1, 4).join('-') : '';
    const parsed = date ? new Date(date + 'T00:00:00Z') : null;
    const dates = match ? [endText, Number(match[2]) + '/' + Number(match[3]) + (match[4] ? ' ' + match[4] + ':' + match[5] : '')] : [];
    const changeText = quote.split(/延長|延期|更正|勘誤|改為|調整至/).at(-1);
    if (!parsed || !Number.isFinite(+parsed) || !parsed.toISOString().startsWith(date) ||
        !dates.some(value => changeText.includes(value)) || !quote.includes(item.title) ||
        !/(?:延長|延期|更正|勘誤|改為|調整至)/.test(quote) ||
        (field === 'claim' && !/領獎|領取/.test(quote)) ||
        (field === 'participation' && !/活動(?:期間|時間|日期)|參加|活動延/.test(quote))) {
      throw new Problem('更正需在同段原文中明確寫出活動、欄位與新期限。日期格式用 YYYY/MM/DD，可另加 HH:mm。');
    }
  }
  return {
    id: 'correction-' + fingerprint([source.url, field, quote]).slice(0, 20),
    url: officialCorrectionUrl(source.url), quote, kind, field, endText: kind === 'correction' ? endText : null,
    capturedAt: now.toISOString(), snapshot: 'official-' + fingerprint(source.html) + '.html',
  };
}

export function withCorrections(item, records = []) {
  const changes = {};
  for (const field of ['participation', 'claim']) {
    const candidates = records.filter(record => record.field === field && record.kind === 'correction');
    if (candidates.length && new Set(candidates.map(record => record.endText)).size === 1) changes[field] = candidates[0];
  }
  const active = Object.values(changes);
  const sources = active.map(record => ({ id: record.id, scope: '已核對官方更正', text: record.quote, url: record.url }));
  return {
    ...item, changes, linkedSources: records, sources: [...item.sources, ...sources],
    methods: item.methods.map(method => ({ ...method, sharedSourceIds: [...method.sharedSourceIds, ...sources.map(source => source.id)] })),
  };
}
