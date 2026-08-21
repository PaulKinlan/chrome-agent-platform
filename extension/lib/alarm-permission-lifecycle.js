// lib/alarm-permission-lifecycle.js — optional alarms permission activation.
//
// The Settings page owns permission requests because only its button has a real
// owner gesture. The service worker owns listener activation. If Chrome does
// not inject chrome.alarms into a worker that started before the grant, one
// bounded reload activates the API. Permission removal detaches the listener;
// persisted cap:scheduledTasks records remain the sole re-arm authority.

export const ALARM_RELOAD_DELAY_MS = 250;

function includesAlarms(permissions) {
  return Array.isArray(permissions?.permissions) &&
    permissions.permissions.includes("alarms");
}

/**
 * @param {{
 *   chromeApi?: any,
 *   onAlarm: (alarm: any) => any,
 *   setTimer?: (fn: () => void, delay: number) => any,
 *   clearTimer?: (id: any) => void,
 *   reloadDelayMs?: number,
 * }} options
 */
export function createAlarmPermissionLifecycle({
  chromeApi = globalThis.chrome,
  onAlarm,
  setTimer = (fn, delay) => globalThis.setTimeout(fn, delay),
  clearTimer = (id) => globalThis.clearTimeout(id),
  reloadDelayMs = ALARM_RELOAD_DELAY_MS,
} = {}) {
  if (typeof onAlarm !== "function") {
    throw new TypeError("alarm lifecycle requires an onAlarm handler");
  }

  let listenerRegistered = false;
  let reloadScheduled = false;
  let reloadStarted = false;
  let reloadTimer = null;
  let disarmed = false;

  function state(extra = {}) {
    return {
      ok: true,
      listenerRegistered,
      reloadScheduled,
      reloadStarted,
      disarmed,
      ...extra,
    };
  }

  function ensureAlarmListener() {
    if (listenerRegistered) return state({ apiAvailable: true });
    const event = chromeApi?.alarms?.onAlarm;
    if (typeof event?.addListener !== "function") {
      return state({ apiAvailable: false });
    }
    if (
      typeof event.hasListener !== "function" || !event.hasListener(onAlarm)
    ) {
      event.addListener(onAlarm);
    }
    listenerRegistered = true;
    disarmed = false;
    return state({ apiAvailable: true });
  }

  function scheduleControlledReload(source) {
    if (reloadScheduled || reloadStarted) return state({ source });
    if (
      typeof chromeApi?.runtime?.reload !== "function" ||
      typeof setTimer !== "function"
    ) {
      return {
        ...state({ source }),
        ok: false,
        error: "alarms granted but the extension runtime cannot be reloaded",
      };
    }
    reloadScheduled = true;
    reloadTimer = setTimer(() => {
      reloadTimer = null;
      if (reloadStarted || disarmed) return;
      reloadStarted = true;
      chromeApi.runtime.reload();
    }, reloadDelayMs);
    return state({ source });
  }

  function activateConfirmedGrant(source) {
    disarmed = false;
    const ensured = ensureAlarmListener();
    if (ensured.listenerRegistered) return { ...ensured, source };
    return scheduleControlledReload(source);
  }

  function onPermissionsAdded(permissions) {
    if (!includesAlarms(permissions)) return state({ ignored: true });
    return activateConfirmedGrant("permissions.onAdded");
  }

  function onPermissionsRemoved(permissions) {
    if (!includesAlarms(permissions)) return state({ ignored: true });
    disarmed = true;
    if (reloadTimer != null && typeof clearTimer === "function") {
      clearTimer(reloadTimer);
      reloadTimer = null;
    }
    reloadScheduled = false;
    const event = chromeApi?.alarms?.onAlarm;
    if (listenerRegistered && typeof event?.removeListener === "function") {
      event.removeListener(onAlarm);
    }
    listenerRegistered = false;
    return state({ source: "permissions.onRemoved" });
  }

  async function notifyGrantedFromOwner() {
    let granted = false;
    try {
      granted = await chromeApi?.permissions?.contains?.({
        permissions: ["alarms"],
      }) === true;
    } catch {
      granted = false;
    }
    if (!granted) {
      return {
        ...state(),
        ok: false,
        granted: false,
        error: "alarms permission is not granted",
      };
    }
    return {
      ...activateConfirmedGrant("owner-notification"),
      granted: true,
    };
  }

  // Zero-permission startup is expected and never reloads. A reload can begin
  // only after onAdded or an exact Settings notification re-confirms the grant.
  ensureAlarmListener();
  chromeApi?.permissions?.onAdded?.addListener?.(onPermissionsAdded);
  chromeApi?.permissions?.onRemoved?.addListener?.(onPermissionsRemoved);

  return Object.freeze({
    ensureAlarmListener,
    notifyGrantedFromOwner,
    onPermissionsAdded,
    onPermissionsRemoved,
    status: () => state(),
  });
}
