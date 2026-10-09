// Inline MapLibre GL JS (from node_modules) into the viewers:
//   flood_viewer.html        -> dist/flood_viewer_standalone.html
//   flood_viewer_simple.html -> dist/flood_viewer_simple_standalone.html   (built first by build_simple.mjs)
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "node_modules/maplibre-gl/package.json"), "utf8"));
const js = readFileSync(join(here, "node_modules/maplibre-gl/dist/maplibre-gl.js"), "utf8");
const css = readFileSync(join(here, "node_modules/maplibre-gl/dist/maplibre-gl.css"), "utf8");
if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error("bundle contains a closing tag; cannot inline");

const link = /<link rel="stylesheet" href="https:\/\/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/maplibre-gl\.css">/;
const script = /<script src="https:\/\/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/maplibre-gl\.js"><\/script>/;
mkdirSync(join(here, "dist"), { recursive: true });

for (const [name, outName] of [["flood_viewer.html", "flood_viewer_standalone.html"], ["flood_viewer_simple.html", "flood_viewer_simple_standalone.html"]]) {
  const src = readFileSync(join(here, name), "utf8");
  if (!link.test(src) || !script.test(src)) throw new Error(`CDN tags not found in ${name}`);
  // function replacers: a "$&" / "$'" inside the bundle must be inserted literally, not expanded as a replacement pattern
  const out = src
    .replace(link, () => `<style>\n/* MapLibre GL JS ${pkg.version} CSS (inlined) */\n${css}\n</style>`)
    .replace(script, () => `<script>\n/* MapLibre GL JS ${pkg.version} (inlined, BSD-3-Clause; see https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt) */\n${js}\n</script>`);
  const target = join(here, "dist", outName);
  writeFileSync(target, out);
  console.log(`built ${target} (${(statSync(target).size / 1048576).toFixed(2)} MB, maplibre-gl ${pkg.version})`);
}
