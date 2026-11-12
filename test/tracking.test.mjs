import test from 'node:test';
import assert from 'node:assert/strict';
import { activityTracking, sourceTracking } from '../src/tracking.mjs';

const url = 'https://maplestory.beanfun.com/bulletin?bid=1';
const now = new Date('2026-11-12T14:10:00+08:00');
const activity = (id, participation, claim) => ({
  id, title: id, officialUrl: url, sources: [], methods: [],
  local: [participation, claim].filter(Boolean).map((text, index) => ({ id: String(index), text })),
});

test('來源只在所有活動期限屆滿 30 天後停止；未知期限與領獎期繼續追蹤', () => {
  const expired = activity('已結束', '活動時間：2026/10/01 09:00 ~ 2026/10/13 14:10');
  const grace = activity('寬限期', '活動時間：2026/10/01 09:00 ~ 2026/10/13 14:11');
  const claiming = activity('仍可領獎', expired.local[0].text, '領獎期限：至 2026/11/20');
  const unknown = activity('期限不明', expired.local[0].text, '領獎期限：另行公告');
  assert.equal(activityTracking(expired, now).track, false);
  assert.equal(activityTracking(grace, now).reason, '最後期限結束未滿 30 天');
  assert.equal(activityTracking(claiming, now).reason, '領獎期限尚未結束');
  assert.equal(activityTracking(unknown, now).reason, '期限待確認');
  assert.equal(sourceTracking([expired, claiming], {}, now).get(url).filter(item => item.track).length, 1);
});
