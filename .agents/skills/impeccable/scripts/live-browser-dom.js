/**
 * Browser-side DOM helpers for Impeccable live mode.
 *
 * Kept separate from live-browser.js so future browser script parts can share
 * chrome mounting, lookup, focus, and picker helpers without depending on the
 * full overlay UI bundle.
 */
(function (root) {
  'use strict';
  if (!root) return;

  function createLiveBrowserDomHelpers({
    prefix,
    skipTags,
    document: doc = root.document,
    css = root.CSS,
    crypto = root.crypto,
  } = {}) {
    if (!prefix) throw new Error('prefix required');
    if (!doc) throw new Error('document required');
    const tagsToSkip = skipTags || new Set();

    function own(el) {
      return el && (el.id?.startsWith(prefix) || el.closest?.('[id^="' + prefix + '"]'));
    }

    // chrome-agent-platform-hheu4: pickable() forced layout on EVERY
    // pointermove — getBoundingClientRect per element per event, several
    // elements per event burst. Cache each element's rect and invalidate on
    // scroll, resize, DOM mutation (childList, attributes AND characterData —
    // text-node data/nodeValue updates are the React text-update shape), and
    // explicit apply-completion so the measurements are reused across the
    // burst while never outliving a signalled layout change.
    // chrome-agent-platform-1cs04: layout changes with NO scroll/resize/DOM-
    // mutation signal — CSS animation/transition, hover-driven resize, webfont
    // or image load — do NOT invalidate this cache. Callers that drive those
    // must invalidate explicitly (dispose() also drops the cache).
    // chrome-agent-platform-ffp7s: hheu4 only routed pickable() through the
    // cache; the insert-mode path (live-browser.js layoutFlowChildren +
    // handleMouseMove's target read) kept calling getBoundingClientRect
    // directly, so every uncoalesced mousemove still forced N+1 layouts.
    // cachedRect() below is the SINGLE shared read path for this cache —
    // every hot-path caller must go through it, never raw
    // getBoundingClientRect, or the fix silently regresses per caller.
    let elementRectCache = new WeakMap();
    function invalidateElementRects() {
      // WeakMap has no clear(); a fresh map drops every entry.
      elementRectCache = new WeakMap();
    }

    // The shared cache read. Returns the same cached DOMRect snapshot for an
    // element until the next invalidation, for EVERY caller.
    function cachedRect(el) {
      if (!el || typeof el.getBoundingClientRect !== 'function') return null;
      let r = elementRectCache.get(el);
      if (!r) {
        r = el.getBoundingClientRect();
        elementRectCache.set(el, r);
      }
      return r;
    }
    // Per-instance listeners: each instance's invalidator clears only its own
    // cache, so parallel instances stay correct (the cost is one listener set
    // per live session — created once per live-mode start).
    // chrome-agent-platform-1rc3n: registration is guarded so non-window roots
    // (Node harnesses, stub roots) degrade to explicit invalidation only,
    // mirroring the MutationObserver typeof guard below; dispose() removes the
    // listeners and disconnects the observer so repeated factory calls cannot
    // accumulate observers on doc for the process lifetime.
    const onScroll = () => invalidateElementRects();
    const onResize = () => invalidateElementRects();
    let rectObserver = null;
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('scroll', onScroll, { capture: true, passive: true });
      root.addEventListener('resize', onResize, { passive: true });
    }
    if (typeof MutationObserver === 'function') {
      // chrome-agent-platform-m0uen: the observer used to fire on the overlay's OWN
      // chrome writes — setPageInteractionCursor rewrites the cursor <style>'s
      // textContent on every insert-mode mousemove, and showHighlight/showInsertLine
      // write inside the UI root — so the cache measuring the HOST page was emptied
      // by our own churn between moves and never amortised (reviewer measured
      // [5,5,5,5] rect reads per element across 5 insert-mode moves instead of
      // [1,1,1,1]). Own-chrome mutations cannot change host layout (the cursor
      // style is style-only; the chrome is overlay UI), so records whose targets
      // are all inside [id^=prefix] are ignored; ANY host-page record still
      // invalidates, exactly as before, and anything not provably own-chrome
      // (including a malformed record list) fails safe toward invalidation.
      const isOwnChromeTarget = (node) => {
        if (!node) return false;
        const el = node.nodeType === 1 ? node : node.parentElement;
        return !!own(el);
      };
      rectObserver = new MutationObserver((records) => {
        if (!Array.isArray(records) || records.some((r) => !isOwnChromeTarget(r && r.target))) {
          invalidateElementRects();
        }
      });
      rectObserver.observe(doc, { childList: true, subtree: true, attributes: true, characterData: true });
    }

    function dispose() {
      if (typeof root.removeEventListener === 'function') {
        root.removeEventListener('scroll', onScroll, { capture: true });
        root.removeEventListener('resize', onResize);
      }
      if (rectObserver) {
        rectObserver.disconnect();
        rectObserver = null;
      }
      invalidateElementRects();
    }

    function pickable(el) {
      if (!el || el.nodeType !== 1) return false;
      if (tagsToSkip.has(String(el.tagName || '').toLowerCase())) return false;
      if (own(el)) return false;
      const r = cachedRect(el);
      return !!r && r.width >= 20 && r.height >= 20;
    }

    function desc(el) {
      if (!el) return '';
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
      return s;
    }

    function rectIsUsableAnchor(rect) {
      return !!rect && rect.width > 0.5 && rect.height > 0.5;
    }

    function makeFrozenAnchor(el) {
      if (!el || !el.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      if (!rectIsUsableAnchor(r)) return null;
      const rect = {
        x: r.x, y: r.y,
        top: r.top, left: r.left,
        right: r.right, bottom: r.bottom,
        width: r.width, height: r.height,
      };
      return {
        __impeccableFrozenAnchor: true,
        tagName: el.tagName || 'DIV',
        id: el.id || '',
        classList: el.classList ? [...el.classList] : [],
        hasAttribute: () => false,
        getBoundingClientRect: () => rect,
      };
    }

    function id8() {
      if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      return (Math.random().toString(16).slice(2) + Date.now().toString(16)).slice(0, 8);
    }

    function cssId(id) {
      if (css?.escape) return css.escape(id);
      return String(id).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
    }

    function liveUiRoot() {
      const uiRoot = root.__IMPECCABLE_LIVE_UI_ROOT__;
      if (uiRoot && typeof uiRoot.appendChild === 'function') return uiRoot;
      return doc.body;
    }

    function uiAppend(el) {
      liveUiRoot().appendChild(el);
      return el;
    }

    function uiAppendStyle(styleEl) {
      const uiRoot = liveUiRoot();
      if (uiRoot && uiRoot !== doc.body) uiRoot.appendChild(styleEl);
      else doc.head.appendChild(styleEl);
      return styleEl;
    }

    function uiGetById(id) {
      const uiRoot = liveUiRoot();
      if (uiRoot?.getElementById) {
        const found = uiRoot.getElementById(id);
        if (found) return found;
      }
      if (uiRoot?.querySelector) {
        const found = uiRoot.querySelector('#' + cssId(id));
        if (found) return found;
      }
      return doc.getElementById(id);
    }

    function activeElementDeep() {
      let active = doc.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active;
    }

    function defangOutsideHandlers(rootEl, { setPointerEvents = true } = {}) {
      if (!rootEl) return;
      if (setPointerEvents) {
        rootEl.style.setProperty('pointer-events', 'auto', 'important');
      }
      const stop = (e) => e.stopPropagation();
      rootEl.addEventListener('pointerdown', stop);
      rootEl.addEventListener('mousedown', stop);
      rootEl.addEventListener('focusin', stop);
    }

    return {
      own,
      pickable,
      cachedRect,
      invalidateElementRects,
      dispose,
      desc,
      rectIsUsableAnchor,
      makeFrozenAnchor,
      id8,
      cssId,
      liveUiRoot,
      uiAppend,
      uiAppendStyle,
      uiGetById,
      activeElementDeep,
      defangOutsideHandlers,
    };
  }

  root.__IMPECCABLE_LIVE_DOM__ = {
    version: 1,
    createLiveBrowserDomHelpers,
  };
})(typeof window !== 'undefined' ? window : globalThis);
