// panels/user-wasm.js — User Wasm files Settings panel module.

import { mountUserWasmPanel } from "../user-wasm-panel.js";
import { createPanelContext, resolvePanelCtx } from "../panel-context.js";

export { mountUserWasmPanel };

let activeCtx = null;

const ensureCtx = (root, ctx) => (activeCtx = resolvePanelCtx("user-wasm", root, ctx, activeCtx));

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  activeCtx = panelCtx;
  const wasmHost = panelCtx.byId("user-wasm-manager") ?? panelCtx.root;
  const handle = await mountUserWasmPanel(wasmHost);
  if (handle?.unmount) {
    panelCtx.registerCleanup(() => handle.unmount());
  }
  return {
    refresh: () => handle?.refresh?.(),
    unmount: () => {
      if (activeCtx === panelCtx) activeCtx = null;
      panelCtx.unmount();
    },
  };
}
