/**
 * PURE MATH. No DOM, no localStorage, no implicit clock.
 * Every function that depends on "now" takes `today` as an explicit argument.
 *
 * CONTRACT FILE. Signatures and types are fixed. Implementations are not.
 *
 * THE ONE-SERIES INVARIANT
 *
 *   Every pill that leaves the bottle is counted exactly once, on exactly one
 *   day, by both balance and surplus. balance and surplus are two readings of
 *   ONE depletion series, never two independently computed series.
 *
 * Concretely: a single forward walk over the calendar (see `walk`) produces,
 * for each day, the depletion that day charged to the running balance. That
 * per-day record is what `depletionForDay` returns and what `surplus` sums,
 * and the running balance it leaves behind is what `balance` returns. There is
 * no second computation of depletion anywhere in this file. If the two ever
 * diverge, the double-count bug is back.
 *
 * The rules the walk applies, in order, for each calendar day D up to today:
 *   1. Process D's entries in seq order. setup and recount reset the running
 *      balance; fill adds; dose subtracts. A recount's derived gap is
 *      max(0, running balance just before it - counted qty), and that running
 *      balance already includes every earlier completed day's estimates.
 *   2. If D is completed (D < today) and D holds no setup, each slot without a
 *      logged dose is assumed to have followed the effective plan: that
 *      estimate is subtracted from the running balance at the END of D, after
 *      every entry dated D including any recount, and reported as an
 *      estimated slot.
 *   3. The setup day never estimates its unlogged slots. Setup is the seed:
 *      the count IS the bottle at that moment, and the setup day sits outside
 *      the accrual window anyway, so estimating on it cannot help surplus and
 *      can only corrupt the seed balance. Counting 40 at 23:00 and then
 *      inferring 2 pills gone after that count is simply wrong with no
 *      compensating benefit.
 *      A recount day is NOT exempt. Entries carry no time of day, so a
 *      recount cannot say whether the day's unlogged doses came before or
 *      after the count. Exempting it would trade a surplus error for a
 *      balance error, and that is the wrong trade: surplus is the product. An
 *      exempt recount day with both doses taken but unlogged would charge 0,
 *      hand surplus a phantom +plannedPerDay, and report 0 estimated slots, so
 *      nothing would disclose it. That silent inflation is the failure mode
 *      this rebuild exists to eliminate. Estimating instead keeps surplus
 *      right in both orderings and discloses the guess. If the count came
 *      after the doses the balance reads low, but a balance error self-heals
 *      at the very next recount, because a count that reads higher than the
 *      running value resets it with a gap of 0. An unflagged phantom surplus
 *      never heals.
 *   4. Today is never completed, so today never estimates and never accrues.
 *
 * @typedef {"setup"|"dose"|"fill"|"recount"|"settings"} EntryType
 * @typedef {"am"|"pm"} Slot
 * @typedef {string} DateKey  Local calendar day, "YYYY-MM-DD". Never parsed as UTC.
 *
 * @typedef {Object} Plan
 * @property {number} am
 * @property {number} pm
 *
 * @typedef {Object} Entry
 * @property {string}   id
 * @property {number}   seq    Monotonic. Orders events within one date. Never reused.
 * @property {EntryType} type
 * @property {DateKey}  date
 * @property {Slot}     [slot] dose only
 * @property {number}   [qty]  setup | dose | fill | recount. Multiple of 0.5, >= 0.
 *                             On a dose, 0 means a deliberate skip.
 * @property {number}   [prescribedPerDay] settings only
 * @property {Plan}     [plan]             settings only
 * @property {string}   [note]
 *
 * @typedef {Object} Effective
 * @property {number} prescribedPerDay
 * @property {Plan}   plan
 *
 * @typedef {Object} DayDepletion
 * @property {number} total          Pills that left the bottle on this day.
 * @property {number} estimatedSlots How many of the two slots were assumed, not logged.
 *
 * @typedef {Object} Surplus
 * @property {number} pills          Cumulative pills banked vs the prescribed baseline.
 * @property {number} estimatedDays  Days contributing at least one estimated slot.
 * @property {number} estimatedSlots Total assumed slots across the accrual window.
 *
 * @typedef {Object} Projection
 * @property {number}  plannedPerDay   From the PLAN. Never from recent doses.
 * @property {number}  remainingToday  Planned amount for today's not-yet-logged slots.
 * @property {DateKey|null} runOutDate null only when plannedPerDay is 0 and the
 *                                     bottle is not already empty: on the plan it
 *                                     never runs out. daysLeft is then Infinity.
 * @property {number}  daysLeft
 *
 * @typedef {Object} Summary
 * @property {number}     balance
 * @property {Surplus}    surplus
 * @property {Projection} projection
 * @property {Effective}  effective
 */

const ENTRY_TYPES = new Set(["setup", "dose", "fill", "recount", "settings"]);
const SLOTS = /** @type {Slot[]} */ (["am", "pm"]);

/**
 * Values in force before any `settings` entry has been written. First run
 * always writes a `settings` entry on the setup date, so these only matter
 * for a log that predates it or has had that entry removed.
 */
const DEFAULT_PRESCRIBED_PER_DAY = 2;
const DEFAULT_PLAN = Object.freeze({ am: 1, pm: 1 });

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Dates. Local time only. See CLAUDE.md invariant 6.
// ---------------------------------------------------------------------------

/** @param {number} n @param {number} width */
function pad(n, width) {
  return String(n).padStart(width, "0");
}

/** @param {Date} d @returns {DateKey} */
export function localDateKey(d) {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/** Parse a DateKey into a LOCAL midnight Date. @param {DateKey} key @returns {Date} */
export function parseLocalDate(key) {
  if (!isValidDateKey(key)) throw new Error(`invalid date key: ${String(key)}`);
  const m = DATE_KEY_RE.exec(key);
  // Built from parts: local midnight, never the UTC parse of `new Date(string)`.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Years 0..99 would be remapped to 1900..1999 by the Date constructor.
  d.setFullYear(Number(m[1]));
  return d;
}

/** Calendar-step a DateKey. DST safe. @param {DateKey} key @param {number} n @returns {DateKey} */
export function addDays(key, n) {
  if (!Number.isInteger(n)) throw new Error(`addDays: n must be an integer, got ${String(n)}`);
  const d = parseLocalDate(key);
  d.setDate(d.getDate() + n);
  return localDateKey(d);
}

/** Whole calendar days from a to b. DST safe. @param {DateKey} a @param {DateKey} b @returns {number} */
export function daysBetween(a, b) {
  if (!isValidDateKey(a)) throw new Error(`invalid date key: ${String(a)}`);
  if (!isValidDateKey(b)) throw new Error(`invalid date key: ${String(b)}`);
  if (a === b) return 0;
  // Walk the calendar one day at a time with setDate. Never divide
  // milliseconds: a spring-forward day is 23 hours long and would undercount.
  const forward = a < b;
  const from = forward ? a : b;
  const to = forward ? b : a;
  const cur = parseLocalDate(from);
  let n = 0;
  while (localDateKey(cur) !== to) {
    cur.setDate(cur.getDate() + 1);
    n += 1;
  }
  return forward ? n : -n;
}

// ---------------------------------------------------------------------------
// Validation. src/export.js MUST reuse these rather than writing its own.
// ---------------------------------------------------------------------------

/** Non-negative multiple of 0.5. @param {unknown} n @returns {boolean} */
export function isValidQty(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && Number.isInteger(n * 2);
}

/** @param {unknown} key @returns {boolean} */
export function isValidDateKey(key) {
  if (typeof key !== "string") return false;
  const m = DATE_KEY_RE.exec(key);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  return true;
}

/** @param {number} y @param {number} mo 1..12 */
function daysInMonth(y, mo) {
  if (mo === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(mo) ? 30 : 31;
}

/** @param {unknown} p @returns {p is Plan} */
function isValidPlan(p) {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const o = /** @type {any} */ (p);
  if (!isValidQty(o.am) || !isValidQty(o.pm)) return false;
  // There are exactly two slots, so any further key is invalid data rather
  // than data worth preserving. Rejecting it here keeps import and load from
  // disagreeing: import used to keep an unknown key that load then dropped on
  // the next launch, losing it silently.
  return Object.keys(o).every((k) => k === "am" || k === "pm");
}

/** @param {unknown} entry @returns {string[]} Empty array means valid. */
export function validateEntry(entry) {
  /** @type {string[]} */
  const problems = [];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return ["entry must be an object"];
  }
  const e = /** @type {any} */ (entry);

  if (typeof e.id !== "string" || e.id.length === 0) {
    problems.push("id must be a non-empty string");
  }
  if (!Number.isInteger(e.seq) || e.seq < 0) {
    problems.push("seq must be a non-negative integer");
  }
  if (!ENTRY_TYPES.has(e.type)) {
    problems.push(`type must be one of setup, dose, fill, recount, settings (got ${JSON.stringify(e.type)})`);
  }
  if (!isValidDateKey(e.date)) {
    problems.push(`date must be a real calendar date in YYYY-MM-DD form (got ${JSON.stringify(e.date)})`);
  }
  if (e.note !== undefined && typeof e.note !== "string") {
    problems.push("note must be a string when present");
  }

  const qtyProblem = `qty must be a non-negative multiple of 0.5 (got ${JSON.stringify(e.qty)})`;

  switch (e.type) {
    case "setup":
    case "fill":
    case "recount":
      if (!isValidQty(e.qty)) problems.push(qtyProblem);
      if (e.slot !== undefined) problems.push(`slot is only allowed on dose entries`);
      break;
    case "dose":
      if (e.slot !== "am" && e.slot !== "pm") {
        problems.push(`dose slot must be "am" or "pm" (got ${JSON.stringify(e.slot)})`);
      }
      if (!isValidQty(e.qty)) problems.push(qtyProblem);
      break;
    case "settings": {
      const hasRate = e.prescribedPerDay !== undefined;
      const hasPlan = e.plan !== undefined;
      if (!hasRate && !hasPlan) {
        problems.push("settings entry must carry prescribedPerDay, plan, or both");
      }
      if (hasRate && !isValidQty(e.prescribedPerDay)) {
        problems.push(`prescribedPerDay must be a non-negative multiple of 0.5 (got ${JSON.stringify(e.prescribedPerDay)})`);
      }
      if (hasPlan && !isValidPlan(e.plan)) {
        problems.push("plan must be an object with am and pm, each a non-negative multiple of 0.5");
      }
      if (e.slot !== undefined) problems.push(`slot is only allowed on dose entries`);
      if (e.qty !== undefined) problems.push(`qty is not allowed on settings entries`);
      break;
    }
    default:
      break;
  }

  if (e.type !== "settings") {
    if (e.prescribedPerDay !== undefined) problems.push("prescribedPerDay is only allowed on settings entries");
    if (e.plan !== undefined) problems.push("plan is only allowed on settings entries");
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Ordering and effective settings
// ---------------------------------------------------------------------------

/** Stable sort by (date, seq). Does not mutate. @param {Entry[]} entries @returns {Entry[]} */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return a.seq - b.seq;
  });
}

/** @returns {Effective} */
function defaultEffective() {
  return { prescribedPerDay: DEFAULT_PRESCRIBED_PER_DAY, plan: { am: DEFAULT_PLAN.am, pm: DEFAULT_PLAN.pm } };
}

/**
 * Layer one settings entry onto the values in force. Each entry may carry only
 * one of the two fields, so the plan in force comes from the latest entry that
 * set a plan and the rate from the latest entry that set a rate.
 * @param {Effective} eff @param {Entry} e @returns {Effective}
 */
function applySettings(eff, e) {
  return {
    prescribedPerDay: e.prescribedPerDay !== undefined ? e.prescribedPerDay : eff.prescribedPerDay,
    plan: e.plan !== undefined ? { am: e.plan.am, pm: e.plan.pm } : eff.plan,
  };
}

/**
 * Settings in force on a given day, from the latest `settings` entry at or before it.
 * Falls back to the built-in defaults.
 * @param {Entry[]} entries @param {DateKey} date @returns {Effective}
 */
export function effectiveAt(entries, date) {
  return effectiveFromSorted(sortEntries(entries), date);
}

/** @param {Entry[]} sorted @param {DateKey} date @returns {Effective} */
function effectiveFromSorted(sorted, date) {
  let eff = defaultEffective();
  for (const e of sorted) {
    if (e.date > date) break;
    if (e.type === "settings") eff = applySettings(eff, e);
  }
  return eff;
}

// ---------------------------------------------------------------------------
// The single depletion series
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Walk
 * @property {number} balance                 Running balance at the end of `today`.
 * @property {Map<string, number>} gaps       Derived gap per recount id.
 * @property {Map<DateKey, DayDepletion>} days What each day charged to the balance.
 */

/**
 * One forward pass over the calendar from the first entry's day up to and
 * including `today`, applying the rules in the file header. Every other
 * function in this section is a reading of this walk's output.
 *
 * Entries dated after `today` are never visited: they stay in the log but
 * touch neither balance nor gaps nor any day's depletion.
 *
 * @param {Entry[]} sorted @param {DateKey} today @returns {Walk}
 */
function walk(sorted, today) {
  /** @type {Walk} */
  const out = { balance: 0, gaps: new Map(), days: new Map() };
  if (sorted.length === 0 || sorted[0].date > today) return out;

  let bal = 0;
  let eff = defaultEffective();
  // Estimation only makes sense once there is a bottle to deplete from.
  let anchored = false;
  let i = 0;

  for (let day = sorted[0].date; day <= today; day = addDays(day, 1)) {
    /** @type {{ am: number|undefined, pm: number|undefined }} */
    const logged = { am: undefined, pm: undefined };
    let gapTotal = 0;
    let setupToday = false;

    // Rule 1: this day's entries, in seq order.
    for (; i < sorted.length && sorted[i].date === day; i += 1) {
      const e = sorted[i];
      switch (e.type) {
        case "setup":
          bal = e.qty;
          anchored = true;
          setupToday = true;
          break;
        case "fill":
          bal += e.qty;
          break;
        case "dose":
          bal -= e.qty;
          // The invariant is one dose per (date, slot); state.js enforces it.
          // If it is ever violated the doses are summed here so this record
          // stays equal to what the balance actually subtracted.
          logged[e.slot] = (logged[e.slot] ?? 0) + e.qty;
          break;
        case "recount": {
          const gap = Math.max(0, bal - e.qty);
          out.gaps.set(e.id, gap);
          gapTotal += gap;
          bal = e.qty;
          anchored = true;
          break;
        }
        case "settings":
          eff = applySettings(eff, e);
          break;
        default:
          break;
      }
    }

    // Rules 2, 3, 4: estimate the unlogged slots of a completed day that is
    // not the setup day, and charge that estimate to the balance at the end
    // of the day, after any recount dated today has already reset it.
    let total = gapTotal;
    let estimatedSlots = 0;
    const mayEstimate = anchored && day < today && !setupToday;
    for (const slot of SLOTS) {
      const q = logged[slot];
      if (q !== undefined) {
        total += q;
      } else if (mayEstimate) {
        total += eff.plan[slot];
        bal -= eff.plan[slot];
        estimatedSlots += 1;
      }
    }
    out.days.set(day, { total, estimatedSlots });
  }

  out.balance = bal;
  return out;
}

// ---------------------------------------------------------------------------
// Balance and derived gaps
// ---------------------------------------------------------------------------

/**
 * Derived gap for each recount, keyed by recount id. Never stored.
 * gap = max(0, balance just before the recount - counted qty).
 * A count higher than computed yields 0, not found pills.
 * @param {Entry[]} entries @param {DateKey} today @returns {Map<string, number>}
 */
export function gaps(entries, today) {
  return walk(sortEntries(entries), today).gaps;
}

/**
 * Pills on hand as of end of `today`. Future-dated entries are excluded.
 * @param {Entry[]} entries @param {DateKey} today @returns {number}
 */
export function balance(entries, today) {
  return walk(sortEntries(entries), today).balance;
}

// ---------------------------------------------------------------------------
// Depletion, surplus, projection
// ---------------------------------------------------------------------------

/**
 * What left the bottle on one day, treated as a completed day. A slot with no
 * dose entry is assumed to have followed the effective plan and is counted as
 * estimated, unless the day is the setup day (rule 3). A dose of qty 0 is a
 * logged skip: it depletes nothing and is NOT estimated.
 *
 * This is exactly the amount the balance walk charged for `date`: a day's
 * record depends only on entries dated at or before it and on whether it is
 * completed, so walking to the following day reads the completed record.
 * @param {Entry[]} entries @param {DateKey} date @returns {DayDepletion}
 */
export function depletionForDay(entries, date) {
  const sorted = sortEntries(entries);
  return dayRecord(walk(sorted, addDays(date, 1)), date);
}

/** @param {Walk} w @param {DateKey} date @returns {DayDepletion} */
function dayRecord(w, date) {
  return w.days.get(date) ?? { total: 0, estimatedSlots: 0 };
}

/** @param {Entry[]} sorted @returns {Entry|undefined} */
function findSetup(sorted) {
  return sorted.find((e) => e.type === "setup");
}

/**
 * Cumulative over [setupDate + 1, yesterday]. The setup day never accrues and
 * today never accrues.
 * @param {Entry[]} entries @param {DateKey} today @returns {Surplus}
 */
export function surplus(entries, today) {
  const sorted = sortEntries(entries);
  return surplusFromWalk(sorted, walk(sorted, today), today);
}

/** @param {Entry[]} sorted @param {Walk} w @param {DateKey} today @returns {Surplus} */
function surplusFromWalk(sorted, w, today) {
  const setup = findSetup(sorted);
  if (!setup) return { pills: 0, estimatedDays: 0, estimatedSlots: 0 };

  let pills = 0;
  let estimatedDays = 0;
  let estimatedSlots = 0;
  let eff = defaultEffective();
  let i = 0;
  for (let d = addDays(setup.date, 1); d < today; d = addDays(d, 1)) {
    for (; i < sorted.length && sorted[i].date <= d; i += 1) {
      if (sorted[i].type === "settings") eff = applySettings(eff, sorted[i]);
    }
    const dep = dayRecord(w, d);
    pills += eff.prescribedPerDay - dep.total;
    if (dep.estimatedSlots > 0) estimatedDays += 1;
    estimatedSlots += dep.estimatedSlots;
  }
  return { pills, estimatedDays, estimatedSlots };
}

/** @param {Entry[]} entries @param {DateKey} today @returns {Projection} */
export function projection(entries, today) {
  const sorted = sortEntries(entries);
  return projectionFromSorted(sorted, today, walk(sorted, today).balance);
}

/**
 * @param {Entry[]} sorted @param {DateKey} today @param {number} bal
 * @returns {Projection}
 */
function projectionFromSorted(sorted, today, bal) {
  const eff = effectiveFromSorted(sorted, today);
  const plannedPerDay = eff.plan.am + eff.plan.pm;

  const loggedToday = { am: false, pm: false };
  for (const e of sorted) {
    if (e.date < today) continue;
    if (e.date > today) break;
    if (e.type === "dose") loggedToday[e.slot] = true;
  }
  let remainingToday = 0;
  for (const slot of SLOTS) {
    if (!loggedToday[slot]) remainingToday += eff.plan[slot];
  }

  if (bal <= remainingToday) {
    return { plannedPerDay, remainingToday, runOutDate: today, daysLeft: 0 };
  }
  if (plannedPerDay === 0) {
    // Nothing planned to leave the bottle: on the plan it never runs out.
    return { plannedPerDay, remainingToday, runOutDate: null, daysLeft: Infinity };
  }
  const daysLeft = Math.floor((bal - remainingToday) / plannedPerDay);
  return { plannedPerDay, remainingToday, runOutDate: addDays(today, daysLeft), daysLeft };
}

/** Everything the UI needs, in one pass. @param {Entry[]} entries @param {DateKey} today @returns {Summary} */
export function summary(entries, today) {
  const sorted = sortEntries(entries);
  const w = walk(sorted, today);
  return {
    balance: w.balance,
    surplus: surplusFromWalk(sorted, w, today),
    projection: projectionFromSorted(sorted, today, w.balance),
    effective: effectiveFromSorted(sorted, today),
  };
}
