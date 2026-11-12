import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarActivity, exportCalendar } from '../src/calendar.mjs';

test('匯出只加選取且有依據的重置提醒，跳過官方排除的首個週四', () => {
  const range = { id: 'date', text: '活動時間：2026/09/09 09:00 ~ 2026/10/20 23:59', scope: '活動共用條件與說明' };
  const sources = [range, { id: 'weekly', scope: '方法', text: '每週四0:00初始化。(活動的首個週四除外)' },
    { id: 'daily', scope: '方法', text: '每天上午6:30重置。' }, { id: 'unknown', scope: '方法', text: '每天重置，時間另行公告。' }];
  const item = { id: 'academy', title: '學院', sources, local: [range], methods: sources.slice(1).map(source =>
    ({ id: source.id, title: source.id, kind: 'method', sourceIds: [source.id], sharedSourceIds: ['date'] })) };
  const activity = calendarActivity(item);
  const now = new Date('2026-09-09T00:00:00Z');
  const file = options => exportCalendar([activity], now, 'http://localhost', options);
  assert.doesNotMatch(file({}), /RRULE/);
  assert.match(file({ academy: ['WEEKLY'] }), /DTSTART:20260916T160000Z\r\nRRULE:FREQ=WEEKLY;UNTIL=20261020T155900Z/);
  assert.match(file({ academy: ['DAILY'] }), /DTSTART:20260909T223000Z\r\nRRULE:FREQ=DAILY/);
  assert.equal((file({ academy: ['DAILY'] }).match(/RRULE/g) ?? []).length, 1);
  sources[2].text = '每天下午6:30重置。';
  assert.match(exportCalendar([calendarActivity(item)], now, 'http://localhost', { academy: ['DAILY'] }),
    /DTSTART:20260909T103000Z\r\nRRULE:FREQ=DAILY/);
  range.text = '活動時間：2026/09/09 維護後 ~ 2026/10/20 23:59';
  assert.match(exportCalendar([calendarActivity(item)], now, 'http://localhost', { academy: ['DAILY'] }),
    /DTSTART:20260910T103000Z\r\nRRULE:FREQ=DAILY/);
  sources[2].text = '每天不會在6:30重置。';
  assert.doesNotMatch(exportCalendar([calendarActivity(item)], now, 'http://localhost', { academy: ['DAILY'] }), /RRULE/);
  sources[1].text = '紀錄會於每週三0:00進行初始化。';
  const shared = { ...item, methods: [{ ...item.methods[0], sourceIds: [], sharedSourceIds: ['date', 'weekly'] }] };
  assert.match(exportCalendar([calendarActivity(shared)], now, 'http://localhost', { academy: ['WEEKLY'] }),
    /DTSTART:20260915T160000Z\r\nRRULE:FREQ=WEEKLY/);
});
