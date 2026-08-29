// lib/navigation-controller.js — Modern Navigation API controller and View Router
// for extension pages and Settings views (CAP-FB-20260823-NAVIGATION-BACK-01).
//
// Invariants:
//   - Uses modern window.navigation (navigate, navigatesuccess, navigateerror) where available.
//   - Graceful fallback to popstate + hashchange when Navigation API is absent.
//   - Exactly ONE active listener registration per window/document (no duplicate listeners).
//   - History is the single source of truth: Home is the root and only the current deep NTP route follows it.
//   - Back/forward traversal restores full UI state (aria-current, data renders, scroll, focus, overlay state).
//   - Deep links and reloads restore the exact target view/section.
//   - Stale/invalid hashes fail closed safely without crashing.

export const NAVIGATION_EVENT_TYPES = Object.freeze({
  NAVIGATE: "navigate",
  SUCCESS: "navigatesuccess",
  ERROR: "navigateerror",
});

/**
 * Creates a navigation controller for a document/window.
 */
export function createNavigationController({
  win = typeof window !== "undefined" ? window : null,
  onNavigate = null,
  onError = null,
  normalizeHash = (h) => (h ? h.replace(/^#/, "") : null),
  isAllowedHash = () => true,
} = {}) {
  if (!win) {
    return {
      navigate: () => false,
      dispose: () => {},
      isModern: false,
    };
  }

  let disposed = false;
  const isModern = Boolean(win.navigation && typeof win.navigation.addEventListener === "function");

  let currentHash = win.location?.hash ?? "";
  let lastNavigationSuccess = true;

  const handleHashChange = async (newHash, { isTraverse = false, info = null } = {}) => {
    if (disposed) return false;
    currentHash = newHash;
    const cleanId = normalizeHash(newHash);
    if (!cleanId || !isAllowedHash(cleanId)) {
      lastNavigationSuccess = false;
      return false;
    }
    if (typeof onNavigate === "function") {
      try {
        await onNavigate({
          hash: newHash,
          sectionId: cleanId,
          isTraverse,
          info,
        });
        lastNavigationSuccess = true;
        return true;
      } catch (err) {
        lastNavigationSuccess = false;
        if (typeof onError === "function") {
          onError(err);
        }
        return false;
      }
    }
    lastNavigationSuccess = true;
    return true;
  };

  // Modern Navigation API Listener
  const onModernNavigate = (event) => {
    if (disposed) return;
    const destinationUrl = event.destination?.url ? new URL(event.destination.url) : null;
    const destinationHash = destinationUrl?.hash ?? "";

    if (event.canIntercept && destinationUrl && destinationUrl.pathname === win.location.pathname) {
      event.intercept({
        async handler() {
          await handleHashChange(destinationHash, {
            isTraverse: event.navigationType === "traverse",
            info: event.info,
          });
        },
      });
    }
  };

  const onModernSuccess = (_event) => {
    // Navigation committed successfully
  };

  const onModernError = (event) => {
    if (typeof onError === "function" && event?.error) {
      onError(event.error);
    }
  };

  // Fallback History API Listeners
  const onPopState = (event) => {
    if (disposed) return;
    handleHashChange(win.location.hash, { isTraverse: true, info: event.state });
  };

  const onNativeHashChange = () => {
    if (disposed) return;
    handleHashChange(win.location.hash, { isTraverse: false });
  };

  // Register exactly one listener set
  if (isModern) {
    win.navigation.addEventListener("navigate", onModernNavigate);
    win.navigation.addEventListener("navigatesuccess", onModernSuccess);
    win.navigation.addEventListener("navigateerror", onModernError);
  } else {
    win.addEventListener("popstate", onPopState);
    win.addEventListener("hashchange", onNativeHashChange);
  }

  return {
    isModern,
    get currentHash() {
      return currentHash;
    },
    async navigate(targetHash, { replace = false, info = null } = {}) {
      if (disposed) return false;
      const formatted = targetHash.startsWith("#") ? targetHash : `#${targetHash}`;
      const cleanId = normalizeHash(formatted);
      if (!cleanId || !isAllowedHash(cleanId)) {
        return false;
      }

      if (isModern && typeof win.navigation.navigate === "function") {
        try {
          const currentUrl = new URL(win.location.href);
          currentUrl.hash = formatted;
          const navResult = win.navigation.navigate(currentUrl.href, {
            history: replace ? "replace" : "push",
            info,
          });
          if (navResult?.finished) {
            await navResult.finished;
          }
          return lastNavigationSuccess;
        } catch (e) {
          // Fall back to location hash assignment
        }
      }

      if (replace && win.history?.replaceState) {
        win.history.replaceState(info, "", formatted);
      } else if (win.history?.pushState) {
        win.history.pushState(info, "", formatted);
      } else {
        win.location.hash = formatted;
      }

      return await handleHashChange(formatted, { isTraverse: false, info });
    },
    syncCurrent() {
      if (disposed) return;
      return handleHashChange(win.location.hash, { isTraverse: false });
    },
    dispose() {
      disposed = true;
      if (isModern) {
        win.navigation.removeEventListener("navigate", onModernNavigate);
        win.navigation.removeEventListener("navigatesuccess", onModernSuccess);
        win.navigation.removeEventListener("navigateerror", onModernError);
      } else {
        win.removeEventListener("popstate", onPopState);
        win.removeEventListener("hashchange", onNativeHashChange);
      }
    },
  };
}

/**
 * Parses an NTP hash into a structured route descriptor.
 * Supported shapes:
 *   - "" or "#" -> { route: "hub" }
 *   - "#thread=<id>" -> { route: "thread", id: "<id>" }
 *   - "#agent=<kind>:<id>" -> { route: "agent", kind: "<kind>", id: "<id>" }
 *   - "#agent=named:<id>&edit=1" -> the same route with { edit: true }
 *   - "#view=<path>" -> { route: "view", path: "<path>" }
 *   - "#omnibox=<mode>:<query>" -> { route: "omnibox", mode: "<mode>", query: "<query>" }
 *   - "#compose" -> { route: "compose" }  (hub, with the task composer focused)
 */
export function parseNtpHash(hash) {
  if (typeof hash !== "string" || !hash || hash === "#") {
    return { route: "hub" };
  }
  const clean = hash.startsWith("#") ? hash.slice(1).trim() : hash.trim();
  if (!clean) return { route: "hub" };

  // The keyboard "new task" command lands here: same surface as the hub, but the
  // composer takes focus so the owner can type immediately. It carries no
  // payload — a shortcut must never inject task text.
  if (clean === "compose") return { route: "compose" };

  const mThread = /^thread=(.+)$/.exec(clean);
  if (mThread) return { route: "thread", id: decodeURIComponent(mThread[1]) };

  const mAgent = /^agent=([^:]+):(.+?)(?:&(edit)=1)?$/.exec(clean);
  if (mAgent) return {
    route: "agent",
    kind: decodeURIComponent(mAgent[1]),
    id: decodeURIComponent(mAgent[2]),
    ...(mAgent[3] ? { edit: true } : {}),
  };

  const mView = /^view=(.+)$/.exec(clean);
  if (mView) return { route: "view", path: decodeURIComponent(mView[1]) };

  const mOmnibox = /^omnibox=([^:]+):(.+)$/.exec(clean);
  if (mOmnibox) return { route: "omnibox", mode: decodeURIComponent(mOmnibox[1]), query: decodeURIComponent(mOmnibox[2]) };

  return { route: "hub" };
}

const NTP_ROOT_STATE = "capNtpRoot";
const NTP_RETURNED_HOME_STATE = "capNtpReturnedHome";
const NTP_ROOTED_STATE = "capNtpRooted";

/** Seed a hub entry behind a direct deep link, while leaving normal hub loads
 * as the single root entry. Reloaded rooted routes keep their existing stack. */
export function ensureNtpHistoryRoot(win = typeof window !== "undefined" ? window : null) {
  if (!win?.history?.replaceState || !win?.history?.pushState) return false;
  const parsed = parseNtpHash(win.location?.hash ?? "");
  const state = win.history.state && typeof win.history.state === "object" ? win.history.state : {};
  if (parsed.route === "hub" || parsed.route === "compose" || parsed.route === "omnibox") {
    win.history.replaceState({ ...state, [NTP_ROOT_STATE]: true }, "", win.location.href);
    return false;
  }
  if (state[NTP_ROOTED_STATE] === true) return false;

  const deepUrl = win.location.href;
  win.history.replaceState({ route: "hub", [NTP_ROOT_STATE]: true }, "", `${win.location.pathname}${win.location.search}`);
  win.history.pushState({ ...state, [NTP_ROOTED_STATE]: true }, "", deepUrl);
  return true;
}

/** Keep the NTP stack rooted as [home, current view]. Moving between deep
 * views replaces the current view instead of accumulating a breadcrumb trail. */
export function navigateNtpRoute(win, hash, state, title = "") {
  if (!win?.history?.pushState || !win?.history?.replaceState) return false;
  const current = parseNtpHash(win.location?.hash ?? "");
  const currentState = win.history.state && typeof win.history.state === "object" ? win.history.state : {};
  const method = current.route === "hub" && currentState[NTP_RETURNED_HOME_STATE] !== true
    ? "pushState"
    : "replaceState";
  win.history[method]({ ...(state ?? {}), [NTP_ROOTED_STATE]: true }, title, hash);
  return method === "pushState" ? "push" : "replace";
}

/** Replace the current deep entry with the hub. This is a destination, not a
 * Back command: older deep views cannot be replayed after Home or New task. */
export function navigateHome(win = typeof window !== "undefined" ? window : null) {
  if (!win?.history?.replaceState || parseNtpHash(win.location?.hash ?? "").route === "hub") return false;
  win.history.replaceState(
    { route: "hub", [NTP_ROOT_STATE]: true, [NTP_RETURNED_HOME_STATE]: true },
    "",
    `${win.location.pathname}${win.location.search}`,
  );
  return true;
}

/** A self-initiated same-document pushState/replaceState must NOT re-dispatch
 * the route (the open* call already rendered the view) — only traversals and
 * reloads drive the dispatcher. Pure; the NTP's navigate listener + tests use
 * it. */
export function shouldDispatchForNavigationType(type) {
  return type !== "push" && type !== "replace";
}

/** Resolve the EXACT entry title/name from the history state (the single
 * source of truth) for a parsed route — never a degraded hardcoded fallback
 * when the entry carried a real title/name. Pure; the NTP dispatcher + tests
 * use it. */
export function resolveEntryMeta(parsed, state = null) {
  const s = (state && typeof state === "object") ? state : null;
  if (!parsed || typeof parsed !== "object") return { title: null, name: null };
  if (parsed.route === "view") {
    return {
      title: (s && typeof s.title === "string" && s.title) ? s.title : "View",
      name: null,
    };
  }
  if (parsed.route === "agent") {
    return {
      title: null,
      name: (s && typeof s.name === "string" && s.name) ? s.name : null,
    };
  }
  return { title: null, name: null };
}
