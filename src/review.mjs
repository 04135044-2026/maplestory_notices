import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { official, Problem } from './notice.mjs';
import { tableLayout, tableRows } from './segmentation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const headings = /^(?:h[1-6]|p|table|ul|ol|img)$/;
export function reviewDocument(html) {
  const $ = load(html);
  $('script,style,noscript,iframe').remove();
  const root = $('.content, .bulletin_main').first();
  const body = root.length ? root : $('body');
  const blocks = [];
  for (const node of body.find('h1,h2,h3,h4,h5,h6,p,table,ul,ol,img').toArray()) {
    if (!headings.test(node.tagName) || $(node).parentsUntil(body).filter('table,ul,ol,p').length) continue;
    const rows = node.tagName === 'table' ? tableRows($, node) : undefined;
    const text = rows
      ? rows.map(row => row.join(' | ')).join('\n')
      : $(node).text().replace(/\s+/g, ' ').trim();
    const images = $(node).find('img').addBack('img').map((_, img) => {
      try {
        const url = new URL($(img).attr('src'), official);
        return url.protocol === 'https:' && url.hostname === 'tw.hicdn.beanfun.com' ? url.href : null;
      } catch { return null; }
    }).get();
    if (text || images.length) blocks.push({ id: 'B' + (blocks.length + 1), text, rows, images,
      cells: rows ? tableLayout($, node) : undefined });
  }
  if (!blocks.length && body.text().trim()) blocks.push({ id: 'B1', text: body.text().trim(), images: [] });
  return { fingerprint: hash(html), blocks };
}

export function manualActivity(document, form, automatic = [], notice = {}) {
  if (form.get('fingerprint') !== document.fingerprint) throw new Problem('來源已更新，請重新核對人工歸屬。', 409);
  const title = form.get('title')?.trim();
  const method = form.get('method')?.trim();
  const selection = name => [...new Set(form.getAll(name))];
  const own = selection('own');
  const shared = selection('shared');
  if (!method || (title?.length ?? 0) > 100 || method.length > 100 || !own.length
    || own.some(id => shared.includes(id)) || [...own, ...shared].some(id => !document.blocks.some(block => block.id === id))) {
    throw new Problem('請填寫活動及方法，並分開選擇方法區塊和共用條件。');
  }
  const blocks = document.blocks.filter(block => own.includes(block.id) || shared.includes(block.id));
  const target = form.get('target');
  const current = automatic.find(item => item.methods.some(entry => entry.id === target));
  const parentId = form.get('parent');
  const parent = parentId ? automatic.find(item => item.id === parentId) : current;
  if ((target && !current) || (parentId && !parent)) throw new Problem('選取的活動或方法已不在這份來源。');
  if (!parent && !title) throw new Problem('新增活動時請填寫活動名稱。');
  const id = parent?.id ?? 'manual-' + hash(JSON.stringify(notice.id ? [notice.id, title] : [title]));
  const methodId = target || id + '-method-' + hash(JSON.stringify([method]));
  const sources = blocks.map(block => ({ ...block, scope: shared.includes(block.id) ? '人工確認共用條件' : '人工確認取得方法' }));
  const images = blocks.flatMap(block => block.images);
  const sharedImages = blocks.filter(block => shared.includes(block.id)).flatMap(block => block.images);
  const local = sources.filter(block => shared.includes(block.id));
  return { id, title: parent?.title ?? title, fromActivityId: current?.id, pageTitle: notice.title ?? '公告 19129',
    officialUrl: notice.url, sources, images, local, dates: null, template: 'manual-v1',
    eligibility: sources.find(source => /^(參加條件|活動資格)[：:]/.test(source.text)),
    methods: [{ id: methodId, title: method, kind: 'method', images, sourceIds: own, sharedSourceIds: shared }],
    sharedImages };
}

export function mergeManual(items, entries) {
  const byId = new Map(items.map(item => [item.id, item]));
  for (const entry of entries) {
    const original = byId.get(entry.fromActivityId);
    if (original && original.id !== entry.id) {
      byId.set(original.id, { ...original, methods: original.methods.filter(method => method.id !== entry.methods[0].id) });
    }
    const current = byId.get(entry.id);
    if (!current) { byId.set(entry.id, entry); continue; }
    const methods = new Map(current.methods.map(method => [method.id, method]));
    for (const method of entry.methods) methods.set(method.id, method);
    byId.set(entry.id, {
      ...current, methods: [...methods.values()],
      sources: [...new Map([...current.sources, ...entry.sources].map(source => [source.id, source])).values()],
      images: [...new Set([...current.images, ...entry.images])],
    });
  }
  return [...byId.values()];
}
