// A tiny page-local ownership fence for async run/surface rendering. Replacing
// a surface claims a new token; continuations holding an older token may keep
// executing (and the service worker may keep journaling) but cannot commit UI.
export function createRunSurfaceOwner() {
  let current = 0;

  return Object.freeze({
    claim() {
      current += 1;
      return current;
    },
    current() {
      return current;
    },
    owns(owner) {
      return owner === current;
    },
    commit(owner, effect) {
      if (owner !== current) return false;
      effect();
      return true;
    },
  });
}
