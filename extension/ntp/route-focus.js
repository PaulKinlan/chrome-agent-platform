// Synchronous route-update runner + focus routing for the NTP's same-document
// routes. The runner applies the DOM update immediately and routes focus
// synchronously — nothing snapshots the document, no transition API is
// invoked anywhere, and a newer route replaces a pending focus disposition.

export const VIEW_ROUTE = Object.freeze({
  HUB: "hub",
  TASK: "task",
  SETTINGS: "settings",
  DIRECTORY: "directory",
  ARTIFACTS: "artifacts",
});

function routeFocus(target) {
  if (!target || target.isConnected === false) return;
  try {
    target.focus?.();
  } catch {
    // Focus routing is progressive enhancement; the route update must win.
  }
}

/** Route focus only when a caller explicitly owns the focus disposition. */
export function focusExplicitRouteTarget(options = {}) {
  if (!Object.hasOwn(options, "focusAfter")) return false;
  routeFocus(options.focusAfter);
  return true;
}

export function createRouteUpdateRunner() {
  let focusGeneration = 0;

  return function runRouteUpdate(update, options = {}) {
    const { focusAfter = null } = options;

    // Apply the DOM/state update immediately, then route focus synchronously
    // to preserve keyboard navigation. A newer route replaces the pending
    // focus disposition (generation check).
    const ownsFocus = Object.hasOwn(options, "focusAfter");
    const routeGeneration = ownsFocus ? ++focusGeneration : focusGeneration;
    const focusCurrentRoute = () => {
      if (ownsFocus && routeGeneration === focusGeneration) {
        routeFocus(focusAfter);
      }
    };

    update();
    focusCurrentRoute();
    return null;
  };
}
