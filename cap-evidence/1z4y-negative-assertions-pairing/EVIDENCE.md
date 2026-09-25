# chrome-agent-platform-1z4y — Audit and Pairing of Negative Assertions in Security Gates

**Candidate:** branch `cap/gemini-1z4y-negative-assertions` @ worktree `/home/paulkinlan/worktrees/cap-gemini-1z4y`.  
**Date:** 2026-09-25.  
**Authority:** Audit criterion after nweh. Ensure every negative assertion in security gates is paired with a positive counterpart.

---

## 1. Background & The Criterion

In `chrome-agent-platform-nweh`, a defect survived a green security gate because the check was a bare negative:
`!cookieTranscript.includes(COOKIE_SENTINEL)` and `count === 0`.
The fixture returned zero rows, and the check passed vacuously on absent data rather than clean data.

**The Criterion:**
A negative check (`!X.includes(bad)`, `count === 0`, `=== "absent"`, `=== "null"`) only has teeth if a sibling assertion proves:
1. The probe actually ran and reached the code under test.
2. The fixture was non-empty and non-trivial.
3. The boundary was actively exercised, not dead or unmounted.

---

## 2. Audit of `scripts/security-suite.ts` & Added Pairings

| Security Boundary | Bare Negative Check | Hazard if Unpaired | Added Positive Counterpart |
| :--- | :--- | :--- | :--- |
| **Network Exfil** | `attacker.requests() === 0` | Frame never mounted, crashed, or script threw before network call | Untrusted frame posts `{ frame: "exfil", executed: true }` upon executing probe payload; asserted in `results` |
| **Sandbox Execution** | `escape?.chromeRuntime === "absent"`, `escape?.opener === "null"` | Sandbox document failed to load or parse | `escape.domAccessible === true && escape.origin === "null"` proving real execution in opaque sandbox |
| **Top Navigation** | `path.includes("security-fixture")` (page did not navigate away) | Frame never attempted navigation | Frame actively attempted `top.location.href` and caught `SecurityError` (`escape.topNav.startsWith("blocked")`) |
| **Window.open** | Navigation blocked | Frame never attempted `window.open` | Selfnav frame actively attempted `window.open` (`selfnav.attempted === true && selfnav.opened === false`) |
| **Sender Authority** | `mainRuntime === "undefined"` | Main world context dead or un-evaluated | `mainDom === "security fixture"` proving main world evaluated with full DOM |
| **cap:fetch SSRF** | `run.ok === false` with `private or loopback address` (4 targets) | Script sandbox broken; all scripts fail unconditionally | Positive control script executes `21 * 2 === 42` and `typeof fetch === 'function'` to success |
| **Cookie Redaction** | `!cookieTranscript.includes(COOKIE_SENTINEL)` | Fixture returned zero cookies (the nweh bug) | `cookieSeeded === "nweh_probe"` and `result.cookies.some(...)` (retained from nweh) |

---

## 3. Falsification Drills

1. **Unexecuted Probe (Vacuous Pass Prevention):**
   When probe results are empty (frame does not execute), the bare negative check (`attacker.requests() === 0`) passes vacuously, but the positive check (`exfilReport?.executed === true`) fails RED, catching the defect immediately.
2. **Real Probe With Boundary Leak:**
   When the probe executes and leaks (`attacker.requests() > 0`), the positive check stays GREEN, while the negative check fails RED specifically on the leak.
3. **Broken Script Sandbox:**
   If `script.run` fails unconditionally, the positive control fails RED, revealing that sandbox execution is broken rather than claiming all SSRF targets were safely blocked.

---

## 4. Verification

- **Production Security Suite:** `npm run test:security` passes with **26 passed / 0 failed** (increased from 21 to 26 checks, covering all positive counterparts).
- **Unit Guard:** `tests/security-assertion-pairing.test.ts` passes 2/2 tests, verifying presence of required pairings in `scripts/security-suite.ts` and executing falsification drills.
- **Partition Guard:** `tests/test-partition-guard.test.ts` passes 7/7 tests (clean parallel classification).
