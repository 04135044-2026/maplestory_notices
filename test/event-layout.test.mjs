import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileEventReview, splitEventPage } from '../src/event-layout.mjs';
import { activityState, timeline } from '../src/periods.mjs';

const notice = { url: 'https://beanfun-event.beanfun.com/EventAD_Mobile/EventAD?eventAdId=1' };
const heading = text => '<p style="font-weight:700;font-size:15pt">【' + text + '】</p>';
const page = content => '<div class="box"><div class="title"><h1>測試活動</h1></div></div>' +
  '<div class="bulletin_main"><div><h3>活動時間：</h3><p>2026/11/04 09:00 ~ 2026/12/01 23:59</p></div>' +
  '<div><h3>測試活動</h3><p>活動資格：Lv101</p>' + content + '</div><div><h3>注意事項</h3></div></div>';

// Minimal reproduction of notice 19032, preserving the headings and date labels.
const towerNotice = page(
  '<p style="font-weight:bold">〖次元之塔〗</p><p>活動日期：10/7 ~ 10/20</p><p>活動資格：Lv101</p>' +
  '<p>完成塔的挑戰</p><p>※排行獎勵可領取期間：2026/11/4 維護後~2026/11/10 23:59。(10/27編輯)</p>' +
  '<hr><p style="font-weight:bold">〖挑戰之路〗</p><p>活動日期：永久</p><p>向 NPC 接取任務後進入。</p>',
).replace('<p>活動資格：Lv101</p><p style', '<p style')
  .replace('2026/11/04 09:00 ~ 2026/12/01 23:59', '2026/10/07 09:00 ~ 2026/10/20 23:59');

test('獨立標題明示永久時可單獨拆分，不承接相鄰活動的資格和期限', () => {
  const items = splitEventPage(towerNotice, notice);
  assert.deepEqual(items.map(item => item.title), ['次元之塔', '挑戰之路']);
  const [tower, road] = items;
  assert.ok(!tower.sources.some(source => source.text.includes('接取任務')));
  assert.equal(road.eligibility, undefined);
  assert.ok(!road.sources.some(source => source.text.includes('排行獎勵') || source.text.includes('Lv101')));
  const periods = timeline(road, road.methods[0]);
  assert.equal(periods.participation.permanent, true);
  assert.equal(periods.participation.source.text, '活動日期：永久');
  assert.equal(periods.participation.end, undefined);
  assert.equal(activityState(periods, new Date('2026-11-13T12:00:00+08:00')), '進行中');
});

test('排行獎勵領取期間保留維護後時刻未知及明示的截止時刻', () => {
  const [tower] = splitEventPage(towerNotice, notice);
  const { participation, claim } = timeline(tower, tower.methods[0]);
  assert.equal(participation.end.exact, Date.parse('2026-10-20T23:59:00+08:00'));
  assert.deepEqual(claim.start, { date: '2026-11-04', exact: null });
  assert.equal(claim.end.exact, Date.parse('2026-11-10T23:59:00+08:00'));
});

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

test('多活動公告保留分波原文及有獨立資格的玩法分組', () => {
  const parent = '<p>活動日期：</p><p>第一波：11/4 ~ 11/10</p><p>第二波：11/11 ~ 12/1</p><p>活動資格：Lv101</p><p>狩獵累積里程。</p>';
  const child = '<hr><p style="font-weight:bold;font-size:20pt">【拳擊機】</p><p>活動資格：Lv200並完成五轉</p>' +
    heading('氣球挑戰') + '<p>活動日期：11/4 ~ 11/10</p>';
  const event = content => page(content).replace('<h3>測試活動</h3><p>活動資格：Lv101</p>', '<h3>測試活動</h3>');
  const [item] = splitEventPage(event(heading('馬拉松') + parent + child), notice);
  const [, group, challenge] = item.methods;
  assert.equal(challenge.groupTitle, '拳擊機');
  const qualification = item.sources.filter(source => challenge.sharedSourceIds.includes(source.id) &&
    source.text.startsWith('活動資格'));
  assert.deepEqual(qualification.map(source => source.text), ['活動資格：Lv200並完成五轉']);
  assert.equal(timeline(item, group).participation.start, undefined);
  assert.deepEqual(timeline(item).participation.phases.map(({ start, end }) => [start.date, end.date]), [
    ['2026-11-04', '2026-11-10'], ['2026-11-11', '2026-12-01'],
  ]);
  assert.equal(timeline(item, challenge).participation.end.date, '2026-11-10');
  const [ungrouped] = splitEventPage(event(heading('馬拉松') + parent + child.replace('font-size:20pt', 'font-size:15pt')), notice);
  assert.deepEqual(item.methods.map(method => method.id), ungrouped.methods.map(method => method.id));
});
