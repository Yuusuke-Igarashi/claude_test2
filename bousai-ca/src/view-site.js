/* Screen 2: company / site view - disaster readiness assessment */
const SCEN_SITE = {
  flood: { ja: 'River flood (river overflow, prolonged inundation)', short: 'River flood', icon: 'wave', zone: 'flood', zoneCls: 'sm-flood' },
  urban_flood: { ja: 'Urban flooding (cloudbursts, drainage overload)', short: 'Urban flood', icon: 'drop', zone: 'urban_flood', zoneCls: 'sm-flood' },
  quake: { ja: 'Earthquake (strong shaking, building damage)', short: 'Earthquake', icon: 'quake', zone: 'quake', zoneCls: 'sm-shake' },
  fire: { ja: 'Fire / power outage (incident inside the building)', short: 'Fire / outage', icon: 'fire', zone: null, zoneCls: '' },
};
function walkMin(m, speed = 4) { return Math.round(m / (speed * 1000 / 60)); }
/* Route cost (per scenario) */
function routeCost(A, scen, A_area, origin) {
  const hi = A.pois.filter((p) => ['mall_highrise', 'hotel'].includes(p.kind));
  /* If the start point itself lies in a deep assumed-flood zone, treat it as "leave before the flooding": a large cost factor rather than impassable */
  const originDeep = origin && (scen === 'flood' || scen === 'urban_flood') && zoneDepthAt(A, scen, origin.x, origin.y) >= 0.6;
  return (e, a, b) => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; let m = e.major ? 0.95 : 1;
    if (scen === 'flood' || scen === 'urban_flood') { const d = zoneDepthAt(A, scen, mx, my); if (d >= 0.6) { if (!originDeep) return Infinity; m *= 4; } else if (d >= 0.3) m *= 3.5; else if (d > 0) m *= 1.8; }
    if (scen === 'quake') { const d = zoneDepthAt(A, 'quake', mx, my); if (d >= 1) m *= 2.2; for (const p of hi) { if (Math.hypot(p.x - mx, p.y - my) < 70) { m *= 1.5; break; } } if (!e.major) m *= 1.05; }
    return m;
  };
}
function shelterCandidates(A, area, scen, from, speed) {
  /* Fire / outage: only outdoor assembly points (parks, open spaces, estate assembly areas) */
  const fit = (p) => scen === 'fire' ? (p.kind === 'park_open_space' || p.assembly) : (p.shelter_for || []).includes(scen === 'urban_flood' ? 'flood' : scen);
  const origin = A.nodes[from]; const cost = routeCost(A, scen, area, origin);
  const originDeep = origin && (scen === 'flood' || scen === 'urban_flood') && zoneDepthAt(A, scen, origin.x, origin.y) >= 0.6;
  return A.pois.filter(fit).map((p) => {
    const to = nearestNode(A, p.x, p.y); const r = shortestPath(A, from, to, cost); const dflood = (scen === 'flood' || scen === 'urban_flood') ? zoneDepthAt(A, scen, p.x, p.y) : 0;
    const reach = !!(r && isFinite(r.cost)); const len = reach ? r.len : null; const min = reach ? walkMin(len, speed) : null;
    const penalty = (dflood >= 0.6 ? (originDeep ? 3 : 1e6) : dflood > 0 ? 1.4 : 1);
    return { poi: p, route: r, len, min, reach, dflood, originDeep, score: reach ? r.cost * penalty : Infinity };
  }).sort((a, b) => a.score - b.score);
}

App.views.site = {
  st: { site: Store.get('site', 'alm-hq'), scen: 'flood', me: 'site', custom: null, dest: null, done: Store.get('siteDone', {}) },
  init(root) {
    const st = this.st; const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">02 · Site readiness</span><span class="aud">${ic('building')}Audience: site managers, general affairs and safety officers</span></div>
          <h1>Assess site readiness from <em>how evacuation actually works</em></h1>
          <p class="q"><b>Question:</b> for the hazards this site faces, who evacuates, to where, by which route, and what should be in place beforehand?</p>
        </div>
        <div class="vh-r"><span class="tag asm">Shelters and routes are a demo on a schematic map</span></div>
      </div>
      <div class="ctl">
        <div class="f"><label for="stSel">Site</label><select id="stSel">${M.sites().map((s) => `<option value="${s.id}">${esc(s.label)} · ${esc(s.name_ja)}</option>`).join('')}</select></div>
        <div class="f"><label>Scenario</label><div class="seg" id="scSeg" role="group" aria-label="Scenario">${Object.entries(SCEN_SITE).map(([k, v]) => `<button data-scen="${k}" aria-pressed="${k === st.scen}">${ic(v.icon)}${esc(v.short)}</button>`).join('')}</div></div>
        <div class="f"><label>Your location</label><div class="seg" id="meSeg" role="group" aria-label="Your location"><button data-me="site" aria-pressed="true">${ic('building')}Site</button><button data-me="home" aria-pressed="false">${ic('home')}Expat residence (representative)</button><button data-me="custom" aria-pressed="false">${ic('pin')}Click on map</button></div></div>
      </div>
      <div class="answer" id="stAnswer"></div>
      <div class="grid side">
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="card flush"><div class="map-box tall" id="stMapBox"><svg id="stMap" role="img" aria-label="Schematic map of the site area with evacuation routes"></svg><div class="hint" id="stHint"></div><div class="legend" id="stLegend"></div><div class="attr" id="stAttr"></div></div></div>
          <div id="stRoutes" class="grid c3"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px" id="stSide"></div>
      </div>
      <section class="sec" id="stShelters"></section>
      <section class="sec" id="stAlerts"></section>
      <section class="sec" id="stTodo"></section>
      <section class="sec" id="stInfo"></section>`;
    $('#stSel', root).value = st.site;
    $('#stSel', root).onchange = (e) => { st.site = e.target.value; st.custom = null; st.dest = null; st.me = 'site'; $$('#meSeg button', root).forEach((b) => b.setAttribute('aria-pressed', b.dataset.me === 'site')); Store.set('site', st.site); self.update(root); };
    $('#scSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.scen = b.dataset.scen; st.dest = null; $$('#scSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); self.update(root); };
    $('#meSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.me = b.dataset.me; $$('#meSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); if (st.me === 'custom') toast('Click anywhere on the map to compute routes from that point'); st.dest = null; self.update(root); };
    const pickDest = (name) => { const cnd = (self.lastCands || []).find((x) => x.poi.name === name); if (cnd && cnd.reach) { st.dest = name; self.update(root); } else toast(`${name}: not reachable or not suitable in this scenario`); };
    root.addEventListener('click', (e) => { const d = e.target.closest('[data-dest]'); if (d) { pickDest(d.dataset.dest); return; } const c = e.target.closest('[data-chk]'); if (c) { st.done[c.dataset.chk] = !st.done[c.dataset.chk]; Store.set('siteDone', st.done); self.update(root); } });
    root.addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== ' ') return; const d = e.target.closest('[data-dest]'); if (d) { e.preventDefault(); pickDest(d.dataset.dest); } });
    this.update(root);
  },
  show(root) { const s = Store.get('site', this.st.site); if (s !== this.st.site) { this.st.site = s; $('#stSel', root).value = s; this.st.custom = null; this.update(root); } },
  update(root) {
    const st = this.st; const site = M.site(st.site); const area = M.area(site.area); const reg = M.region(site.region); const c = M.country(site.country || reg.country);
    if (!area) { $('#stSide', root).innerHTML = '<div class="empty">No area map configured for this site</div>'; return; }
    const A = area._built || (area._built = buildArea(area));
    const siteXY = localXY(area, site.lon, site.lat); const homeXY = site.home ? localXY(area, site.home.lon, site.home.lat) : siteXY;
    const me = st.me === 'custom' && st.custom ? st.custom : st.me === 'home' ? { x: homeXY[0], y: homeXY[1], label: site.home ? site.home.name_ja : 'Residence' } : { x: siteXY[0], y: siteXY[1], label: site.label + ' site' };
    const from = nearestNode(A, me.x, me.y); const speed = 4;
    const cands = shelterCandidates(A, area, st.scen, from, speed); this.lastCands = cands;
    /* best = recommended (always the optimum); viewing = the route currently shown (switched by clicking) */
    const best = cands.find((x) => x.reach); const viewing = (st.dest ? cands.find((x) => x.poi.name === st.dest && x.reach) : null) || best; const chosen = best;
    const originDeep = cands.some((x) => x.originDeep);
    const alts = cands.filter((x) => x.reach && x !== best).slice(0, 2);
    const scen = SCEN_SITE[st.scen];
    const routes = []; if (viewing && viewing.route) routes.push({ path: viewing.route.path }); cands.filter((x) => x.reach && x !== viewing).slice(0, 2).forEach((a) => routes.push({ path: a.route.path, cls: 'alt' }));
    const closed = new Set(cands.filter((x) => x.dflood >= 0.6 || !x.reach).map((x) => x.poi.name));
    renderAreaMap($('#stMap', root), A, area, { scenario: scen.zone, zoneCls: scen.zoneCls, me, routes, dest: viewing ? viewing.poi.name : null, closed, site: { x: siteXY[0], y: siteXY[1], name: site.label + ' ' + site.short_ja }, onMap: (x, y) => { if (st.me !== 'custom') { st.me = 'custom'; $$('#meSeg button', root).forEach((b) => b.setAttribute('aria-pressed', b.dataset.me === 'custom')); } st.custom = { x, y, label: 'Selected point' }; st.dest = null; this.update(root); }, onPoi: (name) => { const cnd = cands.find((x) => x.poi.name === name); if (cnd && cnd.reach) { st.dest = name; this.update(root); } else toast(`${name}: not suitable as a destination in this scenario`); } });
    const isFactory = /factory|plant|manufactur/i.test(site.type_ja || '');
    $('#stHint', root).innerHTML = `${ic('route')}<span>${esc(scen.ja)}: ${best ? `best <b>${esc(best.poi.name_ja || best.poi.name)}</b> (${best.min} min walk · ${fmt(best.len)} m)${viewing && viewing !== best ? ` · Route shown: ${esc(viewing.poi.name_ja || viewing.poi.name)} (alternative · ${viewing.min} min walk)` : ''}${originDeep ? '<br><b>Start point is inside the assumed flood zone: leaving before the flooding begins (at the warning stage) is a precondition</b>' : ''}${isFactory && st.scen === 'flood' && site.flood_trigger_ja ? `<br>${esc(site.flood_trigger_ja)}` : ''}` : 'No reachable shelter'}</span>`;
    $('#stLegend', root).innerHTML = `<span class="t">Legend</span><span><i style="background:var(--sel);border-radius:50%"></i>Your location</span><span><i style="background:var(--fg);border-radius:2px"></i>Site</span><span><i style="background:var(--ok);border-radius:50%"></i>Park / open space</span><span><i style="background:var(--accent);border-radius:50%"></i>High-rise (vertical evacuation)</span><span><i style="background:var(--crit);border-radius:50%"></i>Hospital</span><span><i style="background:var(--poi);border-radius:50%"></i>Embassy / consulate</span>${scen.zone === 'quake' ? '<span><i style="background:var(--crit);opacity:.3"></i>Assumed damage zone (soft ground, falling debris)</span>' : scen.zone ? '<span><i style="background:var(--m-flood);opacity:.4"></i>Assumed flood zone (darker = deeper)</span>' : ''}<span><i class="ln" style="background:var(--sel)"></i>Recommended route <i class="ln" style="background:var(--muted)"></i>Alternative</span>`;
    $('#stAttr', root).textContent = `Schematic: road network is stylised; facilities are placed relative to their real coordinates · flood and damage zones: ${area.zone_src_ja || 'assumed'}`;
    /* Route cards */
    const card = (cnd, isBest) => `<div class="route-card${isBest ? ' best' : ''}${viewing === cnd ? ' sel' : ''}" data-dest="${esc(cnd.poi.name)}" role="button" tabindex="0" aria-pressed="${viewing === cnd}"><div class="h">${ic(isBest ? 'check' : 'route')}${isBest ? 'Recommended' : 'Alternative'}: ${esc(cnd.poi.name_ja || cnd.poi.name)}${viewing === cnd && !isBest ? ' <span class="tag acc">Route shown</span>' : ''}</div><div class="kv"><span>Distance <b>${fmt(cnd.len)} m</b></span><span>Walk <b>${cnd.min} min</b></span>${cnd.poi.floors ? `<span>Floors <b>${cnd.poi.floors}</b></span>` : ''}${cnd.poi.cap ? `<span>Est. capacity <b>${fmt(cnd.poi.cap)}</b></span>` : ''}</div><ol class="steps">${(cnd.poi.why_ja ? [`Suitability: ${cnd.poi.why_ja}`] : []).concat(cnd.dflood > 0 ? [`Caution: assumed flooding around the facility (${cnd.dflood} m)`] : []).concat(scen.zone === 'quake' ? ['Wait at a safe distance from buildings in case of aftershocks'] : scen.zone ? ['Avoid flooded roads and never enter moving water (FEMA: 15 cm can knock an adult over, 30 cm can carry away a car)'] : ['Use the emergency stairs, never the elevator']).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>`;
    $('#stRoutes', root).innerHTML = (chosen ? card(chosen, true) : '') + alts.map((a) => card(a, false)).join('') || '<div class="empty">No shelter candidates</div>';
    /* Right column: preparedness score */
    const sc = siteScore(site);
    const weakest = sc.cats.slice().sort((a, b) => a.score - b.score).slice(0, 2);
    const top = sc.gaps.filter((g) => g.pri === 1).slice(0, 2);
    $('#stAnswer', root).innerHTML = `<span class="k">Answer</span><ul>
      <li><b>${esc(scen.short)}, starting from ${esc(me.label)}:</b> ${chosen ? `walk ${chosen.min} min (${fmt(chosen.len)} m) to ${esc(chosen.poi.name_ja || chosen.poi.name)}. Alternatives: ${alts.map((a) => esc(a.poi.name_ja || a.poi.name)).join(', ') || 'none'}.${originDeep ? ' The start point is inside the assumed flood zone, so leaving before the flooding begins (at the warning stage) is a precondition.' : ''}` : 'No reachable shelter was found; the plan needs revising.'}</li>
      <li><b>Preparedness today:</b> score ${sc.total}/100. Weakest areas: ${weakest.map((c) => `${esc(c.label)} (${c.score})`).join(', ')}.</li>
      <li><b>Start with:</b> ${top.length ? top.map((g) => esc(g.label)).join(' / ') : 'all priority items are in place'}. Alerts: registered on ${(c.alert_channels || []).filter((a) => (site.alerts || {})[a.key]).length}/${(c.alert_channels || []).length} channels.</li></ul>`;
    $('#stSide', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>${esc(site.name_ja)}</h2><span class="r"><span class="tag ${sc.total >= 75 ? 'ok' : sc.total >= 50 ? 'warn' : 'crit'}">${ic('shield')}Preparedness score ${sc.total}</span></span><span class="sub">${esc(site.desc_ja || '')}</span></div>
        <div class="score-rows">${sc.cats.map((cat) => `<div class="score-row"><span class="k">${esc(cat.label)}<small>${esc(cat.note)}</small></span><span class="track"><i style="width:${cat.score}%;background:${cat.score >= 75 ? 'var(--ok)' : cat.score >= 50 ? 'var(--warn)' : 'var(--crit)'}"></i></span><span class="v">${cat.score}</span></div>`).join('')}</div>
        <div class="note" style="margin-top:10px">${ic('info')}<span><b>Demo value</b>: weighted average of eight categories, each scored by item status (in place 1 / partial 0.5 / missing 0). The category set draws on standard business-continuity guidance (Japan's Cabinet Office Business Continuity Guidelines and the SME Agency's BCP guidance).</span></div></div>
      <div class="card"><div class="card-h"><h2>Hazard levels at this site</h2><span class="r">${srcTag('ThinkHazard', reg.th_url)}</span></div><div class="hz-grid">${['flood', 'urban_flood', 'quake', 'cyclone', 'heat', 'haze'].map((k) => { const v = hazardLevel(reg, k); return `<div class="hz" style="cursor:default"><span class="h">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</span>${lvTag(v.level)}<span class="s">${v.scope === 'country' ? 'National level' : v.scope === 'region' ? 'Region' : ''}</span></div>`; }).join('')}</div>${site.risk_note_ja ? `<p style="font-size:12.5px;color:var(--fg2);margin:10px 0 0">${esc(site.risk_note_ja)}</p>` : ''}</div>`;
    /* Shelter candidates table */
    $('#stShelters', root).innerHTML = `<div class="sec-h"><span class="no">02</span><h2>Shelter candidates (${esc(scen.short)})</h2><span class="r"><span class="tag neutral">Location: ${esc(me.label)}</span></span><p>Click a row to show the route to that candidate on the map (the recommendation does not change). Candidates inside the assumed flood zone or out of reach are dimmed. Capacity figures are assumptions based on facility size.</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>Candidate</th><th>Type</th><th class="n">Distance</th><th class="n">Walk</th><th>Suitable for</th><th>Notes</th></tr></thead><tbody>${cands.map((x) => `<tr class="${x.reach ? 'click' : ''}${viewing && viewing.poi.name === x.poi.name ? ' sel' : ''}"${x.reach ? ` data-dest="${esc(x.poi.name)}" tabindex="0"` : ''} style="${x.reach && x.dflood < 0.6 ? '' : 'opacity:.5'}"><td><b>${esc(x.poi.name_ja || x.poi.name)}</b><span class="sub">${esc(x.poi.name)}</span></td><td>${esc({ park_open_space: 'Park / open space', mall_highrise: 'High-rise mall', hotel: 'Hotel', hospital: 'Hospital', embassy: 'Embassy / consulate', school: 'School', station: 'Station', government: 'Public building' }[x.poi.kind] || x.poi.kind)}</td><td class="n">${x.reach ? fmt(x.len) + ' m' : 'Unreachable'}</td><td class="n">${x.reach ? x.min + ' min' : '—'}</td><td>${(x.poi.shelter_for || []).map((s) => `<span class="tag neutral">${esc(SCEN_SITE[s] ? SCEN_SITE[s].short : s)}</span>`).join(' ')}</td><td style="font-size:12.5px;color:var(--fg2)">${esc(x.poi.why_ja || '')}${x.dflood ? `<span class="tag warn" style="margin-left:4px">Assumed flooding ${x.dflood} m</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No candidates</td></tr>'}</tbody></table></div>`;
    /* Alerts and information channels */
    const ch = (c.alert_channels || []); const regd = site.alerts || {};
    $('#stAlerts', root).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>Receiving warnings and information</h2><p>Do not rely on a single channel. Outdoor civil-defence sirens exist in many cities of the region, but coverage and testing vary; combine emergency-ministry SMS and cell-broadcast alerts, official apps, social media and your embassy's consular e-mails. Registration status is a demo value for this site.</p></div>
      <div class="grid c2">
        <div class="card"><div class="card-h"><h2>${esc(COUNTRY_JA[reg.country] || reg.country)}: official alert channels</h2><span class="r">${c.alert_src ? srcTag(c.alert_src_name || 'Source', c.alert_src) : ''}</span></div><div class="chk-list">${ch.map((a) => `<div class="chk" data-done="${regd[a.key] ? 1 : 0}"><span class="box">${ic('check')}</span><span class="t"><b>${esc(a.name_ja)}</b><span>${esc(a.desc_ja || '')}</span></span><span class="pri ${regd[a.key] ? 'p3' : 'p1'}">${regd[a.key] ? 'Registered' : 'Not registered'}</span></div>`).join('') || '<div class="empty">No channel information</div>'}</div>${c.alert_note_ja ? `<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(c.alert_note_ja)}</span></div>` : ''}</div>
        <div class="card"><div class="card-h"><h2>Embassy and consular channels</h2><span class="r">${srcTag('Embassy registration', 'https://www.mofa.go.jp/')}</span></div><div class="chk-list">${(D.contacts && D.contacts.mofa_services || []).map((m) => `<div class="chk" data-done="${regd[m.key] ? 1 : 0}"><span class="box">${ic('check')}</span><span class="t"><b>${esc(m.name_ja)}</b><span>${esc(m.what_ja || '')}${m.url ? ` <a href="${esc(m.url)}" target="_blank" rel="noopener">Link</a>` : ''}</span></span><span class="pri ${regd[m.key] ? 'p3' : 'p2'}">${regd[m.key] ? 'Registered' : 'Not registered'}</span></div>`).join('')}</div></div>
      </div>`;
    /* What should be in place */
    const gaps = sc.gaps; const g = M.guidance();
    const ref = (key) => { const r = g.find((x) => x.key === key); return r ? srcTag(r.source_name, r.source_url) : ''; };
    $('#stTodo', root).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>What the site should have in place</h2><span class="r"><span class="tag crit">Priority ${gaps.filter((x) => x.pri === 1).length}</span><span class="tag warn">Recommended ${gaps.filter((x) => x.pri === 2).length}</span><span class="tag neutral">In place ${sum(sc.cats, (c) => c.items.filter((i) => i.s === 1).length)}</span></span><p>Items not yet in place, or only partly in place, ordered by priority. Checkmarks are saved on this device only (demo).</p></div>
      <div class="grid c2"><div class="chk-list">${gaps.slice(0, Math.ceil(gaps.length / 2)).map((it) => `<div class="chk" data-done="${st.done[site.id + '|' + it.id] ? 1 : 0}"><button class="box" data-chk="${esc(site.id + '|' + it.id)}" aria-label="Mark as done">${ic('check')}</button><span class="t"><b>${esc(it.label)}</b><span>${esc(it.cat)}${it.s === 0.5 ? ' · partly in place' : ''}${it.note ? ': ' + esc(it.note) : ''} ${it.ref ? ref(it.ref) : ''}</span></span><span class="pri p${it.pri || 3}">${it.pri === 1 ? 'Priority' : it.pri === 2 ? 'Recommended' : 'Improve'}</span></div>`).join('')}</div><div class="chk-list">${gaps.slice(Math.ceil(gaps.length / 2)).map((it) => `<div class="chk" data-done="${st.done[site.id + '|' + it.id] ? 1 : 0}"><button class="box" data-chk="${esc(site.id + '|' + it.id)}" aria-label="Mark as done">${ic('check')}</button><span class="t"><b>${esc(it.label)}</b><span>${esc(it.cat)}${it.s === 0.5 ? ' · partly in place' : ''}${it.note ? ': ' + esc(it.note) : ''} ${it.ref ? ref(it.ref) : ''}</span></span><span class="pri p${it.pri || 3}">${it.pri === 1 ? 'Priority' : it.pri === 2 ? 'Recommended' : 'Improve'}</span></div>`).join('')}</div></div>
      <details class="more"><summary>${ic('chev')}Items in place (${sum(sc.cats, (c) => c.items.filter((i) => i.s === 1).length)})</summary><div class="body"><ul>${sc.cats.flatMap((c) => c.items.filter((i) => i.s === 1).map((i) => `<li>${esc(c.label)}: ${esc(i.label)}</li>`)).join('')}</ul></div></details>`;
    /* Site information */
    $('#stInfo', root).innerHTML = `<div class="sec-h"><span class="no">05</span><h2>Site facts and assumptions</h2></div><div class="grid c3">
      <div class="card"><div class="card-h"><h3>Facility</h3></div><dl style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:13px"><dt class="muted">Type</dt><dd style="margin:0">${esc(site.type_ja)}</dd><dt class="muted">Building</dt><dd style="margin:0">${esc(site.building_ja || '—')}</dd><dt class="muted">Staff</dt><dd style="margin:0">${fmt(site.staff)} (${fmt(site.jp_staff)} expatriates, ${fmt(site.families)} accompanying family members)</dd><dt class="muted">Expat residence</dt><dd style="margin:0">${esc(site.home ? site.home.name_ja : '—')}</dd></dl></div>
      <div class="card"><div class="card-h"><h3>Local context</h3></div><p style="font-size:13px;color:var(--fg2);margin:0">${esc(area.flood_context_ja || '')}</p><p style="font-size:13px;color:var(--fg2);margin:8px 0 0">${esc(area.earthquake_context_ja || '')}</p>${(area.sources || []).map((s) => srcTag(s.name, s.url)).join(' ')}</div>
      <div class="card"><div class="card-h"><h3>Assumptions on this screen</h3></div><ul style="font-size:12.5px;color:var(--fg2);margin:0;padding-left:18px"><li>The road network is stylised as a grid; only major roads approximate their real positions. Route distances and times are indicative (walking ${speed} km/h).</li><li>Facility coordinates: ${(() => { const cs = {}; A.pois.forEach((p) => { cs[p.coord_src || 'n/a'] = (cs[p.coord_src || 'n/a'] || 0) + 1; }); return `${cs.page_read || 0} confirmed from public data (OSM, GTFS, hospital lists), ${cs.derived || 0} derived from neighbouring points, ${(cs.unverified || 0) + (cs['n/a'] || 0)} unverified approximations`; })()}.</li><li>Flood zones: ${esc(area.zone_src_ja || 'assumed from past flood events and terrain')}.</li><li>Shelter "capacity" and "suitability" are assumptions based on facility size, not acceptance agreements with the facilities.</li><li>For real use, replace them with local-authority hazard maps, agreements with the facilities and the results of evacuation drills.</li></ul></div></div>`;
  },
};
