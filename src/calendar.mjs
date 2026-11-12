import { fingerprint } from './incremental.mjs';
import { timeline } from './periods.mjs';
import { official } from './notice.mjs';

const labels = { start: '開始', end: '截止', claim: '領獎截止' };
const day = 86400000;
const samePoint = (a, b) => a?.date === b?.date && a?.exact === b?.exact;

export function calendarActivity(item) {
  const base = timeline(item);
  const periods = value => ({
    start: { point: value.participation.start, source: value.participation.source },
    end: { point: value.participation.end, source: value.participation.change ?
      { text: value.participation.change.quote, url: value.participation.change.url } : value.participation.source },
    claim: { point: value.claim.end, source: value.claim.change ?
      { text: value.claim.change.quote, url: value.claim.change.url } : value.claim.source },
  });
  const main = periods(base);
  const dates = Object.entries(main).map(([kind, value]) => ({ kind, ...value }));
  for (const method of item.methods.filter(method => method.kind === 'method')) {
    for (const [kind, value] of Object.entries(periods(timeline(item, method)))) {
      if (samePoint(main[kind].point, value.point) &&
          (value.point || main[kind].source?.text === value.source?.text)) continue;
      dates.push({ kind, ...value, method });
    }
  }
  return { item, dates: dates.map(entry => ({ ...entry, label: labels[entry.kind] })) };
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

export function exportCalendar(activities, now, origin) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Maple Notices//Calendar//ZH-TW', 'CALSCALE:GREGORIAN'];
  for (const { item, dates } of activities) {
    for (const { kind, label, point, source, method } of dates.filter(entry => entry.point)) {
      const title = [item.pageTitle, item.title, method?.title].filter((name, index, names) => name && names.indexOf(name) === index).join(' › ');
      const href = origin + '/activities/' + item.id + (method ? '#' + method.id : '');
      const officialUrl = source?.url ?? item.officialUrl ?? official;
      const description = ['活動筆記 ' + href, '官方來源 ' + officialUrl, source?.text].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT', 'UID:' + fingerprint([item.id, method?.id, kind]).slice(0, 32) + '@maplestory-notices',
        'DTSTAMP:' + utc(now), 'SUMMARY:' + icsText(label + ' · ' + title), 'DESCRIPTION:' + icsText(description),
        point.exact === null ? 'DTSTART;VALUE=DATE:' + point.date.replaceAll('-', '') : 'DTSTART:' + utc(point.exact), 'END:VEVENT');
    }
  }
  return [...lines, 'END:VCALENDAR', ''].map(fold).join('\r\n');
}
