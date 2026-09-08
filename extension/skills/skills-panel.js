// skills/skills-panel.js — the Skills manager as a REUSABLE panel module.
// Formerly the standalone recipes/index.html page (the sidebar Skills button
// was folded into Settings — the owner wants skills managed as a Settings
// panel), and formerly under extension/recipes/ — moved by
// CAP-FB-20260828-NOUN-DISCIPLINE-01 so the directory says what the UI says.
// The options page mounts this natively in its #skills section; the
// rendering (intent-grouped capability-rows + collapsed "how it works") is the
// SAME component set the standalone page used — no fork, no iframe.

import { send } from "../lib/messages.js";
import { SKILL_ICON } from "../shared/skill-icons.js";

/** A skill = the shared capability-row (consistent layout) + a collapsed
 * "how it works" details for the documentation. The action is "Use in a task"
 * (a skill is included in a task, not run in isolation). */
function recipeCard(r, onUse, onDelete, sendFn = send) {
  const wrap = document.createElement("div");
  wrap.className = "recipe";

  const needs = (r.requiredCapabilities ?? []).length
    ? `needs ${r.requiredCapabilities.join(", ")}`
    : "no extra permissions";
  const baseDesc = `${r.description ?? ""} · ${needs}`;

  const isImported = r.source === "imported" || r.category === "imported";
  const row = document.createElement("capability-row");
  row.setAttribute("name", r.name);
  row.setAttribute("description", baseDesc);
  row.setAttribute("icon", SKILL_ICON[r.icon] ?? "");
  row.setAttribute("action", isImported ? "use-delete" : "use");
  row.addEventListener("use", () => onUse?.(r));
  if (isImported) {
    row.addEventListener("delete", async () => {
      const res = await sendFn("skill.delete", { id: r.id }).catch(() => ({ ok: false }));
      if (res?.ok) {
        if (onDelete) onDelete();
        else wrap.remove();
      }
    });
  }

  const details = document.createElement("details");
  details.className = "how";
  const summary = document.createElement("summary");
  summary.textContent = "How it works";
  const how = document.createElement("p");
  const hint = document.createElement("span");
  hint.className = "hint";
  const fileCount = (r.fileCount ?? 0) > 1 ? ` · ${r.fileCount} files` : "";
  const large = (r.promptBytes ?? 0) > 8192 || (r.prompt ?? "").length > 8192 ? " · large (load on demand)" : "";
  hint.textContent = `/skill:${r.refId ?? r.id}${fileCount}${large}`;
  // Imported large skills carry metadata only (the body lives in OPFS); the
  // "how it works" panel must not dump an absent body — show the description
  // and the on-demand loader note instead.
  const bodyText = r.prompt ?? "";
  how.textContent = bodyText
    ? bodyText
    : `${r.description ?? ""}${large ? " — the full body and supporting files load on demand via skill_read during a run." : ""}`.trim() || r.id;
  details.append(summary, how, hint);

  wrap.append(row, details);
  return wrap;
}

/** Render the intent-grouped skill list into `listEl` from the live
 * recipe.list record. Exported for tests (a seeded store, no SW needed).
 *
 * CAP-FB-20260831-SKILL-LIST-SYNC-01: the catalog (skill.list / recipe.list)
 * is the SINGLE filter authority — the panel applies NO private filter (that
 * private `mode === "on-demand"` copy is what let Settings and /skill drift;
 * background recipes are excluded by the catalog, not by this panel). Skills
 * that failed to load surface in the broken-errors line, never silently. */
export async function renderSkillList(listEl, { onUse, onDelete, send: sendFn = send } = {}) {
  const [res, brokenRes] = await Promise.all([
    sendFn("recipe.list").catch(() => ({ recipes: [] })),
    sendFn("skill.list").catch(() => ({ skills: [], broken: [] })),
  ]);
  const recipes = Array.isArray(res.recipes) ? res.recipes : [];
  const broken = Array.isArray(brokenRes?.broken) ? brokenRes.broken : [];
  listEl.replaceChildren();
  if (broken.length > 0) {
    const brokenEl = document.createElement("div");
    brokenEl.className = "skills-broken";
    brokenEl.setAttribute("role", "note");
    brokenEl.textContent =
      `${broken.length} skill${broken.length === 1 ? "" : "s"} could not be loaded and ${broken.length === 1 ? "is" : "are"} hidden from pickers: ` +
      broken.map((b) => `${b.id} (${b.reason})`).join("; ") +
      ". See the browser console for details.";
    listEl.append(brokenEl);
  }
  if (!recipes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No skills yet.";
    listEl.append(empty);
    return recipes;
  }
  const handleDelete = onDelete || (() => renderSkillList(listEl, { onUse, onDelete, send: sendFn }));
  const byIntent = {};
  for (const r of recipes) (byIntent[r.intent] ??= []).push(r);
  for (const [intent, list] of Object.entries(byIntent)) {
    const group = document.createElement("div");
    group.className = "intent-group";
    const head = document.createElement("div");
    head.className = "intent-head";
    head.textContent = intent;
    group.append(head);
    for (const r of list) group.append(recipeCard(r, onUse, handleDelete, sendFn));
    listEl.append(group);
  }
  return recipes;
}

/** Use a skill in a task: hand the reference to the hub composer. When the
 * settings panel is hosted by the NTP view overlay (the normal in-context
 * case) the parent NTP receives the postMessage and pre-fills the composer.
 * When Settings is opened as a bare tab (no hub parent), degrade honestly:
 * copy the /skill:<id> reference and confirm inline — never a silent no-op. */
export function useSkill(skill, { statusEl } = {}) {
  const ref = `/skill:${skill.refId ?? skill.id}`;
  try {
    if (window.parent && window.parent !== window) {
      // Send the source-qualified refId so the hub pre-fills a collision-proof
      // reference (CAP-FB-20260831-SKILL-LIST-SYNC-01 r2).
      window.parent.postMessage({ type: "use-skill", id: skill.refId ?? skill.id }, "*");
      return;
    }
  } catch {
    // Cross-origin parent — fall through to the copy fallback.
  }
  (async () => {
    try {
      await navigator.clipboard.writeText(ref);
      if (statusEl) statusEl.textContent = `Copied ${ref} — paste it in the hub composer to use it.`;
    } catch {
      if (statusEl) statusEl.textContent = `Copy this reference to use it: ${ref}`;
    }
  })();
}

/** Wire the import form + list inside a container. Idempotent per container:
 * the section re-renders in place (re-imports refresh the list). */
export function mountSkillsSection(sectionEl, { send: sendFn = send } = {}) {
  if (!sectionEl || sectionEl.dataset.skillsMounted === "1") return;
  sectionEl.dataset.skillsMounted = "1";
  const list = sectionEl.querySelector(".skills-list");
  const status = sectionEl.querySelector(".import-status");
  const urlInput = sectionEl.querySelector(".import-url");
  const importBtn = sectionEl.querySelector(".import-btn");

  const refresh = () => renderSkillList(list, {
    onUse: (r) => useSkill(r, { statusEl: status }),
    onDelete: () => refresh(),
    send: sendFn,
  });
  sectionEl._refreshSkills = refresh;

  const doImport = async () => {
    const url = urlInput?.value?.trim();
    if (!url) { status.textContent = "Enter a URL first"; return; }
    importBtn.disabled = true;
    status.textContent = "Importing…";
    const out = await sendFn("skill.import", { url }).catch(() => ({ ok: false, error: "import failed" }));
    importBtn.disabled = false;
    if (out?.ok) {
      const fileNote = (out.skill?.fileCount ?? 0) > 1 ? ` (${out.skill.fileCount} files)` : "";
      // Fresh imports always live in the imported store → the collision-proof
      // reference is imported:<id>.
      status.textContent = `Imported "${out.skill.name}"${fileNote} — use /skill:imported:${out.skill.id}`;
      urlInput.value = "";
      await refresh();
    } else {
      status.textContent = out?.error ?? "import failed";
    }
  };
  importBtn?.addEventListener("click", doImport);

  // ── Multi-skill discovery + batch import (chrome-agent-platform-kozg.4) ──
  const discoverBtn = sectionEl.querySelector(".discover-btn");
  const discoveryCard = sectionEl.querySelector(".discovery-card");
  const discoverySummary = sectionEl.querySelector(".discovery-summary");
  const discoveryList = sectionEl.querySelector(".discovery-list");
  const discoveryActions = sectionEl.querySelector(".discovery-actions");
  const batchProgress = sectionEl.querySelector(".batch-progress");
  const commandsList = sectionEl.querySelector(".commands-list");
  let discovery = null; // the live skill.discover result for this section

  const setProgress = (text) => { if (batchProgress) { batchProgress.hidden = false; batchProgress.textContent = text; } };

  /** Render the discovery preview card: the summary line + one checkbox row
   * per discovered skill/command (checked by default = import all). */
  const renderDiscovery = (d) => {
    if (!discoveryCard) return;
    discovery = d;
    discoveryCard.hidden = false;
    if (discoverySummary) discoverySummary.textContent = discoveryLine(d);
    if (discoveryList) {
      discoveryList.replaceChildren();
      const addRow = (entry, kind) => {
        const label = document.createElement("label");
        label.className = "discovery-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = true;
        box.dataset.kind = kind;
        box.dataset.id = String(entry?.id ?? "");
        label.append(box);
        const name = document.createElement("span");
        name.className = "discovery-name";
        name.textContent = entry?.name ?? entry?.id ?? "(unnamed)";
        const kindTag = document.createElement("span");
        kindTag.className = "discovery-kind";
        kindTag.textContent = kind === "command" ? "command" : (entry?.plugin ? `plugin: ${entry.plugin}` : "skill");
        const desc = document.createElement("span");
        desc.className = "discovery-desc";
        desc.textContent = String(entry?.description ?? "").slice(0, 160);
        label.append(name, kindTag, desc);
        discoveryList.append(label);
      };
      for (const s of (Array.isArray(d?.skills) ? d.skills : [])) addRow(s, "skill");
      for (const c of (Array.isArray(d?.commands) ? d.commands : [])) addRow(c, "command");
    }
    if (discoveryActions) discoveryActions.hidden = false;
  };

  const collectSelection = () => {
    const ids = [];
    discoveryList?.querySelectorAll('input[type="checkbox"]:checked').forEach((box) => ids.push(box.dataset.id));
    return selectEntriesByIds(discovery, ids);
  };

  const doDiscover = async () => {
    const url = urlInput?.value?.trim();
    if (!url) { if (status) status.textContent = "Enter a GitHub URL first"; return; }
    if (discoverBtn) discoverBtn.disabled = true;
    if (discoveryCard) discoveryCard.hidden = true;
    if (status) status.textContent = "Discovering skills and commands…";
    try {
      const d = await sendFn("skill.discover", { url });
      if (d?.ok === false) throw new Error(d?.error ?? "discovery failed");
      if (discoveryCard) renderDiscovery(d);
      if (status) status.textContent = "";
    } catch (e) {
      if (status) status.textContent = `Could not discover skills in that repository - check the URL is a GitHub repo, then try again. (${String(e?.message ?? e)})`;
    } finally {
      if (discoverBtn) discoverBtn.disabled = false;
    }
  };
  discoverBtn?.addEventListener("click", doDiscover);

  const renderBatchProgress = (p) => {
    const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
    setProgress(`Imported ${p.done} of ${p.total} (${pct}%)${p.errors ? ` — ${p.errors} failed` : ""}…`);
  };

  const doBatchImport = async (selection) => {
    const total = (selection.skills?.length ?? 0) + (selection.commands?.length ?? 0);
    if (total === 0) { setProgress("Nothing selected to import"); return; }
    if (importBtn) importBtn.disabled = true;
    if (discoverBtn) discoverBtn.disabled = true;
    renderBatchProgress({ done: 0, total, errors: 0 });
    const res = await runBatchImport(selection, {
      send: sendFn,
      chunkSize: 4,
      onProgress: renderBatchProgress,
    });
    if (importBtn) importBtn.disabled = false;
    if (discoverBtn) discoverBtn.disabled = false;
    const note = res.errors.length
      ? ` — ${res.errors.length} failed: ${res.errors.map((e) => `${e.id} (${String(e.error).slice(0, 60)})`).join("; ")}`
      : "";
    setProgress(`Imported ${res.imported.skills.length} skills and ${res.imported.commands.length} commands${note}`);
    if (!res.errors.length) {
      urlInput.value = "";
      if (discoveryCard) discoveryCard.hidden = true;
    }
    await refresh();
    await renderCommands();
  };

  const importAllBtn = sectionEl.querySelector(".import-all-btn");
  const importSelectedBtn = sectionEl.querySelector(".import-selected-btn");
  importAllBtn?.addEventListener("click", () => doBatchImport(selectAllEntries(discovery)));
  importSelectedBtn?.addEventListener("click", () => doBatchImport(collectSelection()));

  // ── Installed commands (command.list / command.delete) ──────────────────
  const renderCommands = async () => {
    if (!commandsList) return;
    const res = await sendFn("command.list").catch(() => ({ commands: [] }));
    const commands = Array.isArray(res?.commands) ? res.commands : [];
    commandsList.replaceChildren();
    if (commands.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No commands imported yet.";
      commandsList.append(empty);
      return;
    }
    const head = document.createElement("div");
    head.className = "intent-head";
    head.textContent = "commands";
    commandsList.append(head);
    for (const cmd of commands) {
      const view = commandView(cmd);
      const wrap = document.createElement("div");
      wrap.className = "recipe";
      const row = document.createElement("capability-row");
      row.setAttribute("name", view.name);
      row.setAttribute("description", view.description || "imported command");
      row.setAttribute("action", "use-delete");
      row.addEventListener("use", () => onUse?.(view));
      row.addEventListener("delete", async () => {
        const res2 = await sendFn("command.delete", { id: view.id }).catch(() => ({ ok: false }));
        if (res2?.ok) await renderCommands();
      });
      const details = document.createElement("details");
      details.className = "how";
      const summary = document.createElement("summary");
      summary.textContent = "How it works";
      const how = document.createElement("p");
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = view.ref;
      how.textContent = view.description || `Imported command ${view.name}.`;
      details.append(summary, how, hint);
      wrap.append(row, details);
      commandsList.append(wrap);
    }
  };

  const refreshAll = () => { refresh(); renderCommands(); };
  sectionEl._refreshSkills = refreshAll;

  urlInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") doImport(); });

  refresh();
  renderCommands();
}

// ── Multi-skill discovery + batch import + installed commands
// (chrome-agent-platform-kozg.4). The SW routes (skill.discover /
// skill.importBatch / command.list / command.delete) landed with kozg.1/.2;
// this is the panel surface. The decision logic is pure and exported so the
// committed tests execute it (the uodl rule: a pin on the source text proves
// nothing).

/** The preview-card summary line for a skill.discover result. */
export function summarizeDiscovery(d) {
  const stats = d?.stats ?? {};
  const n = (v, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : fallback;
  };
  const pluginCount = n(stats.pluginCount, (d?.plugins ?? []).length);
  const skillCount = n(stats.skillCount, (d?.skills ?? []).length);
  const commandCount = n(stats.commandCount, (d?.commands ?? []).length);
  const repo = d?.owner && d?.repo ? `${d.owner}/${d.repo}` : String(d?.repo ?? "repository");
  return { pluginCount, skillCount, commandCount, repo };
}

export function discoveryLine(d) {
  const s = summarizeDiscovery(d);
  return `Found ${s.pluginCount} plugin${s.pluginCount === 1 ? "" : "s"}, ${s.skillCount} skill${s.skillCount === 1 ? "" : "s"}, ${s.commandCount} command${s.commandCount === 1 ? "" : "s"} in ${s.repo}`;
}

/** The batch selection for "import all": every discovered entry. */
export function selectAllEntries(d) {
  return { skills: [...(d?.skills ?? [])], commands: [...(d?.commands ?? [])] };
}

/** The batch selection narrowed to the checked ids (a skill/command id set). */
export function selectEntriesByIds(d, ids) {
  const set = new Set((Array.isArray(ids) ? ids : []).map(String));
  const pick = (list) => (Array.isArray(list) ? list : []).filter((e) => set.has(String(e?.id ?? "")));
  return { skills: pick(d?.skills), commands: pick(d?.commands) };
}

/** Split a batch selection into bounded chunks so the panel can report real
 * progress between network round trips (each chunk is one skill.importBatch
 * call; the SW installs its items sequentially inside the call). */
export function chunkBatchSelection(sel, size = 4) {
  const sizeN = Number.isSafeInteger(size) && size > 0 ? size : 4;
  const skills = Array.isArray(sel?.skills) ? sel.skills : [];
  const commands = Array.isArray(sel?.commands) ? sel.commands : [];
  // A flat typed list sliced across the skill/command boundary keeps every
  // chunk a valid skill.importBatch payload.
  const flat = [
    ...skills.map((s) => ({ kind: "skill", entry: s })),
    ...commands.map((c) => ({ kind: "command", entry: c })),
  ];
  const chunks = [];
  for (let i = 0; i < flat.length; i += sizeN) {
    const part = flat.slice(i, i + sizeN);
    chunks.push({
      skills: part.filter((x) => x.kind === "skill").map((x) => x.entry),
      commands: part.filter((x) => x.kind === "command").map((x) => x.entry),
    });
  }
  return { chunks, total: flat.length };
}

/** The batch import driver: bounded chunks, real progress between them,
 * per-item error accumulation (the SW reports per-item errors in its result). */
export async function runBatchImport(sel, { send: sendFn = send, chunkSize = 4, onProgress = null } = {}) {
  const { chunks, total } = chunkBatchSelection(sel, chunkSize);
  let done = 0;
  const imported = { skills: [], commands: [] };
  const errors = [];
  for (const chunk of chunks) {
    const res = await sendFn("skill.importBatch", { skills: chunk.skills, commands: chunk.commands })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e), skills: [], commands: [], errors: [{ error: String(e?.message ?? e) }] }));
    for (const s of (Array.isArray(res?.skills) ? res.skills : [])) imported.skills.push(s);
    for (const c of (Array.isArray(res?.commands) ? res.commands : [])) imported.commands.push(c);
    for (const e of (Array.isArray(res?.errors) ? res.errors : [])) errors.push(e);
    done += chunk.skills.length + chunk.commands.length;
    if (total > 0) onProgress?.({ done, total, errors: errors.length });
  }
  return { ok: errors.length === 0 && done === total, imported, errors, done, total };
}

/** The view model for one installed command row (command.list entry). */
export function commandView(cmd) {
  const name = String(cmd?.name ?? cmd?.id ?? "command");
  const hint = String(cmd?.argumentHint ?? "").trim();
  const description = String(cmd?.description ?? "").trim();
  return {
    id: String(cmd?.id ?? name),
    name,
    hint,
    description,
    ref: `/${name}${hint ? " " + hint : ""}`,
  };
}
