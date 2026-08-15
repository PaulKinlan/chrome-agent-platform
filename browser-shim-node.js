// browser-shim-node.js — minimal no-op shims for Node builtins that agent-do's
// transitive deps (MCP SDK, filesystem routine/scheduled-task stores) import
// but the browser extension never exercises at runtime. The core agent loop
// uses only the AI SDK + in-memory stores.
export const readFileSync = () => { throw new Error("fs not available in extension"); };
export const writeFileSync = () => { throw new Error("fs not available in extension"); };
export const readFile = () => Promise.reject(new Error("fs not available in extension"));
export const writeFile = () => Promise.reject(new Error("fs not available in extension"));
export const existsSync = () => false;
export const mkdirSync = () => {};
export const readdirSync = () => [];
export const statSync = () => { throw new Error("fs not available in extension"); };
export const promises = {
  readFile: () => Promise.reject(new Error("fs not available in extension")),
  writeFile: () => Promise.reject(new Error("fs not available in extension")),
  mkdir: () => Promise.resolve(),
  access: () => Promise.resolve(),
};

export const join = (...p) => p.filter(Boolean).join("/");
export const dirname = (p) => p.split("/").slice(0, -1).join("/") || ".";
export const basename = (p) => String(p).split("/").pop() || String(p);
export const resolve = (...p) => p.filter(Boolean).join("/");
export const extname = (p) => { const b = String(p).split("/").pop(); const i = b.lastIndexOf("."); return i >= 0 ? b.slice(i) : ""; };
export const homedir = () => "/";
export const tmpdir = () => "/tmp";
export const platform = () => "browser";
export const hostname = () => "localhost";
export const os = { homedir, tmpdir, platform, hostname };

export const randomBytes = (n) => {
  const b = new Uint8Array(n);
  globalThis.crypto?.getRandomValues?.(b) ?? (() => { for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); })();
  return b;
};
export const createHash = () => ({ update: () => ({ digest: () => "" }) });
export const crypto = { randomBytes, createHash };

export const process = {
  env: {},
  cwd: () => "/",
  platform: "browser",
  nextTick: (fn) => setTimeout(fn, 0),
  versions: { node: "0" },
};

export const Stream = class {};
export const Readable = class { static from() { return { pipe() {}, on() {} }; } };
export const Writable = class {};
export const stream = { Stream, Readable, Writable };

export const createRequire = () => (() => { throw new Error("require not available"); });
export const module = { createRequire };

export const TextDecoder = globalThis.TextDecoder;
export const TextEncoder = globalThis.TextEncoder;
export const util = {};

export const mkdir = () => Promise.resolve();
export const promisify = (fn) => fn;
export const PassThrough = class extends Readable {};
export const spawn = () => { throw new Error("child_process not available in extension"); };
export const exec = () => { throw new Error("child_process not available in extension"); };
export const child_process = { spawn, exec };

export default { readFileSync, writeFileSync, promises, join, dirname, basename, resolve, extname, os, crypto, process, stream, util, mkdir, promisify, PassThrough };
