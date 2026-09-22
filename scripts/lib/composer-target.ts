// scripts/lib/composer-target.ts — the ONE way a harness addresses the agent
// composer (chrome-agent-platform-4vfj).
//
// The fixed ids `task-input` / `run-task` were REMOVED ON PURPOSE by bead
// chrome-agent-platform-sndb, and the removal is pinned by
// tests/agent-composer-unique-ids.test.ts. The reason is worth repeating at
// every call site: several documents carry MORE THAN ONE composer, so
// document.getElementById("task-input") silently resolved to the FIRST one —
// input went to a hidden element while the user was looking at another. The
// component now renders per-instance ids (`${host.id}-input` / `${host.id}-send`)
// and exposes two STABLE hooks for harnesses: `[data-composer-input]` and
// `[data-composer-send]` (extension/shared/components.js:7035).
//
// So a harness addresses the composer by HOST + stable hook. A document-wide
// `[data-composer-input]` is wrong for the same reason the fixed ids were: it
// resolves to whichever composer comes first in document order, which is not
// necessarily the one the harness means.
//
// This module is the deliverable half of an unfinished migration: 35 files
// addressed the composer by the retired ids, `npm run test:a11y` was red on main
// because of it, and `npm run test:security` reads the same absent selector with
// no fallback (loudly — its check puts `composer` in its own condition).
// scripts/a11y-audit.ts was the first migrant; the rest are listed with their
// counts in tests/composer-selector-migration.test.ts, which is the guard half —
// read that ledger for how many are left, it is measured rather than remembered.
// The guard fails when a NEW site is written, so the ledger can only shrink.
// Migrate a file by importing from here and lowering its count there.

/** Every composer host in the shipped product, by the document it lives in.
 * Verified against the markup: `git grep -n "<agent-composer" -- extension`. */
export const COMPOSER_HOSTS = {
  /** ntp/ntp.html — the hub composer (the one the journeys drive). */
  hub: "composer",
  /** ntp/ntp.html — the thread-view reply composer. */
  thread: "thread-composer",
  /** sidepanel/sidepanel.html — the page-agent composer. */
  sidepanelPage: "page-composer",
  /** sidepanel/sidepanel.html — the side-panel agent composer. */
  sidepanelAgent: "agent-composer",
} as const;

export type ComposerHost = keyof typeof COMPOSER_HOSTS;

function hostId(host: ComposerHost): string {
  const id = COMPOSER_HOSTS[host];
  // Fail at the call site, in Deno, with the host name in the message. Never
  // emit a selector that resolves to nothing in the page.
  if (typeof id !== "string" || !id) {
    throw new Error(
      `unknown composer host "${String(host)}" — add it to COMPOSER_HOSTS in scripts/lib/composer-target.ts`,
    );
  }
  return id;
}

/** The composer's text input, scoped to its host. */
export function composerInput(host: ComposerHost = "hub"): string {
  return `#${hostId(host)} [data-composer-input]`;
}

/** The composer's send / run button, scoped to its host. */
export function composerSend(host: ComposerHost = "hub"): string {
  return `#${hostId(host)} [data-composer-send]`;
}

/** The composer's mention + slash-command popup, scoped to its host. */
export function composerPopup(host: ComposerHost = "hub"): string {
  return `#${hostId(host)} .popup`;
}
