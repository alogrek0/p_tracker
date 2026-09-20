/**
 * Boot.
 *
 * Deliberately thin: it starts the UI, registers the service worker, and owns
 * the one piece of coordination neither of them can own alone, which is what to
 * do when a newer worker takes control of a page that is already open.
 */

import { init } from "./ui.js";
import { registerServiceWorker } from "./sw-register.js";

/**
 * Kept in step with VERSION in sw.js. test/integration.test.js fails if the two
 * drift, because a version shown in Settings that does not match the worker
 * actually serving the app is worse than showing nothing.
 */
const APP_VERSION = "2";

/**
 * True when reloading now would destroy something the user is part way through.
 * The app saves after every mutation, so the only losable state is text typed
 * into an open dialog or a settings field not yet submitted.
 */
function midInteraction() {
  if (document.querySelector("dialog[open]")) return true;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

/**
 * A newer worker has claimed this page, so the DOM is running code older than
 * the one now serving it. Reload, but not out from under someone mid entry:
 * wait for the tab to be backgrounded and returned to, which is the natural
 * moment a phone user comes back to a standalone app anyway.
 */
function reloadWhenSafe() {
  if (!midInteraction()) {
    window.location.reload();
    return;
  }
  const onReturn = () => {
    if (document.visibilityState === "visible" && !midInteraction()) {
      document.removeEventListener("visibilitychange", onReturn);
      window.location.reload();
    }
  };
  document.addEventListener("visibilitychange", onReturn);
}

function showVersion(version) {
  const el = document.getElementById("app-version");
  if (el) el.textContent = "Version " + version;
}

init();
showVersion(APP_VERSION);

// Registration never throws and resolves to null where service workers are
// unavailable, so the app still runs in a plain tab or an older browser.
registerServiceWorker({
  onTakeover: ({ version, hadController }) => {
    showVersion(version ?? APP_VERSION);
    // hadController is false on a first install: nothing to reload, the page
    // already IS the new app. It is true only when a newer worker replaced the
    // one this page loaded under.
    if (hadController) reloadWhenSafe();
  },
  onError: (err) => {
    console.warn("[p_tracker] service worker registration failed:", err);
  },
});
