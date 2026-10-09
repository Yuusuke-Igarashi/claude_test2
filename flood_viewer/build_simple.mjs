// Build flood_viewer_simple.html (road links + XRAIN only) from flood_viewer_simple.template.html.
//
// The template holds the page and the glue specific to the simple viewer. Everything the two viewers share
// (CSV / GeoTIFF parsing, the error computation, the chart panel, the rain painting, ...) is copied verbatim
// from flood_viewer.html at build time, so a fix in the full viewer reaches the simple one on the next
// `npm run build`. Markers in the template:
//   // @from flood_viewer.html: name, name, ...   top-level functions / consts of flood_viewer.html, by name
//   // @config from flood_viewer.html: key, files.key, ...   the listed CONFIG entries, as a new CONFIG literal
//   <!-- @maplibre from flood_viewer.html -->   the MapLibre <link> and <script> tags (same version)
//   <!-- @generated -->   replaced by a "generated file" notice
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(here, "flood_viewer.html");
export const TEMPLATE = join(here, "flood_viewer_simple.template.html");
export const TARGET = join(here, "flood_viewer_simple.html");

export function buildSimple(full = readFileSync(SOURCE, "utf8"), tpl = readFileSync(TEMPLATE, "utf8")) {
  const lines = full.split("\n");
  const braces = (s) => (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;

  // One top-level definition by name: "function NAME(", "async function NAME(", "const NAME =" or "let NAME =".
  // A one-line definition (balanced braces, ending in } or ;) is that line; otherwise it runs to the first
  // following line that is exactly "}" or "};" at column 0 (top-level definitions of flood_viewer.html end that way).
  function definition(name) {
    const head = new RegExp(`^(?:(?:async )?function ${name}\\(|(?:const|let) ${name} =)`);
    const start = lines.findIndex((l) => head.test(l));
    if (start < 0) throw new Error(`${name}: not found in flood_viewer.html`);
    if (braces(lines[start]) === 0 && /[};]\s*$/.test(lines[start])) return lines[start];
    const end = lines.findIndex((l, i) => i > start && /^};?$/.test(l));
    if (end < 0) throw new Error(`${name}: no closing line in flood_viewer.html`);
    const block = lines.slice(start, end + 1).join("\n");
    if (braces(block) !== 0) throw new Error(`${name}: braces do not balance in the extracted block`);
    return block;
  }

  // CONFIG of flood_viewer.html as a value (the literal holds comments and 1/3, so it is evaluated, not parsed as JSON)
  function fullConfig() {
    const start = lines.findIndex((l) => /^const CONFIG = \{/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^};$/.test(l));
    if (start < 0 || end < 0) throw new Error("CONFIG literal not found in flood_viewer.html");
    return vm.runInNewContext(lines.slice(start, end + 1).join("\n") + "\nCONFIG", {}, { timeout: 1000 });
  }
  // object literal: one entry per line, arrays and the objects inside them on one line
  function literal(v, indent = "", inline = false) {
    if (Array.isArray(v)) return "[" + v.map((x) => literal(x, indent, true)).join(", ") + "]";
    if (v && typeof v === "object") {
      const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
      if (inline) return "{" + Object.entries(v).map(([k, x]) => `${key(k)}: ${literal(x, indent, true)}`).join(", ") + "}";
      const inner = indent + "  ";
      return "{\n" + Object.entries(v).map(([k, x]) => `${inner}${key(k)}: ${literal(x, inner)}`).join(",\n") + "\n" + indent + "}";
    }
    return JSON.stringify(v);
  }
  function configLiteral(list) {
    const src = fullConfig(), out = {};
    for (const path of list) {
      const keys = path.split(".");
      let from = src, to = out;
      for (const k of keys.slice(0, -1)) {
        if (from[k] === undefined || typeof from[k] !== "object") throw new Error(`CONFIG.${path}: not an object in flood_viewer.html`);
        from = from[k]; to = to[k] = to[k] || {};
      }
      const last = keys[keys.length - 1];
      if (from[last] === undefined) throw new Error(`CONFIG.${path}: missing in flood_viewer.html`);
      to[last] = from[last];
    }
    return `const CONFIG = ${literal(out)};`;
  }

  const names = (list) => list.split(",").map((s) => s.trim()).filter(Boolean);
  const used = new Set();
  let out = tpl
    .replace(/^[ \t]*\/\/ @from flood_viewer\.html: (.+)$/gm, (_, list) => names(list).map((name) => {
      if (used.has(name)) throw new Error(`${name}: listed twice in the template`);
      used.add(name);
      return definition(name);
    }).join("\n"))
    .replace(/^[ \t]*\/\/ @config from flood_viewer\.html: (.+)$/gm, (_, list) => configLiteral(names(list)))
    .replace(/^<!-- @maplibre from flood_viewer\.html -->$/m, () => {
      const tags = lines.filter((l) => /^<(link rel="stylesheet" href|script src)="https:\/\/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/maplibre-gl\.(css|js)"/.test(l));
      if (tags.length !== 2) throw new Error("MapLibre CDN tags not found in flood_viewer.html");
      return tags.join("\n");
    })
    .replace(/^<!-- @generated -->$/m, "<!-- GENERATED FILE: built by build_simple.mjs from flood_viewer_simple.template.html plus the shared functions of flood_viewer.html. Edit those and run `npm run build`. -->");
  const left = out.match(/@(from|config|maplibre|generated)\b/);
  if (left) throw new Error(`marker not replaced: ${left[0]}`);

  // sanity: the page script parses, and every element it looks up by a literal id exists in the page
  const m = out.match(/<script>\n([\s\S]*?)\n<\/script>\s*<\/body>/);
  if (!m) throw new Error("page script not found in the output");
  new vm.Script(m[1], { filename: "flood_viewer_simple.html" });
  const ids = new Set([...out.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]));
  for (const x of m[1].matchAll(/\$\("([^"]+)"\)/g)) if (!ids.has(x[1])) throw new Error(`#${x[1]} is used by the script but missing from the page`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(TARGET, buildSimple());
  console.log(`built ${TARGET} (${(statSync(TARGET).size / 1024).toFixed(0)} KB)`);
}
