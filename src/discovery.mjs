import { load } from 'cheerio';
import { Problem, official } from './notice.mjs';
import { fingerprint } from './incremental.mjs';
import { reviewDocument } from './review.mjs';

const origin = 'https://maplestory.beanfun.com';
const eventHosts = new Set(['maplestory-event.beanfun.com', 'beanfun-event.beanfun.com']);
const routine = /例行維護/;
const shop = /商城|販售|黃金蘋果|皇家美容|閃亮彗星|福袋|組合包|制裁|楓潮派對|橘子週年慶/;
const change = /延期|延長|提前|更正|勘誤|調整|補償|異常|修復|修正|問題|取消|暫停/;
const clean = text => text.replace(/\s+/g, '').toLowerCase();

export function announcementUrl(value) {
  let url;
  try { url = new URL(value, origin); } catch { throw new Problem('請提供有效的新楓之谷官方公告網址。'); }
  if (url.protocol === 'https:' && !url.port && !url.username && !url.password) {
    const param = [...url.searchParams].find(([key]) => /^eventadid$/i.test(key))?.[1];
    if (eventHosts.has(url.hostname) && /^\/(?:eventad_mobile|eventad)\/eventad\/?$/i.test(url.pathname) && /^\d+$/.test(param ?? '')) {
      return 'https://beanfun-event.beanfun.com/EventAD_Mobile/EventAD?eventAdId=' + param;
    }
    if (url.origin === origin && /^\/bulletin\/?$/i.test(url.pathname) && /^\d+$/.test(url.searchParams.get('bid') ?? '')) {
      return origin + '/bulletin?bid=' + url.searchParams.get('bid');
    }
    if (url.hostname === 'maplestory-event.beanfun.com' && /^\/Event\/E\d{8}\/Index\/?$/i.test(url.pathname)) {
      return url.origin + url.pathname.replace(/\/$/, '');
    }
  }
  throw new Problem('請提供新楓之谷官方公告或活動專頁網址。');
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) })
    .catch(() => { throw new Problem('官網連線逾時或未能取得頁面。', 502); });
  if (!response.ok) throw new Problem('官網回應 HTTP ' + response.status, 502);
  return response;
}

async function officialSession(path) {
  const response = await request(origin + path);
  const token = load(await response.text())('input[name="__RequestVerificationToken"]').val();
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  if (!token || !cookie) throw new Problem('官網公告表單格式已變更。', 502);
  return async (handler, params) => {
    const response = await request(origin + handler, {
      method: 'POST', headers: { cookie, 'X-CSRF-TOKEN': token }, body: new URLSearchParams(params),
    });
    const result = (await response.json())?.data?.myDataSet;
    if (!result) throw new Problem('官網公告回應格式已變更。', 502);
    return result;
  };
}

export async function officialPages() {
  const post = await officialSession('/main');
  return async page => {
    const result = await post('/main?handler=BulletinProxy', { Kind: '0', Page: page, method: '0', PageSize: '10' });
    return { rows: result.table, totalPages: Number(result.systemTable?.totalPage) };
  };
}

export async function officialAnnouncement(url) {
  const bid = new URL(url).searchParams.get('bid');
  if (bid) {
    const post = await officialSession('/bulletin?bid=' + bid);
    const { table } = await post('/bulletin?handler=BulletinDetail', { Bid: bid });
    if (!table?.content || !table.title) throw new Problem('官網未提供公告正文。', 502);
    return { title: table.title, date: table.startDate, html: '<article class="bulletin_main">' + table.content + '</article>' };
  }
  const html = await (await request(url)).text();
  const $ = load(html);
  const title = $('.content h1').first().text().trim() || $('title').text().trim();
  if (!$('body').text().trim() && !$('body img').length) throw new Problem('官網未提供公告正文。', 502);
  return { title, html };
}

const dateKey = value => {
  const parts = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:$|[ T])/.exec(value ?? '');
  if (!parts) return null;
  const date = parts[1] + '-' + parts[2].padStart(2, '0') + '-' + parts[3].padStart(2, '0');
  const parsed = new Date(date);
  return Number.isFinite(+parsed) && parsed.toISOString().startsWith(date) ? date : null;
};

export function discoveryWindow(now) {
  const end = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
  const start = new Date(Date.parse(end) - 89 * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function classification(url, title) {
  if (shop.test(title) || /臨時維護|改版維護|分段分流|已知問題/.test(title)) return 'related';
  if (routine.test(title)) return 'routine';
  if (eventHosts.has(new URL(url).hostname) || /改版內容|版本更新內容|改版資訊/.test(title)) return 'version';
  return 'related';
}

export async function collectAnnouncements(openPages, now) {
  const window = discoveryWindow(now);
  const candidates = new Map();
  let pages = 0;
  let error;
  try {
    const list = await openPages();
    let previousDate;
    for (let page = 1; page <= 60; page++) {
      const { rows, totalPages } = await list(page);
      if (!Array.isArray(rows) || !rows.length || !Number.isInteger(totalPages) || totalPages < page) throw new Error('列表資料缺漏');
      const dates = rows.map(row => dateKey(row.startDate));
      if (dates.some((date, index) => !date || date > (dates[index - 1] ?? previousDate ?? date))) throw new Error('列表日期缺漏或順序改變');
      for (const [index, row] of rows.entries()) {
        if (dates[index] < window.start || dates[index] > window.end) continue;
        const title = String(row.title ?? '').trim();
        let url;
        try { url = announcementUrl(row.urlLink || '/bulletin?bid=' + row.bullentinId); } catch { continue; }
        if (!title) throw new Error('列表公告缺少標題');
        candidates.set(url, { url, title, date: dates[index], kind: classification(url, title) });
      }
      pages++;
      previousDate = dates.at(-1);
      if (previousDate < window.start || page === totalPages) return { ...window, pages, candidates: [...candidates.values()] };
    }
    throw new Error('已達本次列表檢查上限');
  } catch (cause) {
    error = cause.message;
  }
  return { ...window, pages, error, candidates: [...candidates.values()] };
}

export async function saveAnnouncement(candidate, items, fetchAnnouncement, save, previous, now) {
  const detail = await fetchAnnouncement(candidate.url);
  const title = candidate.title || detail.title || '官方公告';
  const kind = candidate.kind ?? classification(candidate.url, title);
  const document = reviewDocument(detail.html);
  if (!document.blocks.length) throw new Problem('官方來源缺少可核對的內容。', 502);
  const headings = items.flatMap(item => [item.title, item.pageTitle].filter(Boolean)
    .map(name => ({ name, id: item.id, title: item.title })));
  const matches = document.blocks.flatMap((block, index) => {
    const activities = headings.filter(({ name }) => clean(block.text).includes(clean(name)));
    if (!activities.length) return [];
    const isHeading = /^[【〖]/.test(block.text) && /[】〗](?:\s*NEW!*)?$/.test(block.text);
    const section = isHeading ? document.blocks.slice(index + 1, index + 7) : [];
    const nextHeading = section.findIndex(next => /^[【〖]|^[一二三四五六]+、/.test(next.text));
    const text = [block, ...section.slice(0, nextHeading === -1 ? undefined : nextHeading)].map(part => part.text).join('\n');
    if (kind === 'related' && !change.test(text)) return [];
    return [{ id: block.id, text, activities: [...new Map(activities.map(activity => [activity.id, activity])).values()] }];
  });
  if (kind === 'related' && !matches.length) return null;
  const id = fingerprint(candidate.url).slice(0, 24);
  const snapshot = 'discovered-' + fingerprint([candidate.url, detail.html]) + '.html';
  if (previous?.snapshot !== snapshot) await save(snapshot, detail.html);
  return {
    id, url: candidate.url, title, kind, date: candidate.date ?? dateKey(detail.date),
    snapshot, matches, checkedAt: now.toISOString(),
    review: previous?.review,
    existing: candidate.url === official,
  };
}
