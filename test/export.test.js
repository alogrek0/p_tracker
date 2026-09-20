// Backup and restore. This file is the safety net's test: there is no backend
// and no sync, iOS can evict this app's localStorage without warning, and this
// export is the only copy that will ever exist. A silently lossy round trip is
// worse than a refused import, so every case below either round trips exactly
// or is rejected by name.
//
// Same timezone pin as ledger.test.js and state.test.js so date behaviour is
// reproducible, and so the DST assertions below mean something.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";

import { STALE_AFTER_DAYS, exportJSON, importJSON, exportStaleness } from "../src/export.js";

import {
  STORAGE_KEY,
  load,
  createState,
  addEntry,
  logDose,
  recordFill,
  recordRecount,
  updateSettings,
  updateEntry,
  markExported,
} from "../src/state.js";

import { summary, balance, surplus, projection, addDays, daysBetween } from "../src/ledger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SETUP_DAY = "2026-09-01";
const TODAY = "2026-09-19";

/**
 * A rich state: setup, a settings change, doses including a qty 0 skip, a fill,
 * a recount, a backdated entry, a note, and a recorded export.
 */
function richState() {
  let s = createState({ count: 40, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: SETUP_DAY });
  for (let d = "2026-09-02"; d <= "2026-09-05"; d = addDays(d, 1)) {
    s = logDose(s, { slot: "am", qty: 1, date: d });
    s = logDose(s, { slot: "pm", qty: 1, date: d });
  }
  // A deliberate skip, logged as qty 0.
  s = logDose(s, { slot: "am", qty: 0, date: "2026-09-06" });
  s = logDose(s, { slot: "pm", qty: 0.5, date: "2026-09-06" });
  s = recordFill(s, { qty: 60, date: "2026-09-07" });
  s = recordRecount(s, { qty: 88, date: "2026-09-10" });
  s = updateSettings(s, { prescribedPerDay: 2.5, plan: { am: 1.5, pm: 1 } }, "2026-09-11");
  s = logDose(s, { slot: "am", qty: 1.5, date: "2026-09-12" });
  // Backdated: written now, dated back before everything above it.
  s = addEntry(s, { type: "dose", slot: "pm", qty: 1, date: "2026-09-07" });
  s = updateEntry(s, s.entries[0].id, { note: "first bottle" });
  s = markExported(s, "2026-09-12");
  return s;
}

/** The two entries a valid minimal document carries. */
const SETUP_ENTRY = { id: "e1", seq: 1, type: "setup", date: SETUP_DAY, qty: 40 };
const SETTINGS_ENTRY = {
  id: "e2",
  seq: 2,
  type: "settings",
  date: SETUP_DAY,
  prescribedPerDay: 2,
  plan: { am: 1, pm: 1 },
};

/** Build a backup document as text. @param {any[]} entries @param {any} over */
function doc(entries, over = {}) {
  const maxSeq = entries.reduce((m, e) => (Number.isInteger(e && e.seq) && e.seq > m ? e.seq : m), -1);
  return JSON.stringify({
    schema: 1,
    nextSeq: maxSeq + 1,
    meta: { lastExportAt: null, lowBalanceDays: 7 },
    entries,
    ...over,
  });
}

/** Import without ever letting a throw escape, and report what came back. */
function tryImport(text) {
  let result;
  assert.doesNotThrow(() => {
    result = importJSON(text);
  }, `importJSON threw on ${String(text).slice(0, 60)}`);
  assert.equal(typeof result, "object");
  assert.equal(Array.isArray(result.errors), true, "errors is always an array");
  return result;
}

/** Assert a rejection, and that the message names the real problem. */
function assertRejected(text, pattern, label) {
  const r = tryImport(text);
  assert.equal(r.ok, false, `accepted ${label}`);
  assert.equal(r.state, undefined, `${label}: a rejected import must hand back no state`);
  assert.ok(r.errors.length > 0, `${label}: rejected with no reason given`);
  for (const e of r.errors) assert.equal(typeof e, "string");
  assert.match(r.errors.join(" | "), pattern, `${label}: unhelpful message`);
  return r;
}

/** Minimal in-memory localStorage, as in state.test.js. */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/** Run fn with a stubbed localStorage and a captured console.warn. */
function withStorage(store, fn) {
  const hadStorage = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prevStorage = globalThis.localStorage;
  const prevWarn = console.warn;
  const warnings = [];
  globalThis.localStorage = store;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return fn(warnings);
  } finally {
    console.warn = prevWarn;
    if (hadStorage) globalThis.localStorage = prevStorage;
    else delete globalThis.localStorage;
  }
}

/** What load() makes of one raw string. */
function loadRaw(text) {
  const store = makeStorage();
  store.setItem(STORAGE_KEY, text);
  return withStorage(store, () => load());
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("a rich state exports, imports, and comes back deep equal", () => {
  const s = richState();

  // The fixture really is rich: every entry type, a skip, a backdated entry.
  const types = s.entries.map((e) => e.type);
  for (const t of ["setup", "settings", "dose", "fill", "recount"]) {
    assert.ok(types.includes(t), `fixture is missing a ${t} entry`);
  }
  assert.ok(s.entries.some((e) => e.type === "dose" && e.qty === 0), "fixture is missing a logged skip");
  assert.ok(s.entries.some((e) => e.note === "first bottle"), "fixture is missing a note");
  assert.equal(s.meta.lastExportAt, "2026-09-12");
  const backdated = s.entries.at(-1);
  assert.ok(backdated.date < s.entries.at(-2).date, "fixture is missing a backdated entry");

  const text = exportJSON(s);
  assert.equal(typeof text, "string");
  assert.match(text, /\n {2}"schema": 1/, "pretty printed with two space indent");
  assert.equal(text.endsWith("\n"), true);

  const r = tryImport(text);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true, r.errors.join(" | "));
  assert.deepEqual(r.state, s);

  // Nothing is shared with the text it came from, and re-exporting the imported
  // state reproduces the file byte for byte, so a backup of a restore is the
  // same backup.
  assert.notEqual(r.state, s);
  assert.notEqual(r.state.entries, s.entries);
  assert.equal(exportJSON(r.state), text);

  // A second round trip changes nothing either.
  const twice = tryImport(exportJSON(r.state));
  assert.equal(twice.ok, true);
  assert.deepEqual(twice.state, s);

  // Values that are easy to lose in a careless serializer survive.
  const skip = r.state.entries.find((e) => e.type === "dose" && e.qty === 0);
  assert.equal(skip.qty, 0, "a qty 0 skip is a value, not an absence");
  assert.equal(r.state.entries.find((e) => e.note !== undefined).note, "first bottle");
  assert.deepEqual(
    r.state.entries.find((e) => e.date === "2026-09-11" && e.type === "settings").plan,
    { am: 1.5, pm: 1 },
  );

  // A state that has never been exported round trips too, null and all.
  const fresh = createState({ count: 40, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: TODAY });
  const rf = tryImport(exportJSON(fresh));
  assert.equal(rf.ok, true);
  assert.deepEqual(rf.state, fresh);
  assert.equal(rf.state.meta.lastExportAt, null);
});

test("the imported state produces exactly the same ledger as the original", () => {
  const s = richState();
  const back = tryImport(exportJSON(s)).state;

  // The assertion that makes the backup worth having: same numbers, not just
  // the same bytes. Checked on several days, including the setup day, a day
  // mid log, today, and a day far in the future.
  for (const day of [SETUP_DAY, "2026-09-07", "2026-09-11", TODAY, "2026-12-25"]) {
    assert.deepEqual(summary(back.entries, day), summary(s.entries, day), `summary differs on ${day}`);
    assert.equal(balance(back.entries, day), balance(s.entries, day), `balance differs on ${day}`);
    assert.deepEqual(surplus(back.entries, day), surplus(s.entries, day), `surplus differs on ${day}`);
    assert.deepEqual(projection(back.entries, day), projection(s.entries, day), `projection differs on ${day}`);
  }

  // And the restored ledger is live: it keeps accepting writes from the seq the
  // backup carried, with no collision.
  const after = logDose(back, { slot: "am", qty: 1, date: TODAY });
  assert.equal(after.entries.at(-1).seq, s.nextSeq);
  assert.equal(new Set(after.entries.map((e) => e.id)).size, after.entries.length);
  assert.deepEqual(summary(after.entries, TODAY), summary(logDose(s, { slot: "am", qty: 1, date: TODAY }).entries, TODAY));
});

// ---------------------------------------------------------------------------
// Byte stability
// ---------------------------------------------------------------------------

test("exporting equal states gives byte identical text, whatever order the keys were built in", () => {
  // Same state, exported twice.
  const s = richState();
  assert.equal(exportJSON(s), exportJSON(s));

  // Two states built independently by the same steps.
  assert.equal(exportJSON(richState()), exportJSON(richState()));

  // Two states built with their properties, and their entries' properties, in
  // different orders. A diff between two backups must show ledger changes, not
  // the order some object literal happened to be written in.
  const a = {
    schema: 1,
    nextSeq: 3,
    meta: { lastExportAt: "2026-09-12", lowBalanceDays: 7 },
    entries: [{ ...SETUP_ENTRY }, { ...SETTINGS_ENTRY }],
  };
  const b = {
    entries: [
      { qty: 40, date: SETUP_DAY, type: "setup", seq: 1, id: "e1" },
      { plan: { pm: 1, am: 1 }, prescribedPerDay: 2, date: SETUP_DAY, type: "settings", seq: 2, id: "e2" },
    ],
    meta: { lowBalanceDays: 7, lastExportAt: "2026-09-12" },
    nextSeq: 3,
    schema: 1,
  };
  assert.deepEqual(a, b, "the two fixtures must be equal states, differing only in key order");
  assert.equal(exportJSON(a), exportJSON(b));

  // The stable order is the declared one, so the file reads the same way every
  // time and a diff lines up.
  const text = exportJSON(a);
  const topKeys = [...text.matchAll(/^ {2}"(\w+)":/gm)].map((m) => m[1]);
  assert.deepEqual(topKeys, ["schema", "nextSeq", "meta", "entries"]);
  assert.ok(text.indexOf('"id": "e1"') < text.indexOf('"seq": 1'), "entry keys are in the declared order");

  // Entry ORDER is content, not formatting: two different logs are two
  // different files.
  const reordered = { ...a, entries: [a.entries[1], a.entries[0]] };
  assert.notEqual(exportJSON(reordered), text);
});

// ---------------------------------------------------------------------------
// Rejection. Every one of these asserts no throw, ok === false, and a message
// that names the real problem.
// ---------------------------------------------------------------------------

test("importJSON never throws and rejects anything that is not a backup document", () => {
  // Not text at all.
  for (const v of [undefined, null, 42, {}, [], true, Symbol("x"), () => {}]) {
    assertRejected(v, /must be text/, `non string ${String(v)}`);
  }
  assertRejected("", /empty/, "empty string");
  assertRejected("   \n  ", /empty/, "whitespace only");

  // Not valid JSON.
  assertRejected("not json", /not valid JSON/, "prose");
  assertRejected("{", /not valid JSON|truncated/, "open brace");
  assertRejected('{"schema": 1, "entries": [', /not valid JSON|truncated/, "cut off mid array");

  // A real export, truncated by a failed download or a partial copy and paste.
  const whole = exportJSON(richState());
  assertRejected(whole.slice(0, Math.floor(whole.length / 2)), /not valid JSON|truncated/, "half a file");

  // Valid JSON that is not an object.
  assertRejected("null", /null/, "null");
  assertRejected("[]", /array/, "empty array");
  assertRejected(JSON.stringify([SETUP_ENTRY, SETTINGS_ENTRY]), /array/, "a bare array of entries");
  assertRejected("42", /number/, "a number");
  assertRejected('"a string"', /string/, "a JSON string");
  assertRejected("true", /boolean/, "a boolean");

  // A state from a different app entirely.
  assertRejected(
    JSON.stringify({ app: "budget-tracker", version: 3, accounts: [{ name: "checking", cents: 100 }] }),
    /schema|p_tracker/,
    "another app's file",
  );
  assertRejected("{}", /schema|p_tracker/, "an empty object");
});

test("importJSON rejects a document whose ledger would be corrupt, naming the entry and the rule", () => {
  // A bad seq, in each of its flavours.
  assertRejected(doc([{ ...SETUP_ENTRY, seq: -1 }], { nextSeq: 5 }), /seq must be a non-negative integer/, "negative seq");
  assertRejected(doc([{ ...SETUP_ENTRY, seq: 1.5 }], { nextSeq: 5 }), /seq must be a non-negative integer/, "fractional seq");
  assertRejected(doc([{ ...SETUP_ENTRY, seq: "1" }], { nextSeq: 5 }), /seq must be a non-negative integer/, "string seq");
  assertRejected(doc([{ ...SETUP_ENTRY, seq: null }], { nextSeq: 5 }), /seq must be a non-negative integer/, "null seq");

  // Duplicate ids: two entries, one identity. Editing one would edit both.
  assertRejected(
    doc([SETUP_ENTRY, { ...SETTINGS_ENTRY, id: "e1" }]),
    /duplicate|already used/i,
    "duplicate ids",
  );
  // Duplicate seqs: the ordering within a day stops being defined.
  assertRejected(
    doc([SETUP_ENTRY, { ...SETTINGS_ENTRY, seq: 1 }], { nextSeq: 3 }),
    /duplicate|already used/i,
    "duplicate seqs",
  );

  // Two doses in one (date, slot): the double count this app exists to prevent.
  assertRejected(
    doc([
      SETUP_ENTRY,
      SETTINGS_ENTRY,
      { id: "e3", seq: 3, type: "dose", date: "2026-09-02", slot: "am", qty: 1 },
      { id: "e4", seq: 4, type: "dose", date: "2026-09-02", slot: "am", qty: 1 },
    ]),
    /second am dose .*2026-09-02/,
    "two am doses in one day",
  );
  // The other slot, and the same slot on another day, are not a clash.
  const fine = tryImport(
    doc([
      SETUP_ENTRY,
      SETTINGS_ENTRY,
      { id: "e3", seq: 3, type: "dose", date: "2026-09-02", slot: "am", qty: 1 },
      { id: "e4", seq: 4, type: "dose", date: "2026-09-02", slot: "pm", qty: 1 },
      { id: "e5", seq: 5, type: "dose", date: "2026-09-03", slot: "am", qty: 1 },
    ]),
  );
  assert.equal(fine.ok, true, fine.errors.join(" | "));

  // Quantities that are not non-negative multiples of 0.5.
  for (const bad of [0.3, 0.25, -1, -0.5, "1", null, true]) {
    assertRejected(doc([{ ...SETUP_ENTRY, qty: bad }]), /qty/, `qty ${String(bad)}`);
  }
  assertRejected(
    doc([SETUP_ENTRY, { ...SETTINGS_ENTRY, plan: { am: 0.3, pm: 1 } }]),
    /plan/,
    "a plan that is not in halves",
  );
  assertRejected(
    doc([SETUP_ENTRY, { ...SETTINGS_ENTRY, prescribedPerDay: 0.3 }]),
    /prescribedPerDay/,
    "a prescribed rate that is not in halves",
  );

  // Dates that are not real local calendar days.
  for (const bad of ["2026-02-30", "2026-13-01", "2026-9-1", "09/01/2026", "2026-09-01T00:00:00Z", 20260901, null]) {
    assertRejected(doc([{ ...SETUP_ENTRY, date: bad }]), /date/, `date ${String(bad)}`);
  }

  // More than one setup entry: two seeds, so the balance has two answers.
  assertRejected(
    doc([SETUP_ENTRY, { ...SETUP_ENTRY, id: "e2", seq: 2, qty: 99 }]),
    /setup/,
    "two setup entries",
  );

  // nextSeq at or below the highest seq present would hand out a seq already in
  // use, which silently merges two entries later.
  assertRejected(doc([SETUP_ENTRY, SETTINGS_ENTRY], { nextSeq: 2 }), /nextSeq 2 .*highest seq 2/, "nextSeq equal to max");
  assertRejected(doc([SETUP_ENTRY, SETTINGS_ENTRY], { nextSeq: 0 }), /nextSeq 0 .*highest seq 2/, "nextSeq below max");
  assertRejected(doc([SETUP_ENTRY, SETTINGS_ENTRY], { nextSeq: -1 }), /nextSeq/, "negative nextSeq");
  assertRejected(doc([SETUP_ENTRY, SETTINGS_ENTRY], { nextSeq: "3" }), /nextSeq/, "string nextSeq");

  // Other shape failures.
  assertRejected(doc([SETUP_ENTRY], { schema: 2 }), /schema 2/, "a future schema");
  assertRejected(doc([SETUP_ENTRY], { entries: "nope" }), /entries must be an array/, "entries not an array");
  assertRejected(doc([SETUP_ENTRY], { entries: [null] }), /entry must be an object/, "a null entry");
  assertRejected(doc([SETUP_ENTRY], { entries: ["x"] }), /entry must be an object/, "a string entry");
  assertRejected(doc([{ ...SETUP_ENTRY, type: "gap" }]), /type must be one of/, "an unknown entry type");
  assertRejected(doc([{ ...SETUP_ENTRY, id: "" }]), /id must be a non-empty string/, "an empty id");
  assertRejected(doc([SETUP_ENTRY], { meta: "soon" }), /meta must be an object/, "meta not an object");
  assertRejected(
    doc([SETUP_ENTRY], { meta: { lastExportAt: "yesterday" } }),
    /lastExportAt/,
    "an unreadable lastExportAt",
  );
  assertRejected(
    doc([SETUP_ENTRY], { meta: { lowBalanceDays: -1 } }),
    /lowBalanceDays/,
    "a negative lowBalanceDays",
  );

  // Several problems at once are all reported, not just the first, and each one
  // says which entry it is about.
  const messy = assertRejected(
    doc(
      [
        { ...SETUP_ENTRY, qty: 0.3, date: "2026-02-30" },
        { ...SETTINGS_ENTRY, prescribedPerDay: 0.3 },
        { id: "e5", seq: 5, type: "dose", date: "2026-09-02", slot: "am", qty: 1 },
      ],
      { nextSeq: 1 },
    ),
    /qty/,
    "several problems",
  );
  assert.ok(messy.errors.length >= 3, `expected several reasons, got ${JSON.stringify(messy.errors)}`);
  assert.match(messy.errors.join(" | "), /date/);
  assert.match(messy.errors.join(" | "), /prescribedPerDay/);
  assert.match(messy.errors.join(" | "), /nextSeq/);
  assert.match(messy.errors[0], /entry 1 \(id e1\)/, "an error names the entry it is about");
  assert.match(messy.errors[1], /entry 2 \(id e2\)/);
});

test("a pill-ledger-v1 backup is rejected by name, never half accepted", () => {
  // The old app's shape: meds and slots arrays rather than a flat entry log.
  const old = {
    meds: [{ name: "the one", pillsPerDay: 2, remaining: 40 }],
    slots: [
      { id: "am", label: "Morning", taken: true },
      { id: "pm", label: "Evening", taken: false },
    ],
    lastUpdated: "2026-08-30",
  };
  const namesPreviousVersion = /previous version|pill-ledger-v1/i;

  const r = assertRejected(JSON.stringify(old), namesPreviousVersion, "the old app's backup");
  assert.match(r.errors.join(" | "), /pill-ledger-v1/, "the message names the old format so the user can tell why");
  assert.equal(r.state, undefined, "nothing from the old shape is carried over");

  // The other shapes that version wrote, and a raw localStorage dump of it.
  const variants = [
    { pillsPerDay: 0.5, count: 40, log: [] },
    { meds: [], slots: [] },
    { medications: [{ name: "the one" }], history: {} },
    { version: "pill-ledger-v1", data: {} },
    { "pill-ledger-v1": JSON.stringify(old) },
    { schema: 1, nextSeq: 3, meds: [], slots: [] },
  ];
  for (const v of variants) {
    assertRejected(JSON.stringify(v), namesPreviousVersion, `old variant ${JSON.stringify(v).slice(0, 40)}`);
  }

  // And a current backup is NOT mistaken for the old one, even with a stray
  // field that shares a name.
  const current = richState();
  assert.equal(tryImport(exportJSON(current)).ok, true);
  const withStray = JSON.parse(exportJSON(current));
  withStray.meds = [];
  const stray = tryImport(JSON.stringify(withStray));
  assert.equal(stray.ok, true, "a real schema 1 entry log is not the old format");
  assert.deepEqual(stray.state, current, "and the stray foreign key does not ride along");
});

// ---------------------------------------------------------------------------
// Parity with state.js load. A divergence between the two is a latent bug: it
// would mean a file this app wrote, and accepted on import, is refused on the
// next launch, or the reverse.
// ---------------------------------------------------------------------------

test("import and load agree on every document, good and bad", () => {
  const good = [
    exportJSON(richState()),
    exportJSON(createState({ count: 40, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: TODAY })),
    // meta absent, and meta partial: both get the same defaults from both paths.
    doc([SETUP_ENTRY, SETTINGS_ENTRY], { meta: undefined }),
    doc([SETUP_ENTRY, SETTINGS_ENTRY], { meta: { lowBalanceDays: 3 } }),
    doc([], { nextSeq: 0 }),
  ];
  for (const raw of good) {
    const r = tryImport(raw);
    assert.equal(r.ok, true, `import refused what load accepts: ${raw.slice(0, 60)} ${r.errors.join(" | ")}`);
    assert.deepEqual(r.state, loadRaw(raw), `import and load built different states from ${raw.slice(0, 60)}`);
  }

  // The garbage table from state.test.js, plus the import only cases.
  const bad = [
    "not json",
    "{",
    "null",
    "42",
    '"a string"',
    "[]",
    "{}",
    JSON.stringify({ schema: 2, nextSeq: 1, entries: [] }),
    JSON.stringify({ schema: 1, nextSeq: "1", entries: [] }),
    JSON.stringify({ schema: 1, nextSeq: 1, entries: "nope" }),
    JSON.stringify({ schema: 1, nextSeq: 1, entries: [{ id: "x", seq: 1, type: "gap", date: TODAY, qty: 1 }] }),
    JSON.stringify({ schema: 1, nextSeq: 1, entries: [{ id: "e1", seq: 1, type: "setup", date: TODAY, qty: 0.3 }] }),
    JSON.stringify({ schema: 1, nextSeq: 1, entries: [{ id: "e1", seq: 1, type: "setup", date: TODAY, qty: 40 }] }),
    doc([SETUP_ENTRY, { ...SETTINGS_ENTRY, id: "e1" }]),
    doc([SETUP_ENTRY, { ...SETUP_ENTRY, id: "e2", seq: 2 }]),
    JSON.stringify({ pillsPerDay: 0.5, count: 40, log: [] }),
  ];
  for (const raw of bad) {
    const r = tryImport(raw);
    assert.equal(r.ok, false, `import accepted what load refuses: ${raw.slice(0, 80)}`);
    assert.equal(loadRaw(raw), null, `load accepted what import refuses: ${raw.slice(0, 80)}`);
  }

  // A foreign top level key is dropped by both. A foreign key on an ENTRY is
  // kept by both, because dropping data from a backup is the one thing this
  // file exists to prevent.
  const foreign = doc([{ ...SETUP_ENTRY, mood: "ok" }, SETTINGS_ENTRY], { device: "phone" });
  const imported = tryImport(foreign);
  assert.equal(imported.ok, true, imported.errors.join(" | "));
  assert.deepEqual(imported.state, loadRaw(foreign));
  assert.equal("device" in imported.state, false);
  assert.equal(imported.state.entries[0].mood, "ok");
  assert.equal(exportJSON(imported.state).includes('"mood": "ok"'), true, "and it survives the next export too");

  // A key named __proto__ is the one that gets silently eaten by a careless
  // copy, and eats the object's prototype with it. It survives as plain data,
  // the same way state.js's load keeps it, and nothing global is touched.
  // The computed key is deliberate: a plain __proto__ in a literal would set
  // the prototype instead of making the own property this is testing.
  const cursed = doc([{ ...SETUP_ENTRY, ["__proto__"]: { hacked: true } }, SETTINGS_ENTRY]);
  const got = tryImport(cursed);
  assert.equal(got.ok, true, got.errors.join(" | "));
  assert.equal(Object.getPrototypeOf(got.state.entries[0]), Object.prototype);
  assert.equal(Object.keys(got.state.entries[0]).includes("__proto__"), true, "the field was not silently dropped");
  assert.equal({}.hacked, undefined, "nothing global was polluted");
  assert.deepEqual(got.state, loadRaw(cursed));
  assert.equal(tryImport(exportJSON(got.state)).ok, true);
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

test("exportStaleness: never exported, exported today, the boundary, and well past it", () => {
  assert.equal(STALE_AFTER_DAYS, 21);
  const base = richState();
  /** @param {string|null} last */
  const at = (last) => ({ ...base, meta: { ...base.meta, lastExportAt: last } });

  // Never exported: no number to report, and stale, because this phone's
  // localStorage is the only copy there is.
  assert.deepEqual(exportStaleness(at(null), TODAY), { stale: true, daysSince: null });

  // Exported today.
  assert.deepEqual(exportStaleness(at(TODAY), TODAY), { stale: false, daysSince: 0 });
  assert.deepEqual(exportStaleness(at(addDays(TODAY, -1)), TODAY), { stale: false, daysSince: 1 });

  // The boundary, from both sides. Exactly STALE_AFTER_DAYS is stale.
  const boundary = exportStaleness(at(addDays(TODAY, -STALE_AFTER_DAYS)), TODAY);
  assert.deepEqual(boundary, { stale: true, daysSince: 21 });
  assert.deepEqual(exportStaleness(at(addDays(TODAY, -(STALE_AFTER_DAYS - 1))), TODAY), { stale: false, daysSince: 20 });
  assert.deepEqual(exportStaleness(at(addDays(TODAY, -(STALE_AFTER_DAYS + 1))), TODAY), { stale: true, daysSince: 22 });

  // Well past it.
  assert.deepEqual(exportStaleness(at("2026-01-01"), TODAY), { stale: true, daysSince: daysBetween("2026-01-01", TODAY) });
  assert.equal(exportStaleness(at("2026-01-01"), TODAY).daysSince, 261);

  // Across a spring forward. 2026-03-08 is the DST change in America/New_York,
  // so this 21 day span is 21 days minus one hour. Dividing milliseconds would
  // floor it to 20 and the nag would arrive a day late.
  assert.deepEqual(exportStaleness(at("2026-03-01"), "2026-03-22"), { stale: true, daysSince: 21 });
  assert.deepEqual(exportStaleness(at("2026-03-01"), "2026-03-21"), { stale: false, daysSince: 20 });
  // And across a fall back, where the same arithmetic would overcount.
  assert.deepEqual(exportStaleness(at("2026-10-20"), "2026-11-10"), { stale: true, daysSince: 21 });
  assert.deepEqual(exportStaleness(at("2026-10-20"), "2026-11-09"), { stale: false, daysSince: 20 });

  // A lastExportAt in the future, from a clock change or a timezone hop, is not
  // stale and does not produce a nonsense positive count.
  assert.deepEqual(exportStaleness(at(addDays(TODAY, 3)), TODAY), { stale: false, daysSince: -3 });

  // markExported clears the nag, through the real reducer.
  const nagging = at("2026-01-01");
  assert.equal(exportStaleness(nagging, TODAY).stale, true);
  assert.deepEqual(exportStaleness(markExported(nagging, TODAY), TODAY), { stale: false, daysSince: 0 });

  // A damaged or absent meta nags rather than throwing: erring towards one
  // extra banner is the safe direction.
  for (const s of [{}, { meta: null }, { meta: {} }, { meta: { lastExportAt: "yesterday" } }, null, undefined]) {
    let out;
    assert.doesNotThrow(() => {
      out = exportStaleness(s, TODAY);
    }, `exportStaleness threw on ${JSON.stringify(s)}`);
    assert.deepEqual(out, { stale: true, daysSince: null });
  }
  assert.deepEqual(exportStaleness(at(TODAY), "2026-02-30"), { stale: true, daysSince: null });

  // The full loop: export, record it, and the nag is gone from the state that
  // then gets saved.
  const exported = tryImport(exportJSON(markExported(richState(), TODAY))).state;
  assert.deepEqual(exportStaleness(exported, TODAY), { stale: false, daysSince: 0 });
  assert.equal(exportStaleness(exported, addDays(TODAY, 21)).stale, true);
});
