/**
 * src/ui.js
 *
 * Rendering and event wiring for every screen, against the static markup in
 * index.html. See DOM-CONTRACT.md for every id, class and data attribute used
 * here. This file owns no markup of its own beyond cloning the two templates.
 *
 * Shape of the loop, and it never varies:
 *
 *     state -> render(state)          reading only, never mutating
 *     event -> reducer(state) -> save -> render
 *
 * Every displayed number comes from `ledger.summary(entries, today)` in one
 * pass. Nothing here recomputes balance, surplus or projection, and nothing
 * here does its own date arithmetic: `localDateKey`, `addDays` and
 * `parseLocalDate` from ledger.js are the only ways a date is built or stepped.
 *
 * THE FIREWALL (CLAUDE.md invariant 1). `log-dose` calls `logDose` and nothing
 * else. It never calls `updateSettings`, never touches meta, never derives a
 * plan from what was taken. The plan changes in exactly one place, the Settings
 * form, and in the entry editor when the user edits a `settings` entry on
 * purpose. If you are ever tempted to "helpfully" sync the plan to the dose
 * just logged, read the first paragraph of state.js instead.
 *
 * Module-level side effects: none. Importing this file does nothing at all.
 * `init()` is the single entry point and src/main.js owns calling it.
 */

import {
  load,
  save,
  createState,
  logDose,
  recordFill,
  recordRecount,
  updateSettings,
  setLowBalanceDays,
  markExported,
  addEntry,
  updateEntry,
  deleteEntry,
} from "./state.js";

import {
  summary,
  gaps,
  effectiveAt,
  sortEntries,
  localDateKey,
  addDays,
  parseLocalDate,
  isValidQty,
  isValidDateKey,
} from "./ledger.js";

import { exportJSON, importJSON, exportStaleness, STALE_AFTER_DAYS } from "./export.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @typedef {import("./ledger.js").DateKey} DateKey */
/** @typedef {import("./ledger.js").Slot} Slot */

const VIEWS = ["home", "history", "actions", "settings"];
const SLOTS = /** @type {Slot[]} */ (["am", "pm"]);
const SLOT_NAMES = { am: "Morning", pm: "Evening" };

/** Local hour after which an unlogged evening dose raises a banner. */
const EVENING_BANNER_HOUR = 20;

/** Completed days in a row with nothing logged before the banner appears. */
const UNLOGGED_DAYS_BANNER = 3;

/**
 * How far back history renders the derived `estimated` rows. They are not
 * stored entries, they are one per unlogged slot per completed day, so an
 * untouched log of several years would otherwise build thousands of nodes.
 * The math is unaffected: ledger.js estimates over the whole window either way.
 */
const ESTIMATED_ROW_WINDOW_DAYS = 180;

// ---------------------------------------------------------------------------
// Module state. Declarations only, nothing runs at import time.
// ---------------------------------------------------------------------------

/** @type {import("./state.js").State|null} */
let appState = null;
let currentView = "home";
let setupStep = 1;
let booted = false;

/** True once the user has typed in the settings form, so a render cannot stomp it. */
let settingsDirty = false;

/** What the banner region last rendered, so a live region is not refilled for nothing. */
let bannerSignature = null;

/** A one off notice, usually a reducer complaint. Cleared on the next action. */
let flashNotice = null;
let flashCounter = 0;

/** Banner keys the user dismissed, scoped to the day so they come back tomorrow. */
const dismissed = new Set();

/** The date key the last render used, so a page left open overnight can catch up. */
let renderedDay = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {string} id @returns {any} */
function el(id) {
  return document.getElementById(id);
}

/** @returns {DateKey} Today, recomputed every time it is asked for. */
function todayKey() {
  return localDateKey(new Date());
}

/**
 * Quantities are non-negative multiples of 0.5 and halves are exact in binary
 * floating point, so this only tidies presentation.
 * @param {number} n @returns {string}
 */
function fmt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 2) / 2;
  const v = Object.is(rounded, -0) ? 0 : rounded;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** @param {number} n @param {string} one @param {string} many */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** @param {DateKey} key @returns {string} e.g. Friday 19 September */
function longDate(key) {
  return parseLocalDate(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** @param {DateKey} key @returns {string} e.g. Fri 19 Sep */
function rowDate(key) {
  return parseLocalDate(key).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** @param {DateKey} key @returns {string} e.g. 9 Oct */
function shortDate(key) {
  return parseLocalDate(key).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

/** @param {string} s @returns {string} */
function sentence(s) {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Reducers throw developer grade messages carrying raw date keys and entry ids.
 * The few a user can actually provoke get proper copy here; the rest are at
 * least punctuated. Nothing is swallowed.
 * @param {unknown} err @returns {string}
 */
function readable(err) {
  const raw = err && typeof err === "object" && "message" in err ? String(err.message) : String(err ?? "");
  if (raw.length === 0) return "Something went wrong.";

  const duplicate = /^a (am|pm) dose is already logged for (\d{4}-\d{2}-\d{2})/.exec(raw);
  if (duplicate && isValidDateKey(duplicate[2])) {
    const when = duplicate[2];
    const name = SLOT_NAMES[duplicate[1]].toLowerCase();
    return `The ${name} dose is already logged for ${rowDate(when)}. Edit or delete that one first.`;
  }
  if (raw.startsWith("the setup entry cannot be deleted")) {
    return "The first count cannot be deleted. Record a recount instead.";
  }
  if (raw.startsWith("there is already a setup entry")) {
    return "There is already a first count. Record a recount instead.";
  }
  return sentence(raw);
}

/** @param {HTMLElement} node @param {string} text */
function showText(node, text) {
  node.textContent = text;
  node.hidden = false;
}

/** @param {HTMLElement} node */
function hideText(node) {
  node.textContent = "";
  node.hidden = true;
}

/** @param {HTMLElement} node @param {boolean} on */
function setHidden(node, on) {
  node.hidden = on;
}

/** @param {string} text @param {"info"|"ok"|"warn"|"urgent"} severity */
function flash(text, severity) {
  flashCounter += 1;
  flashNotice = { key: `flash-${flashCounter}`, severity, text };
}

function clearFlash() {
  flashNotice = null;
}

// ---------------------------------------------------------------------------
// Reading the log. Everything numeric comes from ledger.js; these only locate
// entries so the UI can show and undo them.
// ---------------------------------------------------------------------------

/** @param {DateKey} date @param {Slot} slot */
function doseEntry(date, slot) {
  if (!appState) return undefined;
  return appState.entries.find((e) => e.type === "dose" && e.date === date && e.slot === slot);
}

/** @param {string} id */
function entryById(id) {
  if (!appState) return undefined;
  return appState.entries.find((e) => e.id === id);
}

function setupEntry() {
  if (!appState) return undefined;
  return appState.entries.find((e) => e.type === "setup");
}

// ---------------------------------------------------------------------------
// The mutation path. Reducers are pure, so every action is
// state -> reducer -> save -> render, and a throw becomes a readable banner.
// ---------------------------------------------------------------------------

/**
 * @param {(s: import("./state.js").State) => import("./state.js").State} fn
 * @returns {boolean} true when the state changed and was saved.
 */
function mutate(fn) {
  if (!appState) return false;
  clearFlash();
  try {
    const next = fn(appState);
    appState = next;
    save(appState);
    render();
    return true;
  } catch (err) {
    flash(readable(err), "urgent");
    render();
    return false;
  }
}

// ---------------------------------------------------------------------------
// View switching. All four steps from DOM-CONTRACT.md.
// ---------------------------------------------------------------------------

/** @param {string} name @param {boolean} [focus] */
function showView(name, focus = true) {
  currentView = name;
  el("view-setup").hidden = true;
  for (const v of VIEWS) {
    const panel = el(`view-${v}`);
    const tab = el(`tab-${v}`);
    const on = v === name;
    panel.hidden = !on;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  if (focus) el(`view-${name}`).focus();
}

function enterSetupMode() {
  el("app").dataset.mode = "setup";
  for (const v of VIEWS) el(`view-${v}`).hidden = true;
  el("view-setup").hidden = false;
  el("banner-region").replaceChildren();
  bannerSignature = null;
  setupStep = 1;
  renderSetupStep();
  el("today-label").textContent = longDate(todayKey());
}

function leaveSetupMode() {
  el("app").dataset.mode = "ready";
  el("view-setup").hidden = true;
  showView("home", false);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  if (!appState) return;
  const today = todayKey();
  renderedDay = today;

  const sum = summary(appState.entries, today);

  el("today-label").textContent = longDate(today);
  renderHome(sum, today);
  renderHistory(today);
  renderActions(today);
  renderSettings(sum);
  renderBanners(sum, today);
}

// --- Home ------------------------------------------------------------------

/**
 * @param {import("./ledger.js").Summary} sum
 * @param {DateKey} today
 */
function renderHome(sum, today) {
  for (const slot of SLOTS) {
    const card = el(`slot-${slot}`);
    const logged = doseEntry(today, slot);

    el(`slot-${slot}-plan`).textContent = `plan ${fmt(sum.effective.plan[slot])}`;
    card.dataset.logged = logged ? "true" : "false";
    setHidden(el(`slot-${slot}-open`), Boolean(logged));
    setHidden(el(`slot-${slot}-done`), !logged);

    if (logged) {
      el(`slot-${slot}-status`).textContent = logged.qty === 0 ? "Skipped today" : "Logged today";
      el(`slot-${slot}-taken`).textContent = logged.qty === 0 ? "Skipped" : `Took ${fmt(logged.qty)}`;
    } else {
      el(`slot-${slot}-status`).textContent = "Not logged yet";
      el(`slot-${slot}-taken`).textContent = "";
    }
  }

  // Surplus, the headline. It can be negative, and the estimated disclosure is
  // a product requirement: the number never silently rests on an assumption.
  const pills = sum.surplus.pills;
  // Show a magnitude and a direction rather than a signed number against a
  // fixed "ahead" label, which produced "-2 pills ahead" and "1 pills ahead".
  const magnitude = Math.abs(pills);
  el("stat-surplus-value").textContent = fmt(magnitude);
  el("stat-surplus-unit").textContent =
    plural(magnitude, "pill", "pills") + (pills < 0 ? " behind" : " ahead");
  el("stat-surplus").dataset.sign = pills > 0 ? "positive" : pills < 0 ? "negative" : "zero";

  const estimatedDays = sum.surplus.estimatedDays;
  const note = el("stat-surplus-note");
  if (estimatedDays > 0) {
    showText(note, `includes ${estimatedDays} estimated ${plural(estimatedDays, "day", "days")}`);
  } else {
    hideText(note);
  }

  el("stat-balance-value").textContent = fmt(sum.balance);

  const runOut = el("stat-runout-value");
  const runOutNote = el("stat-runout-note");
  const proj = sum.projection;
  if (proj.runOutDate === null) {
    // plannedPerDay is 0, so on the plan nothing ever leaves the bottle.
    runOut.textContent = "never";
    showText(runOutNote, "nothing planned per day");
  } else {
    runOut.textContent = shortDate(proj.runOutDate);
    if (proj.daysLeft === 0) {
      showText(runOutNote, "today is the last day");
    } else {
      showText(runOutNote, `${proj.daysLeft} ${plural(proj.daysLeft, "day", "days")} left`);
    }
  }
}

// --- Banners ---------------------------------------------------------------

/**
 * @param {import("./ledger.js").Summary} sum
 * @param {DateKey} today
 */
function buildBanners(sum, today) {
  const list = [];
  if (flashNotice) list.push(flashNotice);
  if (!appState) return list;

  const setup = setupEntry();

  // 1. Evening dose still unlogged late in the day.
  if (new Date().getHours() >= EVENING_BANNER_HOUR && !doseEntry(today, "pm")) {
    list.push({
      key: "evening-unlogged",
      severity: "warn",
      text: "The evening dose is not logged yet.",
    });
  }

  // 2. A run of completed days with nothing logged. Those days are estimated,
  //    so say so before the surplus quietly leans on them.
  if (setup) {
    const streak = unloggedStreak(today, setup.date);
    if (streak >= UNLOGGED_DAYS_BANNER) {
      list.push({
        key: "days-unlogged",
        severity: "warn",
        text: `${streak} days in a row have no dose logged. They are estimated from your plan.`,
      });
    }
  }

  // 3. Balance below the user's own days of supply threshold.
  const low = appState.meta.lowBalanceDays;
  const daysLeft = sum.projection.daysLeft;
  if (Number.isFinite(daysLeft) && low > 0 && daysLeft < low) {
    const text =
      daysLeft <= 0
        ? "You run out of pills today. Time to refill."
        : `${daysLeft} ${plural(daysLeft, "day", "days")} of pills left. Time to refill.`;
    list.push({ key: "low-balance", severity: "urgent", text });
  }

  // 4. Backup staleness, owned entirely by src/export.js.
  let staleness = null;
  try {
    staleness = exportStaleness(appState, today);
  } catch {
    staleness = null; // export.js may not be finished yet.
  }
  if (staleness && staleness.stale) {
    const text =
      staleness.daysSince === null
        ? `No backup yet. Export one at least every ${STALE_AFTER_DAYS} days.`
        : `Your last backup was ${staleness.daysSince} ${plural(staleness.daysSince, "day", "days")} ago.`;
    list.push({ key: "backup-stale", severity: "info", text, action: { label: "Export now", action: "export" } });
  }

  return list;
}

/**
 * How many completed days in a row, counting back from yesterday, hold no dose
 * entry at all. The setup day is excluded: it never estimates.
 * @param {DateKey} today @param {DateKey} setupDate @returns {number}
 */
function unloggedStreak(today, setupDate) {
  if (!appState) return 0;
  const logged = new Set(appState.entries.filter((e) => e.type === "dose").map((e) => e.date));
  let n = 0;
  let day = addDays(today, -1);
  while (day > setupDate && n < 60) {
    if (logged.has(day)) break;
    n += 1;
    day = addDays(day, -1);
  }
  return n;
}

/** @param {{key:string}} banner @param {DateKey} today */
function dismissKey(banner, today) {
  return `${today}:${banner.key}`;
}

/**
 * The region is aria-live, so it is only refilled when the visible set of
 * notices actually changes.
 * @param {import("./ledger.js").Summary} sum @param {DateKey} today
 */
function renderBanners(sum, today) {
  const region = el("banner-region");
  const visible = buildBanners(sum, today).filter((b) => !dismissed.has(dismissKey(b, today)));
  const signature = visible
    .map((b) => `${b.key}|${b.severity}|${b.text}|${b.action ? b.action.label : ""}`)
    .join("\n");
  if (signature === bannerSignature) return;
  bannerSignature = signature;

  region.replaceChildren();
  const tpl = el("tpl-banner");
  for (const b of visible) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.severity = b.severity;
    node.querySelector(".banner__text").textContent = b.text;

    const actionBtn = node.querySelector(".banner__action");
    if (b.action) {
      actionBtn.textContent = b.action.label;
      actionBtn.dataset.action = b.action.action;
      actionBtn.hidden = false;
    }

    const dismissBtn = node.querySelector(".banner__dismiss");
    dismissBtn.addEventListener("click", () => {
      dismissed.add(dismissKey(b, today));
      if (flashNotice && flashNotice.key === b.key) clearFlash();
      node.remove();
      bannerSignature = null;
      render();
    });

    region.append(node);
  }
}

// --- History ---------------------------------------------------------------

/**
 * Stored entries plus the derived `estimated` rows, newest first. Estimated
 * rows sort to the end of their day because that is when ledger.js charges
 * them, which puts them first inside the day once the order is reversed.
 * @param {DateKey} today
 */
function buildRows(today) {
  const sorted = sortEntries(appState.entries);
  const rows = sorted.map((e) => ({ kind: "entry", entry: e, date: e.date, order: e.seq }));

  const setup = sorted.find((e) => e.type === "setup");
  if (setup) {
    const loggedSlots = new Set(sorted.filter((e) => e.type === "dose").map((e) => `${e.date}/${e.slot}`));
    let day = addDays(setup.date, 1);
    const windowStart = addDays(today, -ESTIMATED_ROW_WINDOW_DAYS);
    if (windowStart > day) day = windowStart;
    let guard = 0;
    while (day < today && guard <= ESTIMATED_ROW_WINDOW_DAYS + 1) {
      let plan = null;
      SLOTS.forEach((slot, i) => {
        if (loggedSlots.has(`${day}/${slot}`)) return;
        if (plan === null) plan = effectiveAt(sorted, day).plan;
        rows.push({ kind: "estimated", slot, qty: plan[slot], date: day, order: 1e12 + i });
      });
      day = addDays(day, 1);
      guard += 1;
    }
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.order - a.order;
  });
  return rows;
}

/** @param {DateKey} today */
function renderHistory(today) {
  const list = el("history-list");
  const rows = buildRows(today);
  const gapMap = gaps(appState.entries, today);

  el("history-empty").hidden = rows.length > 0;

  const tpl = el("tpl-entry-row");
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    frag.append(renderRow(row, gapMap, tpl));
  }
  list.replaceChildren(frag);
}

/** @param {any} row @param {Map<string, number>} gapMap @param {HTMLTemplateElement} tpl */
function renderRow(row, gapMap, tpl) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  const badge = node.querySelector(".entry__badge");
  const label = node.querySelector(".entry__label");
  const detail = node.querySelector(".entry__detail");
  const qty = node.querySelector(".entry__qty");
  const gapLine = node.querySelector(".entry__gap");
  const editBtn = node.querySelector(".entry__edit");
  const deleteBtn = node.querySelector(".entry__delete");

  node.querySelector(".entry__date").textContent = rowDate(row.date);
  detail.textContent = "";
  qty.textContent = "";

  if (row.kind === "estimated") {
    // Derived, not stored. No id, so nothing to edit or delete. See
    // CLAUDE.md invariant 2 for why nothing like this is ever written down.
    node.dataset.kind = "estimated";
    node.removeAttribute("data-id");
    badge.textContent = "EST";
    label.textContent = `${SLOT_NAMES[row.slot]} assumed`;
    detail.textContent = "no dose logged, the plan was used";
    qty.textContent = fmt(row.qty);
    editBtn.hidden = true;
    deleteBtn.hidden = true;
    return node;
  }

  const e = row.entry;
  node.dataset.id = e.id;

  switch (e.type) {
    case "dose":
      if (e.qty === 0) {
        node.dataset.kind = "skip";
        badge.textContent = "SKIP";
        label.textContent = `${SLOT_NAMES[e.slot]} skipped`;
        qty.textContent = "0";
      } else {
        node.dataset.kind = "dose";
        badge.textContent = "DOSE";
        label.textContent = `${SLOT_NAMES[e.slot]} dose`;
        qty.textContent = fmt(e.qty);
      }
      break;

    case "fill":
      node.dataset.kind = "fill";
      badge.textContent = "FILL";
      label.textContent = "Refill";
      qty.textContent = `+${fmt(e.qty)}`;
      break;

    case "recount": {
      node.dataset.kind = "recount";
      badge.textContent = "RECOUNT";
      label.textContent = "Recount";
      qty.textContent = `counted ${fmt(e.qty)}`;
      const gap = gapMap.get(e.id) ?? 0;
      if (gap > 0) {
        showText(gapLine, `${fmt(gap)} ${plural(gap, "pill", "pills")} unaccounted`);
      }
      break;
    }

    case "setup":
      node.dataset.kind = "setup";
      badge.textContent = "SETUP";
      label.textContent = "First count";
      qty.textContent = `counted ${fmt(e.qty)}`;
      deleteBtn.hidden = true; // the setup entry cannot be deleted
      break;

    case "settings": {
      node.dataset.kind = "settings";
      badge.textContent = "PLAN";
      label.textContent = "Plan change";
      detail.textContent = settingsDetail(e);
      break;
    }

    default:
      node.dataset.kind = "settings";
      badge.textContent = "";
      label.textContent = String(e.type);
      break;
  }

  return node;
}

/** @param {import("./ledger.js").Entry} e */
function settingsDetail(e) {
  const parts = [];
  if (e.plan) parts.push(`plan ${fmt(e.plan.am)} and ${fmt(e.plan.pm)}`);
  if (e.prescribedPerDay !== undefined) parts.push(`prescribed ${fmt(e.prescribedPerDay)} per day`);
  return parts.join(", ");
}

// --- Actions ---------------------------------------------------------------

/** @param {DateKey} today */
function renderActions(today) {
  // Dates are prefilled only when blank, so a render never clears a date the
  // user is part way through changing.
  const fillDate = el("fill-date");
  if (!fillDate.value) fillDate.value = today;
  const recountDate = el("recount-date");
  if (!recountDate.value) recountDate.value = today;

  const last = appState.meta.lastExportAt;
  el("export-last").textContent = last ? `Last backup ${rowDate(last)}.` : "No backup yet.";
}

/** @param {string} text */
function actionStatus(text) {
  showText(el("actions-status"), text);
}

// --- Settings --------------------------------------------------------------

/** @param {import("./ledger.js").Summary} sum */
function renderSettings(sum) {
  if (settingsDirty) return;
  el("settings-prescribed").value = String(sum.effective.prescribedPerDay);
  el("settings-plan-am").value = String(sum.effective.plan.am);
  el("settings-plan-pm").value = String(sum.effective.plan.pm);
  el("settings-low-days").value = String(appState.meta.lowBalanceDays);
}

// --- Setup -----------------------------------------------------------------

function renderSetupStep() {
  for (const n of [1, 2, 3]) {
    el(`setup-step-${n}`).hidden = n !== setupStep;
  }
  el("setup-back").hidden = setupStep === 1;
  el("setup-next").hidden = setupStep === 3;
  el("setup-finish").hidden = setupStep !== 3;
  hideText(el("setup-error"));
}

/** @returns {boolean} */
function setupStepValid() {
  const err = el("setup-error");
  if (setupStep === 1) {
    if (!isValidQty(Number(el("setup-count").value))) {
      showText(err, "Count the bottle as a number of pills in steps of 0.5, for example 40 or 39.5.");
      el("setup-count").focus();
      return false;
    }
  }
  if (setupStep === 2) {
    if (!isValidQty(Number(el("setup-plan-am").value)) || !isValidQty(Number(el("setup-plan-pm").value))) {
      showText(err, "Each planned dose must be 0 or more, in steps of 0.5.");
      return false;
    }
  }
  if (setupStep === 3) {
    if (!isValidQty(Number(el("setup-prescribed").value))) {
      showText(err, "The prescribed rate must be 0 or more, in steps of 0.5.");
      el("setup-prescribed").focus();
      return false;
    }
  }
  hideText(err);
  return true;
}

function finishSetup() {
  if (!setupStepValid()) return;
  const today = todayKey();
  try {
    appState = createState({
      count: Number(el("setup-count").value),
      plan: { am: Number(el("setup-plan-am").value), pm: Number(el("setup-plan-pm").value) },
      prescribedPerDay: Number(el("setup-prescribed").value),
      today,
    });
  } catch (err) {
    showText(el("setup-error"), readable(err));
    return;
  }
  save(appState);
  settingsDirty = false;
  bannerSignature = null;
  leaveSetupMode();
  render();
}

// ---------------------------------------------------------------------------
// The entry editor dialog
// ---------------------------------------------------------------------------

/** @param {string} type */
function syncDialogFields(type) {
  setHidden(el("entry-slot-field"), type !== "dose");
  setHidden(el("entry-qty-field"), type === "settings");
  setHidden(el("entry-prescribed-field"), type !== "settings");
  setHidden(el("entry-plan-am-field"), type !== "settings");
  setHidden(el("entry-plan-pm-field"), type !== "settings");
}

/** @param {string|null} id */
function openDialog(id) {
  const today = todayKey();
  const sum = summary(appState.entries, today);
  const dialog = el("entry-dialog");
  hideText(el("entry-error"));

  const existing = id ? entryById(id) : undefined;
  if (id && !existing) {
    flash("That entry is gone already.", "warn");
    render();
    return;
  }

  if (existing) {
    el("entry-dialog-title").textContent = "Edit entry";
    el("entry-id").value = existing.id;
    el("entry-type").value = existing.type;
    el("entry-date").value = existing.date;
    el("entry-slot").value = existing.slot ?? "am";
    el("entry-qty").value = existing.qty !== undefined ? String(existing.qty) : "";
    el("entry-prescribed").value =
      existing.prescribedPerDay !== undefined ? String(existing.prescribedPerDay) : String(sum.effective.prescribedPerDay);
    el("entry-plan-am").value = existing.plan ? String(existing.plan.am) : String(sum.effective.plan.am);
    el("entry-plan-pm").value = existing.plan ? String(existing.plan.pm) : String(sum.effective.plan.pm);
    el("entry-delete").hidden = existing.type === "setup";
    syncDialogFields(existing.type);
  } else {
    el("entry-dialog-title").textContent = "Add entry";
    el("entry-id").value = "";
    el("entry-type").value = "dose";
    el("entry-date").value = today;
    el("entry-slot").value = "am";
    el("entry-qty").value = String(sum.effective.plan.am);
    el("entry-prescribed").value = String(sum.effective.prescribedPerDay);
    el("entry-plan-am").value = String(sum.effective.plan.am);
    el("entry-plan-pm").value = String(sum.effective.plan.pm);
    el("entry-delete").hidden = true;
    syncDialogFields("dose");
  }

  dialog.showModal();
}

function closeDialog() {
  const dialog = el("entry-dialog");
  if (dialog.open) dialog.close();
}

/**
 * Build the patch for the chosen kind. Fields that do not belong to the kind
 * are set to undefined so `updateEntry` removes them, which is what makes
 * changing a dose into a fill work.
 * @returns {{ok:true, patch:any}|{ok:false, message:string}}
 */
function readDialog() {
  const type = el("entry-type").value;
  const date = el("entry-date").value;
  if (!isValidDateKey(date)) return { ok: false, message: "Pick a real date." };

  /** @type {any} */
  const patch = {
    type,
    date,
    slot: undefined,
    qty: undefined,
    prescribedPerDay: undefined,
    plan: undefined,
  };

  if (type === "settings") {
    const prescribed = Number(el("entry-prescribed").value);
    const am = Number(el("entry-plan-am").value);
    const pm = Number(el("entry-plan-pm").value);
    if (!isValidQty(prescribed) || !isValidQty(am) || !isValidQty(pm)) {
      return { ok: false, message: "Every value must be 0 or more, in steps of 0.5." };
    }
    patch.prescribedPerDay = prescribed;
    patch.plan = { am, pm };
    return { ok: true, patch };
  }

  const qty = Number(el("entry-qty").value);
  if (!isValidQty(qty)) {
    return { ok: false, message: "Pills must be 0 or more, in steps of 0.5, for example 1 or 1.5." };
  }
  patch.qty = qty;
  if (type === "dose") patch.slot = el("entry-slot").value;
  return { ok: true, patch };
}

function saveDialog() {
  const read = readDialog();
  if (!read.ok) {
    showText(el("entry-error"), read.message);
    return;
  }
  const id = el("entry-id").value;
  const ok = mutate((s) => {
    if (id) return updateEntry(s, id, read.patch);
    const clean = {};
    for (const [k, v] of Object.entries(read.patch)) {
      if (v !== undefined) clean[k] = v;
    }
    return addEntry(s, clean);
  });
  if (ok) {
    closeDialog();
  } else {
    // mutate already rendered the failure as a banner; keep it in the dialog too.
    showText(el("entry-error"), flashNotice ? flashNotice.text : "That change was rejected.");
  }
}

// ---------------------------------------------------------------------------
// Backup, delegated to src/export.js
// ---------------------------------------------------------------------------

function doExport() {
  const today = todayKey();
  let text;
  try {
    text = exportJSON(appState);
  } catch (err) {
    actionStatus(`Export failed. ${readable(err)}`);
    return;
  }
  try {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ptracker_backup_${today}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    actionStatus(`Export failed. ${readable(err)}`);
    return;
  }
  mutate((s) => markExported(s, today));
  actionStatus("Backup saved to your downloads.");
}

async function doImport() {
  const input = el("import-file");
  const file = input.files && input.files[0];
  if (!file) {
    actionStatus("Choose a backup file first.");
    return;
  }
  if (!window.confirm("Importing replaces everything stored now. Continue?")) return;

  let text;
  try {
    text = await file.text();
  } catch (err) {
    actionStatus(`Could not read that file. ${readable(err)}`);
    return;
  }

  let result;
  try {
    result = importJSON(text);
  } catch (err) {
    actionStatus(`Import failed. ${readable(err)}`);
    return;
  }

  if (!result || !result.ok) {
    const errors = result && Array.isArray(result.errors) ? result.errors : [];
    actionStatus(errors.length > 0 ? `Import rejected. ${sentence(errors.join(" "))}` : "Import rejected.");
    return;
  }

  appState = result.state;
  save(appState);
  input.value = "";
  settingsDirty = false;
  bannerSignature = null;
  dismissed.clear();
  render();
  actionStatus("Backup imported.");
}

// ---------------------------------------------------------------------------
// Event wiring. One delegated click listener on #app, one on #entry-dialog,
// plus the form submits. Every control carries data-action.
// ---------------------------------------------------------------------------

function onAppClick(ev) {
  const target = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case "show-view":
      showView(target.dataset.view);
      break;

    case "log-dose": {
      // THE FIREWALL. One reducer, one entry, nothing else.
      const slot = target.dataset.slot;
      const qty = Number(target.dataset.qty);
      mutate((s) => logDose(s, { slot, qty, date: todayKey() }));
      break;
    }

    case "undo-dose": {
      const slot = target.dataset.slot;
      const existing = doseEntry(todayKey(), slot);
      if (!existing) return;
      mutate((s) => deleteEntry(s, existing.id));
      break;
    }

    case "add-entry":
      openDialog(null);
      break;

    case "edit-entry": {
      const row = target.closest(".entry");
      if (!row || !row.dataset.id) return;
      openDialog(row.dataset.id);
      break;
    }

    case "delete-entry": {
      const row = target.closest(".entry");
      if (!row || !row.dataset.id) return;
      if (!window.confirm("Delete this entry?")) return;
      mutate((s) => deleteEntry(s, row.dataset.id));
      break;
    }

    case "export":
      doExport();
      break;

    case "import":
      void doImport();
      break;

    case "setup-next":
      if (!setupStepValid()) return;
      setupStep = Math.min(3, setupStep + 1);
      renderSetupStep();
      break;

    case "setup-back":
      setupStep = Math.max(1, setupStep - 1);
      renderSetupStep();
      break;

    default:
      break;
  }
}

function onDialogClick(ev) {
  const target = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
  if (!target) return;

  switch (target.dataset.action) {
    case "cancel-entry":
      closeDialog();
      break;

    // Shares its action value with the history rows. Inside the dialog there is
    // no owning row, so the id comes from the hidden field.
    case "delete-entry": {
      const id = el("entry-id").value;
      if (!id) {
        closeDialog();
        return;
      }
      if (!window.confirm("Delete this entry?")) return;
      if (mutate((s) => deleteEntry(s, id))) closeDialog();
      else showText(el("entry-error"), flashNotice ? flashNotice.text : "That entry could not be deleted.");
      break;
    }

    default:
      break;
  }
}

function onTabKeydown(ev) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(ev.key)) return;
  const i = VIEWS.indexOf(currentView);
  if (i === -1) return;
  let next = i;
  if (ev.key === "ArrowLeft") next = (i + VIEWS.length - 1) % VIEWS.length;
  if (ev.key === "ArrowRight") next = (i + 1) % VIEWS.length;
  if (ev.key === "Home") next = 0;
  if (ev.key === "End") next = VIEWS.length - 1;
  ev.preventDefault();
  showView(VIEWS[next], false);
  el(`tab-${VIEWS[next]}`).focus();
}

function onFillSubmit(ev) {
  ev.preventDefault();
  const qty = Number(el("fill-qty").value);
  const date = el("fill-date").value;
  if (!isValidQty(qty)) {
    actionStatus("Pills picked up must be 0 or more, in steps of 0.5.");
    return;
  }
  if (!isValidDateKey(date)) {
    actionStatus("Pick a real date for the refill.");
    return;
  }
  if (mutate((s) => recordFill(s, { qty, date }))) {
    el("fill-qty").value = "";
    el("fill-date").value = todayKey();
    actionStatus(`Refill of ${fmt(qty)} recorded.`);
  }
}

function onRecountSubmit(ev) {
  ev.preventDefault();
  const qty = Number(el("recount-qty").value);
  const date = el("recount-date").value;
  if (!isValidQty(qty)) {
    actionStatus("Pills counted must be 0 or more, in steps of 0.5.");
    return;
  }
  if (!isValidDateKey(date)) {
    actionStatus("Pick a real date for the recount.");
    return;
  }
  const before = appState.nextSeq;
  if (mutate((s) => recordRecount(s, { qty, date }))) {
    el("recount-qty").value = "";
    el("recount-date").value = todayKey();
    // The gap is derived, so read it back rather than storing it anywhere.
    const gap = gaps(appState.entries, todayKey()).get(`e${before}`) ?? 0;
    actionStatus(
      gap > 0
        ? `Recount saved. ${fmt(gap)} ${plural(gap, "pill", "pills")} unaccounted.`
        : "Recount saved. Nothing unaccounted.",
    );
  }
}

function onSettingsSubmit(ev) {
  ev.preventDefault();
  const err = el("settings-error");
  const prescribed = Number(el("settings-prescribed").value);
  const am = Number(el("settings-plan-am").value);
  const pm = Number(el("settings-plan-pm").value);
  const lowDays = Number(el("settings-low-days").value);

  if (!isValidQty(prescribed) || !isValidQty(am) || !isValidQty(pm)) {
    showText(err, "The rate and both planned doses must be 0 or more, in steps of 0.5.");
    return;
  }
  if (!Number.isInteger(lowDays) || lowDays < 0) {
    showText(err, "The warning threshold must be a whole number of days, 0 or more.");
    return;
  }
  hideText(err);

  const today = todayKey();
  const current = summary(appState.entries, today).effective;
  const planChanged = current.plan.am !== am || current.plan.pm !== pm;
  const rateChanged = current.prescribedPerDay !== prescribed;

  const ok = mutate((s) => {
    // The one and only call to updateSettings in this file. A dated entry, so
    // past days keep the values that were in force then.
    let next = s;
    if (planChanged || rateChanged) {
      next = updateSettings(next, { prescribedPerDay: prescribed, plan: { am, pm } }, today);
    }
    if (next.meta.lowBalanceDays !== lowDays) {
      next = setLowBalanceDays(next, lowDays);
    }
    return next;
  });

  if (ok) {
    settingsDirty = false;
    showText(el("settings-status"), planChanged || rateChanged ? "Saved, dated today." : "Saved.");
    render();
  } else {
    showText(err, flashNotice ? flashNotice.text : "Those settings were rejected.");
  }
}

function onSetupSubmit(ev) {
  ev.preventDefault();
  if (setupStep < 3) {
    if (setupStepValid()) {
      setupStep += 1;
      renderSetupStep();
    }
    return;
  }
  finishSetup();
}

function onVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (!appState) return;
  // The app sits open on a phone for days. If the calendar day rolled over,
  // today's slots and every date sensitive banner need recomputing.
  if (renderedDay !== todayKey()) {
    dismissed.clear();
    bannerSignature = null;
  }
  render();
}

function wire() {
  el("app").addEventListener("click", onAppClick);
  el("entry-dialog").addEventListener("click", onDialogClick);
  el("tabbar").addEventListener("keydown", onTabKeydown);

  el("setup-form").addEventListener("submit", onSetupSubmit);
  el("fill-form").addEventListener("submit", onFillSubmit);
  el("recount-form").addEventListener("submit", onRecountSubmit);
  el("settings-form").addEventListener("submit", onSettingsSubmit);
  el("settings-form").addEventListener("input", () => {
    settingsDirty = true;
    hideText(el("settings-status"));
  });

  el("entry-form").addEventListener("submit", (ev) => {
    // The form is method="dialog", so without this the dialog closes even when
    // the entry was rejected.
    ev.preventDefault();
    saveDialog();
  });
  el("entry-type").addEventListener("change", (ev) => {
    syncDialogFields(ev.target.value);
    hideText(el("entry-error"));
  });

  document.addEventListener("visibilitychange", onVisibilityChange);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Boot the UI against the document that is already there. Safe to call once.
 * src/main.js owns calling it.
 * @returns {void}
 */
export function init() {
  if (booted) return;
  booted = true;

  appState = load();
  wire();

  if (appState === null) {
    enterSetupMode();
    return;
  }

  el("app").dataset.mode = "ready";
  showView("home", false);
  render();
}
