//! No-op WASI stub for `namedlock`. File locking is meaningless under
//! wasi-preview1 (single-threaded, no cross-process file locks) — every lock
//! simply owns its initial value and releases on drop. Installed via
//! `[patch.crates-io] namedlock = { path = ... }`.
use std::fmt;
use std::hash::Hash;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cleanup { AutoCleanup, ManualCleanup }
pub use Cleanup::AutoCleanup;

#[derive(Debug)]
pub struct Error(String);
impl fmt::Display for Error { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}", self.0) } }
impl std::error::Error for Error {}

pub struct LockSpace<K: Eq + Hash + Clone, V> {
    _cleanup: Cleanup,
    _marker: std::marker::PhantomData<(K, V)>,
}
impl<K: Eq + Hash + Clone, V> LockSpace<K, V> {
    pub fn new(cleanup: Cleanup) -> Self { LockSpace { _cleanup: cleanup, _marker: std::marker::PhantomData } }
    pub fn lock<'a, C>(&'a self, _key: K, initial: C) -> Result<LockSpaceGuard<'a, K, V>, Error>
    where C: FnOnce() -> V {
        Ok(LockSpaceGuard { value: initial(), _marker: std::marker::PhantomData })
    }
    pub fn with_lock<F, R, C>(&self, _key: K, initial: C, f: F) -> Result<R, Error>
    where C: FnOnce() -> V, F: FnOnce(&V) -> R {
        let v = initial();
        Ok(f(&v))
    }
    pub fn try_remove(&self, _key: K) -> bool { true }
}

pub struct LockSpaceGuard<'a, K, V> { value: V, _marker: std::marker::PhantomData<(&'a K,)> }
impl<K, V> std::ops::Deref for LockSpaceGuard<'_, K, V> {
    type Target = V;
    fn deref(&self) -> &V { &self.value }
}
