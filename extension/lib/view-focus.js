// Focus lifecycle for the hub's full in-context views.
function defaultGetStyle(target) {
  return globalThis.getComputedStyle?.(target) ?? null;
}

function isVisibleFocusTarget(target, getStyle) {
  if (
    !target || target.isConnected !== true || target.disabled === true ||
    typeof target.focus !== "function"
  ) return false;

  for (let node = target; node; node = node.parentElement) {
    if (node.hidden === true || node.inert === true) return false;
  }
  const style = getStyle(target);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

export function createViewFocusController({ getStyle = defaultGetStyle } = {}) {
  let returnTarget = null;

  return {
    open(trigger, reveal, viewTarget) {
      returnTarget = isVisibleFocusTarget(trigger, getStyle) ? trigger : null;
      reveal();
      viewTarget?.focus();
    },

    close(hide) {
      hide();
      const target = returnTarget;
      returnTarget = null;
      if (!isVisibleFocusTarget(target, getStyle)) return false;
      target.focus();
      return true;
    },
  };
}
