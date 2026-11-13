import { timeline } from './periods.mjs';
import { official } from './notice.mjs';

const grace = 30 * 86400000;
const endOfDay = point => point.exact ?? Date.parse(point.date + 'T23:59:59.999+08:00');

export function activityTracking(item, now) {
  const periods = [timeline(item), ...item.methods.filter(method => method.kind === 'method').map(method => timeline(item, method))];
  if (periods.some(period => period.participation.permanent)) return { track: true, reason: '常駐活動' };
  if (periods.some(({ participation, claim, opening }) =>
    !participation.end || ((claim.source || opening.source || claim.start) && !claim.end))) {
    return { track: true, reason: '期限待確認' };
  }
  const participationEnd = Math.max(...periods.map(period => endOfDay(period.participation.end)));
  const claimEnd = Math.max(...periods.flatMap(period => period.claim.end ? [endOfDay(period.claim.end)] : []));
  const specialEnd = Math.max(...periods.flatMap(period => [period.effect.end,
    ...period.makeup.map(rule => rule.end)].filter(Boolean).map(endOfDay)));
  const lastEnd = Math.max(participationEnd, claimEnd, specialEnd);
  if (participationEnd >= +now) return { track: true, reason: '參加期限尚未結束' };
  if (claimEnd >= +now) return { track: true, reason: '領獎期限尚未結束' };
  if (specialEnd >= +now) return { track: true, reason: '效果或補完期限尚未結束' };
  if (+now - lastEnd < grace) return { track: true, reason: '最後期限結束未滿 30 天' };
  return { track: false, reason: '最後期限已滿 30 天' };
}

export function sourceTracking(items, entries, now) {
  const sources = new Map();
  for (const item of items) {
    const state = activityTracking(item, now);
    const urls = new Set([item.officialUrl ?? official, ...(item.linkedSources ?? []).map(record => record.url),
      ...(item.relatedNotices ?? []).map(notice => entries[notice.id]?.url).filter(Boolean)]);
    for (const url of urls) {
      if (!sources.has(url)) sources.set(url, []);
      sources.get(url).push({ id: item.id, title: item.title, ...state });
    }
  }
  return sources;
}
