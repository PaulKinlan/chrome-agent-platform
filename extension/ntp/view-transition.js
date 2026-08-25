// Focus-safe View Transition runner for the NTP's same-document routes.
// The document root is still snapshotted by the browser even when a named
// overlay is the intended shared element. Route direction decides whether the
// obsolete root is suppressed; the named overlay transition remains available.

export const TASK_VIEW_TRANSITION_CLASS = "task-view-transition";

export const VIEW_ROUTE = Object.freeze({
  HUB: "hub",
  TASK: "task",
  SETTINGS: "settings",
  DIRECTORY: "directory",
  SKILLS: "skills",
  ARTIFACTS: "artifacts",
});

export function shouldSuppressRootCrossfade(sourceRoute, targetRoute) {
  if (!sourceRoute || !targetRoute || sourceRoute === targetRoute) return false;
  return sourceRoute === VIEW_ROUTE.TASK || targetRoute === VIEW_ROUTE.TASK;
}

function routeFocus(target) {
  if (!target || target.isConnected === false) return;
  try {
    target.focus?.();
  } catch {
    // Focus routing is progressive enhancement; transition cleanup must win.
  }
}

/** Route focus only when a caller explicitly owns the focus disposition. */
export function focusExplicitRouteTarget(options = {}) {
  if (!Object.hasOwn(options, "focusAfter")) return false;
  routeFocus(options.focusAfter);
  return true;
}

export function createViewTransitionRunner({ document, prefersReducedMotion } = {}) {
  let focusGeneration = 0;

  return function withViewTransition(update, options = {}) {
    const {
      sourceRoute = null,
      targetRoute = null,
      focusAfter = null,
    } = options;

    // Evaluate route direction helper for compatibility
    shouldSuppressRootCrossfade(sourceRoute, targetRoute);

    // Immediate synchronous navigation (no slow or janky view transition animation):
    // apply DOM/state update immediately, then route focus synchronously to preserve keyboard navigation.
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
