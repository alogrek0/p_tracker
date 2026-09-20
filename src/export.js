/**
 * JSON backup and restore, plus the staleness nag.
 *
 * Validation MUST reuse `validateEntry` / `isValidQty` / `isValidDateKey` from
 * ./ledger.js. Do not write a second validator here: two validators drift, and a
 * lenient import is how a corrupted ledger gets in.
 *
 * CONTRACT FILE. Signatures and types are fixed. Implementations are not.
 *
 * @typedef {import("./state.js").State}    State
 * @typedef {import("./ledger.js").Entry}   Entry
 * @typedef {import("./ledger.js").DateKey} DateKey
 *
 * @typedef {Object} ImportResult
 * @property {boolean}  ok
 * @property {State}    [state]   Present only when ok.
 * @property {string[]} errors    Human readable. Empty when ok.
 *
 * @typedef {Object} Staleness
 * @property {boolean}     stale
 * @property {number|null} daysSince  null when never exported.
 */

import { validateEntry, isValidDateKey, daysBetween } from "./ledger.js";

/** Days without an export before the nag appears. */
export const STALE_AFTER_DAYS = 21;

const SCHEMA = 1;
const DEFAULT_LOW_BALANCE_DAYS = 7;

/**
 * Key order for the exported document. Fixed, so two exports of equal state are
 * byte identical and a diff between two backups reads in the same order every
 * time. Anything an entry carries that is not listed here is emitted after
 * these, sorted, rather than dropped: a backup that silently loses a field is
 * worse than one that is a little verbose.
 */
const ENTRY_KEY_ORDER = ["id", "seq", "type", "date", "slot", "qty", "pills", "prescribedPerDay", "plan", "note"];
const PLAN_KEY_ORDER = ["am", "pm"];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Add one own key. Never a plain assignment: a key of `__proto__` would run the
 * prototype setter instead of creating a property, which would both silently
 * drop that field and leave the copy with a rewritten prototype.
 * @param {any} obj @param {string} key @param {unknown} value
 */
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Recursively key sorted, for values whose shape we do not know. @param {unknown} v */
function canonicalUnknown(v) {
  if (Array.isArray(v)) return v.map(canonicalUnknown);
  if (typeof v !== "object" || v === null) return v;
  /** @type {any} */
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (v[k] !== undefined) put(out, k, canonicalUnknown(v[k]));
  }
  return out;
}

/**
 * Known keys first, in the given order, then everything else sorted. Absent and
 * undefined fields are skipped, so an entry never gains a field it did not have.
 * @param {any} obj @param {string[]} order @returns {any}
 */
function canonicalObject(obj, order) {
  /** @type {any} */
  const out = {};
  for (const k of order) {
    if (obj[k] === undefined) continue;
    const nested = k === "plan" && typeof obj[k] === "object" && obj[k] !== null && !Array.isArray(obj[k]);
    put(out, k, nested ? canonicalObject(obj[k], PLAN_KEY_ORDER) : canonicalUnknown(obj[k]));
  }
  for (const k of Object.keys(obj).sort()) {
    if (order.includes(k) || obj[k] === undefined) continue;
    put(out, k, canonicalUnknown(obj[k]));
  }
  return out;
}

/** @param {any} e @returns {any} */
function canonicalEntry(e) {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return canonicalUnknown(e);
  return canonicalObject(e, ENTRY_KEY_ORDER);
}

/**
 * The document shape. Entry ORDER is preserved exactly: the log is a sequence,
 * and reordering it would make the backup differ from what was saved.
 * @param {any} state @returns {any}
 */
function canonicalState(state) {
  const meta = typeof state.meta === "object" && state.meta !== null ? state.meta : {};
  const entries = Array.isArray(state.entries) ? state.entries : [];
  return {
    schema: state.schema !== undefined ? state.schema : SCHEMA,
    nextSeq: state.nextSeq,
    meta: {
      lastExportAt: meta.lastExportAt !== undefined ? meta.lastExportAt : null,
      lowBalanceDays: meta.lowBalanceDays !== undefined ? meta.lowBalanceDays : DEFAULT_LOW_BALANCE_DAYS,
    },
    entries: entries.map(canonicalEntry),
  };
}

/**
 * Pretty printed, stable key order, one trailing newline.
 *
 * No timestamp, no device name, no wrapper: every byte in the file comes from
 * the state, so two exports of equal state are byte identical and a diff
 * between two backups shows only what actually changed in the ledger.
 * @param {State} state @returns {string}
 */
export function exportJSON(state) {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("exportJSON: state must be an object");
  }
  return `${JSON.stringify(canonicalState(state), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** @param {string[]} errors @returns {ImportResult} */
function fail(errors) {
  return { ok: false, errors };
}

/** A short phrase naming what something is. @param {unknown} v @returns {string} */
function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

/**
 * The previous version of this app kept a completely different shape under the
 * localStorage key `pill-ledger-v1`: meds and slots arrays, not a flat entry
 * log. Nothing in it can become an entry log without inventing dates, so it is
 * refused by name rather than half accepted.
 * @param {any} o @returns {boolean}
 */
function looksLikePreviousVersion(o) {
  if (o.schema === SCHEMA && Array.isArray(o.entries)) return false;
  return (
    Array.isArray(o.meds) ||
    Array.isArray(o.slots) ||
    Array.isArray(o.medications) ||
    Array.isArray(o.log) ||
    typeof o.pillsPerDay === "number" ||
    o["pill-ledger-v1"] !== undefined ||
    o.version === "pill-ledger-v1"
  );
}

/** How an entry names itself in an error. @param {any} e @param {number} i @returns {string} */
function entryLabel(e, i) {
  const id = e !== null && typeof e === "object" && typeof e.id === "string" ? ` (id ${e.id})` : "";
  return `entry ${i + 1}${id}`;
}

/**
 * Never throws, for any input at all.
 *
 * Every entry goes through ledger's `validateEntry`, so the rules for a single
 * entry live in exactly one place. What is added here is only what spans
 * entries: unique ids, unique seqs, one dose per (date, slot), at most one
 * setup, and a nextSeq above every seq present. Those are the same cross entry
 * rules src/state.js enforces on load and on every write.
 *
 * @param {string} text @returns {ImportResult}
 */
export function importJSON(text) {
  try {
    if (typeof text !== "string") {
      return fail([`the backup must be text, but this is ${describe(text)}`]);
    }
    if (text.trim() === "") {
      return fail(["the backup file is empty"]);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const why = err && err.message ? err.message : String(err);
      return fail([`this file is not valid JSON, so it may be truncated or only partly copied (${why})`]);
    }

    if (parsed === null) return fail(["the backup contains null rather than a saved ledger"]);
    if (Array.isArray(parsed)) return fail(["the backup is a JSON array, not a saved ledger"]);
    if (typeof parsed !== "object") {
      return fail([`the backup is a JSON ${typeof parsed}, not a saved ledger`]);
    }

    if (looksLikePreviousVersion(parsed)) {
      return fail([
        "this backup is from the previous version of the app, the pill-ledger-v1 format that stored meds and slots arrays instead of a single entry log. It cannot be imported.",
      ]);
    }

    /** @type {string[]} */
    const errors = [];

    if (parsed.schema === undefined) {
      errors.push("this file has no schema field, so it does not look like a p_tracker backup");
    } else if (parsed.schema !== SCHEMA) {
      errors.push(`this backup says schema ${JSON.stringify(parsed.schema)}, but this app reads schema ${SCHEMA}`);
    }

    const nextSeqOk = Number.isInteger(parsed.nextSeq) && parsed.nextSeq >= 0;
    if (!nextSeqOk) {
      errors.push(`nextSeq must be a whole number of 0 or more (got ${JSON.stringify(parsed.nextSeq)})`);
    }

    if (!Array.isArray(parsed.entries)) {
      errors.push(`entries must be an array of ledger entries (got ${describe(parsed.entries)})`);
      return fail(errors);
    }

    const ids = new Set();
    const seqs = new Set();
    const doseSlots = new Set();
    let setupCount = 0;
    let openingCount = 0;
    let maxSeq = -1;

    parsed.entries.forEach((e, i) => {
      // ONE entry validator, ledger's. Nothing about a single entry is decided here.
      const problems = validateEntry(e);
      if (problems.length > 0) {
        errors.push(`${entryLabel(e, i)}: ${problems.join("; ")}`);
        return;
      }
      if (ids.has(e.id)) {
        errors.push(`${entryLabel(e, i)}: id ${e.id} is already used by an earlier entry; ids must be unique`);
      }
      ids.add(e.id);
      if (seqs.has(e.seq)) {
        errors.push(`${entryLabel(e, i)}: seq ${e.seq} is already used by an earlier entry; seqs must be unique`);
      }
      seqs.add(e.seq);
      if (e.seq > maxSeq) maxSeq = e.seq;
      if (e.type === "setup") setupCount += 1;
      if (e.type === "opening") openingCount += 1;
      if (e.type === "dose") {
        const key = `${e.date}/${e.slot}`;
        if (doseSlots.has(key)) {
          errors.push(`${entryLabel(e, i)}: a second ${e.slot} dose is logged for ${e.date}; one dose per slot per day`);
        }
        doseSlots.add(key);
      }
    });

    if (openingCount > 1) {
      errors.push(`this backup has ${openingCount} opening entries; a ledger has at most one`);
    }
    if (setupCount > 1) {
      errors.push(`this backup has ${setupCount} setup entries; a ledger has at most one`);
    }
    if (nextSeqOk && parsed.nextSeq <= maxSeq) {
      errors.push(
        `nextSeq ${parsed.nextSeq} is not above the highest seq ${maxSeq}, so importing it would hand out a seq that is already in use`,
      );
    }

    if (parsed.meta !== undefined) {
      if (typeof parsed.meta !== "object" || parsed.meta === null || Array.isArray(parsed.meta)) {
        errors.push(`meta must be an object when present (got ${describe(parsed.meta)})`);
      } else {
        const m = parsed.meta;
        if (m.lastExportAt !== undefined && m.lastExportAt !== null && !isValidDateKey(m.lastExportAt)) {
          errors.push(
            `meta.lastExportAt must be null or a date in YYYY-MM-DD form (got ${JSON.stringify(m.lastExportAt)})`,
          );
        }
        if (m.lowBalanceDays !== undefined && !(Number.isInteger(m.lowBalanceDays) && m.lowBalanceDays >= 0)) {
          errors.push(`meta.lowBalanceDays must be a whole number of 0 or more (got ${JSON.stringify(m.lowBalanceDays)})`);
        }
      }
    }

    if (errors.length > 0) return fail(errors);

    const meta = parsed.meta ?? {};
    return {
      ok: true,
      state: /** @type {State} */ ({
        schema: SCHEMA,
        nextSeq: parsed.nextSeq,
        meta: {
          lastExportAt: meta.lastExportAt ?? null,
          lowBalanceDays: meta.lowBalanceDays ?? DEFAULT_LOW_BALANCE_DAYS,
        },
        // Rebuilt field by field, so the returned state shares no object with
        // the parsed input and carries no foreign top level key.
        entries: parsed.entries.map(canonicalEntry),
      }),
      errors: [],
    };
  } catch (err) {
    // Unreachable by design. If it is ever reached, refusing is still the right
    // answer: this function must never throw into the import button.
    const why = err && err.message ? err.message : String(err);
    return fail([`the backup could not be read: ${why}`]);
  }
}

// ---------------------------------------------------------------------------
// The staleness nag
// ---------------------------------------------------------------------------

/**
 * How long since the last export, in whole calendar days.
 *
 * Counted with ledger's `daysBetween`, which steps the calendar with setDate.
 * Never by dividing milliseconds: a spring forward day is 23 hours long, so
 * millisecond arithmetic reports 20 days for a 21 day gap and the nag arrives a
 * day late.
 *
 * Never exported counts as stale: the whole point of the nag is that this one
 * phone's localStorage is the only copy that exists.
 * @param {State} state @param {DateKey} today @returns {Staleness}
 */
export function exportStaleness(state, today) {
  const last = state !== null && typeof state === "object" && state.meta !== null && typeof state.meta === "object"
    ? state.meta.lastExportAt
    : null;
  // An unreadable or absent date is treated as never exported, which nags.
  // Erring towards nagging is the safe direction: the cost is one banner.
  if (!isValidDateKey(last) || !isValidDateKey(today)) {
    return { stale: true, daysSince: null };
  }
  const daysSince = daysBetween(last, today);
  return { stale: daysSince >= STALE_AFTER_DAYS, daysSince };
}
