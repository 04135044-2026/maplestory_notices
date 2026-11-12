import test from 'node:test';
import assert from 'node:assert/strict';
import { issueIndex } from '../src/known-issues.mjs';

test('只有明示修正才變更狀態，保留歷次原文與未關聯問題', () => {
  const snapshot = (id, date, html) => ({
    id, title: '例行公告 ' + id, url: 'https://maplestory.beanfun.com/bulletin?bid=' + id,
    date, snapshot: id, html,
  });
  const text = '馬戲團拳擊機退場時返回錯誤地圖。';
  const other = '馬戲團拳擊機入場時進入錯誤地圖。';
  const issues = issueIndex([
    snapshot('1', '2026-11-10', '<p>三、已知問題事項</p><p>1. ' + text + '</p><p>2. ' + other + '</p>'),
    snapshot('2', '2026-11-11', '<p>五、修正&amp;改善事項</p><p>1. ' + text + '</p>'),
    snapshot('3', '2026-11-12', '<p>四、已知問題</p><p>1. 商城異常。</p>'),
  ], [{ id: 'circus', title: '馬戲團拳擊機' }]);
  assert.equal(issues.find(issue => issue.text === text).state, 'fixed');
  assert.equal(issues.find(issue => issue.text === text).history.length, 2);
  assert.equal(issues.find(issue => issue.text === other).state, 'known');
  assert.equal(issues.find(issue => issue.text === other).activities[0].id, 'circus');
  assert.deepEqual(issues.find(issue => issue.text === '商城異常。').activities, []);
});
