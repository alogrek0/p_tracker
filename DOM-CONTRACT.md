# DOM contract

What `index.html` provides and what `src/ui.js` is expected to do with it.
`index.html` is a static skeleton. It contains no JavaScript beyond the single
module tag for `./src/main.js`. Every value shown to the user is written by
`src/ui.js`.

## Naming convention

* **ids** are kebab case, prefixed by the area they belong to:
  `view-*`, `tab-*`, `slot-*`, `stat-*`, `history-*`, `fill-*`, `recount-*`,
  `setup-*`, `settings-*`, `entry-*`, `tpl-*`.
* **classes** are light BEM: `block`, `block__element`, `block--modifier`.
  Classes are for styling only. Never read state from a class.
* **state** lives in `data-` attributes, never in class names, so `ui.js` sets
  one attribute rather than juggling class lists:
  `data-mode`, `data-logged`, `data-sign`, `data-severity`, `data-kind`, `data-step`.
* **event wiring** is meant to be one delegated listener on `#app` plus one on
  `#entry-dialog`, keyed on `data-action`. Every interactive control carries a
  `data-action`. Doses and undo also carry `data-slot`, and dose buttons carry
  `data-qty`. History row buttons carry no id, so `ui.js` reads the owning row
  through `closest(".entry")` and its `data-id`.
* `hidden` is the show and hide mechanism everywhere. `styles.css` sets
  `[hidden] { display: none !important }` so it wins against every layout rule.

## Copy rule

All visible strings written by `ui.js` follow the CLAUDE.md rule: no em dashes,
no en dashes, no hyphens used as punctuation.

---

## Shell

| id | element | contents and expected use |
|---|---|---|
| `app` | `div` | Root. Carries `data-mode`. `"ready"` is the normal app. `"setup"` hides the tab bar and drops the bottom padding. `ui.js` sets `data-mode="setup"` on first run and back to `"ready"` once setup finishes. |
| `appbar` | `header` | Sticky title bar. No dynamic content of its own. |
| `today-label` | `p` | Empty in markup. `ui.js` writes today's date as a friendly local string, for example `Friday 19 September`. |
| `banner-region` | `div` | Notices live here. `role="status"`, `aria-live="polite"`. `ui.js` empties it and appends clones of `#tpl-banner`. See Banners. |
| `main` | `main` | Holds all five views. Target of the skip link. |
| `tabbar` | `nav` | Fixed bottom bar. Hidden while `#app[data-mode="setup"]`. |

### Views

Five sections. Exactly one is visible at a time. All but `#view-home` start
`hidden` in the markup. `#view-setup` is not a tab panel and has no tab.

| id | tab | notes |
|---|---|---|
| `view-setup` | none | First run flow. Shown only when `state.load()` returns null. |
| `view-home` | `tab-home` | Default view. Visible in the markup. |
| `view-history` | `tab-history` | |
| `view-actions` | `tab-actions` | |
| `view-settings` | `tab-settings` | |

Tab buttons: `tab-home`, `tab-history`, `tab-actions`, `tab-settings`. Each has
`data-action="show-view"` and `data-view="home|history|actions|settings"`, plus
`aria-controls` pointing at its panel.

**Switching views, all four steps are required:**

1. `hidden = true` on every `.view`, then `hidden = false` on the chosen one.
2. `aria-selected="true"` on the chosen tab, `"false"` on the other three.
3. `tabindex="-1"` on the unselected tabs and `tabindex="0"` (or remove the
   attribute) on the selected one, so the tab strip is a single tab stop.
4. Optionally `focus()` the newly shown panel. Each panel already has
   `tabindex="-1"` for this.

Arrow key navigation across the tab strip is `ui.js` work if wanted. The markup
supplies the roles.

---

## Banners

`#banner-region` is emptied and refilled on every render. Clone
`#tpl-banner`, which yields:

| selector inside the clone | use |
|---|---|
| `.banner` | Root. Set `data-severity` to one of `info`, `ok`, `warn`, `urgent`. Styled for all four. Default in the template is `info`. |
| `.banner__text` | `textContent` is the notice. |
| `.banner__action` | Optional button. Starts `hidden`. To use it, set `textContent`, set `dataset.action` to whatever `ui.js` handles, un-hide it. |
| `.banner__dismiss` | Always present, labelled for screen readers. `ui.js` owns the dismiss behaviour and the memory of what was dismissed. It has no `data-action` because the payload differs per banner. Wire it when the clone is built. |

Severity intent, for the four notices the plan names:

* evening dose not logged after the threshold hour: `warn`
* several days unlogged: `warn`
* balance below the low balance threshold: `urgent`
* export is stale: `info`

Because the region is `aria-live="polite"`, refill it only when the set of
notices actually changed. Rewriting it on every keystroke will spam a screen
reader.

---

## Home

### Slot cards

Two identical cards. Everything below is listed once with `{slot}` standing for
`am` or `pm`. Both sets exist in the markup.

| id | element | expected use |
|---|---|---|
| `slot-{slot}` | `article` | Card root. Set `data-logged="true"` once today's dose for this slot exists, `"false"` otherwise. Drives the logged styling. |
| `slot-{slot}-title` | `h3` | Static, `Morning` or `Evening`. Also the accessible name of the dose button group. Do not rewrite it. |
| `slot-{slot}-plan` | `p` | Empty in markup. Write the planned amount, for example `plan 1`. Comes from `summary.effective.plan[slot]`. |
| `slot-{slot}-status` | `p` | One short line of state, for example `Not logged yet` or `Logged at 08:12`. |
| `slot-{slot}-open` | `div` | Wraps the three dose buttons and the skip button. `hidden = true` once logged. |
| `slot-{slot}-doses` | `div` | `role="group"` over the three buttons. No dynamic content. |
| `slot-{slot}-skip` | `button` | The smaller skip affordance. `data-action="log-dose"`, `data-slot="{slot}"`, `data-qty="0"`. A qty of 0 is a deliberate skip, which banks pills and is not estimated. |
| `slot-{slot}-done` | `div` | The logged state. `hidden = false` once logged. |
| `slot-{slot}-taken` | `p` | Write what was taken, for example `Took 1` or `Skipped`. |
| `slot-{slot}-undo` | `button` | `data-action="undo-dose"`, `data-slot="{slot}"`. Deletes today's dose entry for this slot. |

The three dose buttons have no ids. They are identified by their dataset:
`data-action="log-dose"`, `data-slot`, and `data-qty` of `0.5`, `1`, `1.5`.
Read `Number(button.dataset.qty)`. They are equal width by grid and at least
62px tall.

`ui.js` must toggle `slot-{slot}-open` and `slot-{slot}-done` together with
`data-logged` on the card. Nothing in the CSS does that for you.

### Stat row

| id | element | expected use |
|---|---|---|
| `stats` | `div` | Grid container. Surplus spans the full width, the other two sit side by side. |
| `stat-surplus` | `div` | Headline tile. Set `data-sign` to `positive`, `negative`, or `zero`. That attribute, not a class, picks the colour and the negative border. |
| `stat-surplus-value` | `p` | The number only, for example `1`, `0`, `-12.5`. Do not add a unit here. The type is tabular and sized with `clamp`, so a minus sign and a longer value still fit at 320px. |
| `stat-surplus-note` | `p` | The quiet qualifier. Starts `hidden`. Un-hide and write when `summary.surplus.estimatedDays > 0`, for example `includes 3 estimated days`. Hide it again when the count is 0. |
| `stat-balance-value` | `p` | Pills on hand, from `summary.balance`. |
| `stat-runout-value` | `p` | Run out date as a short local string, for example `9 Oct`. |
| `stat-runout-note` | `p` | Optional second line, for example `18 days left`. Starts `hidden`. |
| `stat-refill` | `div` | Half width tile with `stat--under`, which pins it to the right column under Runs out on narrow screens. |
| `stat-refill-value` | `p` | `nextRefill(entries, today).dueDate`, 27 days after the last fill (the earliest the pharmacy refills a 30 day supply), as a short local string, for example `3 Oct`. `none yet` before any fill. |
| `stat-refill-note` | `p` | Second line, for example `in 9 days`, `due today`, `due 2 days ago`. Starts `hidden`. |

Labels `stat-surplus-label`, `stat-balance-label`, `stat-runout-label`, `stat-refill-label` are
static and are referenced by `aria-describedby` on the values. Leave them alone.

---

## History

| id | element | expected use |
|---|---|---|
| `history-add` | `button` | `data-action="add-entry"`. Opens `#entry-dialog` empty, for a backdated entry. |
| `history-empty` | `p` | Starts `hidden`. Un-hide when the list is empty. |
| `history-list` | `ol` | Emptied and refilled in reverse chronological order. Append clones of `#tpl-entry-row`. |

### Row template, `#tpl-entry-row`

One clone per rendered row. Selectors inside the clone:

| selector | use |
|---|---|
| `.entry` | Row root, an `li`. Set `dataset.id` to the entry id so the Edit and Delete buttons can find it through `closest(".entry")`. Set `data-kind` to pick the visual treatment. |
| `.entry__date` | The date, for example `Fri 19 Sep`. |
| `.entry__badge` | Short uppercase tag, for example `DOSE`, `EST`, `SKIP`, `FILL`, `RECOUNT`. Coloured by the row `data-kind`. Leave it empty and it disappears. |
| `.entry__label` | Main line, for example `Morning dose`. |
| `.entry__detail` | Optional second line, for example `plan was 1 and 1`. Empty means hidden. |
| `.entry__qty` | The number at the right, for example `1`, `+60`, `counted 37`. |
| `.entry__gap` | The derived gap, shown inline inside its recount row. Starts `hidden`. Un-hide on a recount whose derived gap is greater than 0 and write something like `1 pill unaccounted`. Never a stored entry. See CLAUDE.md invariant 2. |
| `.entry__edit` | `data-action="edit-entry"`. Opens `#entry-dialog` populated from this entry. |
| `.entry__delete` | `data-action="delete-entry"`. Deletes this entry. Hide it on the `setup` entry, which cannot be deleted. |

### `data-kind` values, all styled distinctly

| value | meaning | treatment |
|---|---|---|
| `dose` | a logged dose with qty above 0 | solid accent left edge |
| `estimated` | a slot with no entry, assumed to have followed the plan | dashed amber left edge, dimmed italic text |
| `skip` | a dose entry with qty 0, a deliberate skip | dotted grey left edge, dimmed quantity |
| `fill` | pills picked up | green left edge, green quantity |
| `recount` | a bottle recount | purple left edge |
| `gap` | unaccounted pills, if rendered as a standalone row rather than inside `.entry__gap` | red left edge, tinted background |
| `setup` | the first run bottle count | neutral left edge |
| `settings` | a dated settings change | neutral left edge |

`estimated` rows are derived, not stored. They have no entry id, so hide
`.entry__edit` and `.entry__delete` on them, or give them an action that opens
the dialog prefilled to create the missing dose.

The preferred rendering of a gap is `.entry__gap` inside the recount row, which
is what the plan asks for. The standalone `data-kind="gap"` styling exists as a
fallback.

---

## Actions

| id | element | expected use |
|---|---|---|
| `fill-form` | `form` | `submit` handler. Call `preventDefault`. |
| `fill-qty` | `input[type=number]` | `step="0.5"`, `min="0"`. Validate with `isValidQty` before writing. |
| `fill-date` | `input[type=date]` | Prefill with today's `DateKey`. The value is already `YYYY-MM-DD`, so pass it straight through. Never feed it to `new Date(string)`. |
| `fill-save` | `button[type=submit]` | |
| `recount-form` | `form` | `submit` handler. |
| `recount-qty` | `input[type=number]` | |
| `recount-date` | `input[type=date]` | Prefill with today. |
| `recount-save` | `button[type=submit]` | |
| `export-last` | `p` | Write the last export date or `No backup yet`. |
| `export-btn` | `button` | `data-action="export"`. |
| `import-file` | `input[type=file]` | Labelled, accepts JSON. |
| `import-btn` | `button` | `data-action="import"`. Reads the chosen file. Styled as a danger button because import replaces everything. |
| `actions-status` | `p` | `role="status"`. Starts `hidden`. Un-hide and write the result of a save, an export, or an import. |

---

## Settings

| id | element | expected use |
|---|---|---|
| `settings-form` | `form` | `submit` handler. Writes a dated `settings` entry through `updateSettings`. This is the only place the plan changes. |
| `settings-prescribed` | `input[type=number]` | Prefill from `summary.effective.prescribedPerDay`. |
| `settings-plan-am` | `input[type=number]` | Prefill from `summary.effective.plan.am`. |
| `settings-plan-pm` | `input[type=number]` | Prefill from `summary.effective.plan.pm`. |
| `settings-low-days` | `input[type=number]` | Prefill from `state.meta.lowBalanceDays`. This one is UI only. It belongs in `meta`, not in the event log. |
| `settings-error` | `p` | `role="alert"`. Starts `hidden`. Validation failures. |
| `settings-save` | `button[type=submit]` | |
| `settings-status` | `p` | `role="status"`. Starts `hidden`. Confirmation after a save. |
| `app-version` | `p` | Optional. Write the service worker cache version or leave empty. |

---

## Setup, first run

Shown by setting `#app` to `data-mode="setup"` and un-hiding `#view-setup`,
with all four tab panels hidden.

| id | element | expected use |
|---|---|---|
| `setup-form` | `form` | `submit` fires on step 3 only. Call `preventDefault` and then `createState`. |
| `setup-step-1` | `fieldset` | `data-step="1"`. Bottle count. Visible first. |
| `setup-step-2` | `fieldset` | `data-step="2"`. Starts `hidden`. AM and PM plan. |
| `setup-step-3` | `fieldset` | `data-step="3"`. Starts `hidden`. Prescribed rate. |
| `setup-count` | `input[type=number]` | Defaults to 40. |
| `setup-plan-am` | `input[type=number]` | Defaults to 1. |
| `setup-plan-pm` | `input[type=number]` | Defaults to 1. |
| `setup-prescribed` | `input[type=number]` | Defaults to 2. |
| `setup-error` | `p` | `role="alert"`. Starts `hidden`. |
| `setup-back` | `button` | `data-action="setup-back"`. Starts `hidden`. Show on steps 2 and 3. |
| `setup-next` | `button` | `data-action="setup-next"`. Visible on steps 1 and 2. Hide on step 3. |
| `setup-finish` | `button[type=submit]` | `data-action="setup-finish"`. Starts `hidden`. Show on step 3 only. |

`ui.js` owns the step counter. The markup supplies three fieldsets and three
buttons and nothing more.

---

## Entry editor dialog

A native `<dialog>`. Open with `showModal()`, close with `close()`. The form is
`method="dialog"`, so `ui.js` must call `preventDefault` on submit if it wants
to keep the dialog open after a validation failure.

| id | element | expected use |
|---|---|---|
| `entry-dialog` | `dialog` | `aria-labelledby="entry-dialog-title"`. |
| `entry-dialog-title` | `h2` | Set to `Edit entry` or `Add entry`. |
| `entry-form` | `form` | `submit` handler. |
| `entry-id` | `input[type=hidden]` | The entry id being edited. Empty string means a new entry. |
| `entry-type` | `select` | Options: `dose`, `fill`, `recount`, `setup`, `settings`. Its `change` event drives which fields are shown. |
| `entry-date` | `input[type=date]` | |
| `entry-slot-field` | `div` | Wrapper. Show for `dose`, hide otherwise. |
| `entry-slot` | `select` | `am` or `pm`. |
| `entry-qty-field` | `div` | Wrapper. Show for `dose`, `fill`, `recount`, `setup`. Hide for `settings`. |
| `entry-qty` | `input[type=number]` | `step="0.5"`, `min="0"`. |
| `entry-prescribed-field` | `div` | Wrapper. Starts `hidden`. Show for `settings` only. |
| `entry-prescribed` | `input[type=number]` | |
| `entry-plan-am-field` | `div` | Wrapper. Starts `hidden`. Show for `settings` only. |
| `entry-plan-am` | `input[type=number]` | |
| `entry-plan-pm-field` | `div` | Wrapper. Starts `hidden`. Show for `settings` only. |
| `entry-plan-pm` | `input[type=number]` | |
| `entry-error` | `p` | `role="alert"`. Starts `hidden`. Show `validateEntry` output here. |
| `entry-delete` | `button` | `data-action="delete-entry"`. Starts `hidden`. Show when editing an existing entry that is not the `setup` entry. |
| `entry-cancel` | `button` | `data-action="cancel-entry"`. Closes without saving. |
| `entry-save` | `button[type=submit]` | `data-action="save-entry"`. |

Note that `entry-delete` shares the `data-action="delete-entry"` value with the
history row buttons. Disambiguate on `closest(".entry")` being null, or check
the element id.

---

## Templates

| id | yields |
|---|---|
| `tpl-banner` | one `.banner` |
| `tpl-entry-row` | one `.entry` list item |

Clone with `template.content.firstElementChild.cloneNode(true)`. Both templates
sit at the end of `<body>`, outside `#app`, so a delegated listener on `#app`
still catches clicks on appended clones once they are in the document.

---

## Complete class list

Presentation only. `ui.js` should not need to add or remove any of these except
where noted.

**Layout and shell:** `app`, `appbar`, `appbar__title`, `appbar__date`, `main`,
`view`, `view--setup`, `view__head`, `view__title`, `tabbar`, `tabbar__inner`,
`tab`, `skip-link`, `visually-hidden`.

**Banners:** `banners`, `banner`, `banner__text`, `banner__action`,
`banner__dismiss`.

**Cards and text:** `card`, `card__title`, `hint`, `empty`.

**Home:** `slots`, `slot`, `slot__head`, `slot__title`, `slot__plan`,
`slot__status`, `slot__open`, `slot__done`, `slot__taken`, `doses`, `dose`,
`skip`.

**Stats:** `stats`, `stat`, `stat--headline`, `stat__label`, `stat__value`,
`stat__value--small`, `stat__unit`, `stat__note`.

**History:** `entries`, `entry`, `entry__body`, `entry__date`, `entry__title`,
`entry__badge`, `entry__label`, `entry__detail`, `entry__qty`, `entry__gap`,
`entry__controls`, `entry__edit`, `entry__delete`.

**Forms:** `form`, `field`, `field__label`, `field__input`,
`field__input--file`, `form__actions`, `form__actions--spread`, `form__spacer`,
`form__error`, `form__status`, `setup__step`, `setup__legend`.

**Buttons:** `btn`, `btn--primary`, `btn--ghost`, `btn--danger`, `btn--small`.

**Dialog:** `dialog`, `dialog__title`.

## Complete data attribute list

| attribute | on | values |
|---|---|---|
| `data-mode` | `#app` | `ready`, `setup` |
| `data-action` | any control | `show-view`, `log-dose`, `undo-dose`, `add-entry`, `edit-entry`, `delete-entry`, `save-entry`, `cancel-entry`, `export`, `import`, `setup-next`, `setup-back`, `setup-finish` |
| `data-view` | tab buttons | `home`, `history`, `actions`, `settings` |
| `data-slot` | slot cards, dose buttons, skip, undo | `am`, `pm` |
| `data-qty` | dose buttons, skip | `0`, `0.5`, `1`, `1.5` |
| `data-logged` | `.slot` | `true`, `false` |
| `data-sign` | `#stat-surplus` | `positive`, `negative`, `zero` |
| `data-severity` | `.banner` | `info`, `ok`, `warn`, `urgent` |
| `data-kind` | `.entry` | `dose`, `estimated`, `skip`, `fill`, `recount`, `gap`, `setup`, `settings` |
| `data-id` | `.entry` | the entry id. Set by `ui.js`. |
| `data-step` | `.setup__step` | `1`, `2`, `3` |

## Constraints the CSS already guarantees

* No horizontal scroll at 320px. Every grid and flex child carries `min-width: 0`
  and the page uses `box-sizing: border-box` throughout. Do not set inline
  widths, and do not append long unbroken strings without a space.
* Every button and input is at least 44px tall.
* Safe area insets are applied on the app bar top, the tab bar bottom, and the
  left and right page gutters, so content clears the notch and the home
  indicator in standalone mode.
* Light and dark mode both come from the tokens on `:root`. `ui.js` should never
  set a colour.
* The surplus number is tabular and sized with `clamp`, so a minus sign and a
  longer value stay on one line at 320px.
