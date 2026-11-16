/* Screen 3: personalized dashboard (for staff and families) — enter address, household and ages → preparedness for that address plus live information */
/* Address → registered representative point (demo: keyword match on data fields. In production, geocode the address and match it to the nearest block and flood-depth model) */
function matchAddress(q) {
  const s = String(q || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); if (!s) return null;
  let best = null;
  M.sites().forEach((site) => { const area = M.area(site.area); const homes = (area ? area.homes : []) || []; homes.forEach((home, idx) => { const keys = home.keys || []; const score = sum(keys, (k) => (s.includes(String(k).toLowerCase()) ? String(k).length : 0)); if (score > 0 && (!best || score > best.score)) best = { site: site.id, homeIdx: idx, score, how: 'area name' }; }); });
  if (best) return best;
  const city = M.sites().find((site) => (site.city_keys || []).some((k) => s.includes(String(k).toLowerCase())));
  return city ? { site: city.id, homeIdx: 0, score: 0, how: 'city name (representative point)' } : null;
}

App.views.me = {
  st: Object.assign({ site: Store.get('site', 'alm-hq'), homeIdx: 0, home: 'highrise', floor: 18, members: [{ sex: 'm', age: 42, cond: false }, { sex: 'f', age: 39, cond: false }, { sex: 'f', age: 7, cond: false }, { sex: 'm', age: 1, cond: false }], pets: false, car: true, lang: false, days: 7, scen: 'flood', addr: '', addrHow: '' }, Store.get('personal', {})),
  init(root) {
    const self = this;
    root.innerHTML = `
      <div class="vh">
        <div>
          <div class="eyebrow"><span class="eb">05 · Personalized dashboard</span><span class="aud">${ic('home')}Audience: staff and their families</span></div>
          <h1>Tailored to your address and family: <em>what to prepare and what is happening now</em></h1>
          <p class="q"><b>Question:</b> Given my address, household and ages, where and how should we evacuate for each type of hazard, and what should we stock, in what quantity? And in an ongoing incident, what still works in my district and what support is available?</p>
        </div>
        <div class="vh-r"><span class="tag neutral">Entries are saved on this device only</span><div class="jump"><button class="btn sm" data-jump="meAnswer">${ic('shield')}Preparedness</button><button class="btn sm" data-jump="meLive">${ic('clock')}Live</button></div></div>
      </div>
      <div class="persona-note admin-only">${ic('info')}<span>This screen is for staff and their families. Managers can check what staff see (entries are saved on this device only).</span></div>
      <div class="grid side personal">
        <div class="card" id="psForm"></div>
        <div class="stack" id="psRight"><div class="grp-eb"><span class="eb">Preparedness</span></div><div class="answer" id="meAnswer"></div><div class="stack" id="psOut"></div></div>
      </div>
      <section class="sec" id="psStock"></section>
      <section class="sec" id="psTodo"></section>
      <section class="sec" id="psCard"></section>
      <div class="grp-eb"><span class="eb">Live for your address</span></div>
      <section class="sec" id="meLive"></section>
      <section class="sec" id="meEvents"></section>`;
    root.addEventListener('click', (e) => { const j = e.target.closest('[data-jump]'); if (j) { const el = $('#' + j.dataset.jump, root); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; } const cp = e.target.closest('[data-copy]'); if (cp) copyText(cp.dataset.copy, cp); });
    document.addEventListener('ctxchange', () => { if (App.current === 'me') self.renderLive(root); });
    this.form(root); this.update(root);
  },
  form(root) {
    const st = this.st; const self = this; const site = M.site(st.site); const area = M.area(site.area);
    const homes = (area && area.homes) || [];
    const examples = M.sites().map((s) => s.addr_example).filter(Boolean);
    $('#psForm', root).innerHTML = `<div class="card-h"><h2>Address, household and home</h2></div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="fld"><label for="psAddr">Address (city, area, street)</label><div class="addr"><input type="text" id="psAddr" value="${esc(st.addr || '')}" placeholder="${esc(examples[0] ? 'e.g. ' + examples[0] : 'City, area, street')}" list="psAddrList" autocomplete="street-address"><button class="btn sm primary" id="psAddrBtn">${ic('search')}Find from address</button></div><datalist id="psAddrList">${examples.map((a) => `<option value="${esc(a)}">`).join('')}</datalist><div class="addr-hit" id="psAddrHit">${st.addr ? `"${esc(st.addr)}" → showing as <b>${esc(site.short_ja)} area · ${esc(homes[st.homeIdx] ? homes[st.homeIdx].name_ja : 'representative point')}</b>${st.addrHow ? ` (matched by ${esc(st.addrHow)})` : ''}` : 'The demo matches your address to a registered representative point. In production the address would be geocoded and linked to the nearest block, flood-depth model and shelters.'}</div><div class="ex-chips" aria-label="Examples">${examples.map((a) => `<button type="button" data-ex="${esc(a)}">${esc(a)}</button>`).join('')}</div></div>
        <div class="two"><div class="fld"><label for="psSite">Workplace site</label><select id="psSite">${M.sites().map((s) => `<option value="${s.id}">${esc(s.name_ja)}</option>`).join('')}</select></div><div class="fld"><label for="psHome">Home area (representative point)</label><select id="psHome">${homes.map((h, i) => `<option value="${i}">${esc(h.name_ja)}</option>`).join('') || '<option value="0">(representative point)</option>'}</select></div></div>
        <div class="two"><div class="fld"><label for="psType">Home type</label><select id="psType"><option value="highrise">High-rise apartment</option><option value="lowrise">Low-rise apartment (up to 4 floors)</option><option value="house">Detached house</option></select></div><div class="fld"><label for="psFloor">Floor</label><input type="number" id="psFloor" min="1" max="80" value="${st.floor}"></div></div>
        <div class="fld"><label>Household (including yourself): sex, age, needs assistance</label><div class="members" id="psMembers"></div><button class="btn sm" id="psAdd" style="align-self:flex-start;margin-top:4px">${ic('users')}Add member</button></div>
        <div class="pills"><button class="pill" id="psPets" aria-pressed="${st.pets}">${ic('heart')}Pets</button><button class="pill" id="psCar" aria-pressed="${st.car}">${ic('car')}Own car</button><button class="pill" id="psLang" aria-pressed="${st.lang}">${ic('globe')}Speak the local language</button></div>
        <div class="fld"><label id="psDaysLbl">Stockpile days (minimum 3; a week or more recommended)</label><div class="seg" id="psDays" role="group" aria-labelledby="psDaysLbl"><button data-days="3" aria-pressed="${st.days === 3}">3 days</button><button data-days="7" aria-pressed="${st.days === 7}">7 days</button><button data-days="14" aria-pressed="${st.days === 14}">14 days (assumes supply disruption)</button></div></div>
      </div>`;
    $('#psSite', root).value = st.site; $('#psHome', root).value = st.homeIdx; $('#psType', root).value = st.home;
    const renderMembers = () => { $('#psMembers', root).innerHTML = st.members.map((m, i) => `<div class="member"><select data-m="${i}" data-k="sex" aria-label="Sex"><option value="m"${m.sex === 'm' ? ' selected' : ''}>Male</option><option value="f"${m.sex === 'f' ? ' selected' : ''}>Female</option><option value="x"${m.sex === 'x' ? ' selected' : ''}>Other</option></select><input type="number" min="0" max="110" value="${m.age}" data-m="${i}" data-k="age" aria-label="Age" placeholder="Age"><label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" data-m="${i}" data-k="cond"${m.cond ? ' checked' : ''}>Chronic condition / needs assistance</label><button class="icon-btn del" data-del="${i}" aria-label="Remove">${ic('x')}</button></div>`).join(''); };
    renderMembers();
    const save = () => { Store.set('personal', st); self.update(root); };
    const applyAddr = (q) => { st.addr = q; const m = matchAddress(q); if (!m) { st.addrHow = ''; Store.set('personal', st); $('#psAddrHit', root).innerHTML = `Could not identify a city from "${esc(q)}". The demo covers the representative points of ${esc([...new Set(M.sites().map((s) => (M.area(s.area) || {}).city_ja || s.short_ja))].join(', '))} (try one of the examples below).`; toast('Could not identify a city from the address (demo)'); return; } st.addrHow = m.how; const changed = m.site !== st.site; st.site = m.site; st.homeIdx = m.homeIdx; Store.set('site', st.site); const nh = ((M.area(M.site(st.site).area) || {}).homes || [])[st.homeIdx]; if (nh && nh.type) { st.home = nh.type; if (nh.floor) st.floor = nh.floor; } Store.set('personal', st); self.form(root); self.update(root); toast(`Showing ${M.site(st.site).short_ja} area · "${nh ? nh.name_ja : 'representative point'}"${changed ? '' : ''}`); };
    $('#psAddrBtn', root).onclick = () => applyAddr($('#psAddr', root).value.trim());
    $('#psAddr', root).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applyAddr(e.target.value.trim()); } };
    $$('[data-ex]', root).forEach((b) => { b.onclick = () => { $('#psAddr', root).value = b.dataset.ex; applyAddr(b.dataset.ex); }; });
    $('#psSite', root).onchange = (e) => { st.site = e.target.value; st.homeIdx = 0; st.addr = ''; st.addrHow = ''; Store.set('site', st.site); self.form(root); self.update(root); };
    $('#psHome', root).onchange = (e) => { st.homeIdx = +e.target.value; const h = homes[st.homeIdx]; if (h && h.type) { st.home = h.type; $('#psType', root).value = h.type; if (h.floor) { st.floor = h.floor; $('#psFloor', root).value = h.floor; } } st.addr = ''; st.addrHow = ''; $('#psAddrHit', root).textContent = `Representative point "${h ? h.name_ja : ''}" selected. Enter an address to switch to the representative point nearest to it (demo).`; save(); };
    $('#psType', root).onchange = (e) => { st.home = e.target.value; save(); };
    $('#psFloor', root).onchange = (e) => { st.floor = clamp(+e.target.value || 1, 1, 80); save(); };
    $('#psMembers', root).onchange = (e) => { const t = e.target; const i = +t.dataset.m, k = t.dataset.k; if (k === 'cond') st.members[i].cond = t.checked; else if (k === 'age') st.members[i].age = clamp(+t.value || 0, 0, 110); else st.members[i].sex = t.value; save(); };
    $('#psMembers', root).onclick = (e) => { const b = e.target.closest('[data-del]'); if (!b) return; if (st.members.length <= 1) { toast('At least one member is required'); return; } st.members.splice(+b.dataset.del, 1); renderMembers(); save(); };
    $('#psAdd', root).onclick = () => { st.members.push({ sex: 'f', age: 30, cond: false }); renderMembers(); save(); };
    $('#psPets', root).onclick = (e) => { st.pets = !st.pets; e.currentTarget.setAttribute('aria-pressed', st.pets); save(); };
    $('#psCar', root).onclick = (e) => { st.car = !st.car; e.currentTarget.setAttribute('aria-pressed', st.car); save(); };
    $('#psLang', root).onclick = (e) => { st.lang = !st.lang; e.currentTarget.setAttribute('aria-pressed', st.lang); save(); };
    $('#psDays', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.days = +b.dataset.days; $$('#psDays button', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); save(); };
  },
  show(root) { this.renderLive(root); },
  update(root) {
    const st = this.st; const site = M.site(st.site); const area = M.area(site.area); const reg = M.region(site.region); const c = M.country(site.country || reg.country);
    const plan = personalPlan(st); const self = this;
    const A = area ? (area._built || (area._built = buildArea(area))) : null;
    const home = area && area.homes && area.homes[st.homeIdx] ? area.homes[st.homeIdx] : null;
    const hxy = home ? localXY(area, home.lon, home.lat) : localXY(area, site.lon, site.lat);
    /* Risks at home */
    const lv = (k) => hazardLevel(reg, k).level;
    const risks = [];
    const fl = lvInfo(lv('flood')).k, uf = lvInfo(lv('urban_flood')).k, eq = lvInfo(lv('quake')).k, cy = lvInfo(lv('cyclone')).k, hz = lvInfo(lv('haze')).k, ht = lvInfo(lv('heat')).k, cd = lvInfo(lv('cold')).k;
    if (fl >= 3 || uf >= 3) risks.push({ k: 'flood', lv: Math.max(fl, uf), ja: st.home === 'highrise' && st.floor >= 4 ? `Prolonged power, water and elevator outages and supply disruption matter more than the water itself (floor ${st.floor}).` : st.home === 'house' ? 'A detached house takes direct damage from floodwater. Plan to evacuate early to higher ground or a sturdy multi-storey building.' : 'Lower floors take direct damage from floodwater. Agree in advance on an upper floor within the building (vertical evacuation).' });
    if (eq >= 2) risks.push({ k: 'quake', lv: eq, ja: st.home === 'highrise' ? 'Upper floors sway strongly in large regional earthquakes; the January 2024 M7.0 quake was felt strongly across Almaty and Bishkek. Secure furniture and know your stairwell.' : 'Drop, Cover, Hold On. When the shaking stops, leave the building for an open area; check the gas valve and breakers.' });
    if (cd >= 3) risks.push({ k: 'cold', lv: cd, ja: 'Winter cold waves and heating or power failures: warm clothing and blankets, a non-electric heating plan, 3 days of water in case pipes freeze.' });
    if (cy >= 3) risks.push({ k: 'cyclone', lv: cy, ja: 'Strong winds / dust storms: secure loose items, avoid travel.' });
    if (hz >= 2 || ht >= 2) risks.push({ k: 'haze', lv: Math.max(hz, ht), ja: 'Summer heat and winter smog (PM2.5): limit outdoor exposure for children and older adults, N95 masks, an air purifier indoors.' });
    const scenKeys = ['flood', 'quake']; if (!scenKeys.includes(st.scen)) st.scen = 'flood';
    const me = { x: hxy[0], y: hxy[1], label: home ? home.name_ja.split('·')[0].trim() : 'Home' };
    const cons = plan.cons.find((x) => x.k === 'walk'); const speed = cons ? cons.speed : 4;
    let cands = [], best = null, within = null;
    if (A) { const from = nearestNode(A, me.x, me.y); cands = shelterCandidates(A, area, st.scen, from, speed); within = cands.find((x) => x.reach && (!cons || x.len <= cons.maxWalk)); best = within || cands.find((x) => x.reach); }
    const outOfCond = best && !within && cons;
    const homeDepth = A ? { flood: zoneDepthAt(A, 'flood', hxy[0], hxy[1]), urban: zoneDepthAt(A, 'urban_flood', hxy[0], hxy[1]) } : { flood: 0, urban: 0 };
    const vertical = st.scen === 'flood' && st.home === 'highrise' && st.floor >= 4;
    const bestFor = (k) => { if (!A) return null; const from = nearestNode(A, me.x, me.y); const cs = shelterCandidates(A, area, k, from, speed); return cs.find((x) => x.reach && (!cons || x.len <= cons.maxWalk)) || cs.find((x) => x.reach); };
    const floodBest = bestFor('flood'), quakeBest = bestFor('quake');
    const vert = st.home === 'highrise' && st.floor >= 4;
    this._ctx = { site, area, reg, home, me, plan, speed, floodBest, quakeBest, vert, homeDepth };
    const pname = (b) => esc(b.poi.name_ja || b.poi.name);
    $('#meAnswer', root).innerHTML = `<span class="k">Answer</span><ul>
      <li><b>${esc(home ? home.name_ja : site.short_ja + ' area')}</b>${st.addr ? ` (matched to "${esc(st.addr)}")` : ''} · ${esc({ highrise: 'high-rise', lowrise: 'low-rise apartment', house: 'detached house' }[st.home] || st.home)}, floor ${st.floor} · calculated for a household of ${plan.n}.</li>
      <li><b>Flood:</b> ${vert ? `Staying on floor ${st.floor} (vertical evacuation) is the first option. If it drags on, move to ${floodBest ? pname(floodBest) + ` (${walkMin(floodBest.len, speed)} min walk)` : 'a high-rise building within walking distance'}.` : floodBest ? `Move early to ${pname(floodBest)} (${walkMin(floodBest.len, speed)} min walk).` : 'Identify a high-rise building within walking distance.'} <b>Earthquake:</b> ${quakeBest ? `Once the shaking stops, go to ${pname(quakeBest)} (${walkMin(quakeBest.len, speed)} min walk).` : 'Go to a nearby open space.'}</li>
      <li><b>Stockpile:</b> ${plan.n} people × ${plan.days} days = ${plan.water} L of drinking water and ${plan.meals} meals${plan.infants ? ', infant formula and diapers' : ''}${plan.elders ? ', supplies for older adults' : ''}${plan.needs ? ', ' + Math.max(7, plan.days) + ' days of regular medicines' : ''} (Sphere minimum 3 L/person/day).</li>
      <li><b>Register now:</b> embassy or consular registration (Japan: ORRnet / Tabireg; US: STEP), a 3-step family assembly plan with an out-of-area contact, and an emergency contact card (see the checklist below).</li></ul>`;
    const condNotes = plan.cons.filter((x) => x.k !== 'walk');
    $('#psOut', root).innerHTML = `
      <div class="card"><div class="card-h"><h2>Risks at home (${esc(reg.name_ja)})</h2><span class="r">${srcTag('ThinkHazard', reg.th_url)}</span></div>${risks.length ? `<div style="display:flex;flex-direction:column;gap:8px">${risks.map((r) => `<div class="note ${r.lv >= 4 ? 'warn' : ''}">${ic(HAZ[r.k].icon)}<span><b>${esc(HAZ[r.k].short)} (${lvInfo(['unknown', 'Very low', 'Low', 'Medium', 'High'][r.lv]).ja}):</b> ${esc(r.ja)}</span></div>`).join('')}</div>` : '<div class="empty">The main hazards in this region are at low levels</div>'}
        <div class="note" style="margin-top:8px">${ic('pin')}<span><b>Assumed flood depth at your home (${esc(home ? home.name_ja : 'representative point')}):</b> river flood ${homeDepth.flood > 0 ? homeDepth.flood + ' m' : 'outside the modelled zone'}, urban flooding ${homeDepth.urban > 0 ? homeDepth.urban + ' m' : 'outside the modelled zone'} ${asmTag('Schematic assumption')}. ${homeDepth.flood >= 0.5 && st.home !== 'highrise' ? '<b>Low-rise home inside the assumed flood zone, so vertical evacuation is not suggested.</b>' : ''}</span></div></div>
      <div class="card flush"><div style="padding:12px 16px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 style="font-size:15px;margin:0;font-weight:600">Personalized evacuation: destination and route</h2><div class="seg" id="psScen" role="group" aria-label="Evacuation scenario">${scenKeys.map((k) => `<button data-scen="${k}" aria-pressed="${k === st.scen}">${ic(HAZ[k].icon)}${esc(HAZ[k].short)}</button>`).join('')}</div><span class="tag neutral">${esc(cons ? cons.ja : '')}</span></div>
        ${condNotes.length ? `<div style="padding:8px 16px 0;display:flex;flex-direction:column;gap:6px">${condNotes.map((x) => `<div class="note" style="padding:6px 10px">${ic(x.k === 'car' ? 'car' : 'home')}<span>${esc(x.ja)}</span></div>`).join('')}</div>` : ''}
        <div style="padding:10px 16px 12px">${vertical ? `<div class="note ok">${ic('home')}<span><b>First option: stay at home (vertical evacuation).</b> Floor ${st.floor} will not flood, but stock for power, water and elevator outages lasting ${plan.days} days or more. If water and supplies look likely to be cut off for a long time, move early to the horizontal evacuation destination below.</span></div>` : best ? `<div class="note ${outOfCond ? 'warn' : 'ok'}">${ic('route')}<span><b>Recommended destination: ${pname(best)}</b> (${fmt(best.len)} m · ${walkMin(best.len, speed)} min walk). ${esc(best.poi.why_ja || '')}${outOfCond ? `<br><b>No candidate within the constraint (${esc(cons.ja)}); showing the nearest instead.</b> Arrange transport (car or pickup).` : ''}</span></div>` : `<div class="note warn">${ic('alert')}<span>No destination matches the constraints. Check high-rise buildings within walking distance individually.</span></div>`}</div>
        <div class="map-box" style="border-radius:0;border:0;border-top:1px solid var(--line)"><svg id="psMap" role="img" aria-label="Evacuation routes around your home"></svg><div class="attr">Schematic · demo</div></div>
        ${best ? `<div style="padding:10px 16px 14px;font-size:12.5px;color:var(--fg2)">Alternatives: ${cands.filter((x) => x.reach && x !== best).slice(0, 2).map((x) => `${esc(x.poi.name_ja || x.poi.name)} (${walkMin(x.len, speed)} min)`).join(', ') || 'none'}. ${st.lang ? '' : 'If you cannot communicate in the local language, make sure every family member can locate English-speaking hospitals, the expatriate community office and your embassy on the map.'}</div>` : ''}
      </div>`;
    $('#psScen', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.scen = b.dataset.scen; Store.set('personal', st); self.update(root); };
    if (A) renderAreaMap($('#psMap', root), A, area, { scenario: st.scen === 'quake' ? 'quake' : 'flood', zoneCls: st.scen === 'quake' ? 'sm-shake' : 'sm-flood', me, routes: best && !vertical ? [{ path: best.route.path }].concat(cands.filter((x) => x.reach && x !== best).slice(0, 2).map((x) => ({ path: x.route.path, cls: 'alt' }))) : [], dest: best && !vertical ? best.poi.name : null, site: { x: localXY(area, site.lon, site.lat)[0], y: localXY(area, site.lon, site.lat)[1], name: site.label + ' site' }, onPoi: (n) => toast(n) });
    /* Stockpile */
    $('#psStock', root).innerHTML = `<div class="sec-h"><span class="no">02</span><h2>Everyday preparedness: stockpile quantities</h2><span class="r"><span class="tag neutral">${plan.n} people · ${plan.days} days</span>${srcTag('Ready.gov', 'https://www.ready.gov/kit', 'Basic emergency kit: about 1 gallon (roughly 4 L) of water per person per day for several days, and at least a several-day supply of non-perishable food')}</span><p>Calculated automatically from your household. Items for infants, older adults, women and people with chronic conditions are added separately. Rotate what you can buy in local shops ("rolling stock": use it, then replace it).</p></div>
      <div class="stock">${plan.items.map((it) => `<div class="it"><b>${it.v}</b><span>${esc(it.k)}</span><span class="why">${esc(it.why)} ${it.asm ? asmTag() : it.src === 'readygov' ? srcTag('Ready.gov', 'https://www.ready.gov/water') : it.src === 'sphere' ? srcTag('Sphere Handbook', 'https://spherestandards.org/handbook/') : it.src === 'embassy' ? srcTag('Embassy registration', 'https://www.mofa.go.jp/') : it.src === 'who' ? srcTag('WHO', 'https://www.who.int/') : ''}</span></div>`).join('')}</div>`;
    /* Action checklist */
    const g = M.guidance().filter((x) => x.audience !== 'company');
    const todo = [
      { b: 'Register with your embassy', s: 'Japan: ORRnet / Tabireg; US: STEP; others: consular registration. You then receive consular alerts and safety checks in an emergency. Register every family member', src: (D.contacts && D.contacts.mofa_services || []).find((m) => /ORR|registration/i.test(m.name_ja)) },
      { b: 'Agree on family contact rules', s: '3-step assembly plan (outside home → evacuation destination → company site), one out-of-area contact such as a relative abroad, school pickup rules', src: null },
      { b: 'Make an emergency contact card', s: `Ambulance ${esc(((c.emergency_numbers || []).find((n) => /ambulance|medical/i.test(n.service_ja)) || {}).number || '—')}, police ${esc(((c.emergency_numbers || []).find((n) => /police/i.test(n.service_ja)) || {}).number || '—')}, embassy, your doctor or hospital, workplace. On paper, in your wallet and in the children's bags. Numbers are transcribed from third-party data; confirm them on your embassy's official site when you arrive`, src: null, warn: true },
      { b: 'Home safety', s: st.home === 'highrise' ? 'Secure furniture, anti-shatter film on glass, know the emergency stairs, stored water for outages (upper floors lose water first), a non-electric heat source for winter outages' : 'Flood barriers and sandbags, move valuables upstairs, know the breaker location and the nearest tall building, a non-electric heat source and insulation for winter outages', src: null },
      { b: 'Health preparations', s: 'Prescription drugs by generic (INN) name plus a spare supply, vaccinations (tetanus, hepatitis A), a winter flu shot, water disinfection (boil for 1 minute; 3 minutes above 2,000 m)', src: g.find((x) => /disinfect/i.test(x.category_ja || '') || /boil/i.test(x.recommendation_ja || '')) },
      { b: 'Cash and documents', s: 'Small notes in local currency and some US dollars, copies of passports and visas, insurance policy, a way home in an emergency (airline contacts)', src: null },
    ];
    $('#psTodo', root).innerHTML = `<div class="sec-h"><span class="no">03</span><h2>Everyday preparedness: action checklist</h2></div><div class="ready">${todo.map((t) => `<div class="it">${ic('check')}<div><b>${esc(t.b)}${t.warn ? ' <span class="tag warn">To verify</span>' : ''}</b><span>${t.s}</span>${t.src ? ' ' + srcTag(t.src.name_ja || t.src.source_name, t.src.url || t.src.source_url) : ''}</div></div>`).join('')}</div>`;
    /* Family card */
    const emb = (c.japanese_missions || [])[0];
    $('#psCard', root).innerHTML = `<div class="sec-h"><span class="no">04</span><h2>Family emergency card</h2><p>Print or screenshot this so that every family member carries a copy.</p></div>
      <div class="fam-card"><span class="eb">Family emergency card · ${esc(reg.name_ja)}</span><h3>Household of ${plan.n} at ${esc(home ? home.name_ja : site.name_ja)}</h3>
        <dl><dt>Family</dt><dd>Ages ${st.members.map((m) => `${m.age}${m.cond ? ' (needs assistance)' : ''}`).join(', ')}${st.pets ? ', pets' : ''}</dd>
        <dt>Flood</dt><dd>${vert ? `Stay on floor ${st.floor} (vertical evacuation). If it drags on, go to ${floodBest ? pname(floodBest) + ` (${walkMin(floodBest.len, speed)} min walk)` : 'a high-rise building'}` : floodBest ? `Move early to ${pname(floodBest)} (${walkMin(floodBest.len, speed)} min walk)` : 'Go to a high-rise building within walking distance'}</dd>
        <dt>Earthquake</dt><dd>When the shaking stops, take the emergency stairs outside. ${quakeBest ? `Meet at ${pname(quakeBest)} (${walkMin(quakeBest.len, speed)} min walk)` : 'Meet in an open space (park or square)'}. Beware of aftershocks</dd>
        <dt>Assembly points</dt><dd>1. Outside home → 2. ${quakeBest ? pname(quakeBest) : 'nearby open space'} (in a flood: ${floodBest ? pname(floodBest) : 'high-rise building'}) → 3. Site ${esc(site.label)} (${esc(site.short_ja)})</dd>
        <dt>Emergency numbers</dt><dd class="num">${(c.emergency_numbers || []).slice(0, 3).map((n) => `${esc(n.service_ja)} ${esc(n.number)}`).join(' / ') || '—'} <span class="tag warn" style="font-family:var(--f-body)">To verify</span></dd>
        <dt>Embassy / consulate</dt><dd>${emb ? `${esc(emb.name_ja)} ${esc(emb.phone || '')}` : '—'} <span class="tag warn">To verify</span></dd>
        <dt>Out-of-area contact</dt><dd>(write in the name and phone number of a relative abroad)</dd></dl>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="psCopy">${ic('doc')}Copy as text</button><span class="muted" style="font-size:11.5px;align-self:center">Created ${new Date().toLocaleDateString('en-US')} · demo. Phone numbers are transcribed from third-party data; confirm them on your embassy's official site before printing</span></div></div>`;
    $('#psCopy', root).onclick = () => { const txt = $('.fam-card dl', root).innerText; copyText(txt, $('.fam-card dl', root)); };
    this.renderLive(root);
  },
  /* Live: identify the ongoing event and the district that the address (representative point) belongs to */
  renderLive(root) {
    const st = this.st; const cx = this._ctx || {}; const site = M.site(st.site); const box = $('#meLive', root); const evBox = $('#meEvents', root); const self = this;
    const scs = M.scenarios().filter((sc) => (sc.sites || []).some((s) => s.id === site.id) || (sc.supply_sites || []).includes(site.id) || sc.region === site.region);
    const sc = scs.find((s) => s.status !== 'watch') || scs[0];
    if (!sc) { box.innerHTML = `<div class="sec-h"><span class="no">05</span><h2>Live: status in your district</h2></div><div class="note ok">${ic('check')}<span><b>No ongoing incident or warning.</b> No demo scenario is registered for the ${esc(site.short_ja)} area.</span></div>`; evBox.innerHTML = ''; return; }
    const t = Live.t(sc); const watch = sc.status === 'watch';
    const did = (sc.area_id === site.area && sc.area_district) ? sc.area_district : (((sc.sites || []).find((s) => s.id === site.id) || {}).district || sc.default_district || ((sc.districts || [])[0] || {}).id);
    const parts = localLive(sc, t, did, { area: cx.area, home: cx.me });
    const d = parts.d; const r = parts.r; const util = (k) => { const u = r.util.find((x) => x.key === k); return u ? (u.per[did] ? u.per[did].avail : u.avail) : null; };
    const pname = (b) => esc(b.poi.name_ja || b.poi.name);
    /* Action instructions for you */
    let act;
    if (watch) act = { cls: 'warn', icon: 'cloud', ja: `Warning stage; reported impacts are minor so far. ${esc(((sc.actions || [])[0] || {}).ja || '')} Follow the hydromet and emergency-ministry updates, avoid unnecessary travel and charge your devices in case of a power outage.` };
    else if (!d) act = { cls: '', icon: 'info', ja: 'No scenario values for this district.' };
    else if (sc.type === 'flood') {
      const depth = d.depth || 0; const high = st.home === 'highrise' && st.floor >= 4;
      const wm = cx.floodBest ? walkMin(cx.floodBest.len, cx.speed) : null;
      if (depth >= 0.3 && !high && (wm == null || wm > 60)) act = { cls: 'crit', icon: 'alert', ja: `Flood depth in your district is ${depth} m. No evacuation destination is reachable on foot${wm != null ? ` (nearest: ${pname(cx.floodBest)}, ${wm} min walk)` : ''}, and walking through floodwater is dangerous. Move to an upper floor or a nearby taller building and contact site ${esc(site.label)} and the local rescue services (boats). Secure drinking water and phone power.` };
      else if (depth >= 0.3 && !high) act = { cls: 'crit', icon: 'route', ja: `Flood depth in your district is ${depth} m. ${st.home === 'house' ? 'In a detached house' : 'On a low floor'} you should move now to ${cx.floodBest ? `${pname(cx.floodBest)} (${walkMin(cx.floodBest.len, cx.speed)} min walk)` : 'a nearby high-rise building'}. The water is expected to recede around ${esc(fmtHours(d.recede_h || 0))}.` };
      else if (depth >= 0.3) act = { cls: 'warn', icon: 'home', ja: `Your district is flooded (${depth} m) but floor ${st.floor} will not flood. Stay at home (vertical evacuation) and check your ${cx.plan.days}-day stockpile for elevator and water outages. Use the restoration of power (${fmtPct(util('power'))}) and water (${fmtPct(util('water'))}) as a guide; if it drags on, move to ${cx.floodBest ? pname(cx.floodBest) : 'a high-rise building'}.` };
      else if (d.onset_h != null && t < d.onset_h) act = { cls: 'warn', icon: 'clock', ja: `Flooding is expected to start in your district in about ${fmt(d.onset_h - t)} hours. ${high ? 'Top up food, water and cash today and prepare for elevator outages' : 'Move your car to high ground and get ready to leave for your evacuation destination'}.` };
      else if (d.I > 0.05) act = { cls: '', icon: 'info', ja: `Flooding in your district is minor (${depth} m). Watch for flooded roads and power outages and keep trips outside to a minimum.` };
      else act = { cls: 'ok', icon: 'check', ja: 'Your district is not flooded at this time. Check your stockpile in case supply chains are disrupted.' };
    } else {
      if (t < 72) act = { cls: 'crit', icon: 'quake', ja: `Aftershocks continue. Wait at ${cx.quakeBest ? `${pname(cx.quakeBest)} (${walkMin(cx.quakeBest.len, cx.speed)} min walk)` : 'a nearby open space'} until the building has been inspected. Do not use elevators; shut off the gas.` };
      else act = { cls: 'warn', icon: 'home', ja: `Return home only after the building inspection result is known. Watch the restoration of power (${fmtPct(util('power'))}) and water (${fmtPct(util('water'))}) and secure drinking water.` };
    }
    box.innerHTML = `<div class="sec-h"><span class="no">05</span><h2>Live reporting: status in ${esc(d ? d.name_ja.split(' (')[0] : site.short_ja)}</h2><span class="r"><span class="tag ${watch ? 'warn' : 'crit'}">${watch ? 'Warning in effect' : 'Incident in progress'}</span><button class="btn sm primary" id="meSafe">${ic('check')}Report I am safe (demo)</button></span><p>Utilities, weather, contacts and medical status for the district your address (representative point) belongs to. The clock is shared with the live reporting screen.</p></div>
      ${liveHead(sc, t, { compact: true, idp: 'me' })}
      <div class="jump" style="justify-content:flex-start"><a class="btn sm" href="#recovery" data-gorecovery="personal">${ic('refresh')}Recovery timeline for your district (weeks and months after)</a></div>
      <div class="note ${act.cls}">${ic(act.icon)}<span><b>Action for you:</b> ${act.ja}</span></div>
      <div class="status-grid">${parts.util}</div>
      <div class="grid c2">${parts.weather}${parts.contacts}</div>
      ${parts.hospitals ? `<div class="grid c2">${parts.hospitals}${parts.health}</div>` : parts.health}
      ${parts.mapHtml}`;
    parts.mountMap(box);
    evBox.innerHTML = `<div class="sec-h"><span class="no">06</span><h2>Support events</h2><span class="r"><span class="tag neutral">${parts.upcoming.length} upcoming</span></span><p>Water distribution, hot meals, mobile clinics and consular services planned or under way in your district. The orange pins on the map mark the locations.</p></div>${parts.events}`;
    $('#meSafe', root).onclick = () => toast('Safety report sent (demo): recorded in the site safety confirmation system as "safe, staying at home"');
    const rng = $('#meRange', root); rng.oninput = (e) => { Live.setT(+e.target.value, sc); const tm = scenTime(sc, Live.t(sc)); $('#meClock', root).innerHTML = `${esc(tm.time)}<small>${esc(tm.date)} (${esc(tm.dow)}) local time · ${esc(fmtHours(Live.t(sc)))}</small>`; $('.lb-t', box).textContent = fmtHours(Live.t(sc)); };
    rng.onchange = () => self.renderLive(root);
    if (window.updateScales) setTimeout(window.updateScales, 20);
  },
};
