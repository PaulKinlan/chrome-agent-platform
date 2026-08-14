export const join = (...p) => p.filter(Boolean).join("/");
export const dirname = (p) => p.split("/").slice(0, -1).join("/") || ".";
export const basename = (p) => p.split("/").pop() || p;
export const resolve = (...p) => p.filter(Boolean).join("/");
export const extname = (p) => { const b = p.split("/").pop(); const i = b.lastIndexOf("."); return i >= 0 ? b.slice(i) : ""; };
export default { join, dirname, basename, resolve, extname };
