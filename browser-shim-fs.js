// Minimal no-op shims for agent-do-style imports that reference node:fs /
// node:path in code paths the extension does not exercise.
export const readFileSync = () => { throw new Error("fs not available in extension"); };
export const writeFileSync = () => { throw new Error("fs not available in extension"); };
export const existsSync = () => false;
export const mkdirSync = () => {};
export const readdirSync = () => [];
export default { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync };
