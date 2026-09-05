# The agent as a web-platform principal — a position plan

**Bead:** chrome-agent-platform-jakw (umbrella 9zw7) · **Date:** 2026-09-05 ·
**Audience:** web platform / Chrome engineers. **Evidence base:** everything
cited as "we built" is shipping code in this repo at `origin/main@14e2a817`;
section references point at `ARCHITECTURE.md` (same folder) and code file:line.

## 1. The claim

An agent is a **new kind of principal** on the web. It is not the user (it acts
unattended), not the site (it acts across sites, on the user's behalf), and not
the extension (many agents share one extension; the user trusts them
differently). The web platform today has exactly three principals — the user,
the origin, and (in Chrome) the extension — so anyone building agents must
synthesize the fourth principal out of extension plumbing.

We know because we did it. This extension implements persistent named agents,
per-site sub-agents, background agents, tool discovery, and durable runs on
MV3. What follows is what that actually took, what it proves the platform is
missing, and the concrete APIs that would let the platform host agents
natively.

## 2. What an agent needs — and what we had to build instead

### 2.1 Identity and principalhood
**Needed:** a first-class, user-visible agent identity whose actions are
attributable and revocable independently of both the user and any site.

**We built:** canonical agent refs (`named:<slug>` / `background:<slug>` /
`site:<origin>`), a redacted registry route, run-bound `executionId`s as the
only mutation authority, and an activity ledger that renders "what the agent
did" with Undo (docs/AGENT-MODEL.md; `extension/lib/action-ledger.js`;
ARCHITECTURE.md §2.3). Chrome reports everything we do as the *extension*
acting; our agent identities exist nowhere the user can see outside our own UI.

**The gap:** there is no platform-level answer to "which agent did this?" —
not in the permission UI, not in site data UI, not in history.

### 2.2 Sandboxed execution for agent code
**Needed:** an isolated realm, per agent and per job, with explicit
capabilities in and out.

**We built:** manifest-sandbox opaque-origin iframes for agent-authored JS
(the only place `new Function` is legal), fresh dedicated Workers per Wasm job
(never pooled, wall-clock-killed), a fixed WASI import allowlist, and teach-
guard shims because opaque origins get *no* usable storage
(`extension/sandbox/script-sandbox.js`, `extension/lib/wasm-executor.js`,
`extension/lib/wasi-preview1-runtime.js`; ARCHITECTURE.md §1).

**The gap:** MV3 service workers cannot construct Workers at all — every
isolated execution must proxy through the single offscreen document, which
makes that document a five-subsystem single point of failure (risk R11/R13).
The platform's isolation primitives (realms, workers, sandboxes) are keyed to
documents, not to principals, so "an agent's own sandbox" is not expressible.

### 2.3 Per-agent storage with a real boundary
**Needed:** storage partitioned per agent, quota-attributed per agent,
enumerable and clearable by the user per agent.

**We built:** logical multiplexing inside the extension's single OPFS origin
root — `memory/agents/<slug>`, `memory/origins/<encoded>`, … — where the
isolation boundary is *our code*, with no platform backstop (risk R1;
`extension/lib/memory.js:393-395`, verified: one root per origin is the
platform truth). A durable per-store generation/tombstone authority, CAS
writes, and a write mutex implement the consistency the platform doesn't
(memory.js:17-35, :711-760).

**The gap:** one OPFS root per origin means "per-agent storage" cannot be
enforced by the platform inside an extension. The Storage Buckets API is the
closest primitive and is not exposed to extensions for this, carries no
principal binding, and attributes no quota per bucket in UI.

### 2.4 Attested messaging between user ↔ agent ↔ site
**Needed:** channels where a receiver can *prove* which principal sent a
message — including across the page boundary.

**We built:** a single SW router that classifies every sender into principals
(`page` / `extension` / `owner-options` / `model`), an 8-route allowlist for
page-originated messages, `__`-key scrubbing at dispatch, browser-attested
sender identity (`sender.tab.id`/`documentId`) as the only trusted page
identity, and an HMAC-per-document key handshake so a page cannot forge its
own tool-capability reports (service-worker.js:9463+;
`extension/lib/pure.js:1120-1130`; `extension/content/webmcp-detect-*.js`;
ARCHITECTURE.md §2.1, §4.1).

**The gap:** pages have no way to receive an attested message *from* an agent,
and extensions synthesize attestation from content-script sender metadata —
workable, but it means every agent product re-implements (and re-audits) the
same handshake.

### 2.5 Consent and authority, finer than install time
**Needed:** per-agent, per-capability, per-run consent with honest UX — the
platform already knows how to ask ("Allow X to…?"); it just can't ask *about
an agent*.

**We built:** all-optional permissions requested just-in-time from real
gestures, in-conversation approval cards binding the exact digest of what is
approved (a script's source, a file diff, a cookie name), per-origin
browser-control grants, enrollment-as-consent for site tools, and a closed
destructive-action set (`extension/lib/owner-approval.js:14-50`;
docs/CONSTITUTION.md §1; ARCHITECTURE.md §1.6, §4.2).

**The gap:** Chrome's consent surfaces stop at the extension. When our agent
acts, the platform tells the user the *extension* did it, at install time,
with the maximal warning. The per-agent, per-run, digest-bound cards we render
are exactly the UX the platform should own — it can render them trusted, where
ours are spoofable-in-principle page content.

### 2.6 Tool contracts between sites and agents
**Needed:** a standard way for a site to offer tools to agents with declared
trust semantics (read vs mutate), discoverable without injecting scripts into
every page on earth.

**We built:** passive detection via MAIN+ISOLATED content scripts on every
http(s) page (MAC'd snapshots, tool counts only), one-click exact-origin
enrollment, and a lazy catalog where discovered tools are searched and executed
through expiring, fence-bound references (ARCHITECTURE.md §3.1, §4).

**The gap:** this costs us `<all_urls>` install-granted host access and makes
the extension fingerprintable by every site (risks R3, R15). A declarative
discovery surface (well-known manifest, `<link>`, or a permission-gated query
API) would remove both costs. WebMCP (`navigator.modelContext`) is the right
direction but needs: declared read/mutate trust levels, a consent hook, and
attested descriptors.

### 2.7 Durable execution
**Needed:** agent runs that survive the host environment's ephemerality with
crash-safe settlement semantics.

**We built:** an OPFS-authoritative run registry — boot fences, revision CAS,
outbox settlement, single-use resume tokens, per-tool replay-safety classes
(read-only auto-resume / idempotent keyed / mutating pauses for the owner) —
because MV3 service workers die at Chrome's discretion
(docs/DURABLE-RUN-ARCHITECTURE.md; ARCHITECTURE.md §2.3; risk R12).

**The gap:** MV3's ephemeral SW is designed for event handlers, not long-lived
work. Every agent-on-MV3 product rebuilds this registry. A platform durable-
execution primitive (start, heartbeat, settle, recover) would retire the
entire class.

## 3. The contrast table

| Agent need | Platform today | What we built (and its cost) |
|---|---|---|
| Agent identity | none (extension is the finest principal) | canonical refs + ledger + executionIds (R: invisible outside our UI) |
| Per-agent storage | one OPFS root per origin | subdirectory multiplexing, no platform backstop (R1) |
| Isolated execution | no Workers in SW; sandbox = opaque-origin iframe | offscreen SPOF hosting 5 subsystems (R11/R13) |
| Attested messaging | sender metadata on content-script messages only | MAC'd handshake + principal router (R3 costs) |
| Consent | install-time, per-extension | JIT permissions + digest-bound per-run cards (R7 TTL bugs) |
| Site tool contracts | WebMCP nascent, no trust levels | `<all_urls>` passive detection + enrollment (R15, f62c) |
| Durable execution | none | full OPFS run registry + outbox + resume (R12) |
| Termination/fuel | none for workers | wall-clock + worker.terminate only (R14) |

## 4. Concrete proposals

Ordered by leverage for agent products, each with its track.

**P1. Agent principals (Chrome extensions, then web).** `chrome.agents`: a
registered, named, user-visible principal with its own storage partition,
permission scope, and activity attribution. Chrome UI (permissions, site data,
history) attributes actions to the agent, not just the extension. This is the
load-bearing proposal: §2.2-2.5 all become expressible once the principal
exists.

**P2. Per-principal storage (web standards).** OPFS buckets bound to a
principal (agent id within an extension; origin-scoped on the web), with
per-bucket quota attribution and user enumeration/clearing in Chrome's site-
data UI. Kills risk R1's "isolation by convention" and gives users real per-
agent data control.

**P3. Worker construction from service workers (Chrome/MV3).** Allow
`new Worker`/`new SharedWorker` in ServiceWorkerGlobalScope. One-line platform
change that deletes our offscreen SPOF (R11/R13) for every MV3 product doing
isolated execution, not just agents.

**P4. Structured per-run consent (Chrome extensions).** An API to request a
capability *for a named agent, for this run*, rendered by Chrome (trusted UI)
with the digest-bound payload pattern we proved out (owner-approval.js).
Extends `chrome.permissions.request` from "extension asks at install/settings"
to "agent asks in the moment, scoped to the task".

**P5. Declarative tool discovery + trust levels (WebMCP standards work).**
Sites declare tools in a fetchable manifest (or `<link rel>`), with per-tool
`readonly`/`mutating` classification; browsers expose a permission-gated
discovery API. Removes the everywhere-injected content script (R3/R15) and
gives consent UX (Q23/eo4d) a standard signal to key on.

**P6. Durable execution primitive (Chrome, research).**
`chrome.runtime.durableTask` (name illustrative): platform-owned journaling,
crash recovery, and settlement callbacks for long-lived extension work. Our
durable-runs registry is the existence proof of the semantics needed (exactly-
once *projection*, honest non-exactly-once side effects, replay-safety
classes).

**P7. Resource accounting for workers (web standards).** Per-worker memory and
CPU accounting with configurable limits — the Wasm fuel/heap gap (R14) is
unfixable in-extension.

**P8. Brokered fetch as a platform capability (web standards).** A fetch mode
with a per-run host allowlist, no credentials, no redirects, no private-
network targets — our `fetch-policy.js` generalized, so agent-authored code can
be allowed network access without opening SSRF (R2).

## 5. What should NOT move into the platform

The hub UX, timelines, model orchestration (the agent loop), provider
management, prompt composition, and the artifact library are product
decisions — they differ per product and should. The platform should own
**principals, isolation, consent, storage attribution, durability, and
attestation**: the guarantees every agent product currently re-derives and
re-audits alone. Everything in section 2's "we built" column is a candidate
for "the platform provides the guarantee; the product keeps the policy".

## 6. Sequencing and where to start

- **Cheapest, highest leverage:** P3 (workers in SW) — a plumbing fix with no
  new UX surface.
- **Most strategic:** P1 (agent principals) — everything else keys off having
  the principal; it also gives Chrome the attribution story agent products
  will be asked for ("what did the agent do?") by default.
- **Standards-track first movers:** P2 (storage buckets + principal binding)
  and P5 (WebMCP trust levels + declarative discovery) — both have existing
  venues and precedents.
- **Research:** P6 durable execution — the semantics are proven here but the
  generalization is genuinely open.
- P4, P7, P8 follow once P1 exists to hang them on.

## 7. The one-paragraph version

The web gave origins storage, identity, and permissions because sites needed
to be principals. Agents need the same promotion. Today an agent product must
build its own principal out of an extension — multiplexing one OPFS root into
fake per-agent stores, routing one offscreen document into fake per-agent
sandboxes, and rendering its own consent cards the platform won't attribute.
Each of those works (this repo is the proof), and each is a place where a
platform primitive would be safer, cheaper, and visible to the user. The
proposals in §4 are ordered so the cheap plumbing lands first and the
principal — the change everything else hangs on — gets the design time it
deserves.
