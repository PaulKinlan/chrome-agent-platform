//! WASI stub for the `home` crate. Under wasi-preview1 there is no OS notion of
//! a user home directory; `home::home_dir()` returns the `HOME` env var when
//! present (honestly `None` otherwise), matching the crate's env-based contract
//! for unix platforms without fabricating a path. Installed via
//! `[patch.crates-io] home = { path = ... }`.
use std::path::PathBuf;

/// The user's home directory, from the `HOME` env var. `None` when unset.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// `CARGO_HOME`, or `$HOME/.cargo` when `CARGO_HOME` is unset.
pub fn cargo_home() -> std::io::Result<PathBuf> {
    std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".cargo")))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no cargo home"))
}

pub fn cargo_home_with_cwd(_cwd: &std::path::Path) -> std::io::Result<PathBuf> {
    cargo_home()
}

/// `RUSTUP_HOME`, or `$HOME/.rustup` when `RUSTUP_HOME` is unset.
pub fn rustup_home() -> std::io::Result<PathBuf> {
    std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".rustup")))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no rustup home"))
}

pub fn rustup_home_with_cwd(_cwd: &std::path::Path) -> std::io::Result<PathBuf> {
    rustup_home()
}
