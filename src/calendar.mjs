import { fingerprint } from './incremental.mjs';
import { timeline } from './periods.mjs';
import { official } from './notice.mjs';
import { methodContext } from './catalog.mjs';

const labels = { start: '開始', end: '截止', claimOpen: '開始領獎', claim: '領獎截止',
  effect: '效果到期', makeupOpen: '開始補完', makeupEnd: '補完截止' };
const day = 86400000;
const samePoint = (a, b) => a?.date === b?.date && a?.exact === b?.exact;
const weekdays = '日一二三四五六';
const resetPattern = /(?:每週([日天一二三四五六])|每日|每天)[^。；，,、週\d]{0,18}?(上午|下午|晚上|凌晨|中午)?(\d{1,2})[：:](\d{2})\s*(?:進行)?(?:初始化|重置)/g;

function methodReminders(item, method) {
  const { participation } = timeline(item, method);
  const resets = methodContext(item, method).filter(source => !source.rows && /初始化|重置/.test(source.text));
  if (!participation.start || !participation.end) return [];
  const start = participation.start.exact ?? Date.parse(participation.start.date + 'T00:00:00+08:00') + day;
  const until = participation.end.exact ?? Date.parse(participation.end.date + 'T00:00:00+08:00') - 1000;
  const rules = [];
  for (const source of resets) {
    if (/不會|不再|不在|不於|不重置|不初始化|取消|停用|UTC|GMT/i.test(source.text)) continue;
    for (const [, weekday, period, hour, minute] of source.text.matchAll(resetPattern)) {
      const rawHour = Number(hour);
      if (rawHour > 23 || Number(minute) > 59 || (period && (rawHour < 1 || rawHour > 12))) continue;
      const clockHour = period ? rawHour % 12 + (/下午|晚上|中午/.test(period) ? 12 : 0) : rawHour;
      const frequency = weekday ? 'WEEKLY' : 'DAILY';
      const interval = weekday ? 7 * day : day;
      let first = Date.parse(participation.start.date + 'T' + String(clockHour).padStart(2, '0') + ':' + minute + ':00+08:00');
      if (weekday) {
        const localDay = new Date(participation.start.date + 'T00:00:00Z').getUTCDay();
        first += ((weekdays.indexOf(weekday === '天' ? '日' : weekday) - localDay + 7) % 7) * day;
      }
      const exceptions = [...source.text.matchAll(/首個(?:週|星期)([日天一二三四五六])除外/g)];
      const rest = source.text.replace(/首個(?:週|星期)[日天一二三四五六]除外/g, '');
      if (/除外|例外|暫停|維護後/.test(rest)) continue;
      if (exceptions.length) {
        if (exceptions.length !== 1 || !weekday || exceptions[0][1].replace('天', '日') !== weekday.replace('天', '日')) continue;
        first += interval;
      }
      if (first < start) first += interval;
      if (first <= until) rules.push({ method, frequency, first, until, source });
    }
  }
  return [...new Map(rules.map(rule => [JSON.stringify([rule.frequency, rule.first, rule.until]), rule])).values()];
}

export function calendarActivity(item) {
  const base = timeline(item);
  const periods = value => ({
    start: { point: value.participation.start, source: value.participation.source },
    end: { point: value.participation.end, source: value.participation.change ?
      { text: value.participation.change.quote, url: value.participation.change.url } : value.participation.source },
    claim: { point: value.claim.end, source: value.claim.change ?
      { text: value.claim.change.quote, url: value.claim.change.url } : value.claim.source },
    claimOpen: { point: value.claim.start ?? value.opening.start, source: value.claim.start ? value.claim.source : value.opening.source },
    effect: { point: value.effect.end, source: value.effect.source },
  });
  const main = periods(base);
  const dates = Object.entries(main).filter(([kind, value]) => !['claimOpen', 'effect'].includes(kind) || value.point)
    .map(([kind, value]) => ({ kind, ...value }));
  const addMakeup = (periods, method) => {
    for (const rule of periods.makeup) {
      if (method && base.makeup.some(entry => entry.source.id === rule.source.id)) continue;
      for (const [kind, point] of [['makeupOpen', rule.start], ['makeupEnd', rule.end]]) {
        if (point) dates.push({ kind, point, source: rule.source, method });
      }
    }
  };
  addMakeup(base);
  for (const method of item.methods.filter(method => method.kind === 'method')) {
    const scoped = timeline(item, method);
    addMakeup(scoped, method);
    for (const [kind, value] of Object.entries(periods(scoped))) {
      if (['claimOpen', 'effect'].includes(kind) && !value.point) continue;
      if (samePoint(main[kind].point, value.point) &&
          (value.point || main[kind].source?.text === value.source?.text)) continue;
      dates.push({ kind, ...value, method });
    }
  }
  const reminders = new Map();
  for (const method of item.methods.filter(method => method.kind === 'method')) {
    for (const rule of methodReminders(item, method)) {
      const key = JSON.stringify([rule.source.id, rule.frequency, rule.first, rule.until]);
      if (!reminders.has(key)) reminders.set(key, rule);
    }
  }
  return { item, reminders: [...reminders.values()], dates: dates.map(entry => ({ ...entry, label: labels[entry.kind] })) };
}

export function exportVersion(activity, frequencies = []) {
  return fingerprint([
    activity.dates.filter(entry => entry.point).map(({ kind, method, point }) =>
      JSON.stringify([kind, method?.id, point.date, point.exact])).sort(),
    activity.reminders.filter(rule => frequencies.includes(rule.frequency)).map(({ method, frequency, first, until }) =>
      JSON.stringify([method.id, frequency, first, until])).sort(),
  ]);
}

const reminderVersion = (activity, frequency) => fingerprint(activity.reminders.filter(rule => rule.frequency === frequency)
  .map(({ method, first, until }) => JSON.stringify([method.id, first, until])).sort());

export function calendarExportChanged(activity, previous) {
  if (!previous) return false;
  if (!previous.reminderVersions) return previous.version !== exportVersion(activity, previous.frequencies);
  return previous.version !== exportVersion(activity) || Object.entries(previous.reminderVersions)
    .some(([frequency, version]) => version !== reminderVersion(activity, frequency));
}

export function calendarExportRecord(activity, selected, previous, at) {
  const reminderVersions = { ...previous?.reminderVersions };
  if (previous && !previous.reminderVersions) {
    const changed = calendarExportChanged(activity, previous);
    for (const frequency of previous.frequencies) reminderVersions[frequency] = changed ? previous.version : reminderVersion(activity, frequency);
  }
  for (const frequency of selected) reminderVersions[frequency] = reminderVersion(activity, frequency);
  return { version: exportVersion(activity), frequencies: Object.keys(reminderVersions), reminderVersions, exportedAt: at.toISOString() };
}

export function calendarMonth(month) {
  const first = Date.parse(month + '-01T00:00:00Z');
  const start = new Date(first);
  const offset = (start.getUTCDay() + 6) % 7;
  const next = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  const days = (next - first) / day;
  return Array.from({ length: Math.ceil((days + offset) / 7) }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const index = week * 7 + weekday - offset;
      return index < 0 || index >= days ? null : new Date(first + index * day).toISOString().slice(0, 10);
    }));
}

const icsText = text => text.replaceAll('\\', '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/[;,]/g, '\\$&');
const utc = date => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function fold(line) {
  let output = '';
  let bytes = 0;
  for (const character of line) {
    const width = Buffer.byteLength(character);
    if (bytes + width > 75) {
      output += '\r\n ';
      bytes = 1;
    }
    output += character;
    bytes += width;
  }
  return output;
}

export function exportCalendar(activities, now, origin, options = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Maple Notices//Calendar//ZH-TW', 'CALSCALE:GREGORIAN'];
  for (const { item, dates, reminders } of activities) {
    for (const { kind, label, point, source, method } of dates.filter(entry => entry.point)) {
      const title = [item.pageTitle, item.title, method?.title].filter((name, index, names) => name && names.indexOf(name) === index).join(' › ');
      const href = origin + '/activities/' + item.id + (method ? '#' + method.id : '');
      const officialUrl = source?.url ?? item.officialUrl ?? official;
      const description = ['活動筆記 ' + href, '官方來源 ' + officialUrl, source?.text].filter(Boolean).join('\n');
      const identity = [item.id, method?.id, kind];
      if (kind.startsWith('makeup')) identity.push(source?.id);
      lines.push('BEGIN:VEVENT', 'UID:' + fingerprint(identity).slice(0, 32) + '@maplestory-notices',
        'DTSTAMP:' + utc(now), 'SUMMARY:' + icsText(label + ' · ' + title), 'DESCRIPTION:' + icsText(description),
        point.exact === null ? 'DTSTART;VALUE=DATE:' + point.date.replaceAll('-', '') : 'DTSTART:' + utc(point.exact), 'END:VEVENT');
    }
    for (const rule of reminders.filter(rule => options[item.id]?.includes(rule.frequency))) {
      const title = (rule.frequency === 'DAILY' ? '每日重置' : '每週重置') + ' · ' + item.title + ' › ' + rule.method.title;
      const description = [rule.source.text, '活動筆記 ' + origin + '/activities/' + item.id + '#' + rule.method.id,
        '官方來源 ' + (rule.source.url ?? item.officialUrl ?? official)].join('\n');
      lines.push('BEGIN:VEVENT', 'UID:' + fingerprint([item.id, rule.method.id, rule.frequency, rule.first]).slice(0, 32) + '@maplestory-notices',
        'DTSTAMP:' + utc(now), 'SUMMARY:' + icsText(title), 'DESCRIPTION:' + icsText(description), 'DTSTART:' + utc(rule.first),
        'RRULE:FREQ=' + rule.frequency + ';UNTIL=' + utc(rule.until), 'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY',
        'DESCRIPTION:' + icsText(title), 'END:VALARM', 'END:VEVENT');
    }
  }
  return [...lines, 'END:VCALENDAR', ''].map(fold).join('\r\n');
}
