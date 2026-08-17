# Changelog

## [0.2.42] — 2026-08-17
- (describe the change)

## [0.2.41] — 2026-08-17
- (describe the change)

## [0.2.40] — 2026-08-17
- (describe the change)

## [0.2.39] — 2026-08-17
- (describe the change)

## [0.2.38] — 2026-08-17
- (describe the change)

## [0.2.37] — 2026-08-17
- (describe the change)

## [0.2.36] — 2026-08-17
- (describe the change)

## [0.2.35] — 2026-08-17
- (describe the change)

## [0.2.34] — 2026-08-17
- (describe the change)

## [0.2.33] — 2026-08-17
- (describe the change)

## [0.2.32] — 2026-08-17
- (describe the change)

## [0.2.31] — 2026-08-17
- (describe the change)

## [0.2.30] — 2026-08-17
- (describe the change)

## [0.2.29] — 2026-08-17
- (describe the change)

## [0.2.28] — 2026-08-17
- (describe the change)

## [0.2.27] — 2026-08-17
- (describe the change)

## [0.2.26] — 2026-08-17
- (describe the change)

## [0.2.25] — 2026-08-17
- (describe the change)

## [0.2.24] — 2026-08-17
- (describe the change)

## [0.2.23] — 2026-08-17
- (describe the change)

## [0.2.22] — 2026-08-17
- (describe the change)

## [0.2.21] — 2026-08-17
- (describe the change)

## [0.2.20] — 2026-08-17
- (describe the change)

## [0.2.19] — 2026-08-17
- (describe the change)

## [0.2.18] — 2026-08-17
- (describe the change)

## [0.2.17] — 2026-08-17
- (describe the change)

## [0.2.16] — 2026-08-17
- (describe the change)

## [0.2.15] — 2026-08-17
- (describe the change)

## [0.2.14] — 2026-08-17
- (describe the change)

## [0.2.13] — 2026-08-17
- (describe the change)

## [0.2.12] — 2026-08-17
- (describe the change)

## [0.2.11] — 2026-08-17
- (describe the change)

## [0.2.10] — 2026-08-17
- (describe the change)

## [0.2.9] — 2026-08-17
- (describe the change)

## [0.2.8] — 2026-08-17
- (describe the change)

## [0.2.7] — 2026-08-17
- (describe the change)

## [0.2.6] — 2026-08-17
- (describe the change)

## [0.2.5] — 2026-08-17
- (describe the change)

## [0.2.4] — 2026-08-17
- (describe the change)

## [0.2.3] — 2026-08-17
- (describe the change)

## [0.2.2] — 2026-08-17
- (describe the change)

## [0.2.1] — 2026-08-17
- (describe the change)

All notable changes to the Chrome Agent Platform. Semantic versioning: MAJOR.MINOR.PATCH.

## [0.2.0] — 2026-08-16
### Added
- The component design system (15+ Web Components) + the component gallery on GitHub Pages.
- The master hub management tool suite (16 tools) + artifacts system + master skill + pluggable skills.
- The unified conversational surface (<agent-conversation> with rich message rendering: styled code blocks, structured tool cards, thinking traces).
- Distinct task threads (auto-named, fullscreen continue, per-thread persistence) + the task sidebar.
- The hooks system (the full chrome.* on* event catalog) + the owner-only authoritative deny-list.
- The 27 prompt-in-a-box recipes + background agents (the Sorting Hat) with the base-select picker.
- The error console + the security shield (co-do-inspired transparency).
- Provider "Test connection" buttons (all 7 providers).
- The impeccable design system (paper + petrol-teal, PRODUCT.md + DESIGN.md).

### Security
- All-optional permissions (manifest permissions = []) + no debugger permission.
- The apiKey-leak fix (redactSecrets — credentials never reach the model prompt/journal).
- 27 rounds of independent security/correctness review (sol).

## [0.1.0] — 2026-08-15
- Initial scaffold + the multi-agent hub.
