// Tests 1 and 2 from the plan: the plan/log firewall, driven through the real
// logDose() path in src/state.js. Then the persistence and CRUD invariants.
//
// Same timezone pin as ledger.test.js so date behaviour is reproducible.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_KEY,
  load,
  save,
  createState,
  addEntry,
  updateEntry,
  deleteEntry,
  logDose,
  recordFill,
  recordRecount,
  updateSettings,
  markExported,
} from "../src/state.js";

import { effectiveAt, projection, balance, surplus, summary, addDays } from "../src/ledger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TODAY = "2026-09-19";

/** Standard first run through the real createState. */
function firstRun({ count = 40, plan = { am: 1, pm: 1 }, prescribedPerDay = 2, today = TODAY } = {}) {
  return createState({ count, plan, prescribedPerDay, today });
}

/** Structural snapshot, for "the input was not mutated" assertions. */
function snapshot(state) {
  return JSON.stringify(state);
}

/** Recursively freeze so any in-place write throws (modules run in strict mode). */
function deepFreeze(obj) {
  if (typeof obj !== "object" || obj === null || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj)) deepFreeze(v);
  return obj;
}

/**
 * Minimal in-memory localStorage. `failOnSet` simulates a quota or security
 * exception. Installed on globalThis for the duration of one test.
 */
function makeStorage({ failOnSet = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failOnSet) throw new DOMExceptionLike("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    _map: map,
  };
}

class DOMExceptionLike extends Error {
  constructor(name) {
    super(name);
    this.name = name;
  }
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

// ---------------------------------------------------------------------------
// 1. THE FIREWALL.
// ---------------------------------------------------------------------------

test("1. firewall: logDose(0.5) leaves the plan, the rate and plannedPerDay untouched and writes one dose entry only", () => {
  const before = firstRun({ count: 40, plan: { am: 1, pm: 1 }, prescribedPerDay: 2 });
  const beforeSnap = snapshot(before);
  const effBefore = effectiveAt(before.entries, TODAY);
  const projBefore = projection(before.entries, TODAY);
  const settingsBefore = before.entries.filter((e) => e.type === "settings");
  assert.equal(settingsBefore.length, 1, "first run writes exactly one settings entry");

  const after = logDose(before, { slot: "am", qty: 0.5, date: TODAY });

  // The plan and the prescribed rate are byte-identical.
  const effAfter = effectiveAt(after.entries, TODAY);
  assert.deepEqual(effAfter, effBefore);
  assert.deepEqual(effAfter.plan, { am: 1, pm: 1 });
  assert.equal(effAfter.prescribedPerDay, 2);

  // plannedPerDay comes from the plan and did not move.
  const projAfter = projection(after.entries, TODAY);
  assert.equal(projAfter.plannedPerDay, projBefore.plannedPerDay);
  assert.equal(projAfter.plannedPerDay, 2);

  // Exactly one new entry, of type dose, and nothing else.
  assert.equal(after.entries.length, before.entries.length + 1);
  const added = after.entries.filter((e) => !before.entries.some((b) => b.id === e.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].type, "dose");
  assert.equal(added[0].slot, "am");
  assert.equal(added[0].qty, 0.5);
  assert.equal(added[0].date, TODAY);
  // Every pre-existing entry is still there, unchanged.
  for (const b of before.entries) {
    assert.deepEqual(after.entries.find((e) => e.id === b.id), b);
  }

  // No settings entry was created, and the existing one is untouched.
  const settingsAfter = after.entries.filter((e) => e.type === "settings");
  assert.deepEqual(settingsAfter, settingsBefore);

  // The dose entry carries no plan-shaped data of any kind.
  assert.equal("plan" in added[0], false);
  assert.equal("prescribedPerDay" in added[0], false);

  // meta is untouched.
  assert.deepEqual(after.meta, before.meta);

  // The input state was not mutated.
  assert.equal(snapshot(before), beforeSnap);
  assert.notEqual(after, before);
  assert.notEqual(after.entries, before.entries);

  // And it holds for every quantity the UI can log, including a skip.
  let s = firstRun();
  for (const [slot, qty] of [["am", 0], ["pm", 1.5]]) {
    s = logDose(s, { slot, qty, date: TODAY });
    assert.deepEqual(effectiveAt(s.entries, TODAY), effBefore);
    assert.equal(projection(s.entries, TODAY).plannedPerDay, 2);
    assert.equal(s.entries.filter((e) => e.type === "settings").length, 1);
  }
});

// ---------------------------------------------------------------------------
// 2. The run-out date DOES move. The rate is fixed; the bottle is not.
// ---------------------------------------------------------------------------

test("2. after logDose(0.5) the run-out date moves with the bottle while plannedPerDay stays fixed", () => {
  // runOutDate = today + floor((balance - remainingToday) / plannedPerDay).
  // Logging takes qty out of the bottle AND clears that slot from
  // remainingToday, so the date shifts by (plan[slot] - qty) relative to the
  // pre-log projection. Taking 0.5 where 1 was planned leaves half a pill more
  // than the plan assumed. 41.5 is chosen so that half pill crosses a day
  // boundary: floor(39.5 / 2) = 19 before, floor(40 / 2) = 20 after.
  const before = firstRun({ count: 41.5, plan: { am: 1, pm: 1 }, prescribedPerDay: 2 });
  const pb = projection(before.entries, TODAY);
  assert.equal(pb.plannedPerDay, 2);
  assert.equal(pb.remainingToday, 2);
  assert.equal(pb.daysLeft, 19);
  assert.equal(pb.runOutDate, "2026-10-08");

  const after = logDose(before, { slot: "am", qty: 0.5, date: TODAY });
  const pa = projection(after.entries, TODAY);

  // Exactly half a pill left the bottle.
  assert.equal(balance(after.entries, TODAY), balance(before.entries, TODAY) - 0.5);
  assert.equal(balance(after.entries, TODAY), 41);

  // The rate did not move. The date did.
  assert.equal(pa.plannedPerDay, 2);
  assert.equal(pa.remainingToday, 1);
  assert.notEqual(pa.runOutDate, pb.runOutDate);
  assert.equal(pa.daysLeft, 20);
  assert.equal(pa.runOutDate, "2026-10-09");
  // The new date is exactly what the fixed rate predicts from the new balance.
  assert.equal(pa.runOutDate, addDays(TODAY, Math.floor((41 - pa.remainingToday) / pa.plannedPerDay)));

  // The bug this guards against: the old app would have set the rate to 0.5
  // per slot (1/day) and reported 41 more days. It must be 20.
  assert.notEqual(pa.daysLeft, Math.floor((41 - 0.5) / 1));

  // One fewer half-pill means an EARLIER run-out. Compare the same slot logged
  // as taken (0.5) versus logged as skipped (0): remainingToday is identical,
  // only the bottle differs by half a pill, and the date moves one day
  // earlier for the state with less in the bottle. 41 is chosen so the half
  // pill crosses a day boundary: floor(40 / 2) = 20 vs floor(39.5 / 2) = 19.
  const base = firstRun({ count: 41, plan: { am: 1, pm: 1 }, prescribedPerDay: 2 });
  const taken = logDose(base, { slot: "am", qty: 0.5, date: TODAY });
  const skipped = logDose(base, { slot: "am", qty: 0, date: TODAY });
  const pt = projection(taken.entries, TODAY);
  const ps = projection(skipped.entries, TODAY);
  assert.equal(balance(taken.entries, TODAY), balance(skipped.entries, TODAY) - 0.5);
  assert.equal(pt.plannedPerDay, ps.plannedPerDay);
  assert.equal(pt.remainingToday, ps.remainingToday);
  assert.equal(ps.runOutDate, "2026-10-09");
  assert.equal(pt.runOutDate, "2026-10-08");
  assert.ok(pt.runOutDate < ps.runOutDate, "fewer pills in the bottle runs out earlier");
});

// ---------------------------------------------------------------------------
// createState
// ---------------------------------------------------------------------------

test("createState: first-run shape, setup and settings both dated today, meta defaults", () => {
  const s = createState({ count: 40, plan: { am: 0.5, pm: 1 }, prescribedPerDay: 2, today: TODAY });

  assert.equal(s.schema, 1);
  assert.equal(s.nextSeq, 3);
  assert.deepEqual(s.meta, { lastExportAt: null, lowBalanceDays: 7 });
  assert.equal(s.entries.length, 2);

  const [setup, settings] = s.entries;
  assert.equal(setup.type, "setup");
  assert.equal(setup.date, TODAY);
  assert.equal(setup.qty, 40);
  assert.equal(setup.seq, 1);
  assert.equal(typeof setup.id, "string");

  assert.equal(settings.type, "settings");
  assert.equal(settings.date, TODAY);
  assert.equal(settings.prescribedPerDay, 2);
  assert.deepEqual(settings.plan, { am: 0.5, pm: 1 });
  assert.equal(settings.seq, 2);
  assert.notEqual(settings.id, setup.id);

  // The ledger reads it back as expected on day zero.
  const sum = summary(s.entries, TODAY);
  assert.equal(sum.balance, 40);
  assert.deepEqual(sum.surplus, { pills: 0, estimatedDays: 0, estimatedSlots: 0 });
  assert.deepEqual(sum.effective, { prescribedPerDay: 2, plan: { am: 0.5, pm: 1 } });
  assert.equal(sum.projection.plannedPerDay, 1.5);

  // The plan object handed in is copied, not referenced.
  const plan = { am: 1, pm: 1 };
  const t = createState({ count: 10, plan, prescribedPerDay: 2, today: TODAY });
  plan.am = 99;
  assert.deepEqual(t.entries[1].plan, { am: 1, pm: 1 });

  // Bad inputs are rejected at construction.
  assert.throws(() => createState({ count: 0.3, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: TODAY }), /qty/);
  assert.throws(() => createState({ count: -1, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: TODAY }), /qty/);
  assert.throws(() => createState({ count: 40, plan: { am: 1 }, prescribedPerDay: 2, today: TODAY }), /plan/);
  assert.throws(() => createState({ count: 40, plan: { am: 1, pm: 1 }, prescribedPerDay: 0.3, today: TODAY }), /prescribedPerDay/);
  assert.throws(() => createState({ count: 40, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: "2026-9-19" }), /date/);
  assert.throws(() => createState({ count: 40, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: "2026-02-30" }), /date/);
});

// ---------------------------------------------------------------------------
// seq and id assignment
// ---------------------------------------------------------------------------

test("seq is monotonic across add, delete, add and is never reused", () => {
  let s = firstRun();
  assert.equal(s.nextSeq, 3);

  s = recordFill(s, { qty: 60, date: TODAY });
  const fill = s.entries.at(-1);
  assert.equal(fill.seq, 3);
  assert.equal(s.nextSeq, 4);

  s = deleteEntry(s, fill.id);
  assert.equal(s.entries.some((e) => e.id === fill.id), false);
  // Deleting hands nothing back.
  assert.equal(s.nextSeq, 4);

  s = recordRecount(s, { qty: 39, date: TODAY });
  const recount = s.entries.at(-1);
  assert.equal(recount.seq, 4);
  assert.notEqual(recount.id, fill.id);
  assert.equal(s.nextSeq, 5);

  // Across a long run: every seq strictly increasing, every id unique.
  let d = TODAY;
  for (let i = 0; i < 50; i += 1) {
    s = logDose(s, { slot: "am", qty: 1, date: d });
    s = logDose(s, { slot: "pm", qty: 1, date: d });
    if (i % 3 === 0) s = deleteEntry(s, s.entries.at(-1).id);
    d = addDays(d, 1);
  }
  const seqs = s.entries.map((e) => e.seq);
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} after ${seqs[i - 1]}`);
  assert.equal(new Set(s.entries.map((e) => e.id)).size, s.entries.length);
  assert.ok(s.nextSeq > Math.max(...seqs));
});

// ---------------------------------------------------------------------------
// Invariants: one dose per (date, slot), setup undeletable, half-pill quantities
// ---------------------------------------------------------------------------

test("a second dose for one (date, slot) is rejected; the other slot and other days are fine", () => {
  let s = firstRun();
  s = logDose(s, { slot: "am", qty: 1, date: TODAY });
  const snap = snapshot(s);

  assert.throws(() => logDose(s, { slot: "am", qty: 0.5, date: TODAY }), /already logged/);
  assert.throws(() => addEntry(s, { type: "dose", slot: "am", qty: 0, date: TODAY }), /already logged/);
  // A failed reducer leaves the input exactly as it was.
  assert.equal(snapshot(s), snap);

  s = logDose(s, { slot: "pm", qty: 1, date: TODAY });
  s = logDose(s, { slot: "am", qty: 1, date: addDays(TODAY, 1) });
  assert.equal(s.entries.filter((e) => e.type === "dose").length, 3);

  // updateEntry cannot move a dose onto an occupied slot either.
  const pm = s.entries.find((e) => e.type === "dose" && e.slot === "pm");
  assert.throws(() => updateEntry(s, pm.id, { slot: "am" }), /already logged/);
  // But it can move onto a free one, and can patch itself in place.
  const moved = updateEntry(s, pm.id, { slot: "pm", qty: 0.5 });
  assert.equal(moved.entries.find((e) => e.id === pm.id).qty, 0.5);
  const free = updateEntry(s, pm.id, { date: addDays(TODAY, 1) });
  assert.equal(free.entries.find((e) => e.id === pm.id).date, addDays(TODAY, 1));
});

test("the setup entry cannot be deleted, cannot change type, and cannot be duplicated", () => {
  const s = firstRun();
  const setup = s.entries.find((e) => e.type === "setup");
  const snap = snapshot(s);

  assert.throws(() => deleteEntry(s, setup.id), /setup/);
  assert.throws(() => updateEntry(s, setup.id, { type: "fill" }), /setup/);
  assert.throws(() => addEntry(s, { type: "setup", qty: 10, date: TODAY }), /setup/);
  assert.equal(snapshot(s), snap);

  // Other entries delete fine, and unknown ids are an error, not a no-op.
  const settings = s.entries.find((e) => e.type === "settings");
  assert.equal(deleteEntry(s, settings.id).entries.length, 1);
  assert.throws(() => deleteEntry(s, "nope"), /no entry/);
  assert.throws(() => updateEntry(s, "nope", { qty: 1 }), /no entry/);

  // The setup count itself is editable (a miscount on day zero).
  const fixed = updateEntry(s, setup.id, { qty: 41 });
  assert.equal(fixed.entries.find((e) => e.id === setup.id).qty, 41);
  assert.equal(balance(fixed.entries, TODAY), 41);
});

test("quantities of 0.3 and negatives are rejected on every path; halves accepted", () => {
  const s = firstRun();
  const snap = snapshot(s);

  for (const bad of [0.3, -1, -0.5, 0.25, NaN, Infinity, "1", null, undefined]) {
    assert.throws(() => logDose(s, { slot: "am", qty: bad, date: TODAY }), /qty/, `logDose ${String(bad)}`);
    assert.throws(() => recordFill(s, { qty: bad, date: TODAY }), /qty/, `recordFill ${String(bad)}`);
    assert.throws(() => recordRecount(s, { qty: bad, date: TODAY }), /qty/, `recordRecount ${String(bad)}`);
    assert.throws(() => addEntry(s, { type: "fill", qty: bad, date: TODAY }), /qty/, `addEntry ${String(bad)}`);
  }
  assert.throws(() => updateSettings(s, { prescribedPerDay: 0.3 }, TODAY), /prescribedPerDay/);
  assert.throws(() => updateSettings(s, { prescribedPerDay: -2 }, TODAY), /prescribedPerDay/);
  assert.throws(() => updateSettings(s, { plan: { am: 0.3, pm: 1 } }, TODAY), /plan/);
  assert.throws(() => updateSettings(s, { plan: { am: 1, pm: -1 } }, TODAY), /plan/);
  assert.throws(() => updateSettings(s, {}, TODAY), /settings/);

  // Patching an existing entry to a bad quantity is rejected too.
  const setup = s.entries.find((e) => e.type === "setup");
  assert.throws(() => updateEntry(s, setup.id, { qty: 0.3 }), /qty/);
  assert.throws(() => updateEntry(s, setup.id, { qty: -5 }), /qty/);
  assert.equal(snapshot(s), snap);

  // Valid halves on every path.
  let ok = s;
  for (const q of [0, 0.5, 1, 1.5]) {
    ok = logDose(ok, { slot: "am", qty: q, date: addDays(TODAY, q * 2) });
  }
  ok = recordFill(ok, { qty: 60, date: TODAY });
  ok = recordRecount(ok, { qty: 99.5, date: TODAY });
  assert.equal(ok.entries.length, s.entries.length + 6);

  // Bad slots and bad dates are rejected as well.
  assert.throws(() => logDose(s, { slot: "noon", qty: 1, date: TODAY }), /slot/);
  assert.throws(() => logDose(s, { slot: "am", qty: 1, date: "2026-09-31" }), /date/);
  assert.throws(() => recordFill(s, { qty: 1, date: "09/19/2026" }), /date/);
});

// ---------------------------------------------------------------------------
// updateSettings: append, never mutate
// ---------------------------------------------------------------------------

test("updateSettings appends a dated settings entry; a rate change today leaves a past day's surplus untouched", () => {
  const setupDay = "2026-09-01";
  let s = firstRun({ count: 100, plan: { am: 1, pm: 1 }, prescribedPerDay: 2, today: setupDay });
  for (let d = "2026-09-02"; d <= "2026-09-11"; d = addDays(d, 1)) {
    s = logDose(s, { slot: "am", qty: 1, date: d });
    s = logDose(s, { slot: "pm", qty: 1, date: d });
  }
  const today = "2026-09-12";
  assert.equal(surplus(s.entries, today).pills, 0);
  const before = s;
  const beforeSnap = snapshot(before);
  const originalSettings = before.entries.find((e) => e.type === "settings");

  const after = updateSettings(before, { prescribedPerDay: 3 }, today);

  // Appended, not mutated: one more entry, the original settings entry intact.
  assert.equal(after.entries.length, before.entries.length + 1);
  const added = after.entries.at(-1);
  assert.equal(added.type, "settings");
  assert.equal(added.date, today);
  assert.equal(added.prescribedPerDay, 3);
  assert.equal("plan" in added, false);
  assert.deepEqual(after.entries.find((e) => e.id === originalSettings.id), originalSettings);
  assert.equal(after.entries.filter((e) => e.type === "settings").length, 2);
  assert.equal(snapshot(before), beforeSnap);

  // Ledger-level: yesterday still sees rate 2, today sees 3, and the ten
  // completed days still sum to 0.
  assert.equal(effectiveAt(after.entries, "2026-09-11").prescribedPerDay, 2);
  assert.equal(effectiveAt(after.entries, today).prescribedPerDay, 3);
  assert.equal(surplus(after.entries, today).pills, 0);
  assert.deepEqual(surplus(after.entries, today), surplus(before.entries, today));

  // Going forward the new rate applies: today, once completed at 2/day, accrues +1.
  let fwd = logDose(after, { slot: "am", qty: 1, date: today });
  fwd = logDose(fwd, { slot: "pm", qty: 1, date: today });
  assert.equal(surplus(fwd.entries, addDays(today, 1)).pills, 1);

  // A plan-only change keeps the rate in force and changes plannedPerDay from
  // its own date forward, with the day before untouched.
  const tomorrow = addDays(today, 1);
  const planned = updateSettings(fwd, { plan: { am: 0.5, pm: 1 } }, tomorrow);
  assert.deepEqual(effectiveAt(planned.entries, tomorrow), { prescribedPerDay: 3, plan: { am: 0.5, pm: 1 } });
  assert.deepEqual(effectiveAt(planned.entries, today).plan, { am: 1, pm: 1 });
  assert.equal(projection(planned.entries, tomorrow).plannedPerDay, 1.5);
  assert.equal(projection(planned.entries, today).plannedPerDay, 2);

  // A backdated settings change is honoured from its date, not from now.
  const back = updateSettings(before, { prescribedPerDay: 3 }, "2026-09-07");
  assert.equal(effectiveAt(back.entries, "2026-09-06").prescribedPerDay, 2);
  assert.equal(effectiveAt(back.entries, "2026-09-07").prescribedPerDay, 3);
  // Five days (07 to 11) at rate 3 with 2 consumed: +5.
  assert.equal(surplus(back.entries, today).pills, 5);

  // Both fields at once, and the patch object is not referenced.
  const patch = { prescribedPerDay: 2.5, plan: { am: 1.5, pm: 1 } };
  const both = updateSettings(before, patch, today);
  patch.plan.am = 99;
  assert.deepEqual(effectiveAt(both.entries, today), { prescribedPerDay: 2.5, plan: { am: 1.5, pm: 1 } });
});

// ---------------------------------------------------------------------------
// markExported
// ---------------------------------------------------------------------------

test("markExported touches meta only", () => {
  const s = firstRun();
  const snap = snapshot(s);
  const after = markExported(s, TODAY);
  assert.equal(after.meta.lastExportAt, TODAY);
  assert.equal(after.meta.lowBalanceDays, 7);
  assert.equal(after.entries, s.entries, "entries array is the very same reference; nothing to copy");
  assert.equal(after.nextSeq, s.nextSeq);
  assert.equal(snapshot(s), snap);
  assert.equal(s.meta.lastExportAt, null);
  assert.throws(() => markExported(s, "yesterday"), /date/);
});

// ---------------------------------------------------------------------------
// Purity: every reducer leaves its input untouched
// ---------------------------------------------------------------------------

test("every reducer returns a new state and never mutates its input", () => {
  const base = deepFreeze(firstRun({ count: 40 }));
  const baseSnap = snapshot(base);
  const setup = base.entries.find((e) => e.type === "setup");
  const settings = base.entries.find((e) => e.type === "settings");

  const reducers = {
    addEntry: (s) => addEntry(s, { type: "fill", qty: 10, date: TODAY }),
    updateEntry: (s) => updateEntry(s, setup.id, { qty: 41, note: "recounted" }),
    deleteEntry: (s) => deleteEntry(s, settings.id),
    logDose: (s) => logDose(s, { slot: "am", qty: 0.5, date: TODAY }),
    recordFill: (s) => recordFill(s, { qty: 60, date: TODAY }),
    recordRecount: (s) => recordRecount(s, { qty: 38, date: TODAY }),
    updateSettings: (s) => updateSettings(s, { plan: { am: 0.5, pm: 1 } }, TODAY),
    markExported: (s) => markExported(s, TODAY),
  };

  for (const [name, fn] of Object.entries(reducers)) {
    // A frozen input makes any in-place write throw; a pure reducer does not.
    const out = fn(base);
    assert.notEqual(out, base, `${name} returned its input`);
    assert.equal(snapshot(base), baseSnap, `${name} mutated its input`);
    assert.equal(Object.isFrozen(base.entries), true);
    // The output is a complete State on its own.
    assert.equal(out.schema, 1);
    assert.ok(Number.isInteger(out.nextSeq));
    assert.ok(Array.isArray(out.entries));
    assert.equal(typeof out.meta, "object");
    // Outputs are independent of the input's arrays and entry objects: a
    // later write on the output cannot leak back.
    if (name !== "markExported") assert.notEqual(out.entries, base.entries, `${name} shares the entries array`);
  }

  // Chaining reducers from one base yields independent branches.
  const a = logDose(base, { slot: "am", qty: 1, date: TODAY });
  const b = logDose(base, { slot: "pm", qty: 1, date: TODAY });
  assert.equal(a.entries.length, 3);
  assert.equal(b.entries.length, 3);
  assert.equal(a.entries.at(-1).seq, b.entries.at(-1).seq, "same base, same next seq");
  assert.equal(snapshot(base), baseSnap);
});

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------

test("STORAGE_KEY is ptracker-v2", () => {
  assert.equal(STORAGE_KEY, "ptracker-v2");
});

test("load returns null with no localStorage at all, on empty storage, and on garbage, without throwing", () => {
  // No storage in this environment (plain Node).
  assert.equal(typeof globalThis.localStorage, "undefined");
  assert.equal(load(), null);
  assert.doesNotThrow(() => save(firstRun()));

  // Empty storage: first run.
  withStorage(makeStorage(), (warnings) => {
    assert.equal(load(), null);
    assert.equal(warnings.length, 0, "an absent key is not a warning");
  });

  // Garbage of every kind: null, warn, never throw.
  const garbage = [
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
    // nextSeq not above the highest seq would let a seq be reused.
    JSON.stringify({ schema: 1, nextSeq: 1, entries: [{ id: "e1", seq: 1, type: "setup", date: TODAY, qty: 40 }] }),
    // Two doses in one slot.
    JSON.stringify({
      schema: 1,
      nextSeq: 4,
      entries: [
        { id: "e1", seq: 1, type: "setup", date: TODAY, qty: 40 },
        { id: "e2", seq: 2, type: "dose", date: TODAY, slot: "am", qty: 1 },
        { id: "e3", seq: 3, type: "dose", date: TODAY, slot: "am", qty: 1 },
      ],
    }),
    // The old app's shape, in case it were ever copied under the new key.
    JSON.stringify({ pillsPerDay: 0.5, count: 40, log: [] }),
  ];
  for (const raw of garbage) {
    const store = makeStorage();
    store.setItem(STORAGE_KEY, raw);
    withStorage(store, (warnings) => {
      let result;
      assert.doesNotThrow(() => {
        result = load();
      }, `load threw on ${raw}`);
      assert.equal(result, null, `load accepted ${raw}`);
      assert.equal(warnings.length, 1, `load did not warn once on ${raw}`);
    });
  }

  // A storage whose getItem throws (SecurityError) is treated as absent.
  const hostile = makeStorage();
  hostile.getItem = () => {
    throw new DOMExceptionLike("SecurityError");
  };
  withStorage(hostile, (warnings) => {
    assert.equal(load(), null);
    assert.equal(warnings.length, 1);
  });
});

test("load never reads pill-ledger-v1, even when it is the only key present", () => {
  const store = makeStorage();
  const reads = [];
  const realGet = store.getItem;
  store.getItem = (k) => {
    reads.push(k);
    return realGet(k);
  };
  // The old app's data, which would parse as JSON and must be ignored.
  store.setItem(
    "pill-ledger-v1",
    JSON.stringify({ schema: 1, nextSeq: 2, entries: [{ id: "e1", seq: 1, type: "setup", date: TODAY, qty: 999 }] }),
  );
  withStorage(store, () => {
    assert.equal(load(), null);
    assert.deepEqual(reads, [STORAGE_KEY]);
  });
});

test("save then load round-trips exactly, with meta defaults filled on the way in", () => {
  let s = firstRun({ count: 40, plan: { am: 0.5, pm: 1 } });
  s = logDose(s, { slot: "am", qty: 0.5, date: TODAY });
  s = recordFill(s, { qty: 60, date: addDays(TODAY, 1) });
  s = updateSettings(s, { prescribedPerDay: 2.5 }, addDays(TODAY, 2));
  s = markExported(s, TODAY);
  s = updateEntry(s, s.entries[0].id, { note: "first bottle" });

  const store = makeStorage();
  withStorage(store, (warnings) => {
    save(s);
    assert.equal(store.length, 1);
    assert.equal(store.key(0), STORAGE_KEY);
    const back = load();
    assert.deepEqual(back, s);
    assert.notEqual(back, s);
    assert.notEqual(back.entries, s.entries);
    assert.equal(warnings.length, 0);

    // The ledger sees the same world after the round trip.
    assert.deepEqual(summary(back.entries, TODAY), summary(s.entries, TODAY));

    // Saving again overwrites in place; nothing accumulates.
    save(logDose(back, { slot: "pm", qty: 1, date: TODAY }));
    assert.equal(store.length, 1);
    assert.equal(load().entries.length, s.entries.length + 1);
  });

  // A stored state missing meta (or with a partial meta) still loads with defaults.
  const bare = { schema: 1, nextSeq: 3, entries: firstRun().entries };
  const store2 = makeStorage();
  store2.setItem(STORAGE_KEY, JSON.stringify(bare));
  withStorage(store2, (warnings) => {
    const back = load();
    assert.deepEqual(back.meta, { lastExportAt: null, lowBalanceDays: 7 });
    assert.deepEqual(back.entries, bare.entries);
    assert.equal(warnings.length, 0);
  });
  const store3 = makeStorage();
  store3.setItem(STORAGE_KEY, JSON.stringify({ ...bare, meta: { lowBalanceDays: 3 } }));
  withStorage(store3, () => {
    assert.deepEqual(load().meta, { lastExportAt: null, lowBalanceDays: 3 });
  });
});

test("save survives a quota or security exception without throwing", () => {
  const s = firstRun();
  const store = makeStorage({ failOnSet: true });
  withStorage(store, (warnings) => {
    assert.doesNotThrow(() => save(s));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /save/);
    assert.equal(store.length, 0);
    // The state itself is unaffected by a failed save.
    assert.equal(load(), null);
  });

  // Access to localStorage itself throwing (some private modes) is absent, not fatal.
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMExceptionLike("SecurityError");
    },
  });
  try {
    assert.doesNotThrow(() => save(s));
    assert.equal(load(), null);
  } finally {
    if (prevDesc) Object.defineProperty(globalThis, "localStorage", prevDesc);
    else delete globalThis.localStorage;
  }
});
