// lib/artifacts.js — the artifacts (asset) system.
//
// Agents create things for the user in the context of a task: generated pages,
// files, data, UI fragments. An artifact is an origin-keyed asset with a type,
// a name, and bounded content. The hub agent manages them via the create_asset /
// update_asset / delete_asset / list_assets / get_asset tools (see
// lib/management-tools.js), and the UI surfaces them per-task and in a master
// hub view (PLAN.md "Feature: Artifacts").
//
// Storage model: each asset is a SEPARATE OPFS value under `asset:<id>` (so a
// single asset may use the full per-value bound, and the per-origin aggregate
// quota still bounds the whole store). A lightweight INDEX (`assets`, reserved —
// never model-writable via memory_set) lists {id,type,name,origin,at,size} so
// list_assets never has to read every asset body.

import { masterMemory, siteMemory, canonicalOrigin } from "./memory.js";

const INDEX_KEY = "assets"; // reserved authority key (see memory.js)
const CONTENT_PREFIX = "asset:";

export const ASSET_BOUNDS = {
  maxContentBytes: 256 * 1024, // 256 KiB content per asset (matches the value bound)
  maxNameLength: 200,
  maxAssetsPerOrigin: 200,
  maxIndexBytes: 128 * 1024, // the index stays small (no content)
};

export const ASSET_TYPES = new Set([
  "html", // a generated page / UI fragment
  "text", // plain text / markdown
  "json", // structured data
  "image", // a data URL
  "data", // any other payload
]);

const utf8Bytes = (s) => new TextEncoder().encode(s).byteLength;

function assetStore(origin) {
  return origin === "master" ? masterMemory() : siteMemory(origin);
}

function canonical(origin) {
  return origin === "master" ? "master" : (canonicalOrigin(origin) ?? "master");
}

function newId() {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Read the asset index (lightweight, no content). */
async function readIndex(store) {
  return (await store.get(INDEX_KEY)) ?? [];
}

/** Write the index via the TRUSTED path (reserved authority key). */
async function writeIndex(store, index) {
  await store.setTrusted(INDEX_KEY, index);
}

function boundAssetMeta({ type, name, content }) {
  const at = type == null || type === "" ? "data" : String(type);
  if (!ASSET_TYPES.has(at)) {
    return { error: `asset type must be one of ${[...ASSET_TYPES].join(", ")}` };
  }
  const nm = String(name ?? "").trim();
  if (nm.length === 0) {
    return { error: "asset needs a name" };
  }
  if (nm.length > ASSET_BOUNDS.maxNameLength) {
    return { error: `asset name exceeds ${ASSET_BOUNDS.maxNameLength} chars` };
  }
  if (typeof content !== "string") {
    return { error: "asset content must be a string" };
  }
  const size = utf8Bytes(content);
  if (size > ASSET_BOUNDS.maxContentBytes) {
    return {
      error: `asset content exceeds ${ASSET_BOUNDS.maxContentBytes} bytes`,
    };
  }
  return { ok: true, type: at, name: nm, size };
}

/**
 * Create an artifact for an origin (or the hub's "master" scope). Returns the
 * index entry (no content) + the full asset. Bounded + type-checked.
 */
export async function createAsset(origin, { type, name, content, meta }) {
  const store = assetStore(origin);
  const o = canonical(origin);
  const bounded = boundAssetMeta({ type, name, content });
  if (bounded.error) return { ok: false, error: bounded.error };
  const id = newId();
  const now = Date.now();
  const asset = {
    id,
    type: bounded.type,
    name: bounded.name,
    origin: o,
    createdAt: now,
    updatedAt: now,
    size: bounded.size,
    content,
    meta: meta ?? {},
  };
  const index = await readIndex(store);
  if (index.length >= ASSET_BOUNDS.maxAssetsPerOrigin) {
    return { ok: false, error: `asset limit reached (${ASSET_BOUNDS.maxAssetsPerOrigin})` };
  }
  await store.set(`asset:${id}`, asset);
  index.push({
    id,
    type: bounded.type,
    name: bounded.name,
    origin: o,
    at: now,
    size: bounded.size,
  });
  // Keep the index within its byte bound (drop the OLDEST entries first).
  let idx = index;
  while (idx.length > 1 && utf8Bytes(JSON.stringify(idx)) > ASSET_BOUNDS.maxIndexBytes) {
    idx = idx.slice(1);
  }
  await writeIndex(store, idx);
  return {
    ok: true,
    asset: { ...asset, content: undefined },
    index: idx,
  };
}

/** Read one asset (with its content). */
export async function getAsset(origin, id) {
  const store = assetStore(origin);
  if (!id || typeof id !== "string") return { ok: false, error: "get_asset needs an id" };
  const asset = await store.get(`asset:${id}`);
  if (!asset) return { ok: false, error: "asset not found" };
  return { ok: true, asset };
}

/** Update an asset's name / type / content (content optional — patch). */
export async function updateAsset(origin, id, patch) {
  const store = assetStore(origin);
  if (!id || typeof id !== "string") return { ok: false, error: "update_asset needs an id" };
  const existing = await store.get(`asset:${id}`);
  if (!existing) return { ok: false, error: "asset not found" };
  const nextType = patch.type ?? existing.type;
  const nextName = patch.name ?? existing.name;
  const nextContent = patch.content ?? existing.content;
  const meta = boundAssetMeta({ type: nextType, name: nextName, content: nextContent });
  if (meta.error) return { ok: false, error: meta.error };
  const updated = {
    ...existing,
    type: meta.type,
    name: meta.name,
    content: nextContent,
    size: meta.size,
    updatedAt: Date.now(),
  };
  await store.set(`asset:${id}`, updated);
  // Update the index entry.
  const index = await readIndex(store);
  const i = index.find((e) => e.id === id);
  if (i) {
    i.type = meta.type;
    i.name = meta.name;
    i.size = meta.size;
    await writeIndex(store, index);
  }
  return { ok: true, asset: { ...updated, content: undefined } };
}

/** Delete an asset (index entry + the asset key). */
export async function deleteAsset(origin, id) {
  const store = assetStore(origin);
  if (!id || typeof id !== "string") return { ok: false, error: "delete_asset needs an id" };
  const index = await readIndex(store);
  const remaining = index.filter((e) => e.id !== id);
  await writeIndex(store, remaining);
  await store.delete(`asset:${id}`);
  return { ok: true };
}

/** List an origin's assets (index entries, no content). */
export async function listAssets(origin) {
  const store = assetStore(origin);
  const index = await readIndex(store);
  return { ok: true, assets: index };
}
