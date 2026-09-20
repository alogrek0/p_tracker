/**
 * Persistence and entry CRUD.
 *
 * THE FIREWALL LIVES HERE. See CLAUDE.md invariant 1. `logDose` appends a dose
 * entry and touches nothing else. It must not write a `settings` entry, must not
 * alter `meta`, and must not change any value that feeds a projection. The
 * previous version of this app died precisely here.
 *
 * All reducers are pure: they take a State and return a NEW State. Only `load`
 * and `save` touch localStorage, which keeps every reducer testable under Node
 * with no DOM.
 *
 * CONTRACT FILE. Signatures and types are fixed. Implementations are not.
 *
 * @typedef {import("./ledger.js").Entry}   Entry
 * @typedef {import("./ledger.js").Plan}    Plan
 * @typedef {import("./ledger.js").Slot}    Slot
 * @typedef {import("./ledger.js").DateKey} DateKey
 *
 * @typedef {Object} Meta
 * @property {DateKey|null} lastExportAt    NOT part of the event log. No effect on math.
 * @property {number}       lowBalanceDays  UI banner threshold. Default 7.
 *
 * @typedef {Object} State
 * @property {1}       schema
 * @property {number}  nextSeq  Next seq to assign. Only ever increases.
 * @property {Meta}    meta
 * @property {Entry[]} entries
 */

import { validateEntry, isValidDateKey } from "./ledger.js";

/** @type {string} Invariant 3: this never changes, and `pill-ledger-v1` is never read. */
export const STORAGE_KEY = "ptracker-v2";

const SCHEMA = 1;
const DEFAULT_LOW_BALANCE_DAYS = 7;

// ---------------------------------------------------------------------------
// I/O. The only two functions in this file that touch the browser.
// ---------------------------------------------------------------------------

/**
 * The storage backend, or null when there is none (Node, or a browser that
 * throws on access, which Safari does in some private modes).
 * @returns {Storage|null}
 */
function storage() {
  try {
    if (typeof localStorage === "undefined" || localStorage === null) return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** @returns {State|null} null when nothing is stored yet (first run). */
export function load() {
  const store = storage();
  if (!store) return null;

  let raw;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn("ptracker: could not read storage, starting fresh", err);
    return null;
  }
  if (raw === null || raw === undefined) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("ptracker: stored data is not valid JSON, treating as absent", err);
    return null;
  }

  const problems = validateState(parsed);
  if (problems.length > 0) {
    console.warn(`ptracker: stored data does not match schema ${SCHEMA}, treating as absent:\n  ${problems.join("\n  ")}`);
    return null;
  }
  return normalizeState(parsed);
}

/** @param {State} state @returns {void} */
export function save(state) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // QuotaExceededError, SecurityError, or a storage that is read-only. The
    // in-memory state is still correct; only persistence has failed.
    console.warn("ptracker: could not save state", err);
  }
}

// ---------------------------------------------------------------------------
// Shape validation. Used by `load` and available for the same reason
// `validateEntry` is: foreign or damaged data must never crash the app.
// ---------------------------------------------------------------------------

/** @param {unknown} s @returns {string[]} Empty array means valid. */
function validateState(s) {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return ["state must be an object"];
  const st = /** @type {any} */ (s);
  /** @type {string[]} */
  const problems = [];

  if (st.schema !== SCHEMA) problems.push(`schema must be ${SCHEMA} (got ${JSON.stringify(st.schema)})`);
  if (!Number.isInteger(st.nextSeq) || st.nextSeq < 0) problems.push("nextSeq must be a non-negative integer");
  if (!Array.isArray(st.entries)) {
    problems.push("entries must be an array");
    return problems;
  }

  const ids = new Set();
  const seqs = new Set();
  const doseSlots = new Set();
  let setupCount = 0;
  let maxSeq = -1;
  st.entries.forEach((e, i) => {
    const p = validateEntry(e);
    if (p.length > 0) {
      problems.push(`entries[${i}]: ${p.join("; ")}`);
      return;
    }
    if (ids.has(e.id)) problems.push(`entries[${i}]: duplicate id ${e.id}`);
    ids.add(e.id);
    if (seqs.has(e.seq)) problems.push(`entries[${i}]: duplicate seq ${e.seq}`);
    seqs.add(e.seq);
    if (e.seq > maxSeq) maxSeq = e.seq;
    if (e.type === "setup") setupCount += 1;
    if (e.type === "dose") {
      const key = doseKey(e.date, e.slot);
      if (doseSlots.has(key)) problems.push(`entries[${i}]: second dose for ${key}`);
      doseSlots.add(key);
    }
  });
  if (setupCount > 1) problems.push("more than one setup entry");
  if (Number.isInteger(st.nextSeq) && st.nextSeq <= maxSeq) {
    problems.push(`nextSeq ${st.nextSeq} is not above the highest seq ${maxSeq}`);
  }

  if (st.meta !== undefined) {
    if (typeof st.meta !== "object" || st.meta === null || Array.isArray(st.meta)) {
      problems.push("meta must be an object when present");
    } else {
      const m = st.meta;
      if (m.lastExportAt !== undefined && m.lastExportAt !== null && !isValidDateKey(m.lastExportAt)) {
        problems.push("meta.lastExportAt must be null or a date key");
      }
      if (m.lowBalanceDays !== undefined && !(Number.isInteger(m.lowBalanceDays) && m.lowBalanceDays >= 0)) {
        problems.push("meta.lowBalanceDays must be a non-negative integer");
      }
    }
  }
  return problems;
}

/**
 * Rebuild a validated state from its own fields, so nothing foreign rides
 * along and missing meta fields get their defaults.
 * @param {any} st @returns {State}
 */
function normalizeState(st) {
  const meta = st.meta ?? {};
  return {
    schema: SCHEMA,
    nextSeq: st.nextSeq,
    meta: {
      lastExportAt: meta.lastExportAt ?? null,
      lowBalanceDays: meta.lowBalanceDays ?? DEFAULT_LOW_BALANCE_DAYS,
    },
    entries: st.entries.map(copyEntry),
  };
}

/** Shallow copy with the plan copied too, so no reference is shared. @param {Entry} e @returns {Entry} */
function copyEntry(e) {
  const out = { ...e };
  if (e.plan !== undefined && e.plan !== null && typeof e.plan === "object") {
    out.plan = { am: e.plan.am, pm: e.plan.pm };
  }
  return out;
}

/** @param {DateKey} date @param {Slot} slot */
function doseKey(date, slot) {
  return `${date}/${slot}`;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * First run. Writes a `setup` entry carrying the bottle count and a `settings`
 * entry carrying the starting plan and prescribed rate, both dated `today`.
 * @param {{count:number, plan:Plan, prescribedPerDay:number, today:DateKey}} opts
 * @returns {State}
 */
export function createState(opts) {
  if (typeof opts !== "object" || opts === null) throw new Error("createState: opts required");
  const { count, plan, prescribedPerDay, today } = opts;
  /** @type {State} */
  const empty = {
    schema: SCHEMA,
    nextSeq: 1,
    meta: { lastExportAt: null, lowBalanceDays: DEFAULT_LOW_BALANCE_DAYS },
    entries: [],
  };
  // addEntry validates each piece: count, date, plan shape and rate.
  const withSetup = addEntry(empty, { type: "setup", date: today, qty: count });
  return addEntry(withSetup, { type: "settings", date: today, prescribedPerDay, plan });
}

// ---------------------------------------------------------------------------
// Generic CRUD. Assigns id and seq. Enforces the invariants in CLAUDE.md.
// ---------------------------------------------------------------------------

/**
 * Invariants that span entries: one dose per (date, slot), one setup entry.
 * @param {Entry[]} others Every entry except the one being checked.
 * @param {Entry} entry
 */
function assertFitsLog(others, entry) {
  if (entry.type === "dose") {
    const clash = others.find((e) => e.type === "dose" && e.date === entry.date && e.slot === entry.slot);
    if (clash) {
      throw new Error(`a ${entry.slot} dose is already logged for ${entry.date} (entry ${clash.id}); edit or delete it instead`);
    }
  }
  if (entry.type === "setup" && others.some((e) => e.type === "setup")) {
    throw new Error("there is already a setup entry; use a recount to correct the count");
  }
}

/**
 * @param {State} state
 * @param {Omit<Entry,"id"|"seq">} partial
 * @returns {State}
 * @throws if the entry is invalid, or would create a second dose for one (date, slot)
 */
export function addEntry(state, partial) {
  if (typeof partial !== "object" || partial === null) throw new Error("addEntry: entry must be an object");
  const seq = state.nextSeq;
  /** @type {Entry} */
  const entry = copyEntry(/** @type {Entry} */ ({ ...partial, id: `e${seq}`, seq }));
  const problems = validateEntry(entry);
  if (problems.length > 0) throw new Error(`invalid entry: ${problems.join("; ")}`);
  assertFitsLog(state.entries, entry);
  return {
    ...state,
    nextSeq: seq + 1,
    entries: [...state.entries, entry],
  };
}

/** @param {State} state @param {string} id @param {Partial<Entry>} patch @returns {State} */
export function updateEntry(state, id, patch) {
  if (typeof patch !== "object" || patch === null) throw new Error("updateEntry: patch must be an object");
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`no entry with id ${id}`);
  const existing = state.entries[idx];
  if (patch.id !== undefined && patch.id !== existing.id) throw new Error("an entry's id cannot change");
  if (patch.seq !== undefined && patch.seq !== existing.seq) throw new Error("an entry's seq cannot change");
  if (existing.type === "setup" && patch.type !== undefined && patch.type !== "setup") {
    throw new Error("the setup entry cannot change type");
  }
  const merged = copyEntry(/** @type {Entry} */ ({ ...existing, ...patch, id: existing.id, seq: existing.seq }));
  // A field patched to undefined is a removal; drop it so validation sees absence.
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  const problems = validateEntry(merged);
  if (problems.length > 0) throw new Error(`invalid entry: ${problems.join("; ")}`);
  const others = state.entries.filter((_, i) => i !== idx);
  assertFitsLog(others, merged);
  const entries = state.entries.slice();
  entries[idx] = merged;
  return { ...state, entries };
}

/** @param {State} state @param {string} id @returns {State} @throws on the setup entry */
export function deleteEntry(state, id) {
  const existing = state.entries.find((e) => e.id === id);
  if (!existing) throw new Error(`no entry with id ${id}`);
  if (existing.type === "setup") throw new Error("the setup entry cannot be deleted; use a recount to correct the count");
  // nextSeq is untouched: a deleted seq is never handed out again.
  return { ...state, entries: state.entries.filter((e) => e.id !== id) };
}

// ---------------------------------------------------------------------------
// Intent-named actions. These are what the UI calls.
// ---------------------------------------------------------------------------

/**
 * THE FIREWALL. Appends a dose entry. qty 0 records a deliberate skip.
 * Writes nothing else, ever.
 * @param {State} state @param {{slot:Slot, qty:number, date:DateKey}} arg @returns {State}
 */
export function logDose(state, arg) {
  if (typeof arg !== "object" || arg === null) throw new Error("logDose: arg required");
  // One dose entry. No settings entry, no meta change, no plan derivation.
  return addEntry(state, { type: "dose", date: arg.date, slot: arg.slot, qty: arg.qty });
}

/** @param {State} state @param {{qty:number, date:DateKey}} arg @returns {State} */
export function recordFill(state, arg) {
  if (typeof arg !== "object" || arg === null) throw new Error("recordFill: arg required");
  return addEntry(state, { type: "fill", date: arg.date, qty: arg.qty });
}

/** @param {State} state @param {{qty:number, date:DateKey}} arg @returns {State} */
export function recordRecount(state, arg) {
  if (typeof arg !== "object" || arg === null) throw new Error("recordRecount: arg required");
  return addEntry(state, { type: "recount", date: arg.date, qty: arg.qty });
}

/**
 * The ONLY way the plan or prescribed rate changes. Appends a dated `settings`
 * entry so past days keep the values that were in force then.
 * @param {State} state
 * @param {{prescribedPerDay?:number, plan?:Plan}} patch
 * @param {DateKey} date
 * @returns {State}
 */
export function updateSettings(state, patch, date) {
  if (typeof patch !== "object" || patch === null) throw new Error("updateSettings: patch required");
  /** @type {any} */
  const partial = { type: "settings", date };
  if (patch.prescribedPerDay !== undefined) partial.prescribedPerDay = patch.prescribedPerDay;
  if (patch.plan !== undefined) partial.plan = patch.plan;
  // validateEntry rejects an entry carrying neither field.
  return addEntry(state, partial);
}

/** Records a successful export. Touches meta only. @param {State} state @param {DateKey} date @returns {State} */
export function markExported(state, date) {
  if (!isValidDateKey(date)) throw new Error(`markExported: invalid date key ${String(date)}`);
  return { ...state, meta: { ...state.meta, lastExportAt: date } };
}

/**
 * The low-balance banner threshold, in days. Lives in meta rather than in a
 * `settings` entry because it is a display preference and has no effect on any
 * ledger computation. Keeping it out of the event log means changing it can
 * never alter a past day's surplus.
 * @param {State} state @param {number} days @returns {State}
 */
export function setLowBalanceDays(state, days) {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`setLowBalanceDays: expected a non-negative integer, got ${String(days)}`);
  }
  return { ...state, meta: { ...state.meta, lowBalanceDays: days } };
}
