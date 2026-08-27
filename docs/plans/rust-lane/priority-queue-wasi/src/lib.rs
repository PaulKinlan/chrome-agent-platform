//! Vec-backed stub for `priority-queue` (the upstream crate is LGPL-3.0 OR
//! MPL-2.0 — the LGPL arm is GPL-family, which the CAP permissive-only policy
//! excludes). This stub implements the subset topk uses with linear scans —
//! top-k sizes are small, so O(n) per op is irrelevant. Installed via
//! `[patch.crates-io] priority-queue = { path = ... }`.
use std::hash::Hash;

#[derive(Clone)]
pub struct PriorityQueue<I, P, H = std::hash::RandomState> {
    items: Vec<(I, P)>,
    _hasher: std::marker::PhantomData<H>,
}

impl<I: Hash + Eq, P: Ord, H: std::hash::BuildHasher + Default> PriorityQueue<I, P, H> {
    pub fn new() -> Self { PriorityQueue { items: Vec::new(), _hasher: std::marker::PhantomData } }
    pub fn with_capacity(cap: usize) -> Self { PriorityQueue { items: Vec::with_capacity(cap), _hasher: std::marker::PhantomData } }
    pub fn with_hasher(_h: H) -> Self { PriorityQueue { items: Vec::new(), _hasher: std::marker::PhantomData::<H> } }
    pub fn with_capacity_and_default_hasher(cap: usize) -> Self { PriorityQueue { items: Vec::with_capacity(cap), _hasher: std::marker::PhantomData } }
    pub fn clear(&mut self) { self.items.clear(); }
    pub fn len(&self) -> usize { self.items.len() }
    pub fn is_empty(&self) -> bool { self.items.is_empty() }
    pub fn push(&mut self, item: I, priority: P) {
        if let Some(slot) = self.items.iter_mut().find(|(i, _)| i == &item) { slot.1 = priority; }
        else { self.items.push((item, priority)); }
    }
    pub fn peek(&self) -> Option<(&I, &P)> {
        self.items.iter().min_by(|a, b| a.1.cmp(&b.1)).map(|(i, p)| (i, p))
    }
    pub fn pop(&mut self) -> Option<(I, P)> {
        let idx = self.items.iter().enumerate().min_by(|a, b| a.1.1.cmp(&b.1.1)).map(|(i, _)| i)?;
        Some(self.items.swap_remove(idx))
    }
    pub fn get(&self, item: &I) -> Option<(&I, &P)> {
        self.items.iter().find(|(i, _)| i == item).map(|(i, p)| (i, p))
    }
    pub fn get_priority(&self, item: &I) -> Option<&P> { self.get(item).map(|(_, p)| p) }
    pub fn change_priority_by<F>(&mut self, item: &I, f: F) -> bool
    where F: FnOnce(&mut P) {
        match self.items.iter_mut().find(|(i, _)| i == item) {
            Some((_, p)) => { f(p); true }
            None => false,
        }
    }
    pub fn change_priority<F>(&mut self, item: &I, f: F) -> bool where F: FnOnce(&mut P) {
        self.change_priority_by(item, f)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&I, &P)> { self.items.iter().map(|(i, p)| (i, p)) }
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&I, &mut P)> { self.items.iter_mut().map(|(i, p)| (&*i, p)) }
    pub fn into_sorted_iter(self) -> std::vec::IntoIter<(I, P)> {
        let mut v = self.items; v.sort_by(|a, b| a.1.cmp(&b.1)); v.into_iter()
    }
    pub fn into_iter(self) -> std::vec::IntoIter<(I, P)> { self.items.into_iter() }
}
impl<I: Hash + Eq, P: Ord, H: std::hash::BuildHasher + Default> Default for PriorityQueue<I, P, H> {
    fn default() -> Self { Self::new() }
}
impl<I: Hash + Eq, P: Ord, H: std::hash::BuildHasher + Default> IntoIterator for PriorityQueue<I, P, H> {
    type Item = (I, P);
    type IntoIter = std::vec::IntoIter<(I, P)>;
    fn into_iter(self) -> Self::IntoIter { self.items.into_iter() }
}
impl<I, P, H> std::iter::FromIterator<(I, P)> for PriorityQueue<I, P, H>
where I: Hash + Eq, P: Ord, H: std::hash::BuildHasher + Default {
    fn from_iter<T: IntoIterator<Item = (I, P)>>(iter: T) -> Self {
        let mut q = Self::new();
        for (i, p) in iter { q.push(i, p); }
        q
    }
}
