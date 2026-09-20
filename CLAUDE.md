# p_tracker

Personal pill ledger PWA. Single user. Static files on GitHub Pages, no backend,
no build step, native ES modules.

Full design: see the approved plan referenced in the repo history. These are the
rules that must never be broken.

## Invariants

1. **The plan and the log are separate data.** Logging a dose writes a `dose`
   entry and nothing else. It must never mutate the standing plan, the prescribed
   rate, or any projection input. The previous version of this app died from
   exactly this defect. There are no exceptions and no confirm-prompt shortcuts.

2. **The recount gap is derived, never stored.** A gap is recomputed from the log
   on every read. Storing it makes it permanently wrong the moment a real dose is
   backfilled into the window it covered.

3. **Storage key is `ptracker-v2`.** It does not change. The old app's data still
   sits under `pill-ledger-v1` on this same origin and must never be read.

4. **`src/ledger.js` is pure.** No DOM, no localStorage, no implicit clock. Today's
   date is always an argument. This is what makes it testable.

5. **All paths are relative.** Pages serves this from `/p_tracker/`, not from root.
   `start_url` and `scope` are `"./"`.

6. **Dates are local time.** Never `new Date("2026-09-19")`, which parses as UTC and
   lands a day early in negative-offset zones. Build keys from getFullYear /
   getMonth / getDate. Step days with setDate, never by dividing milliseconds.

7. **Quantities are non-negative multiples of 0.5.** Validated at every input and
   on import.

8. **Bump `VERSION` in `sw.js`** on every shipped change to any cached file.

## Copy style

No em dashes, en dashes, or hyphens used as punctuation in UI copy or docs.

## Tests

`npm test` (which is `node --test`). Zero dependencies. Must be green before
anything ships.
