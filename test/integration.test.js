// Whole app wiring.
//
// These do not test behaviour; they test the things that are only wrong once
// the app is deployed, where the feedback loop is a phone that will not update.
// There is no build step, so nothing else enforces any of this.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** Pull a relative-path array literal such as SHELL_URLS out of sw.js. */
function urlList(source, name) {
  const at = source.indexOf("const " + name);
  assert.notEqual(at, -1, name + " not found in sw.js");
  const open = source.indexOf("[", at);
  const close = source.indexOf("]", open);
  assert.ok(open !== -1 && close > open, name + " is not an array literal");
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const sw = read("sw.js");
const shell = urlList(sw, "SHELL_URLS");
const optional = urlList(sw, "OPTIONAL_URLS");

test("every ES module under src/ is precached", () => {
  // A module missing from SHELL_URLS works online and breaks on the next cold
  // offline launch, which is the hardest failure here to notice by hand.
  const modules = readdirSync(join(root, "src"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `./src/${f}`);
  assert.notEqual(modules.length, 0);
  for (const m of modules) {
    assert.ok(shell.includes(m), `${m} exists but is not in sw.js SHELL_URLS`);
  }
});

test("the precache lists no file that does not exist", () => {
  for (const url of [...shell, ...optional]) {
    if (url === "./") continue; // the navigation root, not a file
    const rel = url.replace(/^\.\//, "");
    assert.ok(existsSync(join(root, rel)), `sw.js precaches ${url} but it is missing`);
  }
});

test("the app shell itself is precached", () => {
  for (const required of ["./", "./index.html", "./styles.css", "./manifest.webmanifest"]) {
    assert.ok(shell.includes(required), `${required} must be in SHELL_URLS`);
  }
});

test("main.js APP_VERSION matches sw.js VERSION", () => {
  const swVersion = sw.match(/const VERSION\s*=\s*"([^"]+)"/);
  const appVersion = read("src/main.js").match(/const APP_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(swVersion && appVersion);
  assert.equal(
    appVersion[1],
    swVersion[1],
    "Settings would show a version different from the worker actually serving the app",
  );
});

test("nothing uses a root relative path", () => {
  // GitHub Pages serves this from /p_tracker/, so a leading slash resolves to
  // the domain root and 404s in production while working on a localhost root.
  for (const file of ["index.html", "sw.js", "src/main.js", "src/ui.js", "src/sw-register.js"]) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const hits = [...src.matchAll(/(?:href|src|url)\s*[=:]\s*"(\/[^/][^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(hits, [], `${file} has root relative path(s): ${hits.join(", ")}`);
  }
  const manifest = JSON.parse(read("manifest.webmanifest"));
  for (const p of [manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src)]) {
    assert.ok(!String(p).startsWith("/"), `manifest has a root relative path: ${p}`);
  }
});

test("index.html loads the real entry point", () => {
  const html = read("index.html");
  assert.match(html, /<script[^>]+type="module"[^>]+src="\.\/src\/main\.js"/);
  assert.match(html, /<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/);
});

test("the service worker keeps its legacy cache cleanup", () => {
  // The previous app's worker is registered on the user's phone under the same
  // origin. If this ever stops deleting pill-ledger-* caches, a stale app can
  // keep being served from them.
  assert.match(sw, /pill-ledger-/, "sw.js must still delete the previous app's caches");
  assert.match(sw, /skipWaiting\(\)/);
  assert.match(sw, /clients\.claim\(\)/);
});
