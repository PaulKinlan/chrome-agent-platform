// shared/rpc-cache.js — Hub RPC coalescing layer: single-flight deduplication +
// micro-TTL caching + event-driven invalidation.
//
// Prevents RPC storms caused by independent UI components querying identical
// read-only routes simultaneously (e.g. during hub boot, navigation, or progress fan-out).

const inFlight = new Map(); // key -> Promise
const cache = new Map(); // key -> { value, expiresAt }

const DEFAULT_TTL_MS = 2000;

// Read-only routes eligible for coalescing and caching.
const READ_ONLY_ROUTES = new Set([
  "settings.get",
  "agents.list",
  "skills.list",
  "harnesses.list",
  "permissions.list",
  "cron.list",
  "hooks.list",
  "mcp.status",
  "webmcp.status",
  "tasks.list",
  "task.list",
  "durableRun.list",
  "memory.stats",
  "ledger.summary",
  "threads.list",
  "thread.list",
  "artifacts.list",
  "asset.list",
  "asset.get",
  "asset.version-get",
  "agent.directory",
  "agent.tool-offers",
  "agent.discoverable-tabs",
  "named-agent.list",
  "background-agent.list",
  "provider.status",
  "provider.summary",
  "agent.registry",
  "actions.list",
  "board.list",
  "board.messages",
  "run.list",
  "run.control.queue.list",
  "run.dismissedFailed",
  "command.list",
  "skill.list",
  "fs-grant.read-file",
  "screenshots.get",
  "kv.get",
]);

// Write routes that explicitly invalidate related cache entries.
const WRITE_INVALIDATIONS = [
  { match: /^(?:settings\.|setting\.|kv\.set)/, prefixes: ["settings.", "kv."] },
  { match: /^(?:agents?\.(?:save|delete|enroll|create)|named-agent\.(?:save|delete)|background-agent\.(?:save|delete))/, prefixes: ["agent.", "named-agent.", "background-agent.", "agents."] },
  { match: /^(?:skills?\.(?:save|delete))/, prefixes: ["skills.", "skill."] },
  { match: /^(?:permissions?\.(?:grant|revoke|request))/, prefixes: ["permissions.", "permission.", "provider.permission"] },
  { match: /^(?:threads?\.(?:create|delete|append))/, prefixes: ["threads.", "thread."] },
  { match: /^(?:tasks?\.(?:create|update|delete|pause|resume|cancel))/, prefixes: ["tasks.", "task."] },
  { match: /^(?:provider\.(?:set|save|delete))/, prefixes: ["provider."] },
  { match: /^(?:asset\.(?:create|delete|update))/, prefixes: ["asset.", "artifacts."] },
  { match: /^(?:board\.(?:post|claim))/, prefixes: ["board."] },
  { match: /^(?:run\.(?:retry|dismissFailed|dismissedFailed))/, prefixes: ["run."] },
];

// Broadcast events (from chrome.runtime.onMessage or progress streams) to invalidation prefixes.
const BROADCAST_INVALIDATIONS = {
  "agent-registry-changed": ["agent.", "named-agent.", "background-agent.", "agents."],
  "named-agent-changed": ["agent.", "named-agent.", "background-agent.", "agents."],
  "background-agent-changed": ["agent.", "named-agent.", "background-agent.", "agents."],
  "site-tools-detected": ["agent.tool-offers", "agent.directory", "webmcp.status"],
  "open-tabs-changed": ["agent.tool-offers", "agent.directory", "webmcp.status"],
  "provider-changed": ["provider."],
  "asset-changed": ["asset.", "artifacts."],
  "asset-created": ["asset.", "artifacts."],
  "asset-updated": ["asset.", "artifacts."],
  "asset-deleted": ["asset.", "artifacts."],
  "thread-changed": ["thread.", "threads."],
  "threads-changed": ["thread.", "threads."],
  "task-changed": ["task.", "tasks."],
  "tasks-changed": ["task.", "tasks."],
  "commands-changed": ["command.list"],
  "settings-changed": ["settings."],
};

let lastChrome = typeof chrome !== "undefined" ? chrome : null;

function checkChromeInstance() {
  const cur = typeof chrome !== "undefined" ? chrome : null;
  if (cur !== lastChrome) {
    lastChrome = cur;
    clearRpcCache();
  }
}

function isCacheableRoute(type) {
  checkChromeInstance();
  return READ_ONLY_ROUTES.has(type);
}

function stableSerialize(obj) {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(stableSerialize).join(",")}]`;
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

export function cacheKey(type, payload = {}) {
  return `${type}:${stableSerialize(payload)}`;
}

export function invalidateRpcCache(prefix = "") {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

export function clearRpcCache() {
  inFlight.clear();
  cache.clear();
}

export function getRpcCacheStats() {
  return {
    inFlightCount: inFlight.size,
    cacheCount: cache.size,
  };
}

export function handleBroadcastEvent(type) {
  const prefixes = BROADCAST_INVALIDATIONS[type];
  if (prefixes) {
    for (const p of prefixes) {
      invalidateRpcCache(p);
    }
  }
}

// Broadcast events can be wired explicitly via handleBroadcastEvent(type)
// or through progress subscriptions, avoiding duplicate onMessage listeners in SW.

function checkWriteInvalidation(type) {
  for (const inv of WRITE_INVALIDATIONS) {
    if (inv.match.test(type)) {
      for (const p of inv.prefixes) {
        invalidateRpcCache(p);
      }
    }
  }
}

function defaultSend(type, payload = {}, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: "the agent worker didn't answer — it may be busy (retry)" });
    }, timeoutMs);

    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            finish(res ?? { ok: true });
          }
        });
      } else {
        clearTimeout(timer);
        finish({ ok: false, error: "chrome.runtime.sendMessage unavailable" });
      }
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: String(e) });
    }
  });
}

/**
 * Coalesced RPC: single-flight in-flight deduplication + short TTL caching.
 *
 * @param {string} type - RPC route name
 * @param {object} [payload={}] - RPC payload
 * @param {object} [options={}] - { ttlMs, timeoutMs, send, bypassCache }
 * @returns {Promise<any>}
 */
export function cachedRpc(type, payload = {}, options = {}) {
  const {
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs,
    send = defaultSend,
    bypassCache = false,
  } = options;

  checkWriteInvalidation(type);

  const cacheable = !bypassCache && isCacheableRoute(type);
  if (!cacheable) {
    return send(type, payload, timeoutMs);
  }

  const key = cacheKey(type, payload);
  const now = Date.now();

  // 1. Check TTL cache
  const cachedEntry = cache.get(key);
  if (cachedEntry) {
    if (cachedEntry.expiresAt > now) {
      return Promise.resolve(cachedEntry.value);
    }
    cache.delete(key);
  }

  // 2. Check in-flight promise
  const existingFlight = inFlight.get(key);
  if (existingFlight) {
    return existingFlight;
  }

  // 3. Initiate single-flight request
  const promise = Promise.resolve()
    .then(() => send(type, payload, timeoutMs))
    .then((result) => {
      inFlight.delete(key);
      if (result && result.ok !== false) {
        cache.set(key, {
          value: result,
          expiresAt: Date.now() + ttlMs,
        });
      }
      return result;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });

  inFlight.set(key, promise);
  return promise;
}

export { cachedRpc as cached };
