import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileEventReview, splitEventPage } from '../src/event-layout.mjs';
import { timeline } from '../src/periods.mjs';

const notice = { url: 'https://beanfun-event.beanfun.com/EventAD_Mobile/EventAD?eventAdId=1' };
const heading = text => '<p style="font-weight:700;font-size:15pt">【' + text + '】</p>';
const page = content => '<div class="box"><div class="title"><h1>測試活動</h1></div></div>' +
  '<div class="bulletin_main"><div><h3>活動時間：</h3><p>2026/11/04 09:00 ~ 2026/12/01 23:59</p></div>' +
  '<div><h3>測試活動</h3><p>活動資格：Lv101</p>' + content + '</div><div><h3>注意事項</h3></div></div>';

test('局部重複標題保留待核對的原文，其後方法照常拆分並保留領獎截止時刻', () => {
  const html = page(heading('點名') + '<p>登入點名</p>' + heading('點名') + '<p>另一項待核對說明</p>' +
    heading('狩獵') + '<p>禮物可領取時間為12/2維護後 ~ 12/15 23:59。</p>');
  const [item] = splitEventPage(html, notice);
  assert.deepEqual(item.methods.map(method => method.title), ['點名', '狩獵']);
  assert.equal(item.warnings.length, 1);
  assert.ok(item.sources.some(source => source.scope === '活動歸屬待確認' && source.text === '另一項待核對說明'));
  const { participation, claim } = timeline(item, item.methods[1]);
  assert.equal(participation.end.date, '2026-12-01');
  assert.deepEqual(claim.start, { date: '2026-12-02', exact: null });
  assert.equal(claim.end.exact, Date.parse('2026-12-15T23:59:00+08:00'));
  const [other] = splitEventPage(html, { url: notice.url.replace('=1', '=2') });
  assert.notEqual(other.id, item.id);
  assert.deepEqual(other.methods.map(method => method.title), item.methods.map(method => method.title));
});

test('重跑保留已核對方法的識別碼與段落並補入其他方法', () => {
  const [item] = splitEventPage(page(heading('點名') + '<p>登入點名</p>' + heading('狩獵') + '<p>狩獵怪物</p>'), notice);
  const [checkIn, hunt] = item.methods;
  const saved = { ...item, id: 'manual-activity', methods: [{ ...checkIn, id: 'manual-method',
    sourceIds: checkIn.sourceIds.slice(1) }] };
  const [merged] = reconcileEventReview([item], [saved]);
  assert.equal(merged.id, saved.id);
  assert.deepEqual(merged.methods.map(method => method.id), ['manual-method', hunt.id]);
  assert.deepEqual(merged.methods[0].sourceIds, saved.methods[0].sourceIds);
});

test('同一場遊戲的玩法與計分獎勵保留在同一取得方式', () => {
  const [item] = splitEventPage(page(heading('遊戲說明') + '<p>進入遊戲</p><hr>' +
    heading('活動獎勵') + '<p>根據遊戲結果獲得狩獵分數。</p>' +
    '<table><tr><th>分數</th><th>獎勵</th></tr><tr><td>500</td><td>交換券</td></tr></table>'), notice);
  assert.deepEqual(item.methods.map(method => method.title), ['遊戲玩法與獎勵']);
  const content = item.sources.filter(source => item.methods[0].sourceIds.includes(source.id));
  assert.ok(content.some(source => source.text === '進入遊戲'));
  assert.ok(content.some(source => source.rows?.[1][1] === '交換券'));
});
