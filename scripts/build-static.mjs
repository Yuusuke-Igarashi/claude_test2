// GitHub Pages 等の静的ホスティング向けに、単一ファイルの `index.html` を生成する。
//
// サーバ版（server/）はMastodonなどからSNSデータをライブ取得するが、
// GitHub Pages はサーバを実行できない（静的配信のみ）。そこで本スクリプトは
//   - 日本地図GeoJSON
//   - デモ用サンプル投稿（server/ のロジックで位置推定したもの）
//   - ラーメン画像(SVG, data URI)
// をすべて1つのHTMLに埋め込み、外部通信ゼロで動く自己完結ページを作る。
//
//   node scripts/build-static.mjs   →  ./index.html を出力
//
// テンプレートは scripts/template.html。`/*__GEOJSON__*/` 等のプレースホルダを置換する。

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fetchSample } from '../server/sources/sample.js';
import { estimateLocation } from '../server/geo/estimate.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUB = join(ROOT, 'public');

// 1. 日本地図
const geojson = readFileSync(join(PUB, 'data/japan.json'), 'utf8');

// 2. 画像 → data URI（index=1..10 でキー化）
const images = {};
for (const f of readdirSync(join(PUB, 'images'))) {
  const m = f.match(/ramen-(\d+)\.svg/);
  if (!m) continue;
  const svg = readFileSync(join(PUB, 'images', f), 'utf8');
  images[String(Number(m[1]))] = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// 3. 投稿: server のサンプル＋位置推定を再利用。時刻は minutesAgo（相対）で持たせ、
//    表示側（ブラウザ）でロード時刻から絶対時刻を計算する（常に「◯分前」が生きる）。
const base = Date.now();
const posts = [];
for (const s of fetchSample({ now: base })) {
  const geo = estimateLocation(s);
  if (!geo) continue;
  posts.push({
    id: s.id,
    sourceLabel: s.sourceLabel,
    text: s.text,
    tags: s.tags,
    author: s.author,
    authorHandle: s.authorHandle,
    img: String(Number(s.image.match(/ramen-(\d+)/)[1])),
    minutesAgo: Math.round((base - Date.parse(s.createdAt)) / 60000),
    lat: Number(geo.lat.toFixed(4)),
    lon: Number(geo.lon.toFixed(4)),
    locationLabel: geo.label,
    confidence: geo.confidence,
    method: geo.method,
  });
}

const tpl = readFileSync(join(ROOT, 'scripts/template.html'), 'utf8');
const out = tpl
  // </script> がJSON内にあるとタグが閉じてしまうのを防ぐ
  .replace('/*__GEOJSON__*/', geojson.replace(/<\/script>/gi, '<\\/script>'))
  .replace('/*__POSTS__*/', JSON.stringify(posts))
  .replace('/*__IMAGES__*/', JSON.stringify(images));

writeFileSync(join(ROOT, 'index.html'), out);
console.log(`index.html を生成: posts=${posts.length}, images=${Object.keys(images).length}, ${Math.round(out.length / 1024)}KB`);
