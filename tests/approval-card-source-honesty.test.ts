// tests/approval-card-source-honesty.test.ts — Verification of display-truth vs run-truth
// on script/workflow approval cards when source exceeds 64 KiB (chrome-agent-platform-vvbq).
// @ts-nocheck
//
// APPROVAL_DETAIL_BOUNDS.maxSourceChars (64 KiB) bounds the source SHOWN on an approval
// card, while the sandbox runs the full body. The card must not claim to run only what
// it shows: it must truthfully disclose that the source preview is partial, state the
// total length, show the SHA-256 digest of the full source, and mark the truncated preview.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  APPROVAL_DETAIL_BOUNDS,
  boundApprovalDetail,
  approvalCardDenial,
} from "../extension/lib/owner-approval.js";
import { sha256Hex } from "../extension/lib/pure.js";

Deno.test("boundApprovalDetail: source <= 64 KiB remains untruncated without preview notice flags", () => {
  const source = "console.log('short script');";
  const detail = boundApprovalDetail({ source, hosts: ["api.example.com"], dynamic: false });

  assertEquals(detail.source, source);
  assertEquals(detail.truncated, undefined);
  assertEquals(detail.totalSourceChars, undefined);
  assertEquals(detail.hosts, ["api.example.com"]);
  assertEquals(detail.dynamic, false);
});

Deno.test("boundApprovalDetail: source > 64 KiB is bounded with truncated flag, totalSourceChars, and sourceDigest", () => {
  const OVER_SIZE = 70 * 1024;
  const rawSource = "a".repeat(OVER_SIZE);
  const digest = sha256Hex(rawSource);

  const detail = boundApprovalDetail({
    source: rawSource,
    hosts: ["api.example.com"],
    dynamic: false,
    sourceDigest: digest,
  });

  assertEquals(detail.source.length, APPROVAL_DETAIL_BOUNDS.maxSourceChars);
  assertEquals(detail.truncated, true);
  assertEquals(detail.totalSourceChars, OVER_SIZE);
  assertEquals(detail.sourceDigest, digest);
  assertEquals(detail.hosts, ["api.example.com"]);
});

Deno.test("approvalCardDenial: propagates honest truncation metadata in permissionRequirement approvals", () => {
  const rawSource = "x".repeat(65 * 1024);
  const digest = sha256Hex(rawSource);

  const card = approvalCardDenial({
    approvalId: "ap_test_1",
    action: "workflow.run",
    targetRef: "ref_1",
    detail: { source: rawSource, hosts: [], dynamic: false, sourceDigest: digest },
  });

  assert(card, "approvalCardDenial must succeed");
  const detail = card.permissionRequirement.approvals[0].detail;
  assertEquals(detail.truncated, true);
  assertEquals(detail.totalSourceChars, 65 * 1024);
  assertEquals(detail.source.length, 64 * 1024);
  assertEquals(detail.sourceDigest, digest);
});

Deno.test("ApprovalCard component: renders honest preview notice and source truncation marker for over-cap scripts", async () => {
  const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));

  // 1. Template CSS defines .source-notice
  assertStringIncludes(components, ".source-notice");

  // 2. Component property accepts truncated and totalSourceChars
  assertStringIncludes(components, "truncated: value.truncated === true");
  assertStringIncludes(components, 'totalSourceChars: typeof value.totalSourceChars === "number"');

  // 3. Template HTML renders preview notice when truncated
  assertStringIncludes(components, "Showing the first 64 KB");
  assertStringIncludes(components, "The complete script will run if approved.");

  // 4. Wire method appends truncation comment in the <pre class="source">
  assertStringIncludes(components, "characters truncated from preview — full script");
});

Deno.test("ArtifactInspector component: renders honest preview notice and copy button for file-backed stream artifacts", async () => {
  const componentsPath = new URL("../extension/shared/components.js", import.meta.url).pathname;
  const components = await Deno.readTextFile(componentsPath);

  // Verifies fileBacked and contentIncomplete checks
  assertStringIncludes(components, "const isFileBacked = a.meta?.fileBacked === true || a.meta?.isStreamBacked === true;");
  assertStringIncludes(components, "const isIncomplete = a.meta?.contentIncomplete === true || a.meta?.contentComplete === false;");

  // Verifies honest button text and note message
  assertStringIncludes(components, 'if (copyBtn) copyBtn.textContent = "Copy preview content";');
  assertStringIncludes(components, 'Preview showing initial 64 KiB. Complete file is retained in OPFS stream');

  // Verifies honest copy status message
  assertStringIncludes(components, "Copied preview content (file-backed stream in OPFS).");
});
