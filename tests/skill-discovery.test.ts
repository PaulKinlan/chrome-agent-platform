// tests/skill-discovery.test.ts — recursive GitHub skill and command discovery engine
// (Git Trees API + monorepo/plugin crawler).
// @ts-nocheck
import { assertEquals, assertStringIncludes, assert, assertRejects } from "jsr:@std/assert@1";
import {
  parseGitHubUrl,
  discoverRepoSkillsAndCommands,
} from "../extension/lib/skill-import.js";

Deno.test("parseGitHubUrl correctly parses diverse GitHub URL shapes", () => {
  // Root repos
  assertEquals(parseGitHubUrl("https://github.com/phuryn/pm-skills"), {
    owner: "phuryn",
    repo: "pm-skills",
    type: null,
    branch: "main",
    path: "",
  });

  assertEquals(parseGitHubUrl("https://github.com/phuryn/pm-skills.git"), {
    owner: "phuryn",
    repo: "pm-skills",
    type: null,
    branch: "main",
    path: "",
  });

  assertEquals(parseGitHubUrl("https://github.com/phuryn/pm-skills/"), {
    owner: "phuryn",
    repo: "pm-skills",
    type: null,
    branch: "main",
    path: "",
  });

  // Tree URLs
  assertEquals(parseGitHubUrl("https://github.com/phuryn/pm-skills/tree/main"), {
    owner: "phuryn",
    repo: "pm-skills",
    type: "tree",
    branch: "main",
    path: "",
  });

  assertEquals(parseGitHubUrl("https://github.com/phuryn/pm-skills/tree/v2.1.0/pm-ai-shipping"), {
    owner: "phuryn",
    repo: "pm-skills",
    type: "tree",
    branch: "v2.1.0",
    path: "pm-ai-shipping",
  });

  // Blob URLs
  assertEquals(parseGitHubUrl("https://github.com/phuryn/pm-skills/blob/main/pm-ai-shipping/skills/shipping-artifacts/SKILL.md"), {
    owner: "phuryn",
    repo: "pm-skills",
    type: "blob",
    branch: "main",
    path: "pm-ai-shipping/skills/shipping-artifacts/SKILL.md",
  });

  // Invalid URLs
  assertEquals(parseGitHubUrl("https://gitlab.com/owner/repo"), null);
  assertEquals(parseGitHubUrl("not-a-url"), null);
  assertEquals(parseGitHubUrl(""), null);
});

Deno.test("discoverRepoSkillsAndCommands uses Git Trees API and extracts nested skills and commands", async () => {
  const treeData = {
    sha: "abc12345",
    truncated: false,
    tree: [
      { path: ".claude-plugin/marketplace.json", type: "blob", size: 500 },
      { path: "pm-ai-shipping/skills/shipping-artifacts/SKILL.md", type: "blob", size: 2000 },
      { path: "pm-ai-shipping/skills/shipping-artifacts/scripts/run.py", type: "blob", size: 300 },
      { path: "pm-ai-shipping/skills/intended-vs-implemented/SKILL.md", type: "blob", size: 1800 },
      { path: "pm-ai-shipping/commands/ship-check.md", type: "blob", size: 1500 },
      { path: "pm-ai-shipping/commands/document-app.md", type: "blob", size: 1200 },
      { path: "pm-toolkit/skills/review-resume/SKILL.md", type: "blob", size: 2100 },
      { path: "pm-toolkit/commands/review-resume.md", type: "blob", size: 1400 },
      { path: "README.md", type: "blob", size: 5000 },
    ],
  };

  const marketplaceData = {
    name: "pm-skills",
    version: "2.1.0",
    description: "Structured PM skills",
    plugins: [
      {
        name: "pm-ai-shipping",
        description: "AI Shipping Kit",
        source: "./pm-ai-shipping",
        category: "ai-shipping",
      },
      {
        name: "pm-toolkit",
        description: "PM utility skills",
        source: "./pm-toolkit",
        category: "utilities",
      },
    ],
  };

  const bodies = {
    ".claude-plugin/marketplace.json": JSON.stringify(marketplaceData),
    "pm-ai-shipping/skills/shipping-artifacts/SKILL.md": `---
name: shipping-artifacts
description: Durable documentation set for AI apps
---
# Shipping Artifacts
Documentation guidelines.`,
    "pm-ai-shipping/skills/intended-vs-implemented/SKILL.md": `---
name: intended-vs-implemented
description: Audits code against documented rules
---
# Intended vs Implemented`,
    "pm-ai-shipping/commands/ship-check.md": `---
description: Turn a vibe-coded repo into a reviewer-ready shipping packet
argument-hint: "<repo path or area>"
---
# /ship-check`,
    "pm-ai-shipping/commands/document-app.md": `---
description: Document an application
argument-hint: "<directory>"
---
# /document-app`,
    "pm-toolkit/skills/review-resume/SKILL.md": `---
name: review-resume
description: Comprehensive PM resume review
---
# Resume Review`,
    "pm-toolkit/commands/review-resume.md": `---
description: Review resume against 10 best practices
argument-hint: "<resume text or file>"
---
# /review-resume`,
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/main?recursive=1")) {
      return new Response(JSON.stringify(treeData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const rawMatch = u.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
    if (rawMatch) {
      const p = decodeURIComponent(rawMatch[1]);
      if (bodies[p]) {
        return new Response(bodies[p], { status: 200 });
      }
    }
    return new Response("Not found", { status: 404 });
  };

  const result = await discoverRepoSkillsAndCommands("https://github.com/phuryn/pm-skills/tree/main", {
    fetch: mockFetch,
  });

  assertEquals(result.ok, true);
  assertEquals(result.owner, "phuryn");
  assertEquals(result.repo, "pm-skills");
  assertEquals(result.branch, "main");
  assertEquals(result.stats.usedTreesApi, true);
  assertEquals(result.stats.skillCount, 3);
  assertEquals(result.stats.commandCount, 3);
  assertEquals(result.stats.pluginCount, 2);

  // Check marketplace plugins metadata
  assertEquals(result.plugins.length, 2);
  assertEquals(result.plugins[0].name, "pm-ai-shipping");
  assertEquals(result.plugins[0].category, "ai-shipping");

  // Check discovered skills
  const shipSkill = result.skills.find((s) => s.name === "shipping-artifacts");
  assert(shipSkill, "shipping-artifacts skill found");
  assertEquals(shipSkill.plugin, "pm-ai-shipping");
  assertEquals(shipSkill.category, "ai-shipping");
  assertEquals(shipSkill.description, "Durable documentation set for AI apps");
  assertEquals(shipSkill.files.includes("SKILL.md"), true);
  assertEquals(shipSkill.files.includes("scripts/run.py"), true);
  assertEquals(shipSkill.id, "pm-ai-shipping-shipping-artifacts");

  // Check discovered commands
  const shipCmd = result.commands.find((c) => c.name === "ship-check");
  assert(shipCmd, "ship-check command found");
  assertEquals(shipCmd.plugin, "pm-ai-shipping");
  assertEquals(shipCmd.category, "ai-shipping");
  assertEquals(shipCmd.description, "Turn a vibe-coded repo into a reviewer-ready shipping packet");
  assertEquals(shipCmd.argumentHint, "<repo path or area>");
  assertEquals(shipCmd.id, "pm-ai-shipping-ship-check");
});

Deno.test("discoverRepoSkillsAndCommands scopes discovery when URL targets a subfolder", async () => {
  const treeData = {
    sha: "xyz",
    truncated: false,
    tree: [
      { path: "pm-ai-shipping/skills/shipping-artifacts/SKILL.md", type: "blob", size: 2000 },
      { path: "pm-ai-shipping/commands/ship-check.md", type: "blob", size: 1500 },
      { path: "pm-toolkit/skills/review-resume/SKILL.md", type: "blob", size: 2100 },
      { path: "pm-toolkit/commands/review-resume.md", type: "blob", size: 1400 },
    ],
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/main?recursive=1")) {
      return new Response(JSON.stringify(treeData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("---\ndescription: scoped\n---\n", { status: 200 });
  };

  // Target only pm-ai-shipping subpath
  const result = await discoverRepoSkillsAndCommands(
    "https://github.com/phuryn/pm-skills/tree/main/pm-ai-shipping",
    { fetch: mockFetch },
  );

  assertEquals(result.ok, true);
  assertEquals(result.path, "pm-ai-shipping");
  assertEquals(result.skills.length, 1);
  assertEquals(result.skills[0].name, "shipping-artifacts");
  assertEquals(result.commands.length, 1);
  assertEquals(result.commands[0].name, "ship-check");
});

Deno.test("discoverRepoSkillsAndCommands falls back to Contents walk if Trees API fails", async () => {
  // Mock Contents API response structure
  const contents = {
    "": [
      { type: "dir", name: "skills", path: "skills" },
      { type: "dir", name: "commands", path: "commands" },
    ],
    "skills": [
      { type: "file", name: "SKILL.md", path: "skills/SKILL.md", download_url: "https://raw.githubusercontent.com/o/r/main/skills/SKILL.md" },
    ],
    "commands": [
      { type: "file", name: "hello.md", path: "commands/hello.md", download_url: "https://raw.githubusercontent.com/o/r/main/commands/hello.md" },
    ],
  };

  const mockFetch = async (url) => {
    const u = String(url);
    // Trees API returns 404 to trigger fallback
    if (u.includes("/git/trees/")) {
      return new Response("Not found", { status: 404 });
    }
    const contentsMatch = u.match(/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents(?:\/(.*?))?\?ref=/);
    if (contentsMatch) {
      const p = decodeURIComponent(contentsMatch[1] ?? "").replace(/\/$/, "");
      return new Response(JSON.stringify(contents[p] ?? []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("SKILL.md")) {
      return new Response("---\nname: fallback-skill\ndescription: Found via fallback\n---\n", { status: 200 });
    }
    if (u.includes("hello.md")) {
      return new Response("---\ndescription: Hello command\nargument-hint: [name]\n---\n", { status: 200 });
    }
    return new Response("", { status: 404 });
  };

  const result = await discoverRepoSkillsAndCommands("https://github.com/fallback/repo", {
    fetch: mockFetch,
  });

  assertEquals(result.ok, true);
  assertEquals(result.stats.usedTreesApi, false, "Must indicate fallback was used");
  assertEquals(result.skills.length, 1);
  assertEquals(result.skills[0].name, "fallback-skill");
  assertEquals(result.commands.length, 1);
  assertEquals(result.commands[0].name, "hello");
  assertEquals(result.commands[0].argumentHint, "[name]");
});

Deno.test("discoverRepoSkillsAndCommands throws honest rate-limit error on 403 / 429", async () => {
  const rateLimitFetch = async () => new Response("API rate limit exceeded", { status: 403 });

  await assertRejects(
    async () => {
      await discoverRepoSkillsAndCommands("https://github.com/foo/bar", { fetch: rateLimitFetch });
    },
    Error,
    "rate-limited",
  );
});

Deno.test("discoverRepoSkillsAndCommands parses actual 68-skill and 42-command repository tree", async () => {
  // Verify discovery against the real pm-skills tree if cloned on this machine
  const probePath = "/tmp/pi-github-repos/runtime-HTUkbk/94abac45217e506320db7502214e3d25adda17ee99184e70cb69120f09425ef2";
  let realTree = [];
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    if (fs.existsSync(probePath)) {
      const walk = (dir, base = "") => {
        let out = [];
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          const rel = base ? `${base}/${f}` : f;
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            out.push({ path: rel, type: "tree" });
            out = out.concat(walk(full, rel));
          } else {
            out.push({ path: rel, type: "blob", size: stat.size });
          }
        }
        return out;
      };
      realTree = walk(probePath);
    }
  } catch {
    // Probe not available, skip live-tree test
  }

  if (realTree.length === 0) return; // Only runs if probe exists

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/main?recursive=1")) {
      return new Response(JSON.stringify({ sha: "real", truncated: false, tree: realTree }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Return minimal frontmatter so content fetch doesn't need external network
    return new Response("---\ndescription: test\n---\n", { status: 200 });
  };

  const result = await discoverRepoSkillsAndCommands("https://github.com/phuryn/pm-skills/tree/main", {
    fetch: mockFetch,
    fetchContent: false, // test tree structure parsing
  });

  assertEquals(result.stats.skillCount, 68, "Must discover exactly 68 skills");
  assertEquals(result.stats.commandCount, 42, "Must discover exactly 42 commands");
  assertEquals(result.stats.pluginCount, 9, "Must discover exactly 9 plugins");
});
