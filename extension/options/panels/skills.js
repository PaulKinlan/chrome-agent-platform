// panels/skills.js — Skills & imported commands Settings panel module.

import { mountSkillsSection } from "../../skills/skills-panel.js";
import { createPanelContext, resolvePanelCtx } from "../panel-context.js";

let activeCtx = null;

const ensureCtx = (root, ctx) => (activeCtx = resolvePanelCtx("skills", root, ctx, activeCtx));

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  activeCtx = panelCtx;
  const sectionEl = panelCtx.byId("skills") ?? panelCtx.root;
  const handle = mountSkillsSection(sectionEl, {
    send: (type, payload = {}) => panelCtx.send(type, payload),
    onUse: panelCtx.callbacks?.useSkill ?? null,
  });
  if (handle?.unmount) {
    panelCtx.registerCleanup(() => handle.unmount());
  }
  await (handle?.ready ?? Promise.resolve());
  return {
    refresh: () => handle?.refresh?.(),
    unmount: () => {
      if (activeCtx === panelCtx) activeCtx = null;
      panelCtx.unmount();
    },
  };
}
