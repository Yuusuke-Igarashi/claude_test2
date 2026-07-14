// ラーメンレーダー フロントエンド。
// 1. 日本のGeoJSON(緯度経度)を等距円筒図法で自前投影してSVGに描画
// 2. /api/posts の投稿を同じ投影でピン配置
// 3. ピン/リストのホバーで詳細カードを表示、定期的に自動更新

const SVGNS = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 30_000;

const el = {
  map: document.getElementById('map'),
  mapwrap: document.getElementById('mapwrap'),
  tooltip: document.getElementById('tooltip'),
  loading: document.getElementById('loading'),
  list: document.getElementById('postList'),
  statLocated: document.getElementById('statLocated'),
  updatedAt: document.getElementById('updatedAt'),
  demoBadge: document.getElementById('demoBadge'),
  liveBadge: document.getElementById('liveBadge'),
  refreshBtn: document.getElementById('refreshBtn'),
  autoRefresh: document.getElementById('autoRefresh'),
  windowLabel: document.getElementById('windowLabel'),
};

// ---- 投影 (equirectangular + 緯度補正) ----
const VIEW_W = 1000;
let projection = null; // { project(lon,lat)->{x,y}, width, height }

function buildProjection(bounds) {
  const { minLon, maxLon, minLat, maxLat } = bounds;
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const kx = Math.cos(midLat); // 経度1度あたりの実距離補正
  const rawW = (maxLon - minLon) * kx;
  const rawH = maxLat - minLat;
  const pad = 20;
  const scale = (VIEW_W - pad * 2) / rawW;
  const height = rawH * scale + pad * 2;
  return {
    width: VIEW_W,
    height,
    project(lon, lat) {
      const x = pad + (lon - minLon) * kx * scale;
      const y = pad + (maxLat - lat) * scale; // 北が上
      return { x, y };
    },
  };
}

function boundsOf(geojson) {
  let minLon = 1e9, maxLon = -1e9, minLat = 1e9, maxLat = -1e9;
  for (const f of geojson.features) {
    for (const poly of f.geometry.coordinates) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

// ---- 地図描画 ----
async function drawMap() {
  const geo = await fetch('/data/japan.json').then((r) => r.json());
  projection = buildProjection(boundsOf(geo));
  el.map.setAttribute('viewBox', `0 0 ${projection.width} ${projection.height}`);

  const frag = document.createDocumentFragment();
  for (const f of geo.features) {
    let d = '';
    for (const poly of f.geometry.coordinates) {
      for (const ring of poly) {
        d += ring
          .map(([lon, lat], i) => {
            const { x, y } = projection.project(lon, lat);
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(' ') + ' Z ';
      }
    }
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'pref');
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = f.properties.nam_ja;
    path.appendChild(title);
    frag.appendChild(path);
  }
  el.map.appendChild(frag);
  // ピンを載せるグループ（地図の上に重ねる）
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('id', 'pins');
  el.map.appendChild(g);
}

// ---- ユーティリティ ----
function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}時間前`;
}
const confClass = { high: 'c-high', medium: 'c-medium', low: 'c-low' };
const confLabel = { high: 'ジオタグ', medium: '地名(市区)', low: '地名(都道府県)' };
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- ピン描画 ----
let posts = [];
const pinById = new Map();
const itemById = new Map();

function renderPins() {
  const g = document.getElementById('pins');
  g.innerHTML = '';
  pinById.clear();
  for (const p of posts) {
    const { x, y } = projection.project(p.lon, p.lat);
    const fresh = Date.now() - Date.parse(p.createdAt) < 10 * 60 * 1000;
    if (fresh) {
      const halo = document.createElementNS(SVGNS, 'circle');
      halo.setAttribute('cx', x);
      halo.setAttribute('cy', y);
      halo.setAttribute('r', 4);
      halo.setAttribute('class', `pin-halo pulse ${confClass[p.confidence]}`);
      halo.style.fill = 'currentColor';
      g.appendChild(halo);
    }
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', 5);
    c.setAttribute('class', `pin ${confClass[p.confidence]}`);
    c.dataset.id = p.id;
    c.addEventListener('mouseenter', (e) => showTooltip(p, e));
    c.addEventListener('mousemove', moveTooltip);
    c.addEventListener('mouseleave', hideTooltip);
    g.appendChild(c);
    pinById.set(p.id, c);
  }
}

// ---- ツールチップ ----
function tooltipHTML(p) {
  const tags = (p.tags || []).slice(0, 4).map((t) => `<span class="tt-tag">#${esc(t)}</span>`).join('');
  const link = p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">元投稿 ↗</a>` : p.sourceLabel;
  return `
    <img class="tt-img" src="${esc(p.image)}" alt="ラーメン画像" loading="lazy" />
    <div class="tt-body">
      <div class="tt-loc">📍 ${esc(p.locationLabel)}
        <span class="tt-conf conf-${p.confidence}">${confLabel[p.confidence]}</span></div>
      <div class="tt-text">${esc(p.text)}</div>
      <div class="tt-meta"><span>${esc(p.authorHandle || p.author)}</span><span>${timeAgo(p.createdAt)}</span></div>
      <div class="tt-tags">${tags}</div>
      <div class="tt-meta" style="margin-top:6px"><span>${esc(p.sourceLabel)}</span><span>${link}</span></div>
    </div>`;
}
function showTooltip(p, e) {
  el.tooltip.innerHTML = tooltipHTML(p);
  el.tooltip.hidden = false;
  moveTooltip(e);
  setActive(p.id, true);
}
function moveTooltip(e) {
  const r = el.mapwrap.getBoundingClientRect();
  let x = e.clientX - r.left;
  let y = e.clientY - r.top;
  x = Math.max(140, Math.min(r.width - 140, x));
  // 上端に近いピンはカードを下側に反転表示（画像が切れないように）
  const flip = y < 320;
  el.tooltip.classList.toggle('below', flip);
  el.tooltip.style.left = `${x}px`;
  el.tooltip.style.top = `${flip ? y + 18 : Math.max(160, y)}px`;
}
function hideTooltip() {
  el.tooltip.hidden = true;
  el.tooltip.querySelectorAll && document.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));
}
function setActive(id, on) {
  pinById.get(id)?.classList.toggle('active', on);
  itemById.get(id)?.classList.toggle('active', on);
}

// ---- サイドバー一覧 ----
function renderList() {
  el.list.innerHTML = '';
  itemById.clear();
  for (const p of posts) {
    const li = document.createElement('li');
    li.className = 'post-item';
    li.innerHTML = `
      <img src="${esc(p.image)}" alt="" loading="lazy" />
      <div class="pi-body">
        <div class="pi-loc">📍 ${esc(p.locationLabel)}</div>
        <div class="pi-text">${esc(p.text)}</div>
        <div class="pi-meta">${esc(p.sourceLabel)} ・ ${timeAgo(p.createdAt)}</div>
      </div>`;
    li.addEventListener('mouseenter', (e) => {
      setActive(p.id, true);
      const pin = pinById.get(p.id);
      if (pin) {
        const rect = pin.getBoundingClientRect();
        showTooltip(p, { clientX: rect.left + rect.width / 2, clientY: rect.top });
      }
    });
    li.addEventListener('mouseleave', () => { setActive(p.id, false); hideTooltip(); });
    el.list.appendChild(li);
    itemById.set(p.id, li);
  }
}

// ---- データ取得 ----
async function load() {
  el.refreshBtn.disabled = true;
  try {
    const data = await fetch('/api/posts').then((r) => r.json());
    posts = data.posts || [];
    el.windowLabel.textContent = data.windowMinutes ?? 60;
    el.statLocated.textContent = data.counts?.located ?? posts.length;
    el.updatedAt.textContent = '更新 ' + new Date(data.generatedAt).toLocaleTimeString('ja-JP');
    el.demoBadge.hidden = !data.demo;
    el.liveBadge.hidden = data.demo;
    renderPins();
    renderList();
  } catch (e) {
    el.updatedAt.textContent = '取得エラー';
    console.error(e);
  } finally {
    el.loading.hidden = true;
    el.refreshBtn.disabled = false;
  }
}

// ---- 起動 ----
let timer = null;
function scheduleAuto() {
  clearInterval(timer);
  if (el.autoRefresh.checked) timer = setInterval(load, REFRESH_MS);
}
el.refreshBtn.addEventListener('click', load);
el.autoRefresh.addEventListener('change', scheduleAuto);

(async function main() {
  await drawMap();
  await load();
  scheduleAuto();
})();
