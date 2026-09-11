// Browser tests for flood_viewer (Playwright + node:test).
// Prerequisites: `npm run data` (sample files in sample/output) and `npm run build` (dist/flood_viewer_standalone.html).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, createReadStream, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const DIST = join(ROOT, "dist");
const DATA = join(ROOT, "sample", "output");
const SHOTS = join(here, "shots");
const HTML = "flood_viewer_standalone.html";
const T_18 = 24; // 12:00 + 24 * 15 min = 18:00

const REQUIRED = ["tokyo_20240821_network.geojson", "baseline_speed.csv", "event_speed.csv", "baseline_count.csv", "event_count.csv"];
const OPTIONAL = ["error.csv", "baseline_trajectory.geojson", "event_trajectory.geojson", "baseline_dwell.geojson", "event_dwell.geojson"];
const SLOT_FILES = 2 * 48; // viewer/<role>_<HHMM>.geojson for baseline and event, 48 slots (12:00-23:45) in the sample
// wait until the lazy slot for the current time is parsed
const waitSlot = (page) => page.waitForFunction(() => !S.lazy || S.lazy.loaded === S.times[S.t], null, { timeout: 15000 });

let server, base, browser;
const errors = [];
// expected noise: basemap tiles offline, optional files absent (404), file:// fetch fallback (CORS or "URL scheme not supported")
const NOISE = /gsi\.go\.jp|ERR_TUNNEL|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|404|CORS|ERR_FAILED|fetch failed|Fetch API cannot load|URL scheme "file"|is_target/;

// Independent reference: count error cells per time column straight from error.csv
function errorCountsFromCsv() {
  const lines = readFileSync(join(DATA, "error.csv"), "utf8").trim().split(/\r?\n/);
  const T = lines[0].split(",").length - 1;
  const counts = new Array(T).fill(0);
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    for (let c = 0; c < T; c++) if (cells[c + 1] === "1") counts[c]++;
  }
  return counts;
}

function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".csv": "text/csv", ".geojson": "application/geo+json", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };
  return createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("?")[0].replace(/^\//, "")) || HTML;
    if (name.includes("..")) { res.writeHead(400); res.end(); return; }
    for (const dir of [DIST, DATA]) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isFile()) {
        res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
        createReadStream(p).pipe(res);
        return;
      }
    }
    res.writeHead(404); res.end("not found");
  });
}

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { const t = m.text(); if (NOISE.test(t)) return; if (m.type() === "error") errors.push("console.error: " + t); });
  return page;
}
async function openViewer() {
  const page = await newPage();
  await page.goto(`${base}/${HTML}`);
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  await page.waitForTimeout(500);
  return page;
}
const status = (page) => page.evaluate(() => ({
  time: document.getElementById("timeLabel").textContent,
  target: +document.getElementById("stTarget").textContent.replace(/,/g, ""),
  error: +document.getElementById("stError").textContent.replace(/,/g, ""),
}));
// nearest link of class `cls` to the viewport centre (screen coords)
const findLink = (page, cls, t) => page.evaluate(([cls, t]) => {
  const T = S.T, c0 = map.getCenter(); let best = null;
  for (let r = 0; r < S.ids.length; r++) {
    if (S.cls[r * T + t] !== cls || S.fids[r] < 0) continue;
    const c = S.gj.features[S.fids[r]].geometry.coordinates;
    const mid = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
    if (!map.getBounds().contains(mid)) continue;
    const d = Math.hypot(mid[0] - c0.lng, mid[1] - c0.lat);
    if (!best || d < best.d) { const p = map.project(mid); best = { d, id: S.gj.features[S.fids[r]].properties.id, x: p.x, y: p.y }; }
  }
  return best;
}, [cls, t]);
async function hover(page, pt) {
  const box = await page.locator("#map").boundingBox();
  await page.mouse.move(box.x + pt.x - 3, box.y + pt.y - 3); await page.waitForTimeout(150);
  await page.mouse.move(box.x + pt.x, box.y + pt.y); await page.waitForTimeout(400);
}

before(async () => {
  for (const f of [...REQUIRED, ...OPTIONAL]) assert.ok(existsSync(join(DATA, f)), `missing sample file ${f} (run: npm run data)`);
  assert.ok(existsSync(join(DIST, HTML)), "missing dist/flood_viewer_standalone.html (run: npm run build)");
  mkdirSync(SHOTS, { recursive: true });
  server = serve();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const launch = { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] };
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  browser = await chromium.launch(launch);
});
after(async () => { await browser?.close(); server?.close(); });

test("loads all files and reproduces the notebook's error.csv exactly", async () => {
  const page = await openViewer();
  const info = await page.evaluate(() => ({ N: S.ids.length, T: S.T, lazy: S.lazy ? S.lazy.sources.size : 0, traj: S.traj, check: document.getElementById("pCheck").textContent }));
  assert.equal(info.T, 48);
  assert.ok(info.N > 1000);
  assert.equal(info.lazy, SLOT_FILES, "per-slot viewer files registered via viewer/index.json");
  assert.equal(info.traj, null, "nothing parsed until a slot is shown");
  assert.match(info.check, /不一致: 0 セル/, "in-page error computation must match error.csv at default thresholds");
  const ref = errorCountsFromCsv();
  for (const t of [0, T_18, 47]) {
    await page.evaluate((t) => applyTime(t), t);
    const st = await status(page);
    assert.equal(st.error, ref[t], `error count at t=${t} matches error.csv`);
  }
  await page.screenshot({ path: join(SHOTS, "traffic_18.png") });
  await page.close();
});

test("slider, play and keyboard change the time", async () => {
  const page = await openViewer();
  await page.locator("#slider").fill(String(T_18));
  assert.equal((await status(page)).time, "18:00");
  await page.mouse.move(700, 450);
  await page.keyboard.press("ArrowRight");
  assert.equal((await status(page)).time, "18:15");
  await page.keyboard.press("Space"); await page.waitForTimeout(1500); await page.keyboard.press("Space");
  const after = await page.evaluate(() => S.t);
  assert.ok(after > T_18 + 1, "playback advanced");
  await page.close();
});

test("hovering an error link shows the chart panel with the error band, click pins it", async () => {
  const page = await openViewer();
  await page.evaluate((t) => applyTime(t), T_18);
  const pt = await findLink(page, 2, T_18);
  assert.ok(pt, "an error link is visible");
  await hover(page, pt);
  const cp = await page.evaluate(() => ({
    shown: document.getElementById("chartPanel").style.display, status: document.getElementById("cpStatus").textContent,
    errRects: document.querySelectorAll("#chartSpeed rect.err").length, paths: document.querySelectorAll("#chartCount path").length,
    es: document.getElementById("roES").textContent,
  }));
  assert.equal(cp.shown, "block");
  assert.equal(cp.status, "異常");
  assert.ok(cp.errRects >= 1, "error band drawn");
  assert.equal(cp.paths, 2, "baseline + event series");
  assert.notEqual(cp.es, "–");
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + pt.x, box.y + pt.y); await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.getElementById("chartPanel").classList.contains("pinned")));
  await page.screenshot({ path: join(SHOTS, "hover_pinned.png") });
  await page.close();
});

test("threshold panel recomputes classes and the reference check reacts", async () => {
  const page = await openViewer();
  await page.evaluate((t) => applyTime(t), T_18);
  const base0 = await status(page);
  await page.click("#settingsBtn");
  await page.fill("#pSpeedRatio", "0.3"); await page.waitForTimeout(500);
  const strict = await status(page);
  assert.ok(strict.error < base0.error, "stricter speed ratio -> fewer errors");
  assert.match(await page.textContent("#pCheck"), /想定内/);
  await page.fill("#pMinCount", "0"); await page.waitForTimeout(500);
  assert.ok((await status(page)).target > base0.target, "lower count threshold -> more targets");
  await page.click("#pCorrob"); await page.waitForTimeout(500);
  const noCorrob = await status(page);
  assert.ok(noCorrob.error >= strict.error, "without corroboration errors do not decrease");
  await page.click("#pDefault"); await page.waitForTimeout(500);
  assert.deepEqual(await status(page), base0, "defaults restore the original counts");
  assert.match(await page.textContent("#pCheck"), /不一致: 0 セル/);
  await page.screenshot({ path: join(SHOTS, "settings.png") });
  await page.close();
});

test("trajectory mode: zoom gating, viewport filtering, hover tooltip, no traffic info", async () => {
  const page = await openViewer();
  await page.click("#modeTraj"); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => S.mode), "traj");
  assert.match(await page.textContent("#trajStatus"), /ズーム 14 以上/);
  assert.equal(await page.evaluate(() => map.querySourceFeatures("traj-event").length), 0, "nothing drawn below the zoom threshold");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("statTraffic")).display), "none", "traffic counts hidden");
  assert.equal(await page.evaluate(() => map.getLayoutProperty("links-base", "visibility")), "none", "traffic-coloured network hidden");
  assert.equal(await page.evaluate(() => map.getLayoutProperty("links-context", "visibility")), "visible");
  await page.evaluate((t) => { map.jumpTo({ center: [139.70 + 20 * 0.0025, 35.65 + 15 * 0.002], zoom: 15.2 }); applyTime(t); }, T_18);
  await waitSlot(page);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => S.lazy.loaded), "18:00", "only the 18:00 slot is parsed");
  assert.equal(await page.evaluate(() => Object.values(S.traj).filter(Boolean).length), 8, "4 kinds x baseline+event for the slot");
  const st = await page.textContent("#trajStatus");
  const m = st.match(/平時 徒歩軌跡 (\d+) 本・滞留 (\d+) 点・車→徒歩 (\d+) 点・方向転換 (\d+) 点 \/ イベント時 徒歩軌跡 (\d+) 本・滞留 (\d+) 点・車→徒歩 (\d+) 点・方向転換 (\d+) 点/);
  assert.ok(m, "status lists counts: " + st);
  assert.ok(+m[1] > 0 && +m[5] > 0, "trajectories drawn at zoom 15");
  assert.ok(+m[2] > 0 && +m[6] > 0, "dwell points drawn from the slot files");
  assert.ok(+m[7] > 0 && +m[8] > 0, "mode-change and turn points drawn for the flooded event window");
  assert.match(st, /この時刻のデータ全体: 平時 徒歩軌跡 \d+/, "whole-slot diagnostics shown");
  for (const l of ["mode-event", "turn-event", "dwell-event", "traj-event"]) assert.ok(await page.evaluate((l) => map.queryRenderedFeatures({ layers: [l] }).length, l) > 0, l + " rendered");
  // kind toggles hide their layers
  await page.click("#chkMode"); await page.click("#chkTurn"); await page.waitForTimeout(400);
  assert.match(await page.textContent("#trajStatus"), /イベント時 徒歩軌跡 [1-9]\d* 本・滞留 \d+ 点・車→徒歩 0 点・方向転換 0 点/);
  assert.equal(await page.evaluate(() => map.querySourceFeatures("mode-event").length), 0, "mode-change source cleared by its toggle");
  await page.click("#chkMode"); await page.click("#chkTurn"); await page.waitForTimeout(400);

  // hovering a link shows no chart panel in trajectory mode
  const link = await findLink(page, 2, T_18);
  await hover(page, link);
  assert.notEqual(await page.evaluate(() => document.getElementById("chartPanel").style.display), "block", "no time-series panel on link hover");

  // hover an event trajectory: tooltip only (features carry no identifier, nothing is highlighted)
  const tp = await page.evaluate(() => {
    const fts = map.queryRenderedFeatures({ layers: ["traj-event"] });
    const c0 = map.getCenter(); let best = null;
    for (const f of fts) { const cs = f.geometry.coordinates; const c = cs[Math.floor(cs.length / 2)];
      const d = Math.hypot(c[0] - c0.lng, c[1] - c0.lat); if (!best || d < best.d) { const p = map.project(c); best = { d, x: p.x, y: p.y }; } }
    return best;
  });
  assert.ok(tp, "an event trajectory is rendered");
  await hover(page, tp);
  assert.equal(await page.evaluate(() => document.getElementById("tip").style.display), "block", "tooltip on hover");
  assert.match(await page.textContent("#tip"), /イベント時 (徒歩軌跡|滞留|車→徒歩|方向転換)/);
  assert.doesNotMatch(await page.textContent("#tip"), /ID |userid/, "no identifier in the tooltip");
  assert.equal(await page.evaluate(() => map.getPaintProperty("traj-base", "line-opacity")), 0.7, "nothing faded");
  await page.screenshot({ path: join(SHOTS, "trajectory_hover.png") });
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + tp.x, box.y + tp.y); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => map.getPaintProperty("traj-base", "line-opacity")), 0.7, "click changes nothing");
  await page.mouse.move(700, 30); await page.waitForTimeout(300);   // onto the top bar: leaves the canvas
  assert.equal(await page.evaluate(() => document.getElementById("tip").style.display), "none", "tooltip hidden when the mouse leaves the map");

  // stepping through time loads other slots and keeps a bounded cache
  await page.evaluate((t) => applyTime(t + 1), T_18); await waitSlot(page);
  await page.evaluate((t) => applyTime(t + 2), T_18); await waitSlot(page);
  assert.equal(await page.evaluate(() => S.lazy.loaded), "18:30");
  assert.ok(await page.evaluate(() => S.lazy.cache.size >= 3 && S.lazy.cache.size <= 4), "slot cache bounded");
  await page.evaluate((t) => applyTime(t), T_18); await waitSlot(page); await page.waitForTimeout(800);

  await page.click("#chkBase"); await page.waitForTimeout(500);
  assert.match(await page.textContent("#trajStatus"), /平時 徒歩軌跡 0 本・滞留 0 点・車→徒歩 0 点・方向転換 0 点/);
  await page.click("#chkBase"); await page.waitForTimeout(300);
  // "nearest" button: from an empty corner of the grid the map flies to the nearest feature of the slot
  await page.evaluate(() => map.jumpTo({ center: [139.70 + 2 * 0.0025, 35.65 + 2 * 0.002], zoom: 15.2 })); await page.waitForTimeout(800);
  assert.match(await page.textContent("#trajStatus"), /表示範囲内にはありません/, "diagnostic when the view holds no feature");
  await page.click("#nearestBtn"); await page.waitForTimeout(1500);
  assert.match(await page.textContent("#trajStatus"), /イベント時 徒歩軌跡 [1-9]\d* 本/, "features visible after flying to the nearest one");
  await page.evaluate(() => map.jumpTo({ center: [139.70 + 20 * 0.0025, 35.65 + 15 * 0.002], zoom: 15.2 })); await page.waitForTimeout(800);
  await page.mouse.move(50, 400); await page.keyboard.press("m"); await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => S.mode), "traffic");
  assert.equal(await page.evaluate(() => map.querySourceFeatures("traj-event").length), 0, "sources cleared in traffic mode");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("statTraffic")).display), "none", "traffic counts back");
  await page.close();
});

test("standalone file:// with the file picker, without optional files", async () => {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  await page.setInputFiles("#fileInput", REQUIRED.map((f) => join(DATA, f)));
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  await page.evaluate((t) => applyTime(t), T_18);
  const st = await status(page);
  assert.equal(st.error, errorCountsFromCsv()[T_18], "same result without error.csv");
  assert.ok(await page.evaluate(() => document.getElementById("modeTraj").disabled), "trajectory mode disabled without trajectory files");
  assert.match(await page.textContent("#trajStatus"), /軌跡モードは使えません。選択 5 ファイル: 時刻別ファイル.*なし/, "the reason stays visible in traffic mode");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("trajStatus")).display), "block");
  assert.match(await page.textContent("#pCheck"), /未読み込み/);
  await page.close();
});

test("standalone file:// with the folder picker uses the per-slot files", async () => {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  await page.setInputFiles("#dirInput", DATA);
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  assert.equal(await page.evaluate(() => S.lazy ? S.lazy.sources.size : 0), SLOT_FILES, "slot files found in the folder");
  await page.evaluate((t) => { setMode("traj"); map.jumpTo({ center: [139.70 + 20 * 0.0025, 35.65 + 15 * 0.002], zoom: 15.2 }); applyTime(t); }, T_18);
  await waitSlot(page); await page.waitForTimeout(1500);
  assert.match(await page.textContent("#trajStatus"), /イベント時 徒歩軌跡 [1-9]\d* 本/, "trajectories drawn from a slot file read via FileReader");
  await page.close();
});

test("single-file trajectory GeoJSON (no viewer/ folder) still loads whole-day datasets", async () => {
  const page = await newPage();
  await page.goto("file://" + join(DIST, HTML));
  await page.waitForSelector("#filePick", { state: "visible", timeout: 30000 });
  await page.setInputFiles("#fileInput", [...REQUIRED, ...OPTIONAL].map((f) => join(DATA, f)));
  await page.waitForSelector("#loader", { state: "hidden", timeout: 120000 });
  assert.equal(await page.evaluate(() => S.lazy), null);
  assert.equal(await page.evaluate(() => Object.values(S.traj).filter(Boolean).length), 4);
  await page.close();
});

test("no JavaScript errors were raised", () => {
  assert.deepEqual(errors, []);
});
