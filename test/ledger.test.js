// Tests 3 through 16 from the plan. Tests 1 and 2 (the firewall) live in
// test/state.test.js because they must drive the real logDose() path.
//
// The timezone is pinned to one with DST and a negative UTC offset so that the
// two date bug classes (UTC parse, millisecond division) are reproducible on
// any machine. Node honours a runtime change to TZ before the first Date use.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localDateKey,
  parseLocalDate,
  addDays,
  daysBetween,
  isValidQty,
  isValidDateKey,
  validateEntry,
  sortEntries,
  effectiveAt,
  gaps,
  balance,
  depletionForDay,
  surplus,
  projection,
  summary,
} from "../src/ledger.js";

// ---------------------------------------------------------------------------
// Builder. Assigns seq in creation order, exactly as state.js will.
// ---------------------------------------------------------------------------

function log() {
  let seq = 1;
  const entries = [];
  const push = (fields) => {
    const e = { id: `e${seq}`, seq, ...fields };
    seq += 1;
    entries.push(e);
    return e;
  };
  return {
    entries,
    setup: (date, qty) => push({ type: "setup", date, qty }),
    settings: (date, fields) => push({ type: "settings", date, ...fields }),
    dose: (date, slot, qty) => push({ type: "dose", date, slot, qty }),
    fill: (date, qty) => push({ type: "fill", date, qty }),
    recount: (date, qty) => push({ type: "recount", date, qty }),
  };
}

/** Standard first run: setup count plus the settings entry state.js writes with it. */
function firstRun(date, count, { prescribedPerDay = 2, plan = { am: 1, pm: 1 } } = {}) {
  const l = log();
  l.setup(date, count);
  l.settings(date, { prescribedPerDay, plan });
  return l;
}

// ---------------------------------------------------------------------------
// Date helpers (support for invariant 6; exercised again in test 15)
// ---------------------------------------------------------------------------

test("date keys are built and parsed as local calendar days, never UTC", () => {
  const d = parseLocalDate("2026-09-19");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 0);
  assert.equal(localDateKey(d), "2026-09-19");
  // The bug this guards against: the UTC parse lands a day early here.
  assert.equal(new Date("2026-09-19").getDate(), 18);
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("addDays steps across month and year boundaries", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
  assert.equal(daysBetween("2026-01-01", "2026-12-31"), 364);
  assert.equal(daysBetween("2026-12-31", "2026-01-01"), -364);
  assert.equal(daysBetween("2026-05-05", "2026-05-05"), 0);
});

// ---------------------------------------------------------------------------
// 3. The Q9 case. Derek's own worked example.
// ---------------------------------------------------------------------------

test("3. Q9: baseline 2, two completed days of 0.5 am + 1 pm, surplus === 1", () => {
  const l = firstRun("2026-09-01", 40);
  l.dose("2026-09-02", "am", 0.5);
  l.dose("2026-09-02", "pm", 1);
  l.dose("2026-09-03", "am", 0.5);
  l.dose("2026-09-03", "pm", 1);

  const s = surplus(l.entries, "2026-09-04");
  assert.equal(s.pills, 1);
  assert.equal(s.estimatedDays, 0);
  assert.equal(s.estimatedSlots, 0);
  assert.equal(balance(l.entries, "2026-09-04"), 37);
});

// ---------------------------------------------------------------------------
// 4. Today does not accrue.
// ---------------------------------------------------------------------------

test("4. today does not accrue: second day as today gives 0.5, today reported separately", () => {
  const l = firstRun("2026-09-01", 40);
  l.dose("2026-09-02", "am", 0.5);
  l.dose("2026-09-02", "pm", 1);
  l.dose("2026-09-03", "am", 0.5);
  l.dose("2026-09-03", "pm", 1);

  const today = "2026-09-03";
  const s = surplus(l.entries, today);
  assert.equal(s.pills, 0.5);
  assert.equal(s.estimatedDays, 0);

  // Today's activity is visible on its own, not folded into surplus.
  assert.deepEqual(depletionForDay(l.entries, today), { total: 1.5, estimatedSlots: 0 });
  assert.equal(balance(l.entries, today), 37);
  assert.equal(projection(l.entries, today).remainingToday, 0);
});

// ---------------------------------------------------------------------------
// 5. Setup day does not accrue.
// ---------------------------------------------------------------------------

test("5. setup day does not accrue: setup at 23:00 with nothing logged contributes 0, not +2", () => {
  const setupDay = localDateKey(new Date(2026, 8, 1, 23, 0));
  assert.equal(setupDay, "2026-09-01");
  const l = firstRun(setupDay, 40);

  const s = surplus(l.entries, "2026-09-02");
  assert.equal(s.pills, 0);
  assert.equal(s.estimatedDays, 0);
  assert.equal(s.estimatedSlots, 0);
  assert.equal(balance(l.entries, "2026-09-02"), 40);
});

// ---------------------------------------------------------------------------
// 6. Estimation.
// ---------------------------------------------------------------------------

test("6. estimation: an unlogged completed day depletes plannedPerDay and is counted as estimated", () => {
  const l = firstRun("2026-09-01", 40, { prescribedPerDay: 2, plan: { am: 1, pm: 1 } });
  // 2026-09-02 completed with nothing logged.
  const today = "2026-09-03";

  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 2, estimatedSlots: 2 });
  const s = surplus(l.entries, today);
  assert.equal(s.pills, 0);
  assert.equal(s.estimatedDays, 1);
  assert.equal(s.estimatedSlots, 2);

  // Half-logged day: one slot estimated, day still counts once.
  l.dose("2026-09-03", "am", 0.5);
  const s2 = surplus(l.entries, "2026-09-04");
  assert.deepEqual(depletionForDay(l.entries, "2026-09-03"), { total: 1.5, estimatedSlots: 1 });
  assert.equal(s2.pills, 0.5);
  assert.equal(s2.estimatedDays, 2);
  assert.equal(s2.estimatedSlots, 3);

  // Estimates are charged to the balance too: one series, read twice.
  // 40 - 2 (09-02 estimated) - 0.5 (09-03 am) - 1 (09-03 pm estimated) = 36.5.
  assert.equal(balance(l.entries, "2026-09-04"), 36.5);
  // With 09-03 as today, today's pm is not yet estimated.
  assert.equal(balance(l.entries, "2026-09-03"), 37.5);
});

// ---------------------------------------------------------------------------
// 7. A skip banks.
// ---------------------------------------------------------------------------

test("7. a skip banks: qty 0 in both slots on a completed day yields +2 and is not estimated", () => {
  const l = firstRun("2026-09-01", 40);
  l.dose("2026-09-02", "am", 0);
  l.dose("2026-09-02", "pm", 0);

  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 0, estimatedSlots: 0 });
  const s = surplus(l.entries, "2026-09-03");
  assert.equal(s.pills, 2);
  assert.equal(s.estimatedDays, 0);
  assert.equal(s.estimatedSlots, 0);
  assert.equal(balance(l.entries, "2026-09-03"), 40);
});

// ---------------------------------------------------------------------------
// 8. Same-day ordering.
// ---------------------------------------------------------------------------

test("8. same-day ordering: setup 10, then dose 1, fill 60, recount 69, dose 1 => balance 68", () => {
  const l = log();
  l.setup("2026-09-01", 10);
  const d = "2026-09-02";
  l.dose(d, "am", 1);
  l.fill(d, 60);
  const r = l.recount(d, 69);
  l.dose(d, "pm", 1);

  assert.equal(balance(l.entries, d), 68);
  assert.equal(gaps(l.entries, d).get(r.id), 0);

  // The same entries handed over in scrambled array order give the same answer:
  // (date, seq) is the order, not array position.
  const scrambled = [l.entries[4], l.entries[1], l.entries[3], l.entries[0], l.entries[2]];
  assert.equal(balance(scrambled, d), 68);
  assert.deepEqual(
    sortEntries(scrambled).map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
  // sortEntries does not mutate its input.
  assert.equal(scrambled[0].seq, 5);
});

// ---------------------------------------------------------------------------
// 9. Backdated recount.
// ---------------------------------------------------------------------------

test("9. backdated recount is compared against the balance at its own position, not today's", () => {
  const l = firstRun("2026-09-01", 40);
  l.dose("2026-09-02", "am", 1);
  l.dose("2026-09-02", "pm", 1);
  l.dose("2026-09-03", "am", 1);
  l.dose("2026-09-03", "pm", 1);
  const today = "2026-09-04";
  assert.equal(balance(l.entries, today), 36);

  // Entered on day 4, dated day 2. Its seq is the highest in the log.
  const r = l.recount("2026-09-02", 37);

  // Balance at the end of day 2 was 38, so the gap is 1. Against today's 36 it
  // would have been max(0, 36 - 37) = 0, which is the wrong answer.
  assert.equal(gaps(l.entries, today).get(r.id), 1);
  // Anchor is now the recount (37); day 3 doses come after it.
  assert.equal(balance(l.entries, today), 35);

  // The gap is depletion dated on the recount's day.
  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 3, estimatedSlots: 0 });
  assert.deepEqual(depletionForDay(l.entries, "2026-09-03"), { total: 2, estimatedSlots: 0 });
  assert.equal(surplus(l.entries, today).pills, -1);
});

// ---------------------------------------------------------------------------
// 10. Backfill shrinks the gap.
// ---------------------------------------------------------------------------

test("10. backfilling a real dose into a recount's window never moves the gap or surplus", () => {
  const l = firstRun("2026-09-01", 40);
  l.dose("2026-09-02", "am", 1);
  // pm on 09-02 forgotten. Recount next morning, then both doses logged.
  const r = l.recount("2026-09-03", 38);
  l.dose("2026-09-03", "am", 1);
  l.dose("2026-09-03", "pm", 1);
  const today = "2026-09-04";

  // The forgotten pm was estimated at the end of 09-02 (39 -> 38), so the
  // recount at 38 finds nothing unaccounted for. Gap 0, not 1.
  assert.equal(gaps(l.entries, today).get(r.id), 0);
  assert.equal(balance(l.entries, today), 36);
  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 2, estimatedSlots: 1 });
  assert.deepEqual(depletionForDay(l.entries, "2026-09-03"), { total: 2, estimatedSlots: 0 });
  const before = surplus(l.entries, today);
  assert.equal(before.pills, 0);
  assert.equal(before.estimatedSlots, 1);

  // Now remember and backfill the pm dose. Higher seq, earlier date: it sorts
  // before the recount. The estimate is replaced by the logged dose and
  // nothing else moves.
  l.dose("2026-09-02", "pm", 1);

  assert.equal(gaps(l.entries, today).get(r.id), 0);
  assert.equal(balance(l.entries, today), 36);
  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 2, estimatedSlots: 0 });
  assert.deepEqual(depletionForDay(l.entries, "2026-09-03"), { total: 2, estimatedSlots: 0 });
  const after = surplus(l.entries, today);
  assert.equal(after.pills, 0);
  assert.equal(after.estimatedSlots, 0);
});

test("10b. a count higher than computed yields a gap of 0, not found pills", () => {
  const l = firstRun("2026-09-01", 40);
  l.dose("2026-09-02", "am", 1);
  const r = l.recount("2026-09-02", 45);
  assert.equal(gaps(l.entries, "2026-09-03").get(r.id), 0);
  // The recount is the new anchor.
  // The recount is the new anchor, and the day's unlogged pm is still
  // estimated after it: 45 - 1 = 44.
  assert.equal(balance(l.entries, "2026-09-03"), 44);
  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 2, estimatedSlots: 1 });
});

// ---------------------------------------------------------------------------
// 11. Fills are surplus-neutral.
// ---------------------------------------------------------------------------

test("11. a fill of 60 raises balance by 60 and moves surplus by 0", () => {
  const l = firstRun("2026-09-01", 40);
  l.dose("2026-09-02", "am", 0.5);
  l.dose("2026-09-02", "pm", 1);
  const today = "2026-09-03";
  const before = summary(l.entries, today);

  l.fill("2026-09-02", 60);
  const after = summary(l.entries, today);

  assert.equal(after.balance, before.balance + 60);
  assert.deepEqual(after.surplus, before.surplus);
  assert.equal(after.surplus.pills, 0.5);
});

// ---------------------------------------------------------------------------
// 12. Effective-dated baseline.
// ---------------------------------------------------------------------------

test("12. raising the baseline today leaves past days untouched and applies going forward", () => {
  const l = firstRun("2026-09-01", 100, { prescribedPerDay: 2, plan: { am: 1, pm: 1 } });
  for (let d = "2026-09-02"; d <= "2026-09-11"; d = addDays(d, 1)) {
    l.dose(d, "am", 1);
    l.dose(d, "pm", 1);
  }
  const today = "2026-09-12";
  assert.equal(surplus(l.entries, today).pills, 0);

  l.settings(today, { prescribedPerDay: 3 });

  assert.equal(effectiveAt(l.entries, "2026-09-11").prescribedPerDay, 2);
  assert.equal(effectiveAt(l.entries, today).prescribedPerDay, 3);
  // Ten completed days still sum to 0.
  assert.equal(surplus(l.entries, today).pills, 0);

  // Today, once completed at the same 2/day consumption, accrues +1 under the new rate.
  l.dose(today, "am", 1);
  l.dose(today, "pm", 1);
  assert.equal(surplus(l.entries, addDays(today, 1)).pills, 1);

  // Plan only: a settings entry carrying just a plan keeps the rate in force.
  l.settings(addDays(today, 1), { plan: { am: 0.5, pm: 1 } });
  const eff = effectiveAt(l.entries, addDays(today, 1));
  assert.equal(eff.prescribedPerDay, 3);
  assert.deepEqual(eff.plan, { am: 0.5, pm: 1 });
  // And the plan on the day before is unchanged.
  assert.deepEqual(effectiveAt(l.entries, today).plan, { am: 1, pm: 1 });
});

// ---------------------------------------------------------------------------
// 13. Future-dated fill.
// ---------------------------------------------------------------------------

test("13. a fill dated tomorrow is excluded from today's balance", () => {
  const l = firstRun("2026-09-01", 40);
  // Log skips on the completed days so nothing is estimated and the
  // arithmetic isolates the fill.
  for (let d = "2026-09-02"; d <= "2026-09-05"; d = addDays(d, 1)) {
    l.dose(d, "am", 0);
    l.dose(d, "pm", 0);
  }
  const today = "2026-09-05";
  l.fill(addDays(today, 1), 60);

  assert.equal(balance(l.entries, today), 40);
  assert.equal(balance(l.entries, addDays(today, 1)), 100);
  // It stays in the log, ordered after everything dated today.
  assert.equal(sortEntries(l.entries).at(-1).type, "fill");

  // A future recount is likewise ignored for today's balance and gaps.
  const r = l.recount(addDays(today, 2), 10);
  assert.equal(balance(l.entries, today), 40);
  assert.equal(gaps(l.entries, today).has(r.id), false);
  // Three completed skip days (09-02 to 09-04) bank +2 each. The fill adds nothing.
  assert.equal(surplus(l.entries, today).pills, 6);
});

// ---------------------------------------------------------------------------
// 14. Validation.
// ---------------------------------------------------------------------------

test("14. quantities of 0.3 or negative are rejected; valid halves accepted", () => {
  assert.equal(isValidQty(0), true);
  assert.equal(isValidQty(0.5), true);
  assert.equal(isValidQty(1), true);
  assert.equal(isValidQty(1.5), true);
  assert.equal(isValidQty(60), true);

  assert.equal(isValidQty(0.3), false);
  assert.equal(isValidQty(-1), false);
  assert.equal(isValidQty(-0.5), false);
  assert.equal(isValidQty(0.25), false);
  assert.equal(isValidQty(NaN), false);
  assert.equal(isValidQty(Infinity), false);
  assert.equal(isValidQty("1"), false);
  assert.equal(isValidQty(null), false);
  assert.equal(isValidQty(undefined), false);

  const bad = validateEntry({ id: "x", seq: 1, type: "dose", date: "2026-09-02", slot: "am", qty: 0.3 });
  assert.ok(bad.length > 0);
  assert.match(bad.join("\n"), /qty/);
  const neg = validateEntry({ id: "x", seq: 1, type: "fill", date: "2026-09-02", qty: -1 });
  assert.ok(neg.length > 0);

  assert.deepEqual(validateEntry({ id: "x", seq: 1, type: "dose", date: "2026-09-02", slot: "am", qty: 0 }), []);
  assert.deepEqual(validateEntry({ id: "x", seq: 0, type: "setup", date: "2026-09-02", qty: 40 }), []);
  assert.deepEqual(
    validateEntry({ id: "x", seq: 2, type: "settings", date: "2026-09-02", prescribedPerDay: 2, plan: { am: 1, pm: 1 } }),
    [],
  );
  assert.deepEqual(validateEntry({ id: "x", seq: 2, type: "settings", date: "2026-09-02", plan: { am: 0.5, pm: 1 } }), []);
});

test("14b. validateEntry rejects malformed shape, unknown types, bad dates, bad slots", () => {
  assert.ok(validateEntry(null).length > 0);
  assert.ok(validateEntry("dose").length > 0);
  assert.ok(validateEntry({ id: "x", seq: 1, type: "gap", date: "2026-09-02", qty: 1 }).length > 0);
  assert.ok(validateEntry({ id: "x", seq: 1, type: "dose", date: "2026-09-02", slot: "noon", qty: 1 }).length > 0);
  assert.ok(validateEntry({ id: "x", seq: 1, type: "dose", date: "2026-09-02", qty: 1 }).length > 0);
  assert.ok(validateEntry({ id: "x", seq: 1.5, type: "fill", date: "2026-09-02", qty: 1 }).length > 0);
  assert.ok(validateEntry({ id: "", seq: 1, type: "fill", date: "2026-09-02", qty: 1 }).length > 0);
  assert.ok(validateEntry({ id: "x", seq: 1, type: "settings", date: "2026-09-02" }).length > 0);
  assert.ok(validateEntry({ id: "x", seq: 1, type: "settings", date: "2026-09-02", plan: { am: 1 } }).length > 0);
  assert.ok(validateEntry({ id: "x", seq: 1, type: "fill", date: "2026-02-30", qty: 1 }).length > 0);

  assert.equal(isValidDateKey("2026-09-19"), true);
  assert.equal(isValidDateKey("2024-02-29"), true);
  assert.equal(isValidDateKey("2026-02-29"), false);
  assert.equal(isValidDateKey("2026-13-01"), false);
  assert.equal(isValidDateKey("2026-00-10"), false);
  assert.equal(isValidDateKey("2026-04-31"), false);
  assert.equal(isValidDateKey("2026-9-1"), false);
  assert.equal(isValidDateKey("2026/09/19"), false);
  assert.equal(isValidDateKey("2026-09-19T00:00:00Z"), false);
  assert.equal(isValidDateKey(20260919), false);
  assert.equal(isValidDateKey(""), false);
});

// ---------------------------------------------------------------------------
// 15. DST.
// ---------------------------------------------------------------------------

test("15. DST: a completed-day count across a spring-forward counts the correct number of days", () => {
  // America/New_York springs forward on 2026-03-08.
  const before = parseLocalDate("2026-03-07");
  const after = parseLocalDate("2026-03-09");
  assert.notEqual(before.getTimezoneOffset(), after.getTimezoneOffset(), "TZ pin did not take");

  // The bug: millisecond division sees a 23-hour day and undercounts.
  assert.equal(Math.floor((after - before) / 86400000), 1);
  // The fix: calendar stepping.
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2);
  assert.equal(addDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-03-07", 2), "2026-03-09");

  // Three completed days (07, 08, 09) each 0.5 + 1 must give 3 x 0.5 = 1.5.
  const l = firstRun("2026-03-06", 40);
  for (const d of ["2026-03-07", "2026-03-08", "2026-03-09"]) {
    l.dose(d, "am", 0.5);
    l.dose(d, "pm", 1);
  }
  const s = surplus(l.entries, "2026-03-10");
  assert.equal(s.pills, 1.5);
  assert.equal(s.estimatedDays, 0);

  // Fall back too: 2026-11-01 is 25 hours long. Still one calendar day.
  assert.equal(daysBetween("2026-10-31", "2026-11-02"), 2);
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  const f = firstRun("2026-10-30", 40);
  for (const d of ["2026-10-31", "2026-11-01", "2026-11-02"]) {
    f.dose(d, "am", 0.5);
    f.dose(d, "pm", 1);
  }
  assert.equal(surplus(f.entries, "2026-11-03").pills, 1.5);

  // Projection steps the calendar too: 21 pills at 1/day from 2026-03-07.
  const p = firstRun("2026-03-07", 21, { plan: { am: 0.5, pm: 0.5 } });
  const proj = projection(p.entries, "2026-03-07");
  assert.equal(proj.plannedPerDay, 1);
  assert.equal(proj.remainingToday, 1);
  assert.equal(proj.daysLeft, 20);
  assert.equal(proj.runOutDate, "2026-03-27");
  assert.equal(daysBetween("2026-03-07", proj.runOutDate), 20);
});

// ---------------------------------------------------------------------------
// 16. Half-pill exactness.
// ---------------------------------------------------------------------------

test("16. long sequences of 0.5 arithmetic stay exact and validate at every step", () => {
  let acc = 0;
  for (let i = 0; i < 10000; i += 1) {
    acc += 0.5;
    assert.equal(isValidQty(acc), true, `step ${i}: ${acc}`);
  }
  assert.equal(acc, 5000);

  // Contrast: non-half decimal arithmetic is not exact and is rejected.
  assert.equal(isValidQty(0.1 + 0.2), false);

  // 400 completed days of 0.5 + 1 against baseline 2: exactly 200, exactly 0 estimated.
  const l = firstRun("2025-01-01", 1000);
  let d = "2025-01-02";
  for (let i = 0; i < 400; i += 1) {
    l.dose(d, "am", 0.5);
    l.dose(d, "pm", 1);
    d = addDays(d, 1);
  }
  const s = surplus(l.entries, d);
  assert.equal(s.pills, 200);
  assert.equal(s.estimatedSlots, 0);
  assert.equal(balance(l.entries, d), 1000 - 600);
  assert.equal(isValidQty(balance(l.entries, d)), true);
  assert.equal(isValidQty(s.pills), true);
});

// ---------------------------------------------------------------------------
// 17 and 18. The one-series invariant.
// ---------------------------------------------------------------------------

/**
 * Sum of what every day in [from, to] charged to the bottle. With no fills and
 * no recount reading above the computed balance, this must equal
 * anchor - final balance, or a pill has been counted twice or not at all.
 */
function depletionOver(entries, from, to) {
  let sum = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) sum += depletionForDay(entries, d).total;
  return sum;
}

test("17. a forgotten dose is charged once: estimate on its day, no gap at the next recount", () => {
  const l = firstRun("2026-09-01", 40, { prescribedPerDay: 2, plan: { am: 1, pm: 1 } });
  l.dose("2026-09-02", "am", 1);
  // pm forgotten on 09-02.
  const r = l.recount("2026-09-03", 38);
  l.dose("2026-09-03", "am", 1);
  l.dose("2026-09-03", "pm", 1);
  const today = "2026-09-04";

  // Truth: 2 pills left the bottle on each of 09-02 and 09-03, against 2/day.
  const s = surplus(l.entries, today);
  assert.equal(s.pills, 0);
  assert.equal(s.estimatedDays, 1);
  assert.equal(s.estimatedSlots, 1);
  assert.equal(gaps(l.entries, today).get(r.id), 0);
  assert.equal(balance(l.entries, today), 36);

  // No pill counted twice: total depletion over the window is exactly what
  // left the bottle.
  assert.equal(depletionOver(l.entries, "2026-09-02", "2026-09-03"), 40 - 36);
  // From the setup day through yesterday (today has not been charged yet).
  assert.equal(depletionOver(l.entries, "2026-09-01", "2026-09-03"), 40 - balance(l.entries, today));
});

test("18. a genuine loss is still counted exactly once", () => {
  const l = firstRun("2026-09-01", 40, { prescribedPerDay: 2, plan: { am: 1, pm: 1 } });
  l.dose("2026-09-02", "am", 1);
  const r = l.recount("2026-09-03", 37);
  l.dose("2026-09-03", "am", 1);
  l.dose("2026-09-03", "pm", 1);
  const today = "2026-09-04";

  // Estimated balance before the count was 38; the bottle says 37. One pill is
  // really gone, charged to 09-03 as the recount's gap.
  assert.equal(gaps(l.entries, today).get(r.id), 1);
  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 2, estimatedSlots: 1 });
  assert.deepEqual(depletionForDay(l.entries, "2026-09-03"), { total: 3, estimatedSlots: 0 });
  assert.equal(surplus(l.entries, today).pills, -1);
  assert.equal(balance(l.entries, today), 35);
  assert.equal(depletionOver(l.entries, "2026-09-02", "2026-09-03"), 40 - 35);
});

test("rule 4: depletionForDay equals what the balance walk charged, day by day", () => {
  // A messy log: estimates, skips, a fill, a plan change mid-window, a
  // backdated recount that reads high, and a later recount with a real gap.
  const l = firstRun("2026-09-01", 50, { prescribedPerDay: 2, plan: { am: 1, pm: 1 } });
  l.dose("2026-09-02", "am", 0.5);
  l.dose("2026-09-03", "am", 0);
  l.dose("2026-09-03", "pm", 0);
  l.fill("2026-09-04", 10);
  l.settings("2026-09-05", { plan: { am: 1.5, pm: 1 } });
  l.dose("2026-09-06", "pm", 1.5);
  l.recount("2026-09-07", 40);
  l.dose("2026-09-08", "am", 1);
  l.dose("2026-09-08", "pm", 1);
  l.recount("2026-09-05", 100); // entered late, dated earlier, reads high
  const today = "2026-09-10";

  // balance(d) reads the bottle with d as today, so d's own estimate is not
  // yet charged. Reconstruct the end-of-completed-day balance by charging the
  // estimated portion of depletionForDay(d), which is everything in it that
  // is not a logged dose or a gap dated d.
  const endOfDay = (d) => {
    const dep = depletionForDay(l.entries, d);
    const g = gaps(l.entries, d);
    let known = 0;
    for (const e of l.entries) {
      if (e.date !== d) continue;
      if (e.type === "dose") known += e.qty;
      if (e.type === "recount") known += g.get(e.id) ?? 0;
    }
    return balance(l.entries, d) - (dep.total - known);
  };

  // Every day, today included, must satisfy
  //   endOfDay(d) === endOfDay(d - 1) + fills(d) - depletionForDay(d).total
  // The only permitted exception is a recount reading above the computed
  // balance, which raises the balance without any depletion.
  let prev = endOfDay("2026-09-01");
  assert.equal(prev, 50);
  for (let d = "2026-09-02"; d <= today; d = addDays(d, 1)) {
    const cur = endOfDay(d);
    const fills = l.entries.filter((e) => e.type === "fill" && e.date === d).reduce((a, e) => a + e.qty, 0);
    const dep = depletionForDay(l.entries, d);
    if (d === "2026-09-05") {
      // Reads high: gap 0, balance reset to 100, then the day's own
      // unlogged slots (plan 1.5 + 1 from this day's settings) are estimated.
      assert.deepEqual(dep, { total: 2.5, estimatedSlots: 2 });
      assert.equal(cur, 97.5);
    } else {
      assert.equal(cur, prev + fills - dep.total, `day ${d}`);
    }
    prev = cur;
  }

  // Spot values, computed by hand.
  assert.equal(endOfDay("2026-09-02"), 48.5); // 50 - 0.5 logged - 1 estimated
  assert.equal(endOfDay("2026-09-04"), 56.5); // 48.5 + 10 - 2 estimated
  assert.equal(endOfDay("2026-09-06"), 94.5); // 97.5 - 1.5 logged pm - 1.5 estimated am
  const r40 = l.entries.find((e) => e.type === "recount" && e.qty === 40);
  assert.equal(gaps(l.entries, today).get(r40.id), 54.5); // 94.5 - 40 on 09-07
  // 09-07: gap 54.5 plus both slots estimated after the count (2.5).
  assert.deepEqual(depletionForDay(l.entries, "2026-09-07"), { total: 57, estimatedSlots: 2 });
  assert.equal(endOfDay("2026-09-07"), 37.5);
  assert.equal(balance(l.entries, today), 33); // 37.5 - 2 logged 09-08 - 2.5 estimated 09-09

  // And the whole-window identity from the high recount's reset forward:
  // everything charged from 09-05 (after its reset to 100) through 09-09.
  assert.equal(depletionOver(l.entries, "2026-09-05", "2026-09-09"), 100 - endOfDay("2026-09-09"));
  assert.equal(depletionOver(l.entries, "2026-09-05", "2026-09-09"), 100 - balance(l.entries, today));
});

test("19. a recount day with both slots unlogged estimates them and discloses it", () => {
  // Recount in the morning reads 40, matching the running balance. Neither
  // dose is logged that day.
  const m = firstRun("2026-09-01", 40, { prescribedPerDay: 2, plan: { am: 1, pm: 1 } });
  const r = m.recount("2026-09-02", 40);
  const today = "2026-09-03";

  // Estimated like any other completed day, applied after the count.
  assert.deepEqual(depletionForDay(m.entries, "2026-09-02"), { total: 2, estimatedSlots: 2 });
  assert.equal(gaps(m.entries, today).get(r.id), 0);
  assert.equal(balance(m.entries, today), 38);

  // The day contributes 0 to surplus, not a phantom +2, and the guess is
  // surfaced so the UI can say "includes 1 estimated day".
  const ms = surplus(m.entries, today);
  assert.equal(ms.pills, 0);
  assert.equal(ms.estimatedDays, 1);
  assert.equal(ms.estimatedSlots, 2);

  // Same day, but the count reads 39: one pill really is gone. That gap is
  // depletion dated on the recount day, on top of the estimate.
  const l = firstRun("2026-09-01", 40);
  const r39 = l.recount("2026-09-02", 39);
  assert.equal(gaps(l.entries, today).get(r39.id), 1);
  assert.deepEqual(depletionForDay(l.entries, "2026-09-02"), { total: 3, estimatedSlots: 2 });
  assert.equal(balance(l.entries, today), 37);
  const ls = surplus(l.entries, today);
  assert.equal(ls.pills, -1);
  assert.equal(ls.estimatedSlots, 2);

  // If that count was actually taken in the evening after both doses, the
  // balance reads 2 low (38 vs a true 40). The next recount heals it: 40
  // reads above the running 38, gap 0, balance back to truth, and surplus
  // for 09-02 unchanged at 0.
  const heal = m.recount(today, 40);
  assert.equal(gaps(m.entries, today).get(heal.id), 0);
  assert.equal(balance(m.entries, today), 40);
  assert.equal(surplus(m.entries, today).pills, 0);
});

// ---------------------------------------------------------------------------
// Projection and summary shape (support for the UI contract)
// ---------------------------------------------------------------------------

test("projection: plannedPerDay is from the plan; remainingToday shrinks as slots are logged", () => {
  const l = firstRun("2026-09-01", 10, { plan: { am: 1, pm: 1 } });
  const today = "2026-09-01";

  let p = projection(l.entries, today);
  assert.equal(p.plannedPerDay, 2);
  assert.equal(p.remainingToday, 2);
  // (10 - 2) / 2 = 4 more days after today.
  assert.equal(p.daysLeft, 4);
  assert.equal(p.runOutDate, "2026-09-05");

  // Logging a smaller dose than planned does not touch plannedPerDay.
  l.dose(today, "am", 0.5);
  p = projection(l.entries, today);
  assert.equal(p.plannedPerDay, 2);
  assert.equal(p.remainingToday, 1);
  // (9.5 - 1) / 2 = 4.25 -> 4.
  assert.equal(p.daysLeft, 4);
  assert.equal(p.runOutDate, "2026-09-05");

  // Balance at or below what today still needs: runs out today.
  const low = firstRun("2026-09-01", 1.5, { plan: { am: 1, pm: 1 } });
  const lp = projection(low.entries, today);
  assert.equal(lp.runOutDate, today);
  assert.equal(lp.daysLeft, 0);
});

test("summary bundles balance, surplus, projection and effective consistently", () => {
  const l = firstRun("2026-09-01", 40, { prescribedPerDay: 2, plan: { am: 0.5, pm: 1 } });
  l.dose("2026-09-02", "am", 0.5);
  l.dose("2026-09-02", "pm", 1);
  const today = "2026-09-03";
  const s = summary(l.entries, today);

  assert.equal(s.balance, balance(l.entries, today));
  assert.deepEqual(s.surplus, surplus(l.entries, today));
  assert.deepEqual(s.projection, projection(l.entries, today));
  assert.deepEqual(s.effective, effectiveAt(l.entries, today));
  assert.equal(s.balance, 38.5);
  assert.equal(s.surplus.pills, 0.5);
  assert.equal(s.projection.plannedPerDay, 1.5);
});

test("no setup entry: everything degrades to zero rather than throwing", () => {
  assert.equal(balance([], "2026-09-03"), 0);
  assert.deepEqual(surplus([], "2026-09-03"), { pills: 0, estimatedDays: 0, estimatedSlots: 0 });
  assert.deepEqual(effectiveAt([], "2026-09-03"), { prescribedPerDay: 2, plan: { am: 1, pm: 1 } });
  assert.equal(gaps([], "2026-09-03").size, 0);
  const p = projection([], "2026-09-03");
  assert.equal(p.runOutDate, "2026-09-03");
  assert.equal(p.daysLeft, 0);
});
