// tests/risk-register-contract.test.ts — pins the four-field architectural risk register contract (t4td).
//
// Invariants guarded:
//   1. docs/RISK-REGISTER.md exists and is cited in AGENTS.md.
//   2. Every risk entry strictly implements the 4-field shape:
//      - **Risk:** <hazard>
//      - **Lives at:** <file:line citation>
//      - **Mitigation:** <controls>
//      - **Open question:** <architectural question / platform primitive>
//   3. High-priority ceilings are cited with exact file:line locations:
//      - Service worker bundle budget (3,000,000 bytes with 91 bytes headroom) at build.mjs / bundle-budget.mjs
//      - WebMCP fingerprint surface (f62c) at webmcp-detect-main.js / manifest.json
//      - Unclassified dispatch mutations (ygvt) at service-worker.js
//      - Monolithic data archive caps (2g90) at data-archive.js

import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("risk register: docs/RISK-REGISTER.md exists and is cited in AGENTS.md", async () => {
  const register = await Deno.readTextFile(`${ROOT}docs/RISK-REGISTER.md`).catch(() => null);
  assert(register !== null, "docs/RISK-REGISTER.md must exist");

  const agents = await Deno.readTextFile(`${ROOT}AGENTS.md`);
  assert(agents.includes("docs/RISK-REGISTER.md"), "AGENTS.md must cite docs/RISK-REGISTER.md");
});

Deno.test("risk register: every entry strictly adheres to the four-field contract with file:line citations", async () => {
  const text = await Deno.readTextFile(`${ROOT}docs/RISK-REGISTER.md`);
  const sections = text.split(/\n###\s+/).slice(1);
  assert(sections.length >= 20, `risk register must contain at least 20 architectural entries (found ${sections.length})`);

  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0].trim();

    assert(
      section.includes("- **Risk:**"),
      `entry "${header}" must contain "- **Risk:**"`,
    );
    assert(
      section.includes("- **Lives at:**"),
      `entry "${header}" must contain "- **Lives at:**"`,
    );
    assert(
      section.includes("- **Mitigation:**"),
      `entry "${header}" must contain "- **Mitigation:**"`,
    );
    assert(
      section.includes("- **Open question:**"),
      `entry "${header}" must contain "- **Open question:**"`,
    );

    // Assert that Lives at contains at least one concrete file:line reference
    const livesAtLine = lines.find((l) => l.startsWith("- **Lives at:**"));
    assert(livesAtLine !== undefined, `entry "${header}" must have a "- **Lives at:**" line`);
    assert(
      /[\w.-]+\.(?:js|ts|json|mjs):\d+/.test(livesAtLine),
      `entry "${header}" must cite a concrete file:line in Lives at: ${livesAtLine}`,
    );
  }
});

Deno.test("risk register: citations for load-bearing architectural ceilings are present", async () => {
  const text = await Deno.readTextFile(`${ROOT}docs/RISK-REGISTER.md`);

  // SW bundle budget ceiling (91 bytes headroom, build.mjs:547-563, bundle-budget.mjs:16)
  assert(text.includes("3_000_000") || text.includes("3,000,000"), "must cite 3,000,000 byte bundle budget");
  assert(text.includes("91 bytes of headroom") || text.includes("91 bytes"), "must cite exact 91 bytes headroom");
  assert(text.includes("build.mjs"), "must cite build.mjs for bundle budget");
  assert(text.includes("bundle-budget.mjs"), "must cite bundle-budget.mjs");

  // Fingerprint surface (f62c)
  assert(text.includes("f62c"), "must cite open bead f62c");
  assert(text.includes("webmcp-detect-main.js"), "must cite webmcp-detect-main.js");

  // Unclassified dispatch mutations (ygvt)
  assert(text.includes("named-agent.set-tools"), "must cite named-agent.set-tools");
  assert(text.includes("SW-DISPATCH-AUTHORITY-CENSUS.md"), "must cite dispatch authority census");

  // Monolithic data archive caps (2g90)
  assert(text.includes("MAX_ARCHIVE_OPFS_FILES") || text.includes("100,000"), "must cite 100,000 file cap");
  assert(text.includes("MAX_ARCHIVE_TOTAL_BYTES") || text.includes("512 MiB"), "must cite 512 MiB byte cap");
  assert(text.includes("STREAMED-BACKUP-RESTORE-ARCHITECTURE.md"), "must cite streamed backup architecture");
});
