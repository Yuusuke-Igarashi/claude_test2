/* Maps: regional map (Natural Earth, equirectangular) and site-area sketch map (synthetic blocks + real-coordinate POIs + route search) */

/* ---------- Projection ---------- */
function makeProj(bbox, w, h, pad = 10) {
  const [x0, y0, x1, y1] = bbox; const lat0 = (y0 + y1) / 2; const kx = Math.cos(lat0 * Math.PI / 180);
  const sw = (x1 - x0) * kx, sh = (y1 - y0);
  const s = Math.min((w - pad * 2) / sw, (h - pad * 2) / sh);
  const ox = (w - sw * s) / 2, oy = (h - sh * s) / 2;
  const p = ([lon, lat]) => [ox + (lon - x0) * kx * s, oy + (y1 - lat) * s];
  p.inv = ([x, y]) => [x0 + (x - ox) / (kx * s), y1 - (y - oy) / s];
  p.scale = s; p.kx = kx;
  return p;
}
function ringPath(ring, proj) {
  let d = ''; for (let i = 0; i < ring.length; i++) { const [x, y] = proj(ring[i]); d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); } return d + 'Z';
}
function geoPath(geom, proj) {
  if (!geom) return '';
  const t = geom.type, c = geom.coordinates;
  if (t === 'Polygon') return c.map((r) => ringPath(r, proj)).join('');
  if (t === 'MultiPolygon') return c.map((p) => p.map((r) => ringPath(r, proj)).join('')).join('');
  if (t === 'LineString') return c.map(([lon, lat], i) => { const [x, y] = proj([lon, lat]); return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }).join('');
  if (t === 'MultiLineString') return c.map((l) => l.map(([lon, lat], i) => { const [x, y] = proj([lon, lat]); return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }).join('')).join('');
  return '';
}
function geomBBox(geom, bb = [Infinity, Infinity, -Infinity, -Infinity]) {
  const walk = (c) => { if (typeof c[0] === 'number') { bb[0] = Math.min(bb[0], c[0]); bb[1] = Math.min(bb[1], c[1]); bb[2] = Math.max(bb[2], c[0]); bb[3] = Math.max(bb[3], c[1]); } else c.forEach(walk); };
  walk(geom.coordinates); return bb;
}
function centroid(geom) {
  /* Vertex mean of the largest ring (display only) */
  let best = null, bl = 0; const walk = (c) => { if (typeof c[0][0] === 'number') { if (c.length > bl) { bl = c.length; best = c; } } else c.forEach(walk); };
  walk(geom.coordinates); if (!best) return [0, 0];
  let sx = 0, sy = 0; best.forEach(([x, y]) => { sx += x; sy += y; }); return [sx / best.length, sy / best.length];
}

/* ---------- Regional map ---------- */
const SEA_BBOX = [46, 35, 88, 56];
const SEA_ISO = ['KAZ', 'KGZ', 'TJK', 'TKM', 'UZB'];
const COUNTRY_JA = { KAZ: 'Kazakhstan', KGZ: 'Kyrgyzstan', TJK: 'Tajikistan', TKM: 'Turkmenistan', UZB: 'Uzbekistan', RUS: 'Russia', CHN: 'China', AFG: 'Afghanistan', IRN: 'Iran', AZE: 'Azerbaijan', MNG: 'Mongolia', PAK: 'Pakistan', IND: 'India', GEO: 'Georgia', ARM: 'Armenia', TUR: 'Turkey', IRQ: 'Iraq' };
/* Display names for Natural Earth place names (keys = spelling used in places_sea.geojson; common English where NE uses an odd or outdated spelling) */
const CITY_JA = { 'Nur-Sultan': 'Astana', 'Astana': 'Astana', 'Almaty': 'Almaty', 'Shymkent': 'Shymkent', 'Qaraghandy': 'Karaganda', 'Aqtobe': 'Aktobe', 'Taraz': 'Taraz', 'Pavlodar': 'Pavlodar', 'Semey': 'Semey', 'Oskemen': 'Oskemen', 'Atyrau': 'Atyrau', 'Oral': 'Uralsk (Oral)', 'Oostanay': 'Kostanay', 'Qyzylorda': 'Kyzylorda', 'Petropavlovsk': 'Petropavlovsk', 'Kokshetau': 'Kokshetau', 'Mangyshlak': 'Aktau', 'Zhezqazghan': 'Zhezkazgan', 'Balqash': 'Balkhash', 'Taldyqorghan': 'Taldykorgan', 'Rudniy': 'Rudny', 'Bishkek': 'Bishkek', 'Osh': 'Osh', 'Jalal Abad': 'Jalal-Abad', 'Karakol': 'Karakol', 'Dushanbe': 'Dushanbe', 'Khujand': 'Khujand', 'Qurghonteppa': 'Bokhtar', 'Kulob': 'Kulob', 'Khorugh': 'Khorog', 'Uroteppa': 'Istaravshan', 'Konibodom': 'Kanibadam', 'Ashgabat': 'Ashgabat', 'Türkmenabat': 'Turkmenabat', 'Daşoguz': 'Dashoguz', 'Mary': 'Mary', 'Türkmenbaşy': 'Turkmenbashi', 'Tashkent': 'Tashkent', 'Samarkand': 'Samarkand', 'Bukhara': 'Bukhara', 'Namangan': 'Namangan', 'Andijan': 'Andijan', 'Fargona': 'Fergana', 'Qoqon': 'Kokand', 'Nukus': 'Nukus', 'Urgentch': 'Urgench', 'Navoi': 'Navoi', 'Qarshi': 'Karshi', 'Termiz': 'Termez', 'Jizzax': 'Jizzakh', 'Olmaliq': 'Almalyk', 'Guliston': 'Gulistan', 'Chirchiq': 'Chirchik', 'Kattaqorgon': 'Kattakurgan', 'Denow': 'Denau', 'Kogon': 'Kagan', 'Khiwa': 'Khiva' };
/* Cities labelled at every zoom level (by the places_sea.geojson spelling) */
const BIG_CITIES = ['Almaty', 'Nur-Sultan', 'Astana', 'Shymkent', 'Qaraghandy', 'Aqtobe', 'Taraz', 'Pavlodar', 'Semey', 'Oskemen', 'Atyrau', 'Oral', 'Oostanay', 'Qyzylorda', 'Petropavlovsk', 'Mangyshlak', 'Bishkek', 'Osh', 'Karakol', 'Dushanbe', 'Khujand', 'Qurghonteppa', 'Ashgabat', 'Türkmenabat', 'Daşoguz', 'Mary', 'Türkmenbaşy', 'Tashkent', 'Samarkand', 'Bukhara', 'Namangan', 'Nukus'];

function bboxOfFeatures(fs) { const bb = [Infinity, Infinity, -Infinity, -Infinity]; fs.forEach((f) => geomBBox(f.geometry, bb)); return bb; }
function padBBox(bb, f = 0.08) { const w = bb[2] - bb[0], h = bb[3] - bb[1]; return [bb[0] - w * f, bb[1] - h * f, bb[2] + w * f, bb[3] + h * f]; }

/**
 * opts: { bbox, level(f)->'k0'..'k5'|'b1'..'b5'|'', selIds:Set, sites:[{id,lon,lat,label,status}], onPick(f), onSite(site), tip(f)->html, labels:bool }
 */
function renderRegionMap(svg, opts) {
  const W = 960, H = 600; svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const bbox = opts.bbox || SEA_BBOX; const proj = makeProj(bbox, W, H, 6);
  const G = window.GEO; let h = '';
  // Countries (others drawn faint)
  h += '<g class="g-adm0">' + G.adm0_sea.features.map((f) => `<path class="adm0${SEA_ISO.includes(f.properties.id) ? ' in' : ''}" d="${geoPath(f.geometry, proj)}"/>`).join('') + '</g>';
  // Regions (admin-1)
  h += '<g class="g-adm1">' + G.adm1_sea.features.map((f) => {
    const k = opts.level ? (opts.level(f) || '') : ''; const sel = opts.selIds && opts.selIds.has(f.properties.id);
    return `<path class="adm ${k}${sel ? ' sel' : ''}" data-id="${esc(f.properties.id)}" d="${geoPath(f.geometry, proj)}"><title>${esc(f.properties.n)} (${esc(COUNTRY_JA[f.properties.c] || f.properties.c)})</title></path>`;
  }).join('') + '</g>';
  // Selection outline on top
  if (opts.selIds && opts.selIds.size) h += '<g class="g-sel">' + G.adm1_sea.features.filter((f) => opts.selIds.has(f.properties.id)).map((f) => `<path class="adm sel" style="fill:none;pointer-events:none" d="${geoPath(f.geometry, proj)}"/>`).join('') + '</g>';
  h += '<g class="g-water">' + G.rivers_sea.features.map((f) => `<path class="river" style="stroke-width:${f.properties.sr <= 4 ? 1.6 : f.properties.sr <= 7 ? 1.1 : .7}" d="${geoPath(f.geometry, proj)}"/>`).join('') + G.lakes_sea.features.map((f) => `<path class="lake" d="${geoPath(f.geometry, proj)}"/>`).join('') + '</g>';
  // Country names
  if (opts.labels !== false) {
    const zoomed = (bbox[2] - bbox[0]) < 25;
    h += '<g class="g-lab">' + G.adm0_sea.features.filter((f) => SEA_ISO.includes(f.properties.id)).map((f) => {
      const c = centroid(f.geometry); const [x, y] = proj(c); if (x < 0 || x > W || y < 0 || y > H) return '';
      const fix = { KGZ: [35, -22], TJK: [60, 25] }[f.properties.id] || [0, 0]; /* label nudges (px) so the country names clear the Namangan / Dushanbe labels */
      return `<text class="m-label country" x="${(x + fix[0]).toFixed(0)}" y="${(y + fix[1]).toFixed(0)}" text-anchor="middle">${esc(f.properties.nl || f.properties.n)}</text>`;
    }).join('');
    const places = G.places_sea.features.filter((f) => BIG_CITIES.includes(f.properties.n) || (zoomed && (f.properties.p >= 500000 || /capital/.test(f.properties.cap)) && SEA_ISO.includes(f.properties.c)));
    h += places.map((f) => { const [x, y] = proj(f.geometry.coordinates); if (x < -5 || x > W + 5 || y < -5 || y > H + 5) return ''; const cap = /Admin-0 capital/.test(f.properties.cap); const big = f.properties.p >= 2000000; return `<circle class="m-place" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${cap ? 3.2 : 2.2}"/><text class="m-label${cap ? ' cap' : ' s'}" x="${(x + 5).toFixed(1)}" y="${(y + 3.5).toFixed(1)}">${esc(CITY_JA[f.properties.n] || f.properties.n)}</text>`; }).join('') + '</g>';
  }
  // Sites
  if (opts.sites) h += '<g class="g-sites">' + opts.sites.map((s) => { const [x, y] = proj([s.lon, s.lat]); return `<g class="m-site ${s.status || ''}${s.hl ? ' hl' : ''}" data-site="${esc(s.id)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle class="halo" r="14"/><circle class="dot" r="8"/><text y="3.2">${esc(s.label)}</text><title>${esc(s.name)}</title></g>`; }).join('') + '</g>';
  svg.innerHTML = h;
  const feats = by(G.adm1_sea.features.map((f) => ({ id: f.properties.id, f })), 'id');
  const box = svg.parentElement; let tip = box.querySelector('.tip'); if (!tip) { tip = el('<div class="tip" hidden></div>'); box.appendChild(tip); }
  svg.onmousemove = (e) => {
    const p = e.target.closest('.adm[data-id]'); if (!p || !opts.tip) { tip.hidden = true; return; }
    const f = feats[p.dataset.id].f; tip.innerHTML = opts.tip(f); tip.hidden = false;
    const r = box.getBoundingClientRect(); let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    if (x + 240 > r.width) x = Math.max(4, e.clientX - r.left - 250); if (y + tip.offsetHeight + 8 > r.height) y = Math.max(4, e.clientY - r.top - tip.offsetHeight - 12);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  svg.onmouseleave = () => { tip.hidden = true; };
  svg.onclick = (e) => {
    const s = e.target.closest('.m-site'); if (s && opts.onSite) { opts.onSite(s.dataset.site); return; }
    const p = e.target.closest('.adm[data-id]'); if (p && opts.onPick) opts.onPick(feats[p.dataset.id].f);
  };
  return proj;
}

/* ---------- Site-area sketch map ---------- */
/* Local plane: east-west / north-south distance from the center (m). */
function localXY(area, lon, lat) {
  const kx = 111320 * Math.cos(area.center_lat * Math.PI / 180), ky = 110574;
  return [(lon - area.center_lon) * kx, -(lat - area.center_lat) * ky];
}
function localLL(area, x, y) {
  const kx = 111320 * Math.cos(area.center_lat * Math.PI / 180), ky = 110574;
  return [area.center_lon + x / kx, area.center_lat - y / ky];
}
function pointInPoly(pt, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside; } return inside; }

/** Build the sketch map (deterministic per area). Returns {W,H,s,toPx,grid,nodes,edges,blocks,...} */
function buildArea(area) {
  const W = 960, H = 640; const spanM = (area.extent_km || 6) * 1000; const s = W / spanM; /* px per m */
  const rot = (area.rotation_deg || 0) * Math.PI / 180; const cr = Math.cos(rot), sr = Math.sin(rot);
  const toPx = (x, y) => [W / 2 + x * s, H / 2 + y * s];
  const rnd = mulberry32(hashStr(area.area_id));
  /* Grid (rotated frame): gs m spacing */
  const gs = area.grid_m || 170; const n = Math.ceil(spanM * 0.8 / gs);
  const nodes = [], idx = {}; const key = (i, j) => `${i}_${j}`;
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const jx = (rnd() - .5) * gs * .18, jy = (rnd() - .5) * gs * .18;
    const u = i * gs + jx, v = j * gs + jy; /* before rotation */
    const x = u * cr - v * sr, y = u * sr + v * cr;
    idx[key(i, j)] = nodes.length; nodes.push({ i, j, x, y });
  }
  const edges = []; /* {a,b,len,major} */
  const addE = (a, b, major) => { const A = nodes[a], B = nodes[b]; edges.push({ a, b, len: Math.hypot(A.x - B.x, A.y - B.y), major: !!major }); };
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const a = idx[key(i, j)];
    if (i < n && rnd() > 0.06) addE(a, idx[key(i + 1, j)], j % 4 === 0);
    if (j < n && rnd() > 0.06) addE(a, idx[key(i, j + 1)], i % 5 === 0);
  }
  /* Real major roads (lat/lon polylines) -> local coordinates; grid nodes are attached to the roads to form "arterial" edges */
  const roads = (area.roads || []).map((r) => ({ name: r.name, major: r.major !== false, pts: r.pts.map(([lat, lon]) => localXY(area, lon, lat)) }));
  roads.forEach((r) => {
    /* Add nodes every 150 m along the road and link them */
    let prev = null; for (let k = 0; k < r.pts.length - 1; k++) {
      const [x0, y0] = r.pts[k], [x1, y1] = r.pts[k + 1]; const L = Math.hypot(x1 - x0, y1 - y0); const steps = Math.max(1, Math.round(L / 150));
      for (let t = 0; t <= steps; t++) { if (t === 0 && k > 0) continue; const x = x0 + (x1 - x0) * t / steps, y = y0 + (y1 - y0) * t / steps; const id = nodes.length; nodes.push({ x, y, road: r.name }); if (prev != null) addE(prev, id, r.major); prev = id;
      }
    }
  });
  /* Connect road nodes to grid nodes (within 0.8*gs) */
  const gridCount = (2 * n + 1) * (2 * n + 1);
  for (let q = gridCount; q < nodes.length; q++) { const P = nodes[q]; for (let g = 0; g < gridCount; g++) { const Gd = nodes[g]; const d = Math.hypot(P.x - Gd.x, P.y - Gd.y); if (d < gs * 0.8) addE(q, g, false); } }
  /* Water (polygon or line) */
  const water = (area.water || []).map((w) => ({ name: w.name, kind: w.kind || 'canal', width: w.width_m || 12, pts: w.pts.map(([lat, lon]) => localXY(area, lon, lat)) }));
  /* Parks (park POIs approximated as circles) */
  const pois = (area.pois || []).map((p) => { const [x, y] = localXY(area, p.lon, p.lat); return Object.assign({}, p, { x, y }); });
  /* Assumed inundation zones (per scenario, lat/lon polygons -> local) */
  const zones = {}; Object.entries(area.zones || {}).forEach(([k, arr]) => { zones[k] = arr.map((z) => ({ depth: z.depth_m, note: z.note_ja, poly: z.pts.map(([lat, lon]) => localXY(area, lon, lat)) })); });
  /* Blocks (inside grid cells) */
  const blocks = [];
  for (let j = -n; j < n; j++) for (let i = -n; i < n; i++) {
    const a = nodes[idx[key(i, j)]], b = nodes[idx[key(i + 1, j)]], c = nodes[idx[key(i + 1, j + 1)]], d = nodes[idx[key(i, j + 1)]];
    const cx = (a.x + b.x + c.x + d.x) / 4, cy = (a.y + b.y + c.y + d.y) / 4; const ins = 0.12;
    const sh = (p) => [p.x + (cx - p.x) * ins, p.y + (cy - p.y) * ins];
    blocks.push([sh(a), sh(b), sh(c), sh(d)]);
  }
  return { W, H, s, toPx, nodes, edges, gridCount, roads, water, pois, zones, blocks, gs };
}
/* Nearest node */
function nearestNode(A, x, y, pred) { let bi = -1, bd = Infinity; for (let i = 0; i < A.nodes.length; i++) { if (pred && !pred(A.nodes[i], i)) continue; const d = Math.hypot(A.nodes[i].x - x, A.nodes[i].y - y); if (d < bd) { bd = d; bi = i; } } return bi; }
/* Route search: cost(edge) -> multiplier (Infinity = impassable) */
function shortestPath(A, from, to, costFn) {
  const N = A.nodes.length; const adj = A._adj || (A._adj = (() => { const a = Array.from({ length: N }, () => []); A.edges.forEach((e, i) => { a[e.a].push([e.b, i]); a[e.b].push([e.a, i]); }); return a; })());
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N); dist[from] = 0;
  /* Simple priority queue (small size) */
  const pq = [[0, from]];
  while (pq.length) {
    let mi = 0; for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[mi][0]) mi = i; const [d, u] = pq.splice(mi, 1)[0];
    if (done[u]) continue; done[u] = 1; if (u === to) break;
    for (const [v, ei] of adj[u]) { const e = A.edges[ei]; const m = costFn ? costFn(e, A.nodes[u], A.nodes[v]) : 1; if (!isFinite(m)) continue; const nd = d + e.len * m; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; pq.push([nd, v]); } }
  }
  if (!isFinite(dist[to])) return null;
  const path = []; for (let u = to; u !== -1; u = prev[u]) path.push(u); path.reverse();
  let len = 0; for (let i = 1; i < path.length; i++) len += Math.hypot(A.nodes[path[i]].x - A.nodes[path[i - 1]].x, A.nodes[path[i]].y - A.nodes[path[i - 1]].y);
  return { path, len, cost: dist[to] };
}
/* Zone lookup (max depth) */
function zoneDepthAt(A, scenarioKey, x, y) { const zs = A.zones[scenarioKey] || []; let d = 0; zs.forEach((z) => { if (pointInPoly([x, y], z.poly)) d = Math.max(d, z.depth); }); return d; }

/**
 * Render. opts: { scenario, me:{x,y,label}, routes:[{path, cls}], dest:poiName, closed:Set(poiName), extra(html), shelters:[{poi, occ, cap}], events:[{x,y,label}], site:{x,y,name} }
 */
function renderAreaMap(svg, A, area, opts = {}) {
  const { W, H, toPx } = A; svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const P = (x, y) => toPx(x, y).map((v) => v.toFixed(1)).join(' ');
  let h = `<rect class="sm-bg" width="${W}" height="${H}"/>`;
  h += '<g class="g-blocks">' + A.blocks.map((b) => `<polygon class="sm-block" points="${b.map(([x, y]) => toPx(x, y).map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`).join('') + '</g>';
  /* Parks */
  h += '<g class="g-parks">' + A.pois.filter((p) => p.kind === 'park_open_space').map((p) => { const [x, y] = toPx(p.x, p.y); const r = Math.max(10, (p.radius_m || 220) * A.s); return `<circle class="sm-park" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`; }).join('') + '</g>';
  /* Water */
  h += '<g class="g-water">' + A.water.map((w) => w.kind === 'river' || w.kind === 'lake' ? `<polygon class="sm-water" points="${w.pts.map(([x, y]) => toPx(x, y).map((v) => v.toFixed(1)).join(',')).join(' ')}"/>` : `<polyline class="sm-canal" style="stroke-width:${Math.max(3, w.width * A.s)}" points="${w.pts.map(([x, y]) => toPx(x, y).map((v) => v.toFixed(1)).join(',')).join(' ')}"/>`).join('') + '</g>';
  /* Inundation / damage zones */
  const zs = (opts.scenario && A.zones[opts.scenario]) || [];
  h += '<g class="g-zones">' + zs.map((z) => `<polygon class="${opts.zoneCls || 'sm-flood'}${z.depth >= 1 ? ' deep' : ''}" points="${z.poly.map(([x, y]) => toPx(x, y).map((v) => v.toFixed(1)).join(',')).join(' ')}"><title>${esc(z.note || '')} ${z.depth ? `assumed depth ${z.depth} m` : ''}</title></polygon>`).join('') + '</g>';
  /* Grid streets */
  const gridEdges = A.edges.filter((e) => e.a < A.gridCount && e.b < A.gridCount);
  h += '<g class="g-grid">' + gridEdges.map((e) => `<line class="sm-casing${e.major ? ' major' : ''}" x1="${A.toPx(A.nodes[e.a].x, A.nodes[e.a].y)[0].toFixed(1)}" y1="${A.toPx(A.nodes[e.a].x, A.nodes[e.a].y)[1].toFixed(1)}" x2="${A.toPx(A.nodes[e.b].x, A.nodes[e.b].y)[0].toFixed(1)}" y2="${A.toPx(A.nodes[e.b].x, A.nodes[e.b].y)[1].toFixed(1)}"/>`).join('') + gridEdges.map((e) => `<line class="sm-road${e.major ? ' major' : ''}" x1="${A.toPx(A.nodes[e.a].x, A.nodes[e.a].y)[0].toFixed(1)}" y1="${A.toPx(A.nodes[e.a].x, A.nodes[e.a].y)[1].toFixed(1)}" x2="${A.toPx(A.nodes[e.b].x, A.nodes[e.b].y)[0].toFixed(1)}" y2="${A.toPx(A.nodes[e.b].x, A.nodes[e.b].y)[1].toFixed(1)}"/>`).join('') + '</g>';
  /* Arterial roads (approximate real alignments) */
  h += '<defs>' + A.roads.map((r, i) => `<path id="rd-${esc(area.area_id)}-${i}" d="${r.pts.map(([x, y], k) => (k ? 'L' : 'M') + P(x, y)).join('')}"/>`).join('') + '</defs>';
  h += '<g class="g-roads">' + A.roads.map((r) => `<path class="sm-casing${r.major ? ' major' : ''}" d="${r.pts.map(([x, y], k) => (k ? 'L' : 'M') + P(x, y)).join('')}"/>`).join('') + A.roads.map((r) => `<path class="sm-road${r.major ? ' major' : ''}" d="${r.pts.map(([x, y], k) => (k ? 'L' : 'M') + P(x, y)).join('')}"/>`).join('') + A.roads.map((r, i) => `<text class="sm-road-t" dy="-5"><textPath href="#rd-${esc(area.area_id)}-${i}" startOffset="${r.label_offset || '35%'}">${esc(r.name)}</textPath></text>`).join('') + '</g>';
  /* Rail */
  h += '<g class="g-rail">' + (area.rails || []).map((r) => `<path class="sm-rail" d="${r.pts.map(([lat, lon], k) => { const [x, y] = localXY(area, lon, lat); return (k ? 'L' : 'M') + P(x, y); }).join('')}"><title>${esc(r.name)}</title></path>`).join('') + '</g>';
  /* Routes */
  (opts.routes || []).forEach((r) => { if (!r || !r.path) return; const d = r.path.map((ni, k) => (k ? 'L' : 'M') + P(A.nodes[ni].x, A.nodes[ni].y)).join(''); if (r.cls !== 'alt') h += `<path class="sm-route-bg" d="${d}"/>`; h += `<path class="sm-route ${r.cls || ''}" d="${d}"/>`; });
  /* POI */
  const closed = opts.closed || new Set();
  h += '<g class="g-pois">' + A.pois.map((p) => { const [x, y] = toPx(p.x, p.y); const cls = `sm-poi ${p.kind}${opts.dest === p.name ? ' dest' : ''}${closed.has(p.name) ? ' closed' : ''}${opts.selPoi === p.name ? ' sel' : ''}`; const lbl = p.name_ja || p.name; const dx = p.label_dx || 9, dy = p.label_dy || 3.5; return `<g class="${cls}" data-poi="${esc(p.name)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="${opts.dest === p.name ? 7 : 5.5}"/><text x="${dx}" y="${dy}">${esc(lbl)}</text><title>${esc(lbl)}${p.why_ja ? ': ' + esc(p.why_ja) : ''}</title></g>`; }).join('') + '</g>';
  /* Shelter occupancy */
  if (opts.shelters) h += '<g class="g-shelters">' + opts.shelters.map((sh) => { const p = A.pois.find((q) => q.name === sh.poi); if (!p) return ''; const [x, y] = toPx(p.x, p.y); const full = sh.occ >= sh.cap; return `<g class="sm-shelter${full ? ' full' : ''}" transform="translate(${(x + 8).toFixed(1)} ${(y - 22).toFixed(1)})"><rect width="54" height="14" rx="3"/><text x="4" y="10.5">${fmt(sh.occ)}/${fmt(sh.cap)}</text></g>`; }).join('') + '</g>';
  /* Support events */
  if (opts.events) h += '<g class="g-events">' + opts.events.map((ev) => { const [x, y] = toPx(ev.x, ev.y); return `<g class="sm-ev" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="6"/><text x="9" y="3.5">${esc(ev.label)}</text></g>`; }).join('') + '</g>';
  /* Site */
  if (opts.site) { const [x, y] = toPx(opts.site.x, opts.site.y); h += `<g class="sm-site" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><rect x="-8" y="-8" width="16" height="16" rx="3"/><text x="12" y="4">${esc(opts.site.name)}</text></g>`; }
  /* Current location */
  if (opts.me) { const [x, y] = toPx(opts.me.x, opts.me.y); h += `<g class="sm-me" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle class="ring" r="16"/><circle class="dot" r="7"/><text x="12" y="-10">${esc(opts.me.label || 'Current location')}</text></g>`; }
  /* Scale bar */
  const km = 500 * A.s; h += `<g transform="translate(18 ${H - 22})"><path class="sm-scale" d="M0 -6V0H${km.toFixed(0)}V-6"/><text class="sm-scale-t" x="0" y="-10">0</text><text class="sm-scale-t" x="${km.toFixed(0)}" y="-10" text-anchor="middle">500 m</text></g>`;
  svg.innerHTML = h;
  svg.onclick = (e) => {
    const g = e.target.closest('.sm-poi'); if (g && opts.onPoi) { opts.onPoi(g.dataset.poi); return; }
    if (opts.onMap) { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const m = svg.getScreenCTM(); if (!m) return; const q = pt.matrixTransform(m.inverse()); opts.onMap((q.x - W / 2) / A.s, (q.y - H / 2) / A.s); }
  };
}
