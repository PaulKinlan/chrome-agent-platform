// lib/messages.js — thin wrapper over chrome.runtime messaging for UI pages.

export function send(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else resolve(res ?? { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}
