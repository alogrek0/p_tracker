// Cross module consistency.
//
// state.js `load` and export.js `importJSON` both decide whether a document is
// an acceptable ledger. They are separate code paths by necessity, so anywhere
// they disagree is a latent bug: a document that imports one way and loads
// another loses data silently between one launch and the next. These tests pin
// the cases that actually diverged during the build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateEntry } from "../src/ledger.js";
import { load, save, STORAGE_KEY } from "../src/state.js";
import { importJSON, exportJSON } from "../src/export.js";

/** Minimal in memory localStorage, installed for one call. */
function withStorage(raw, fn) {
  const store = new Map();
  if (raw !== undefined) store.set(STORAGE_KEY, raw);
  const stub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prev = globalThis.localStorage;
  globalThis.localStorage = stub;
  try {
    return fn();
  } finally {
    if (had) globalThis.localStorage = prev;
    else delete globalThis.localStorage;
  }
}

const docWith = (settingsEntry) => ({
  schema: 1,
  nextSeq: 2,
  meta: { lastExportAt: null, lowBalanceDays: 7 },
  entries: [
    { id: "e0", seq: 0, type: "setup", date: "2026-09-01", qty: 40 },
    settingsEntry,
  ],
});

test("a plan carrying a third slot is rejected, not kept by one path and dropped by the other", () => {
  const strayKey = {
    id: "e1",
    seq: 1,
    type: "settings",
    date: "2026-09-01",
    prescribedPerDay: 2,
    plan: { am: 1, pm: 1, noon: 1 },
  };

  // There are exactly two slots, so a third key is invalid data.
  assert.notEqual(validateEntry(strayKey).length, 0);

  const doc = docWith(strayKey);
  const imported = importJSON(JSON.stringify(doc));
  assert.equal(imported.ok, false, "import must reject a plan with an unknown key");

  const loaded = withStorage(JSON.stringify(doc), () => load());
  assert.equal(loaded, null, "load must reject it too");

  // Previously import kept `noon` and the next load silently dropped it.
  // Both now refuse, so the disagreement cannot produce quiet data loss.
});

test("a valid two slot plan still round trips", () => {
  const good = {
    id: "e1",
    seq: 1,
    type: "settings",
    date: "2026-09-01",
    prescribedPerDay: 2,
    plan: { am: 1.5, pm: 0.5 },
  };
  assert.deepEqual(validateEntry(good), []);

  const doc = docWith(good);
  const imported = importJSON(JSON.stringify(doc));
  assert.equal(imported.ok, true, imported.errors.join("; "));

  const loaded = withStorage(JSON.stringify(doc), () => load());
  assert.notEqual(loaded, null);
  assert.deepEqual(loaded.entries[1].plan, { am: 1.5, pm: 0.5 });

  // And the two paths agree on the resulting document.
  assert.equal(exportJSON(imported.state), exportJSON(loaded));
});

test("meta as an array is rejected by both paths", () => {
  const doc = {
    schema: 1,
    nextSeq: 1,
    meta: [],
    entries: [{ id: "e0", seq: 0, type: "setup", date: "2026-09-01", qty: 40 }],
  };
  assert.equal(importJSON(JSON.stringify(doc)).ok, false);
  assert.equal(withStorage(JSON.stringify(doc), () => load()), null);
});

test("the previous app's storage key is never read", () => {
  const reads = [];
  const stub = {
    getItem: (k) => {
      reads.push(k);
      return null;
    },
    setItem: () => {},
    removeItem: () => {},
  };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prev = globalThis.localStorage;
  globalThis.localStorage = stub;
  try {
    load();
  } finally {
    if (had) globalThis.localStorage = prev;
    else delete globalThis.localStorage;
  }
  assert.ok(reads.includes(STORAGE_KEY));
  assert.ok(!reads.includes("pill-ledger-v1"), "the old app's data must never be read");
});

test("a backup with two opening entries is rejected by both paths", () => {
  // An opening entry moves surplus without moving the balance, so two of them
  // would silently double a seeded surplus. load enforced this from the start;
  // import did not, which meant such a file imported cleanly and was then
  // refused on the next launch.
  const doc = {
    schema: 1,
    nextSeq: 4,
    meta: { lastExportAt: null, lowBalanceDays: 7 },
    entries: [
      { id: "e0", seq: 0, type: "setup", date: "2026-09-01", qty: 40 },
      { id: "e1", seq: 1, type: "opening", date: "2026-09-01", pills: 12 },
      { id: "e2", seq: 2, type: "opening", date: "2026-09-01", pills: 9 },
    ],
  };
  const imported = importJSON(JSON.stringify(doc));
  assert.equal(imported.ok, false, "import must reject a second opening entry");
  assert.match(imported.errors.join(" "), /opening/i);
  assert.equal(withStorage(JSON.stringify(doc), () => load()), null);
});

test("a single opening entry round trips and keeps its sign", () => {
  const doc = {
    schema: 1,
    nextSeq: 3,
    meta: { lastExportAt: null, lowBalanceDays: 7 },
    entries: [
      { id: "e0", seq: 0, type: "setup", date: "2026-09-01", qty: 40 },
      { id: "e1", seq: 1, type: "opening", date: "2026-09-01", pills: -3.5 },
    ],
  };
  const imported = importJSON(JSON.stringify(doc));
  assert.equal(imported.ok, true, imported.errors.join("; "));
  assert.equal(imported.state.entries[1].pills, -3.5);

  const loaded = withStorage(JSON.stringify(doc), () => load());
  assert.notEqual(loaded, null);
  assert.equal(exportJSON(imported.state), exportJSON(loaded));

  // And pills sits in the canonical key order rather than the sorted tail.
  const text = exportJSON(imported.state);
  assert.ok(text.indexOf('"pills"') < text.indexOf('"note"') || !text.includes('"note"'));
});
