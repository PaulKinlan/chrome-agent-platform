use std::io::{Error, ErrorKind};

pub const MAX_CAPTURES: usize = 10;

#[derive(Debug, Clone, Copy, Default)]
pub struct RegexFlags {
    pub extended: bool,
    pub ignore_case: bool,
}

impl RegexFlags {
    pub fn bre() -> Self { Self::default() }
    pub fn ere() -> Self { Self { extended: true, ignore_case: false } }
    pub fn ignore_case(mut self) -> Self { self.ignore_case = true; self }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Match { pub start: usize, pub end: usize }
impl Match {
    pub fn is_empty(&self) -> bool { self.start == self.end }
    pub fn as_str<'a>(&self, input: &'a str) -> &'a str { &input[self.start..self.end] }
    pub fn as_bytes<'a>(&self, input: &'a [u8]) -> &'a [u8] { &input[self.start..self.end] }
}

pub struct Regex {
    inner: revera::Regex,
    pattern: Vec<u8>,
    flags: RegexFlags,
    anchored_start: bool,
}

impl Regex {
    pub fn new(pattern: &str, flags: RegexFlags) -> std::io::Result<Self> {
        Self::new_bytes(pattern.as_bytes(), flags)
    }
    pub fn new_bytes(pattern: &[u8], flags: RegexFlags) -> std::io::Result<Self> {
        let mut pattern_string = std::str::from_utf8(pattern)
            .map_err(|e| Error::new(ErrorKind::InvalidInput, e))?.to_owned();
        if flags.ignore_case {
            // revera's public builder does not currently expose REG_ICASE.
            // AWK does not request it; retain fail-closed behavior if a future caller does.
            return Err(Error::new(ErrorKind::Unsupported, "REG_ICASE is unavailable in the WASI build"));
        }
        // This WASI adapter is used by AWK, whose patterns are ERE. Refuse BRE rather
        // than silently applying ERE syntax to a future caller.
        if !flags.extended {
            return Err(Error::new(ErrorKind::Unsupported, "BRE is unavailable in the WASI build"));
        }
        let anchored_start = has_unescaped_start_anchor(&pattern_string);
        let inner = revera::Regex::new(&pattern_string)
            .map_err(|e| Error::new(ErrorKind::InvalidInput, e.to_string()))?;
        Ok(Self { inner, pattern: std::mem::take(&mut pattern_string).into_bytes(), flags, anchored_start })
    }
    pub fn bre(pattern: &str) -> std::io::Result<Self> { Self::new(pattern, RegexFlags::bre()) }
    pub fn ere(pattern: &str) -> std::io::Result<Self> { Self::new(pattern, RegexFlags::ere()) }
    pub fn bre_bytes(pattern: &[u8]) -> std::io::Result<Self> { Self::new_bytes(pattern, RegexFlags::bre()) }
    pub fn ere_bytes(pattern: &[u8]) -> std::io::Result<Self> { Self::new_bytes(pattern, RegexFlags::ere()) }
    pub fn is_match(&self, text: &str) -> bool { self.inner.is_match(text).unwrap_or(false) }
    pub fn is_match_bytes(&self, text: &[u8]) -> bool { std::str::from_utf8(text).ok().is_some_and(|s| self.is_match(s)) }
    pub fn find(&self, text: &str) -> Option<Match> {
        self.inner.find(text).ok().flatten().map(|m| Match { start: m.start(), end: m.end() })
    }
    pub fn find_bytes(&self, text: &[u8]) -> Option<Match> { self.find(std::str::from_utf8(text).ok()?) }
    pub fn find_notbol(&self, text: &str) -> Option<Match> {
        if self.anchored_start { return None; }
        self.find(text)
    }
    pub fn find_notbol_bytes(&self, text: &[u8]) -> Option<Match> { self.find_notbol(std::str::from_utf8(text).ok()?) }
    pub fn as_str(&self) -> &str { std::str::from_utf8(&self.pattern).unwrap_or_default() }
    pub fn as_bytes(&self) -> &[u8] { &self.pattern }
}

fn has_unescaped_start_anchor(pattern: &str) -> bool {
    let mut escaped = false;
    let mut bracket = false;
    for c in pattern.chars() {
        if escaped { escaped = false; continue; }
        if c == '\\' { escaped = true; continue; }
        if c == '[' { bracket = true; continue; }
        if c == ']' { bracket = false; continue; }
        if !bracket && c == '^' { return true; }
    }
    false
}

impl Clone for Regex {
    fn clone(&self) -> Self { Self::new_bytes(&self.pattern, self.flags).expect("compiled regex remains valid") }
}
impl std::fmt::Debug for Regex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Regex").field("pattern", &self.as_str()).field("flags", &self.flags).finish()
    }
}
impl PartialEq for Regex {
    fn eq(&self, other: &Self) -> bool { self.pattern == other.pattern && self.flags.extended == other.flags.extended && self.flags.ignore_case == other.flags.ignore_case }
}
impl Eq for Regex {}
