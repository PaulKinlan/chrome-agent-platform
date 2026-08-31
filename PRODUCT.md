# PRODUCT.md — Chrome Agent Platform

## Users
A power user (knowledge worker, developer, researcher) orchestrating browser agents.
They return to the hub repeatedly across a day, often mid-task, and want to see
what the agents are doing and start the next thing without friction.

## Mode
Operate. The hub is a command center: design serves the task, never decorates it.
The tool must disappear into the work — earned familiarity over novelty.

## Job
Start a task, see what's happening (the active conversation, the background
agents' last runs, the enrolled site agents, the artifacts), and drill in.

## Brand personality
Calm, technical, confident. No hype, no gamification, no decorative motion. The
surface is a precise instrument: quiet, measured, exact.

## Aesthetic direction
A warm-neutral paper (light) with hairline borders and a single confident
petrol-teal accent; a warm charcoal for dark. A workhorse system sans (not a
display face, not monospace-as-costume). Deliberate 8px spacing grid, 12px card
radii, consistent control sizing. Inline SVG line-art icons in one stroke weight,
currentColor.

## Anti-references
Cluttered dashboards. AI beige (warm cream + terracotta + serif). Default purple
and GitHub blue-black. Over-rounded cards and ghost cards (border + soft shadow).
Rainbow conic-gradient "glow". Emoji icons. Uppercase tracked kicker labels.

## Design principles
1. Clarity over density — one primary action per view, generous whitespace.
2. Exact alignment — every row on a deliberate grid; nothing runs together.
3. Restraint — one accent, used for actions/selection/state only, never decoration.
4. Consistency — one component vocabulary everywhere; same button, same control.
5. Calm motion — 150–250ms state transitions only; reduced-motion respected.

---

# Where the product is going (2026-08-28)

Written after auditing the shipped product in a real loaded extension. The owner's
report was "the UI is starting to get messy". It is — but not in a hundred small
ways. There are three structural causes, and they are measurable.

## Why it feels messy

**1. The product speaks three vocabularies for the same nouns.**
*(Fixed for everything a person reads, `0.2.355` — CAP-FB-20260828-NOUN-DISCIPLINE-01.)*
One view was `Assets` in the sidebar, `Recent artifacts` on the card next to it,
`artifacts/index.html` on disk, and `asset.*` in the routes — and `ntp.js` opened it
with the title "Assets" in one place and "Artifacts" in another. `Skills` in the nav
was `recipes/index.html`. `Agents` labelled a sidebar section, a card, and a row
inside that card. A person builds a mental model out of nouns; three names for one
noun means there is no model to build. This was the cheapest thing on this page to fix
and the fastest to feel.
Every user-facing surface now says **Artifacts**, the Agents card names itself once,
and `npm run check:vocabulary` fails the build on a banned term the way
`check:gallery` fails on component drift. What is deliberately unchanged is the wire:
the `asset.*` / `recipe.*` routes, the `*_asset` tool names and the `asset:` storage
keys are a persisted approval/data boundary and get their own reviewed migration. The
checker does not scan them, so it cannot be satisfied by weakening it.

**2. Every capability got its own HTML document, and the hub embeds them in an
iframe.** Twelve HTML surfaces ship; two of them — `chat/chat.html` and
`memory/explorer.html` — are referenced by nothing at all and still ship to users.
Settings, Directory and Artifacts are separate documents loaded into
`#view-frame` (Skills stopped being one of them — its manager is a Settings panel). Five tracked defects trace to that one decision: two back-stack fixes
(`0.2.296`, `0.2.304`), the task-view transition ghost, the covered-nub overflow, the
intermittent UI flash, and the Settings monolith — because when a view is a document,
adding a feature means appending a `<section>`, which is how Settings reached
12,837px with all twelve panels rendered at once. The architecture scales by
accretion and the defect list is the accretion becoming visible.

**3. The hub is three products stacked in one scroll.** An onboarding flow (six
competing actions), a launcher (the composer), and a dashboard (three status cards
that are empty on a fresh profile). This file says the job is "start a task, see
what's happening, and drill in" — and the composer, which is the whole first half of
that sentence, is the second element on the page and visually weaker than the card
above it.
*(First screen fixed, CAP-FB-20260827-HUB-FIRST-RUN-01, 2026-08-30: the composer is
the first element in the DOM and the tab order and sits above the fold at 1024x700;
the onboarding card is a one-sentence banner with ONE action — "Connect a model" —
shown only while no provider is connected; three example chips sit under the
composer; a section renders only once its store has ever had data, so a fresh
profile shows the composer, the chips and the banner and nothing else. The
dashboard-to-timeline collapse is still CAP-FB-20260828-HUB-AS-TIMELINE-01.)*

## The direction

**Nouns before pixels.** *(Done for the UI, `0.2.355`; the routes remain.)* One name
per concept, enforced by a check the way `check:gallery` enforces component drift:
**Artifacts** (never Assets), **Skills** (never recipes), **Agents** used once per
view. The files followed the UI where it was safe (`extension/recipes/` is gone); the
routes did not, and that is a separate, security-boundary change rather than a
rename. Nothing else on this list changed the felt quality of the product as cheaply.

**The hub is a composer and a timeline, not a dashboard.** A returning power user
mid-task needs two things: somewhere to say the next thing, and what happened while
they were gone. Three separate mostly-empty status cards are not that. Collapse
Agents / Recent artifacts / Recent activity into one activity stream with filters,
and let the composer own the top of the page.
*(Spine landed, CAP-FB-20260828-HUB-AS-TIMELINE-01: below the composer the hub now
shows ONE reverse-chronological `<agent-timeline>` — the tasks the owner started and
the runs their agents finished, built from the pure `buildTimeline` projection of the
thread index + the durable-run registry — and the Recent artifacts / Recent activity
catalog cards are cut. An artifact lives in its thread and the sidebar Artifacts
library; the mutating-action ledger lives in the sidebar Activity section. Still to
do on this entry: the filter row (All · Runs · Waiting · Made · Scheduled), the "N
runs today" header, and moving the Agents card's Find-site-tools / WebMCP entry points
to the sidebar so that card can be cut too.)*

**Subtract surfaces.** Delete the two dead documents. Then ask of each remaining
view whether it earns being a view: Directory is a reference table that could live
inside the hub, and the memory explorer already lost that argument by being
unreachable for weeks without anyone noticing.

**Collapse the view-frame — after the demo.** Same-origin extension pages loaded
into an iframe of another extension page buy nothing and cost the back-stack, a
double bootstrap per view, and the Settings monolith. Making the hub one document
with real client-side views retires a whole class of defect. It is the biggest lever
here and also the biggest risk, so it is deliberately sequenced after the demo, not
before it.

**Settings needs an information architecture, not more sections.** Twelve flat
panels is a list, not a structure. Six groups — Providers & models · Agents ·
Permissions & security · Tools · Data · Advanced — and render the one that was asked
for.

**The conversation should read as what the agent did.** Today a tool call is either
a name and a status chip, or 462px of object inspector. Neither tells the story. The
transcript is the product's main surface and should read as a narrative with detail
available on demand — not a debugger that happens to be embedded in a chat.

## What this is (Paul, 2026-08-28)

A **coworking environment for knowledge workers, in the browser**. The tools exist to
let you finish a large range of work without leaving it. They come in two families:

- **Running the browser** — orchestrating tabs, windows, groups, downloads, history,
  and reacting to what the environment does.
- **Doing the work** — the knowledge-worker tools: data, text, files, documents,
  artifacts, skills.

And **WebMCP is the long game**: any website can expose itself as a tool, so the set of
things this can do grows with the web rather than with our release notes.

An earlier draft of this section claimed the product had "a thin story" and needed to
pick one thing it was for. That was wrong, and vaguely put. The purpose is clear. What
follows is what that purpose implies for the UI — which is a sharper critique than the
one it replaces, because it can be checked against the thesis.

## What the thesis implies, and where the UI does not match it yet

**Coworking is organised around work; the hub is organised around object types.**
Agents, Recent artifacts and Recent activity are three catalogs — they answer "what
objects exist?" A colleague-shaped environment answers "what is in flight, what is
waiting on me, what came back while I was gone?" Same information, different spine.
This is the real argument for `CAP-FB-20260828-HUB-AS-TIMELINE-01`, and a better one
than the composition argument it was filed with. A first step landed
(`CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01`): a coworker you can trust is one whose
work you can see and take back, so every mutating action the agents take now writes
a plain-language "what I did" row — "Closed Example Domain", "Grouped 3 tabs" — with
an Undo on the ones that can be reversed, shown in the hub's Activity section and the
side panel. It is the ledger the coworker page actions and the companion build on.

**Artifacts are the central store of everything the person has made — and they must
outlive the agent and the task that made them.** (Paul, 2026-08-28.) The point of an
artifact is that it can be built on: a summary report written in one task is an input to
a follow-up task, or to a different agent entirely. Agents get killed. Tasks get
deleted. The artifact library is the thing that survives both, and it is where the
person's accumulated work lives.

So this is both/and, not either/or. An artifact appears in the thread that produced it,
because that is where you are when it is made and where its context is. AND it is a
first-class entry in a central library that is independent of that thread's lifetime,
addressable from any later task. An earlier draft of this file called the gallery "the
archive, not the primary home", which got the emphasis backwards — the library IS a
primary home, it just should not be the ONLY place an artifact is visible.

This is currently broken in a way that loses data: artifacts created under a site
origin live in that site's store, and deleting the Site Agent clears it. See
`CAP-FB-20260828-ARTIFACT-DURABILITY-01`.

**If every website is a tool, enrollment should not feel like configuration.** Today a
site becomes an agent by being enrolled — Settings → Site agents, a "Discovered open
pages — click to add" box, a curated list. That is a configuration model, and it puts a
setup step between the user and the most distinctive thing the product does. The WebMCP
thesis points the other way: the browser already knows the current tab offers tools, so
that capability should simply be present for a task on that tab, with the owner
approving its use rather than pre-registering the site. This is the biggest gap between
what the product IS and how it presents itself, and it is not currently tracked as
anything.

**The two tool families are invisible.** The tool library is one flat list of 126.
If "run the browser" and "do the work" are genuinely different halves, saying so helps a
person predict what they can ask for — which is the actual problem a 126-item list
creates. Right now the only grouping is by Chrome API.

## Design implications, restated as rules

1. The hub's spine is **work in progress**, not object catalogs.
2. An artifact appears in **the thread that produced it** AND in a **central library
   that outlives that thread, its agent and its task** — deliverables are built upon.
3. A site's tools should be **available on the tab**, approved in the moment — not
   pre-registered in Settings.
4. Group tools by **what they are for**, not by which Chrome API implements them.
5. **Results persist.** A run the owner did not watch — a scheduled agent that fired
   while the tab was closed — must leave something behind: a row on the hub timeline
   with its outcome, a retrievable report artifact (keyed per agent so it rolls, not
   piles up), and, when notifications are granted, a completion notification whose
   click opens the agent. A run that leaves no trace did not happen, as far as the
   owner can tell.
