// 防災モックアプリ（東南アジア拠点・家族向け）のビルド。
// src/ のテンプレート・CSS・JS と data/ geo/ の JSON を 1 つの自己完結 HTML (bousai/index.html) に埋め込む。
//   node bousai/scripts/build.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// JSON を <script> 内に安全に埋め込む（</script> と U+2028/2029 を回避）
const safeJSON = (obj) => JSON.stringify(obj)
  .replace(/<\/(script)/gi, '<\\/$1')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const geo = {};
for (const f of readdirSync(join(ROOT, 'geo'))) {
  if (!f.endsWith('.geojson')) continue;
  geo[f.replace('.geojson', '')] = JSON.parse(read(join('geo', f)));
}
const data = {};
for (const f of readdirSync(join(ROOT, 'data'))) {
  if (!f.endsWith('.json')) continue;
  data[f.replace('.json', '')] = JSON.parse(read(join('data', f)));
}

const order = ['core.js', 'geo.js', 'charts.js', 'model.js', 'view-region.js', 'view-site.js', 'view-groups.js', 'view-live.js', 'view-personal.js', 'view-risk.js', 'app.js'];
const js = order.filter((f) => existsSync(join(ROOT, 'src', f))).map((f) => `/* ---- src/${f} ---- */\n${read(join('src', f))}`).join('\n\n');

let html = read('src/index.template.html');
html = html
  .replace('/*__CSS__*/', () => read('src/style.css'))
  .replace('/*__GEO__*/', () => `window.GEO=${safeJSON(geo)};`)
  .replace('/*__DATA__*/', () => `window.DATA=${safeJSON(data)};`)
  .replace('/*__JS__*/', () => js)
  .replace('__BUILT_AT__', new Date().toISOString().slice(0, 10));

writeFileSync(join(ROOT, 'index.html'), html);
console.log(`bousai/index.html: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB (geo ${Object.keys(geo).join(',')}; data ${Object.keys(data).join(',')})`);
