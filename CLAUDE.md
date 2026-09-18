# Pill ledger

Single file PWA, no build step. index.html holds all markup, CSS, and JS.
Storage key is pill-ledger-v1; do not change it.

## Rules
- Bump VERSION in sw.js whenever index.html, the manifest, or icons change.
- No em dashes, en dashes, or hyphens as punctuation in UI copy or docs.
  Scan with Python; Git Bash grep cannot match \x{2014}.
- Inter is the chosen font. The design hook ignore is in .impeccable/config.json.
- Fewest taps for daily actions. Home shows name, pills and days left, dose
  buttons, and one status sentence. Everything else lives on the detail screen.
- Dose taps log at once with an Undo toast. OK confirmation only for removing
  a dose, deleting a medication, and restoring a backup.
- Pickup schedule anchors on the latest refill entry date. The manual last
  pickup date is a fallback only.

## Testing
- Serve with python -m http.server 8765 and test in a fresh isolated browser
  context. The worker is cache first, so unregister it and clear caches before
  checking an edit.
- beforeinstallprompt never fires under Chrome automation; not a failure.
- Session hooks gate Write, Edit, and Bash on a facts statement; one gated
  Write per message.

## Deploy
- Push to main runs .github/workflows/pages.yml. Live at
  https://alogrek0.github.io/p_tracker/. Confirm with curl on the served
  sw.js VERSION line.
