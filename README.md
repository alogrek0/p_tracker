# Pill ledger

A small personal medication supply ledger that runs entirely in your browser. It is a single static page with no build step, no framework, and no server. All data stays on your device in local storage.

## What it does

For each medication you record the name, how many pills you take per day, the last date the pharmacy filled it, and how many days each fill covers. From there the app keeps a ledger of entries:

- **Refill** adds pills you picked up.
- **Recount** sets the total to what you actually counted on a given date.
- **Adjust** adds or removes a few pills for missed or extra doses.

The current count is derived from the ledger: the latest recount, plus later refills and adjustments, minus your daily dose for each day since the recount. From that the app shows:

- Pills on hand and days left at the current dose.
- The projected run out date.
- The next four pharmacy fill dates, calculated from the last fill date and the days supply.
- Extra supply at the next fill: how many pills (and days) you will have left over when the next fill is due, or how short you will be if the number is negative.
- A status of OK, Low, Shortfall, or Out. Low uses the per medication warning threshold in days.

The page installs to your home screen, follows your system light or dark setting, and works with no network after the first visit.

## Enable GitHub Pages

1. Push this repository to GitHub with `main` as the default branch.
2. Open the repository on GitHub and go to **Settings**, then **Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Push any commit to `main` (or run the **Deploy to GitHub Pages** workflow from the Actions tab). The workflow in `.github/workflows/pages.yml` uploads the repository root and deploys it.
5. The site will be available at `https://<your user>.github.io/<repo name>/`. All paths in the app are relative, so it works under that subpath without changes.

There is no `gh-pages` branch. The `.nojekyll` file tells Pages to serve files exactly as they are.

## Install on iPhone

1. Open the site in Safari.
2. Tap the Share button (the square with an arrow).
3. Tap **Add to Home Screen**, then **Add**.

The icon appears on your home screen and opens without the Safari toolbar. Data is stored separately for the installed app, so run a backup and restore if you already entered data in the Safari tab.

## Install on Android

1. Open the site in Chrome.
2. Tap the three dot menu.
3. Tap **Install app** or **Add to Home screen**, then confirm.

Chrome may also show an install banner at the bottom of the page. Either route gives the same standalone app.

## Move data between devices

Backups are plain text, so any channel that carries text works: an email or message to yourself, a notes app, or a password manager.

1. On the device that has your data, tap **Copy backup**. The full ledger is copied to the clipboard as JSON. If the browser blocks clipboard access, a box appears with the text selected so you can copy it manually.
2. Send that text to the other device.
3. On the other device, copy the text and tap **Paste backup**. The app reads the clipboard, or shows a box to paste into if the browser does not allow reading the clipboard.
4. Confirm the replace. The backup replaces everything currently in the app, so copy a backup of the destination first if it has anything you want to keep.

## Update the service worker cache version

The service worker caches the app shell so the page opens offline. Because the shell is served cache first, browsers keep using the old copy until the worker itself changes. Whenever you edit `index.html`, the manifest, or the icons:

1. Open `sw.js` and change the `VERSION` string, for example from `"v1"` to `"v2"`.
2. Commit and push to `main`.

On their next visit users get the new worker in the background and see an **Update available** bar in the app. Tapping **Reload** activates the new version and deletes the old cache.

## Regenerate the icons

The icons are drawn from `icons/icon.svg`. The PNGs the manifest needs are produced by a small Pillow script:

```
pip install pillow
python scripts/make_icons.py
```

This writes `icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, and `icon-maskable-512.png` into the `icons` folder. If you change the SVG, update the drawing code in the script to match.

## Files

```
index.html                    the whole app
manifest.webmanifest          install metadata
sw.js                         offline cache
icons/                        SVG source and generated PNGs
scripts/make_icons.py         icon generator
.github/workflows/pages.yml   deploy workflow
.nojekyll                     serve files as is
```
