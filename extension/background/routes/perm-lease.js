// extension/background/routes/perm-lease.js — permission lease message routes.

import { acquireLease, settleLease, leaseState } from "../../lib/perm-lease.js";

export const permLeaseRoutes = Object.freeze({
  // ── the permission-request LEASE registry (the final review's HIGH): the SW
  // is the single coordination authority ACROSS ALL PAGES. Pages acquire a
  // lease before prompting (chrome.permissions.request must run in the page's
  // own gesture), settle it with the outcome (late settles accepted for the
  // matching generation), and every surface can observe the settle broadcast.
  async "perm-lease.acquire"({ pattern }) {
    return await acquireLease(String(pattern ?? ""));
  },

  async "perm-lease.settle"({ pattern, generation, token, granted, error }) {
    // The UNGUESSABLE OWNER TOKEN is threaded through (the acceptance review's
    // CRITICAL: dropping it here made every real settlement fail the
    // token-owner check — unit tests bypassed the route and hid it).
    const r = settleLease(String(pattern ?? ""), { generation, token, granted, error });
    if (r.broadcast) {
      // Deliver the late-settle to every extension page (the consumers in
      // options.js + conversation.js reconcile their UI from this message).
      chrome.runtime.sendMessage(r.broadcast).catch(() => {});
    }
    return r;
  },

  async "perm-lease.state"({ pattern }) {
    return await leaseState(String(pattern ?? ""));
  },
});
