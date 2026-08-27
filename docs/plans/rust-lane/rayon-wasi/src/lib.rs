//! Serial WASI fallback shim for `rayon` (wasi-preview1 has no threads).
//! Delegates parallel slice sorts + parallel iteration to serial std equivalents;
//! never spawns a thread. Installed via `[patch.crates-io]`.

pub mod slice {
    pub use crate::ParallelSliceMut;
}

pub mod prelude {
    pub use crate::{IntoParallelRefIterator, ParallelIterator, ParallelSliceMut};
}

pub trait ParallelSliceMut<T: Send> {
    fn par_sort_unstable_by<F>(&mut self, f: F) where F: Fn(&T, &T) -> std::cmp::Ordering + Sync + Send;
    fn par_sort_by<F>(&mut self, f: F) where F: Fn(&T, &T) -> std::cmp::Ordering + Sync + Send;
}
impl<T: Send> ParallelSliceMut<T> for [T] {
    fn par_sort_unstable_by<F>(&mut self, f: F) where F: Fn(&T, &T) -> std::cmp::Ordering + Sync + Send { self.sort_unstable_by(f); }
    fn par_sort_by<F>(&mut self, f: F) where F: Fn(&T, &T) -> std::cmp::Ordering + Sync + Send { self.sort_by(f); }
}
impl<T: Send> ParallelSliceMut<T> for Vec<T> {
    fn par_sort_unstable_by<F>(&mut self, f: F) where F: Fn(&T, &T) -> std::cmp::Ordering + Sync + Send { self.sort_unstable_by(f); }
    fn par_sort_by<F>(&mut self, f: F) where F: Fn(&T, &T) -> std::cmp::Ordering + Sync + Send { self.sort_by(f); }
}

pub trait IntoParallelRefIterator<'a> {
    type Item: 'a;
    type Iter: ParallelIterator<Item = Self::Item>;
    fn par_iter(&'a self) -> Self::Iter;
}
impl<'a, T: 'a + Sync> IntoParallelRefIterator<'a> for [T] {
    type Item = &'a T; type Iter = std::slice::Iter<'a, T>;
    fn par_iter(&'a self) -> Self::Iter { self.iter() }
}
impl<'a, T: 'a + Sync> IntoParallelRefIterator<'a> for Vec<T> {
    type Item = &'a T; type Iter = std::slice::Iter<'a, T>;
    fn par_iter(&'a self) -> Self::Iter { self.iter() }
}

pub trait ParallelIterator: Iterator + Sized {
    fn try_for_each<OP, E>(self, op: OP) -> Result<(), E>
    where OP: Fn(Self::Item) -> Result<(), E> + Sync + Send, E: Send {
        for item in self {
            op(item)?;
        }
        Ok(())
    }
}
impl<I: Iterator> ParallelIterator for I {}

#[derive(Debug, Clone)]
pub struct ThreadPoolBuildError;
impl std::fmt::Display for ThreadPoolBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "thread pool unavailable (serial WASI shim)") }
}
impl std::error::Error for ThreadPoolBuildError {}

pub struct ThreadPoolBuilder;
impl ThreadPoolBuilder {
    pub fn new() -> Self { ThreadPoolBuilder }
    pub fn num_threads(self, _n: usize) -> Self { self }
    pub fn build_global(self) -> Result<(), ThreadPoolBuildError> { Ok(()) }
    pub fn build(self) -> Result<ThreadPool, ThreadPoolBuildError> { Ok(ThreadPool) }
}
impl Default for ThreadPoolBuilder { fn default() -> Self { Self::new() } }

pub struct ThreadPool;
impl ThreadPool { pub fn install(self) -> Result<(), ThreadPoolBuildError> { Ok(()) } }

// ── Top-level free functions (serial no-ops / inline) ─────────────────────
pub fn current_num_threads() -> usize { 1 }
pub fn spawn<F>(f: F) where F: FnOnce() + Send + 'static { f(); }
pub fn spawn_fifo<F>(f: F) where F: FnOnce() + Send + 'static { f(); }
pub fn scope<'scope, OP, R>(op: OP) -> R where OP: FnOnce(&Scope<'scope>) -> R + Send, R: Send { op(&Scope { _p: std::marker::PhantomData }) }
pub struct Scope<'scope> { _p: std::marker::PhantomData<&'scope ()> }
impl<'scope> Scope<'scope> {
    pub fn spawn<BODY>(&self, body: BODY) where BODY: FnOnce(&Scope<'scope>) + Send + 'scope { body(self); }
}
pub fn join<A, B, RA, RB>(a: A, b: B) -> (RA, RB) where A: FnOnce() -> RA + Send, B: FnOnce() -> RB + Send, RA: Send, RB: Send { (a(), b()) }
