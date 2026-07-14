import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateLocation } from '../server/geo/estimate.js';
import { collectPosts } from '../server/collector.js';

test('ジオタグがあれば最優先で高信頼度になる', () => {
  const g = estimateLocation({ id: '1', geo: { lat: 35.69, lon: 139.69 }, text: '博多ラーメン' });
  assert.equal(g.confidence, 'high');
  assert.equal(g.method, 'geotag');
  assert.equal(g.lat, 35.69); // ジオタグの座標がそのまま使われる
  assert.equal(g.lon, 139.69);
});

test('本文の地名から位置を推定できる', () => {
  const g = estimateLocation({ id: '2', text: '喜多方ラーメンの朝ラー最高 #ラーメン' });
  assert.ok(g, '推定できること');
  assert.equal(g.method, 'text');
  assert.match(g.label, /喜多方/);
  // 喜多方 (37.65, 139.87) の近傍（ジッター ±0.05 以内）
  assert.ok(Math.abs(g.lat - 37.65) < 0.06);
  assert.ok(Math.abs(g.lon - 139.87) < 0.06);
});

test('より具体的な地名（市区）を都道府県より優先する', () => {
  const g = estimateLocation({ id: '3', text: '東京の博多で豚骨ラーメン' });
  // landmark(博多) が pref(東京) に勝つ
  assert.match(g.label, /博多/);
  assert.equal(g.confidence, 'medium');
});

test('タグやプロフィール所在地からも推定できる', () => {
  const g = estimateLocation({ id: '4', text: '今日の一杯', tags: ['ラーメン'], authorLocation: '札幌' });
  assert.ok(g);
  assert.match(g.label, /札幌/);
});

test('地名が無ければ null（地図に出さない）', () => {
  const g = estimateLocation({ id: '5', text: 'おいしいラーメン食べた🍜' });
  assert.equal(g, null);
});

test('ジッターは投稿IDに対して決定論的', () => {
  const a = estimateLocation({ id: 'same', text: '仙台ラーメン' });
  const b = estimateLocation({ id: 'same', text: '仙台ラーメン' });
  assert.equal(a.lat, b.lat);
  assert.equal(a.lon, b.lon);
});

test('collectPosts(sample) は1時間以内の位置付き投稿を返す', async () => {
  const res = await collectPosts({ forceSample: true });
  assert.equal(res.demo, true);
  assert.ok(res.posts.length > 0);
  const now = Date.now();
  for (const p of res.posts) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), '座標が有効');
    assert.ok(now - Date.parse(p.createdAt) <= 60 * 60 * 1000, '60分以内');
    assert.ok(p.locationLabel, 'ラベルあり');
    assert.ok(['high', 'medium', 'low'].includes(p.confidence));
  }
});
