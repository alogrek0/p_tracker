/*
 * sw-register.js
 *
 * Registers ./sw.js and reports when a new worker has taken over.
 *
 * Why this is not a one-liner: a previous, unrelated app shipped at this same
 * URL and its cache-first service worker is still registered on the user's
 * phone. The registration options here are part of the takeover story that
 * sw.js documents at the top of that file:
 *
 *   - The path is "./sw.js", RELATIVE, so it resolves under /p_tracker/ on
 *     GitHub Pages and matches the path the old worker was registered at.
 *     The browser's update check only ever looks at that path.
 *   - The scope is "./", relative for the same reason. A root scope would be
 *     rejected on Pages (a worker at /p_tracker/sw.js may not claim "/").
 *   - updateViaCache: "none" makes the browser fetch sw.js from the network
 *     on every update check instead of honouring its HTTP cache, which is
 *     otherwise allowed to hold a worker script for up to 24 hours. Without
 *     this the old worker could keep winning the update check for a day.
 *
 * Safe to call anywhere: if there is no service worker support (old iOS, or
 * a non-secure context such as a file:// or plain http:// origin that is not
 * localhost) it does nothing and never throws.
 */

/**
 * @param {object} [options]
 * @param {(info: { version?: string, hadController: boolean }) => void} [options.onTakeover]
 *   Called once a NEW worker has taken control of this page. If the page
 *   was already controlled by another worker (`hadController` is true), the
 *   assets that are cached now differ from what this page loaded with, and
 *   the UI should offer a reload. On the very first ever install there was
 *   no previous controller and a reload is not needed.
 * @param {(err: unknown) => void} [options.onError]
 *   Called if registration fails. Registration failure is not fatal for the
 *   app itself, only for offline support, so by default it is logged.
 * @returns {Promise<ServiceWorkerRegistration | null>} the registration, or
 *   null when service workers are unavailable or registration failed.
 */
export async function registerServiceWorker(options = {}) {
  const { onTakeover, onError } = options;

  // Feature detection. `navigator` itself can be missing in tests.
  const sw =
    typeof navigator !== "undefined" && navigator && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : null;
  if (!sw) return null;

  // Whether some worker (possibly the legacy one) already controls this page
  // at the moment we start. This decides whether a takeover warrants a reload.
  const hadController = Boolean(sw.controller);

  // Fires when the page's controller changes, which happens exactly when a
  // worker calls clients.claim() in activate. Guard against firing twice.
  let notified = false;
  const notify = (version) => {
    if (notified) return;
    notified = true;
    if (typeof onTakeover === "function") {
      try {
        onTakeover({ version, hadController });
      } catch (err) {
        console.warn("[sw-register] onTakeover handler threw", err);
      }
    }
  };

  try {
    sw.addEventListener("controllerchange", () => notify(undefined));

    // The worker posts { type: "SW_ACTIVATED", version } from activate. This
    // arrives around the same time as controllerchange; whichever is first
    // wins and the other is ignored by the guard above. Listening for the
    // message as well lets the version reach the UI when it is available.
    sw.addEventListener("message", (event) => {
      const data = event && event.data;
      if (data && data.type === "SW_ACTIVATED") notify(data.version);
    });
  } catch (err) {
    // Listener wiring should never fail, but registration is still worth
    // attempting if it somehow does.
    console.warn("[sw-register] could not attach listeners", err);
  }

  try {
    const registration = await sw.register("./sw.js", {
      scope: "./",
      updateViaCache: "none",
    });

    // Ask for an update check right away. The browser also checks on
    // navigation, but a home-screen PWA can be resumed rather than
    // navigated for a long time, so an explicit check on boot is the most
    // reliable way to notice that sw.js changed on the server.
    registration.update().catch(() => {
      /* offline, or the server is unreachable; fine, we will check next boot */
    });

    return registration;
  } catch (err) {
    if (typeof onError === "function") {
      try {
        onError(err);
      } catch (_) {
        /* never let a handler break the caller */
      }
    } else {
      console.warn("[sw-register] service worker registration failed", err);
    }
    return null;
  }
}
