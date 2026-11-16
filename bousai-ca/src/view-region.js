/* Screen 1: regional risk assessment by hazard */
App.views.region = {
  st: { region: Store.get('region', 'kz-alm'), hz: 'flood', focus: 'sea', rpHz: 'flood' },
  init(root) {
    const st = this.st; const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">01 · Regional risk</span><span class="aud">${ic('users')}Audience: HQ risk management and international operations</span></div>
          <h1>See regional disaster risk by <em>frequency and scale</em></h1>
          <p class="q"><b>Question:</b> which hazards affect this region, how often, and at what scale of impact (affected population, downtime, loss)?</p>
        </div>
        <div class="vh-r"><span class="tag asm">Assumed values are labelled</span><span class="tag src">Sourced values are linked</span></div>
      </div>
      <div class="ctl">
        <div class="f"><label for="rgSel">Region (metro area)</label><select id="rgSel">${M.regions().map((r) => `<option value="${r.id}">${esc(r.name_ja)} (${esc(COUNTRY_JA[r.country] || r.country)})</option>`).join('')}</select></div>
        <div class="f"><label>Hazard shown on the map</label><div class="seg" id="hzSeg" role="group" aria-label="Hazard shown on the map">${['flood', 'urban_flood', 'coastal', 'quake', 'tsunami', 'cyclone', 'landslide', 'volcano', 'heat', 'haze'].map((k) => `<button data-hz="${k}" aria-pressed="${k === st.hz}">${esc(HAZ[k].short)}</button>`).join('')}</div></div>
        <div class="f"><label>Map extent</label><div class="seg" id="focusSeg" role="group" aria-label="Map extent"><button data-focus="sea" aria-pressed="true">All Central Asia</button><button data-focus="country" aria-pressed="false">Selected country</button></div></div>
      </div>
      <div class="answer" id="rgAnswer"></div>
      <div class="grid map">
        <div class="card flush"><div class="map-box tall" id="rgMapBox"><svg id="rgMap" role="img" aria-label="Map of hazard levels by region across Central Asia"></svg><div class="legend" id="rgLegend"></div><div class="attr">Natural Earth · Hazard levels: ThinkHazard (GFDRR)</div></div></div>
        <div style="display:flex;flex-direction:column;gap:12px" id="rgSide"></div>
      </div>
      <section class="sec" id="rgRp"></section>
      <section class="sec" id="rgHist"></section>
      <section class="sec" id="rgSeason"></section>
      <section class="sec" id="rgSrc"></section>`;
    $('#rgSel', root).value = st.region;
    $('#rgSel', root).onchange = (e) => { st.region = e.target.value; Store.set('region', st.region); self.update(root); };
    this.setHz = (k) => { st.hz = k; $$('#hzSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x.dataset.hz === k)); $$('#hzCards .hz', root).forEach((x) => x.setAttribute('aria-pressed', x.dataset.hzCard === k)); self.drawMap(root); };
    $('#hzSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; self.setHz(b.dataset.hz); };
    $('#focusSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.focus = b.dataset.focus; $$('#focusSeg button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); self.drawMap(root); };
    root.addEventListener('click', (e) => { const h = e.target.closest('[data-rphz]'); if (h) { st.rpHz = h.dataset.rphz; self.drawRp(root); } });
    this.update(root);
  },
  show(root) { /* Reflect a region change made on another screen */ const r = Store.get('region', this.st.region); if (r !== this.st.region) { this.st.region = r; $('#rgSel', root).value = r; this.update(root); } },
  levelOf(f, hz) {
    const id = f.properties.id; const th = HAZ[hz].th;
    const reg = M.regions().find((r) => (r.hazard_adm1_ids || r.adm1_ids || []).includes(id));
    if (reg && reg.hazards && reg.hazards[th] && reg.hazards[th].level) return { level: reg.hazards[th].level, scope: reg.hazard_scope_ja || reg.name_ja, src: reg.hazards[th].src };
    const c = D.regions && D.regions.countries && D.regions.countries[f.properties.c];
    if (c && c.hazards && c.hazards[th]) return { level: c.hazards[th].level, scope: `${COUNTRY_JA[f.properties.c]} (national level)`, src: c.hazards[th].src };
    return { level: 'unknown', scope: '' };
  },
  drawMap(root) {
    const st = this.st; const reg = M.region(st.region); const self = this;
    const G = window.GEO; let bbox = SEA_BBOX;
    if (st.focus === 'country') { const fs = G.adm1_sea.features.filter((f) => f.properties.c === reg.country); bbox = padBBox(bboxOfFeatures(fs), 0.06); }
    const sites = M.sites().map((s, i) => ({ id: s.id, lon: s.lon, lat: s.lat, label: s.label, name: s.name_ja, hl: s.region === reg.id }));
    renderRegionMap($('#rgMap', root), {
      bbox, selIds: new Set(reg.adm1_ids || []), sites,
      level: (f) => { const l = self.levelOf(f, st.hz); return lvInfo(l.level).cls + (/national level/.test(l.scope || '') ? ' nat' : ''); },
      tip: (f) => { const l = self.levelOf(f, st.hz); return `<b>${esc(f.properties.n)}</b><div class="r"><span>${esc(COUNTRY_JA[f.properties.c] || f.properties.c)}</span><span>${esc(f.properties.t)}</span></div><div class="r"><span>${esc(HAZ[st.hz].ja)}</span>${lvTag(l.level)}</div>${l.scope ? `<div class="r"><span class="muted">${esc(l.scope)}</span></div>` : ''}`; },
      onPick: (f) => { const r = M.regions().find((x) => (x.adm1_ids || []).includes(f.properties.id)); if (r) { st.region = r.id; Store.set('region', r.id); $('#rgSel', root).value = r.id; self.update(root); } else toast(`${f.properties.n}: no metro-area detail data (showing the national-level value)`); },
      onSite: (id) => { const s = M.site(id); st.region = s.region; Store.set('region', s.region); Store.set('site', id); $('#rgSel', root).value = s.region; self.update(root); toast(`Showing the region of ${s.name_ja}. Select the site in the tree for site details`); },
    });
    $('#rgLegend', root).innerHTML = `<span class="t">${esc(HAZ[st.hz].short)} level (ThinkHazard)</span>${['High', 'Medium', 'Low', 'Very low', 'unknown'].map((k) => `<span><i style="background:var(--${lvInfo(k).cls.replace('k', 'h')})"></i>${lvInfo(k).ja}</span>`).join('')}<span><i style="background:var(--h4);opacity:.35"></i>Pale = no region value (national level = max of regions)</span><span><i style="background:var(--sel);opacity:.7;border-radius:50%"></i>Our sites</span>`;
  },
  update(root) {
    const st = this.st; const reg = M.region(st.region); const c = M.country(reg.country); const gem = M.gem(reg.country);
    const cr = (D.regions && D.regions.countries && D.regions.countries[reg.country]) || {};
    this.drawMap(root);
    /* Right column: hazard list and KPIs */
    const order = ['flood', 'urban_flood', 'coastal', 'quake', 'tsunami', 'cyclone', 'landslide', 'volcano', 'heat', 'haze', 'water'];
    const hzCards = order.map((k) => { const th = HAZ[k].th; const v = (reg.hazards && reg.hazards[th]) || (cr.hazards && cr.hazards[th] ? Object.assign({ country_level: true }, cr.hazards[th]) : null); const lv = lvInfo(v ? v.level : 'unknown'); return `<button class="hz" data-hz-card="${k}" aria-pressed="${k === st.hz}" style="${v && v.country_level ? 'opacity:.72;border-style:dashed' : ''}" title="${esc(v && v.country_level ? 'Region value not retrieved; national level (max of regions) used instead' : v && v.note ? v.note : '')}"><span class="h">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</span>${lvTag(v ? v.level : 'unknown')}<span class="lvbar">${[1, 2, 3, 4].map((i) => `<i style="${i <= lv.k ? `background:var(--${lv.cls.replace('k', 'h')})` : ''}"></i>`).join('')}</span><span class="s">${v && v.country_level ? 'Max of regions' : v && v.level ? 'Region' : 'Not retrieved'}${v && v.confirmed_by === 'search_snippet' ? ' · Search summary' : ''}</span></button>`; }).join('');
    const nReg = order.filter((k) => reg.hazards && reg.hazards[HAZ[k].th] && reg.hazards[HAZ[k].th].level).length;
    const NA = '<span style="font-size:15px;font-family:var(--f-body);color:var(--muted)">Not retrieved</span>';
    const kpis = [
      { v: fmt(reg.pop_m, 1), u: 'million', l: 'Metro population', s: reg.pop_src || 'Source: region data', url: reg.pop_url, asm: true },
      { v: c.jp_residents != null ? fmt(c.jp_residents) : NA, u: c.jp_residents != null ? 'people' : '', l: 'Expatriate residents (country)', s: c.jp_residents != null ? (c.residents_src || 'MOFA Japan, statistics on Japanese nationals overseas') : 'MOFA Japan statistics on nationals overseas (not retrieved in this session)', url: c.residents_url || 'https://www.mofa.go.jp/mofaj/toko/tokei/hojin/index.html' },
      { v: c.jp_companies != null ? fmt(c.jp_companies) : NA, u: c.jp_companies != null ? 'sites' : '', l: 'Foreign-company sites (country)', s: c.jp_companies != null ? (c.companies_src || 'MOFA Japan, survey of Japanese-affiliated companies overseas') : 'MOFA Japan survey of Japanese-affiliated companies overseas (not retrieved in this session)', url: c.companies_url || 'https://www.mofa.go.jp/mofaj/toko/page22_000043.html' },
      { v: c.wri != null ? fmt(c.wri, 2) : NA, u: c.wri_rank && !(c.wri_rank_note && /2024/.test(c.wri_rank_note)) ? `rank ${c.wri_rank}` : '', l: 'WorldRiskIndex 2025 score', s: (c.wri_src || 'WorldRiskReport') + (c.wri_rank && c.wri_rank_note && /2024/.test(c.wri_rank_note) ? `. Rank not confirmed for the 2025 edition (2024 edition: rank ${c.wri_rank})` : c.wri_rank ? '' : '. Rank not confirmed'), url: c.wri_url, snip: c.wri_confirmed === 'search_snippet' },
      { v: c.inform != null ? fmt(c.inform, 1) : NA, u: c.inform != null ? '/10' : '', l: 'INFORM Risk 2025', s: c.inform != null ? (c.inform_src || 'EC JRC INFORM') : 'EC JRC INFORM (not retrieved in this session)', url: c.inform_url || 'https://drmkc.jrc.ec.europa.eu/inform-index', snip: c.inform_confirmed === 'search_snippet' },
    ];
    $('#rgSide', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>Hazard levels: ${esc(reg.name_ja)}</h2><span class="r"><span class="tag neutral">Region values ${nReg}/${order.length}</span>${srcTag('ThinkHazard', reg.th_url, 'GFDRR ThinkHazard! qualitative hazard levels at region level')}</span><span class="sub">${esc(reg.desc_ja || '')}</span></div><div class="hz-grid" id="hzCards">${hzCards}</div>${reg.hz_note_ja ? `<div class="note" style="margin-top:10px">${ic('info')}<span>${esc(reg.hz_note_ja)}</span></div>` : ''}</div>
      <div class="kpis">${kpis.filter((k) => k.v !== NA).map((k) => `<div class="kpi"><span class="v">${k.v}<small>${esc(k.u)}</small></span><span class="l">${esc(k.l)}${k.asm ? ' ' + asmTag() : ''}${k.snip ? ' <span class="tag warn" style="font-size:10px">Search summary</span>' : ''}</span><span class="s">${k.url ? `<a href="${esc(k.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(k.s)}</a>` : esc(k.s)}</span></div>`).join('')}</div>
      ${kpis.some((k) => k.v === NA) ? `<div class="note">${ic('info')}<span><b>Not retrieved:</b> ${kpis.filter((k) => k.v === NA).map((k) => `${esc(k.l)} (<a href="${esc(k.url)}" target="_blank" rel="noopener">source</a>)`).join(' · ')}. These sites could not be reached from the environment that built this page, so no values were transcribed.</span></div>` : ''}`;
    $('#hzCards', root).onclick = (e) => { const b = e.target.closest('[data-hz-card]'); if (!b) return; if (!HAZ[b.dataset.hzCard] || b.dataset.hzCard === 'water') return; this.setHz(b.dataset.hzCard); };
    /* 02 Return period */
    const rpHzs = Object.keys(reg.rp || {}); if (!rpHzs.includes(st.rpHz)) st.rpHz = rpHzs[0];
    this.drawRp(root);
    /* Answer (summary) */
    const lvOf = (k) => { const th = HAZ[k].th; const v = (reg.hazards && reg.hazards[th]) || (cr.hazards && cr.hazards[th]); return v ? v.level : null; };
    const main = ['flood', 'urban_flood', 'coastal', 'quake', 'tsunami', 'cyclone', 'landslide', 'volcano', 'heat', 'haze'];
    const highs = main.filter((k) => lvOf(k) === 'High').map((k) => HAZ[k].short), meds = main.filter((k) => lvOf(k) === 'Medium').map((k) => HAZ[k].short);
    const primary = rpHzs[0]; const prow = primary ? rpRows(reg, primary).find((r) => r.rp === 100) : null;
    const nowM = new Date().getMonth() + 1; const inSeason = Object.entries(reg.season || {}).filter(([k, v]) => v.months.includes(nowM)).map(([k]) => HAZ[k] ? HAZ[k].short : k);
    $('#rgAnswer', root).innerHTML = `<span class="k">Answer</span><ul>
      <li><b>Main risks in ${esc(reg.name_ja)}:</b> ${highs.length ? `${esc(highs.join(' · '))} (high)` : 'no hazard rated high'}${meds.length ? `, ${esc(meds.join(' · '))} (medium)` : ''}. Levels from ThinkHazard (region level, search summary).</li>
      ${prow ? `<li><b>Scale guide (${esc(HAZ[primary].short)}, 1% annual exceedance = 100-year return period):</b> estimated loss ${fmtUSD(prow.loss)}${prow.pop ? `, affected population about ${fmt(prow.pop)}` : ''}${prow.downtime ? `, downtime about ${prow.downtime} days` : ''}${primary === 'quake' ? ' (share of the GEM national value)' : ' (assumed model)'}.</li>` : ''}
      <li><b>Seasonality this month (${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][nowM - 1]}):</b> ${inSeason.length ? `watch period for ${esc(inSeason.join(' · '))}` : 'not a watch period for the main hazards'}. ${(reg.history || []).length} major past disasters are listed below.</li></ul>`;
    /* 03 Past disasters */
    const isDate = (d) => /^\d/.test(String(d || ''));
    const hist = (reg.history || []).slice().sort((a, b) => (isDate(b.date) ? String(b.date) : '0').localeCompare(isDate(a.date) ? String(a.date) : '0'));
    const dateLabel = (d) => isDate(d) ? esc(d) : '<span style="font-family:var(--f-body)">Every year<span class="sub">seasonal</span></span>';
    /* Research-process wording (unverified, model memory, etc.) is stripped from the text; confidence is conveyed by the tags and sources instead */
    const clean = (s, n) => String(s || '').replace(/\([^()]*?(model memory|unverified|to verify|citation needed|this session|this run)[^()]*?\)/gi, '').replace(/(unverified|to verify)\.?/gi, '').replace(/\s+/g, ' ').trim().slice(0, n);
    $('#rgHist', root).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>Past major disasters</h2><span class="r"><span class="tag neutral">${hist.length} events</span></span><p>Major disasters on record for this region and country. Deaths and damage are shown as given by the source; where estimates vary, a note says so.</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Disaster</th><th>Type</th><th>Range</th><th class="n">Deaths</th><th class="n">Damage</th><th>Impact on foreign companies and expatriates</th><th>Source</th></tr></thead><tbody>${hist.map((h) => `<tr><td class="num" style="white-space:nowrap">${dateLabel(h.date)}</td><td style="min-width:200px"><b>${esc(h.name_ja)}</b>${h.note_ja ? `<span class="sub">${esc(clean(h.note_ja, 110))}</span>` : ''}</td><td>${esc(HAZ[h.hazard] ? HAZ[h.hazard].short : h.hazard)}</td><td style="font-size:12px;color:var(--fg2);white-space:nowrap">${esc(h.scope_ja || (h.scope === 'country' ? `${COUNTRY_JA[reg.country] || ''} nationwide` : 'This region'))}${h.multi ? ' <span class="tag warn">Multi-country total</span>' : h.other_country ? ' <span class="tag neutral">Mainly elsewhere</span>' : ''}</td><td class="n">${h.deaths != null ? fmt(h.deaths) : '—'}</td><td class="n">${h.damage_usd_m != null ? fmtUSD(h.damage_usd_m) : '—'}</td><td style="font-size:12.5px;color:var(--fg2);min-width:180px">${esc(clean(h.jp_ja, 90) || '—')}</td><td>${srcTag(h.src_name || 'Source', h.src, h.confirmed_by === 'search_snippet' ? 'Based on a search-result summary (source page not retrieved)' : h.confirmed_by === 'unverified' ? 'Unverified approximate figure; confirm with the source before publishing' : '')}${h.confirmed_by === 'unverified' ? ' <span class="tag warn">To verify</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No records</td></tr>'}</tbody></table></div>
      <div class="note">${ic('info')}<span>"Range" says what the deaths and damage figures cover. EM-DAT values (OWID aggregation) are annual totals per country, year and disaster type, so they can differ from the official figures for a single event. "Multi-country total" is the sum of the listed countries' annual totals; "Mainly elsewhere" marks an event whose main impact was in another country but which also affected this one. Damage is in nominal USD at the time of the event.</span></div>
      ${gem && gem.major_eq.length ? `<div class="note">${ic('info')}<span><b>Major earthquakes listed in the GEM seismic risk profile (${esc(gem.name_ja)}):</b> ${gem.major_eq.map((e) => `${e[0]} ${e[1]} ${e[2]} (deaths ${fmt(e[3])})`).join(' / ')}. * = epicentre outside the country. ${srcTag('GEM', D.gem._source.url)}</span></div>` : ''}`;
    /* 04 Seasonality */
    const months = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
    $('#rgSeason', root).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>Seasonality</h2><p>Watch periods by month. Snowmelt, rain, heat and cold peak at different times in mountain and lowland areas. The outlined month is the current one.</p></div><div class="card">${Object.entries(reg.season || {}).map(([k, v]) => `<div class="mrow"><span>${ic(HAZ[k] ? HAZ[k].icon : 'info')} ${esc(HAZ[k] ? HAZ[k].short : k)}<span class="muted" style="font-size:11px;display:block">${esc(v.note_ja || '')}</span></span><div class="months">${months.map((m) => `<span class="${v.months.includes(+m) ? 'on' : ''}${+m === nowM ? ' now' : ''}">${m}</span>`).join('')}</div></div>`).join('') || '<div class="empty">No seasonality data</div>'}${reg.season_src ? `<div style="margin-top:8px">${srcTag(reg.season_src_name || 'Source', reg.season_src)}</div>` : ''}</div>`;
    /* 05 Sources */
    const srcs = (reg.sources || []).concat(cr.sources || []);
    $('#rgSrc', root).innerHTML = `<div class="sec-h"><span class="no">05</span><h2>Sources and confidence</h2><p>Where the values on this screen come from. "Search summary" means the value was transcribed from a web-search result summary because the source page itself could not be retrieved; confirm it against the original before relying on it.</p></div><div class="card src-list">${[{ name: 'ThinkHazard! (GFDRR / World Bank)', d: 'Qualitative hazard levels by region (High / Medium / Low / Very low). thinkhazard.org could not be reached directly from the build environment, so the levels were transcribed from search-result summaries', url: reg.th_url || 'https://thinkhazard.org/', tags: ['Public', 'Search summary'] }, { name: 'GEM Foundation Country Seismic Risk Profiles v2026.0.0 (released June 2026)', d: 'Building loss (residential, commercial and industrial; 2025 USD) at 10 / 50 / 100 / 500 / 1000-year return periods. Values transcribed from the profile images. Figures differ substantially between versions, so do not mix editions. CC BY-NC-SA 4.0 (non-commercial: commercial use requires a separate agreement with GEM)', url: D.gem._source.url, tags: ['Public', 'Retrieved', 'Non-commercial'] }, { name: 'Natural Earth', d: 'Country and region boundaries, cities and rivers (public domain)', url: 'https://www.naturalearthdata.com/', tags: ['Public', 'Retrieved'] }].concat(srcs).map((s, i) => `<div class="src-row"><span class="idx">${i + 1}</span><span><b>${esc(s.name)}</b><span class="d">${esc(s.d || s.what_ja || '')}</span>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : ''}</span><span class="tags">${(s.tags || ['Public']).map((t) => `<span class="tag ${t === 'Search summary' ? 'warn' : t === 'Assumed' ? 'asm' : 'neutral'}">${esc(t)}</span>`).join('')}</span></div>`).join('')}</div>`;
  },
  drawRp(root) {
    const st = this.st; const reg = M.region(st.region); const gem = M.gem(reg.country);
    const hzs = Object.keys(reg.rp || {}); const box = $('#rgRp', root);
    if (!hzs.length) { box.innerHTML = `<div class="sec-h"><span class="no">02</span><h2>Damage scale by return period</h2></div><div class="empty">No return-period model is configured for this region</div>`; return; }
    const hz = st.rpHz; const cfg = reg.rp[hz]; const rows = rpRows(reg, hz);
    const isQ = hz === 'quake' && gem;
    const tabs = `<div class="seg">${hzs.map((k) => `<button data-rphz="${k}" aria-pressed="${k === hz}">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</button>`).join('')}</div>`;
    const cr = (D.regions && D.regions.countries && D.regions.countries[reg.country]) || {};
    const fc = hz === 'flood' && cr.flood_curve ? cr.flood_curve : null;
    /* Earthquake: the national curve (GEM) and the regional share use the same basis, so they share one axis. Flood: the national figure (Aqueduct) uses a different basis, so it appears only as a reference row in the table */
    const series = isQ ? [{ name: `${gem.name_ja} national (GEM, building loss)`, color: 'var(--c6)', points: RPS.map((rp) => [rp, gem.loss_curve_m[String(rp)] || 0]) }, { name: `${reg.name_ja} share (assumed: ${Math.round((cfg.share || 0) * 100)}% of national)`, color: 'var(--c1)', points: rows.map((r) => [r.rp, r.loss || 0]), dashed: true }]
      : [{ name: `${reg.name_ja} estimated loss (assumed)`, color: 'var(--c1)', points: rows.map((r) => [r.rp, r.loss || 0]) }];
    box.innerHTML = `<div class="sec-h"><span class="no">02</span><h2>Damage scale by return period</h2><span class="r">${tabs}</span><p>A "100-year return period" means a magnitude with a 1% chance of occurring in any given year, not something that happens only once a century. The affected-population, downtime and loss columns are <b>assumed values</b>, scaled from sourced anchor values (see the assumptions below) with relative factors.</p></div>
      <div class="grid map">
        <div class="card"><div class="card-h"><h2>${esc(HAZ[hz].ja)}: loss by return period</h2><span class="r">${isQ ? srcTag('GEM v2026', D.gem._source.url, 'GEM Country Seismic Risk Profile (building loss)') : fc ? srcTag('WRI Aqueduct', fc.source_url, fc.note_ja) : ''}${asmTag(isQ ? 'Share is assumed' : 'Regional values are assumed')}</span></div><div class="chart" id="rpChart"></div><div class="chart-cap">${series.map((s) => `<span><i class="ln" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>${fc ? `<div class="note" style="margin-top:10px">${ic('info')}<span><b>Reference (last row of the table):</b> the national figure from ${esc(fc.source_name)} is direct damage to urban assets (2010 baseline, exposure-based, ignoring protection levels). Its basis differs from the assumed regional curve (damage and loss, including indirect losses), so it is not plotted on the same axis.</span></div>` : ''}</div>
        <div class="card"><div class="card-h"><h2>Damage scale guide</h2><span class="r">${asmTag('Assumed')}</span><span class="sub">${esc(cfg.anchor_ja || '')}</span></div>
          <div class="tbl-wrap"><table class="rp-table"><thead><tr><th>Return period<span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">annual exceedance</span></th><th style="min-width:210px">Scenario</th>${cfg.depth_max != null || cfg.area_max != null ? '<th class="n">Flood depth<span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">area affected</span></th>' : ''}<th class="n">Affected population<span class="sub" style="font-weight:400;text-transform:none;letter-spacing:0">downtime</span></th><th class="n">Loss</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="num" style="white-space:nowrap"><b>${r.rp}-yr</b><span class="sub">${(r.p * 100).toFixed(r.rp >= 100 ? 1 : 0)}%/yr</span></td><td style="font-size:12.5px;min-width:210px">${esc(r.scen)}</td>${cfg.depth_max != null || cfg.area_max != null ? `<td class="n">${cfg.depth_max != null ? (r.depth > 0 ? r.depth + ' m' : '—') : ''}<span class="sub">${cfg.area_max != null ? (r.area_pct > 0 ? r.area_pct + '%' : '—') : ''}</span></td>` : ''}<td class="n">${r.pop > 0 ? fmt(r.pop) : '—'}<span class="sub">${r.downtime > 0 ? r.downtime + ' days' : '—'}</span></td><td class="n"><b>${esc(fmtUSD(r.loss))}</b>${isQ ? `<span class="sub">national ${esc(fmtUSD(r.loss_nat))}</span>` : ''}</td></tr>`).join('')}${fc ? `<tr style="background:var(--deep)"><td class="num" colspan="2" style="font-size:12px;color:var(--fg2)">Reference: ${esc(COUNTRY_JA[reg.country] || reg.country)} national river-flood damage to urban assets (Aqueduct 2010)</td><td colspan="${(cfg.depth_max != null || cfg.area_max != null) ? 3 : 2}" class="n" style="font-size:12px;color:var(--fg2)">${Object.values(fc.curve_m).every((v) => !v) ? 'Not modelled (outside the resolution of the river-flood model)' : RPS.map((rp) => `${rp}-yr ${esc(fmtUSD(fc.curve_m[String(rp)]))}`).join(' / ')} ${srcTag('WRI Aqueduct', fc.source_url, fc.note_ja)}</td></tr>` : ''}</tbody></table></div>
          <details class="more" style="margin-top:10px"><summary>${ic('chev')}Assumptions and method</summary><div class="body"><p>${esc(cfg.method_ja || '')}</p><ul>${(cfg.assumptions_ja || []).map((a) => `<li>${esc(a)}</li>`).join('')}${isQ ? `<li>The national loss curve uses the GEM Foundation Country Seismic Risk Profile v2026.0.0 (loss to residential, commercial and industrial buildings, 2025 USD) as published. The regional share is an assumption read from GEM's "AAL by region" breakdown.</li>` : ''}<li>Affected population = metro population × maximum affected share × relative factor. Downtime days are an assumption, using the multi-week to multi-month shutdowns of industrial zones in past major disasters as an upper reference.</li></ul>${(cfg.refs || []).map((r) => srcTag(r.name, r.url)).join(' ')}</div></details>
        </div>
      </div>`;
    rpChart($('#rpChart', root), { series, yLabel: 'Loss' });
  },
};
