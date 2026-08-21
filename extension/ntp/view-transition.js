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

export function createViewTransitionRunner({ document, prefersReducedMotion }) {
  let active = false;
  let activeCompletion = null;
  let focusGeneration = 0;

  return function withViewTransition(update, options = {}) {
    const {
      sourceRoute = null,
      targetRoute = null,
      focusAfter = null,
    } = options;
    const suppressRootCrossfade = shouldSuppressRootCrossfade(
      sourceRoute,
      targetRoute,
    );
    // Only route changes participate in focus ownership. Incidental transitions
    // (for example, collapsing the rail) must not cancel pending route focus;
    // an explicit null still does, for routes that transfer focus themselves.
    const ownsFocus = Object.hasOwn(options, "focusAfter");
    const routeGeneration = ownsFocus ? ++focusGeneration : focusGeneration;
    const focusCurrentRoute = () => {
      if (ownsFocus && routeGeneration === focusGeneration) {
        routeFocus(focusAfter);
      }
    };
    if (
      typeof document?.startViewTransition !== "function" ||
      prefersReducedMotion?.() === true
    ) {
      update();
      focusCurrentRoute();
      return null;
    }
    const root = document.documentElement;
    if (active) {
      // Route direction still applies to an already-active top layer. This is
      // important when a task is left during an incidental/earlier transition:
      // the live old-root pseudo must stop presenting task controls immediately.
      if (suppressRootCrossfade) {
        root?.classList?.add(TASK_VIEW_TRANSITION_CLASS);
      }
      update();
      // The current top-layer snapshot still owns presentation. Apply a rapid
      // route change now, but do not move focus underneath that snapshot; the
      // latest route receives focus when the active transition is gone.
      activeCompletion?.then(focusCurrentRoute);
      return null;
    }

    if (suppressRootCrossfade) root?.classList?.add(TASK_VIEW_TRANSITION_CLASS);
    active = true;
    let updateStarted = false;
    const guardedUpdate = () => {
      updateStarted = true;
      return update();
    };

    const release = () => {
      root?.classList?.remove(TASK_VIEW_TRANSITION_CLASS);
      active = false;
      activeCompletion = null;
    };
    const finish = () => {
      release();
      focusCurrentRoute();
    };

    try {
      const transition = document.startViewTransition(guardedUpdate);
      // Normalize rejection so an aborted transition never creates an
      // unhandled promise; cleanup and focus routing run for finish or abort.
      activeCompletion = Promise.resolve(transition?.finished).catch(() => {});
      activeCompletion.then(finish);
      return transition;
    } catch {
      release();
      // Defensive against an implementation throwing after invoking the update:
      // a route mutation must happen exactly once.
      if (!updateStarted) update();
      focusCurrentRoute();
      return null;
    }
  };
}
