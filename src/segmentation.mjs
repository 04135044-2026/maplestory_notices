import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { official, Problem } from './notice.mjs';

export const TEMPLATE = 'beanfun-eventad-19129-hierarchy-v1';
export const dateLabel = /^活動(?:日期|時間)[：:]/;
export const eligibilityLabel = /^(?:活動資格|參加條件)[：:]/;
const clean = value => value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const ownAnchor = section => [...section.images].sort().join('\n') || [...section.texts].sort().join('\n');

function nodeText($, element) {
  const copy = $(element).clone();
  copy.find('br').replaceWith('\n');
  if (element.tagName === 'table') {
    return tableRows($, element).map(row => row.join(' | ')).join('\n');
  }
  if (['ul', 'ol'].includes(element.tagName)) {
    return copy.children('li').map((_, item) => clean($(item).text())).get().join('\n');
  }
  return clean(copy.text());
}

function tableRows($, table) {
  return $(table).find('tr').toArray().map(row => $(row).children('th,td').map((_, cell) => clean($(cell).text())).get());
}

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const pending = message => { throw new Problem('拆分待確認：' + message); };

export function noticeMetadata(html, title = '') {
  const $ = load(html);
  const published = $('meta[property="article:published_time"]').attr('content') ?? $('time[datetime]').first().attr('datetime');
  const normalized = typeof published === 'string' && published.includes('T') && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(published) ? `${published}+08:00` : published;
  const parts = typeof published === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(published) : null;
  const date = parts ? new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))) : null;
  const valid = parts && date.getUTCFullYear() === Number(parts[1]) && date.getUTCMonth() + 1 === Number(parts[2]) && date.getUTCDate() === Number(parts[3]);
  const publishedAt = valid && Number.isFinite(Date.parse(normalized)) ? normalized : null;
  return { publishedAt, noticeType: /例行|維護(?:關|開)機|(?:關|開)機公告/.test(title || $('h1').first().text()) ? 'routine' : 'version' };
}

function heading($, node) {
  const text = clean($(node).text());
  if (!/^【[^【】]+】$/.test(text)) return null;
  const styles = $(node).find('[style]').addBack('[style]').map((_, el) => $(el).attr('style')).get().join(';');
  const size = /font-size:\s*(20|15)pt\b/.exec(styles)?.[1];
  if (node.tagName !== 'p' || !size || !/font-weight:\s*700\b/.test(styles)) {
    pending('發現未驗證樣式的區塊標題，已保留全文，需要確認拆分。');
  }
  return { title: text.slice(1, -1), size: Number(size) };
}

function identityKeys(texts, images) {
  return [images.length ? `images:${digest([...images].sort().join('\n'))}` : null,
    texts.length ? `text:${digest(texts.join('\n'))}` : null].filter(Boolean);
}

export function splitNotice(html) {
  const canonical = new URL(official);
  const $ = load(html);
  $('script,style,noscript').remove();
  const content = $('.content').length ? $('.content') : $('.bulletin_main');
  if (!content.length) pending('公告正文格式尚未驗證，已保留全文與圖片供人工確認。');
  if (!clean(content.text()) && content.find('img').length) pending('公告以圖片呈現，請人工確認活動歸屬。');
  if (!clean(content.text())) throw new Problem('未取得公告正文；空白頁不代表沒有活動。');
  const pageTitle = clean(content.children('h1').first().text() || $('.box > .title > h1').first().text());
  const metadata = noticeMetadata(html, pageTitle);
  if (canonical.searchParams.get('eventAdId') !== '19129' || !pageTitle) {
    pending('這份公告尚未驗證拆分格式，已保留全文；目前支援活動 19129。');
  }
  const bodies = content.children('div').filter((_, div) => clean($(div).children('h3').text()) === pageTitle);
  if (bodies.length !== 1) pending('官網正文格式已改變，需要重新確認拆分規則。');
  const body = bodies.first();
  const bodyContent = body.children('span').length === 1 ? body.children('span').first() : body;
  const children = bodyContent.children().toArray();
  if (bodyContent.contents().toArray().some(node => node.type === 'text' && clean(node.data))) {
    pending('正文出現沒有段落容器的文字，拆分待確認。');
  }
  const headers = [];
  children.forEach((node, index) => {
    if (node.tagName === 'h3' && index !== 0) pending('正文出現未驗證的標題層級，拆分待確認。');
    if (!['h3', 'p', 'table', 'hr', 'ul', 'ol'].includes(node.tagName) && (clean($(node).text()) || $(node).find('img').length)) {
      pending('正文出現尚未支援的巢狀內容，已保留來源，避免漏掉活動。');
    }
    const found = heading($, node);
    if (found) headers.push({ ...found, index });
  });
  if (!headers.length || !children.slice(0, headers[0].index).some(node => node.tagName === 'hr')) {
    pending('未找到可驗證的活動邊界，已保留全文。');
  }
  function imagesIn(nodes) {
    return [...new Set(nodes.flatMap(node => $(node).find('img').addBack('img').map((_, img) => {
      try {
        const url = new URL($(img).attr('src'), canonical);
        if (!['https:', 'http:'].includes(url.protocol)) pending('圖片來源格式尚未確認。');
        return url.href;
      } catch { pending('圖片來源格式尚未確認。'); }
    }).get()))];
  }
  let ordinal = 0;
  function paragraphs(nodes, scope) {
    return nodes.filter(node => ['p','table','ul','ol','li'].includes(node.tagName)).flatMap(node => {
      const text = nodeText($, node);
      return text ? [{ id: `P${String(++ordinal).padStart(3, '0')}`, scope, text,
        rows: node.tagName === 'table' ? tableRows($, node) : undefined }] : [];
    });
  }
  const sharedSources = [];
  const dateDiv = content.children('div').filter((_, div) => clean($(div).children('h3').text()) === '活動時間：').first();
  sharedSources.push(...paragraphs(dateDiv.children('p').toArray(), '版本共用期間；各活動明示期間優先'));
  const intro = children.slice(0, headers[0].index);
  sharedSources.push(...paragraphs(intro, '版本共用條件與說明'));
  const noteDiv = content.children('div').filter((_, div) => clean($(div).children('h3').text()) === '注意事項').first();
  if (!dateDiv.length || !noteDiv.length) pending('共用期間或注意事項容器缺失，需確認頁面模板。');
  sharedSources.push(...paragraphs(noteDiv.children('p,ul,ol').toArray(), '共用注意事項'));
  const sharedImages = imagesIn(intro);
  const sections = headers.map((header, index) => {
    const nodes = children.slice(header.index + 1, headers[index + 1]?.index ?? children.length);
    const texts = nodes.filter(node => ['p','table','ul','ol'].includes(node.tagName)).map(node => nodeText($, node)).filter(Boolean);
    const date = texts.some(text => dateLabel.test(text));
    const qualification = texts.some(text => eligibilityLabel.test(text));
    if (date !== qualification) pending(`「${header.title}」的獨立期間／資格不完整，拆分待確認。`);
    return { ...header, nodes, date, qualification, texts, images: imagesIn(nodes) };
  });
  const groups = [];
  let current;
  let groupTitle = null;
  let groupImages = [];
  for (const [sectionIndex, section] of sections.entries()) {
    if (section.date && section.qualification) {
      current = { section, sections: [], groupTitle, groupImages };
      groups.push(current);
    } else if (section.size === 20 && !section.texts.length && sections[sectionIndex + 1]?.date) {
      groupTitle = section.title;
      groupImages = section.images;
      current = null;
    } else {
      if (!current) pending(`「${section.title}」無法確認所屬活動，已保留全文。`);
      current.sections.push({ ...section, kind: section.size === 20 ? 'reference' : 'method' });
    }
  }
  if (!groups.length) pending('沒有可確認的活動區塊，已保留全文。');
  const activities = groups.map((group, order) => {
    const { section } = group;
    const ownImages = [...new Set([section, ...group.sections].flatMap(item => item.images))];
    const keys = identityKeys([section, ...group.sections].flatMap(item => item.texts), ownImages);
    const id = `beanfun-19129-${digest(ownAnchor(section))}`;
    const shared = [...sharedSources, ...paragraphs(section.nodes, '活動共用條件與說明')];
    const methods = group.sections.map(item => {
      const methodKeys = identityKeys(item.texts, item.images);
      return { id: `${id}-method-${digest(methodKeys[0] ?? item.title)}`, title: item.title, kind: item.kind,
        identityKeys: methodKeys, images: item.images,
        sources: paragraphs(item.nodes, item.kind === 'reference' ? `補充說明：${item.title}` : `取得方法：${item.title}`) };
    });
    // Standalone activities without subheadings retain one explicit program-owned method.
    if (!methods.some(method => method.kind === 'method')) {
      methods.unshift({ id: `${id}-method-participate`, title: '參與方式', kind: 'method', identityKeys: ['implicit:participate'], images: section.images, sources: [] });
    }
    const seen = new Set();
    for (const method of methods) {
      if (seen.has(method.id)) pending(`「${section.title}」出現無法區分的方法，拆分待確認。`);
      seen.add(method.id);
    }
    const allSources = [...shared, ...methods.flatMap(method => method.sources)];
    // This template's rank/unlock table is activity-wide even though placed inside the upgrade method.
    const rankConditions = allSources.filter(source => /^設計師等級\s*\|\s*設計師優惠\s*\|\s*階級開放日期(?:\n|$)/.test(source.text)
      || /每累積\d+個升級任務圖章.*提升設計師等級/.test(source.text)
      || /提升設計師等級.*UI領取設計師的特別優惠/.test(source.text));
    for (const source of rankConditions) source.scope = '活動共用階級與開放日期（保留原表格位置）';
    // References describe the same activity's items/ranks; they are reusable context, not another activity's rewards.
    const referenceSources = methods.filter(method => method.kind === 'reference').flatMap(method => method.sources);
    const applicableSharedIds = [...new Set([...shared, ...rankConditions, ...referenceSources].map(source => source.id))];
    const scopedMethods = methods.map(({ sources, ...method }) => ({ ...method, sourceIds: sources.map(source => source.id), sharedSourceIds: applicableSharedIds }));
    const applicableSharedImages = [...new Set([...sharedImages, ...group.groupImages, ...section.images, ...methods.filter(method => method.kind === 'reference').flatMap(method => method.images)])];
    const images = [...new Set([...applicableSharedImages, ...ownImages])];
    return { id, identityKeys: keys, title: section.title, pageTitle, groupTitle: group.groupTitle, sourceOrder: order, ...metadata,
      url: canonical.href, template: TEMPLATE, sources: allSources, methods: scopedMethods, sharedSourceIds: applicableSharedIds,
      images, sharedImages: applicableSharedImages, imageCount: images.length,
      shopImages: /商店/.test(section.title) ? ownImages : [],
      warnings: ['活動及方法邊界由程式依已驗證模板判定；其他公告格式仍待驗證。', '圖片尚未辨識；圖片內獎勵與條件待確認，不能視為完整摘要。'],
      contentHash: createHash('sha256').update(JSON.stringify(allSources)).digest('hex') };
  });
  if (new Set(activities.map(activity => activity.id)).size !== activities.length) pending('活動識別有重複，已停止拆分以避免誤合併。');
  return activities;
}
