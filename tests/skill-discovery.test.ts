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

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/main?recursive=1")) {
      return new Response(JSON.stringify(treeData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("marketplace.json")) {
      return new Response(JSON.stringify(marketplaceData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("ship-check.md")) {
      return new Response(
        `---\ndescription: Turn a vibe-coded repo into a reviewer-ready shipping packet\nargument-hint: "<repo path>"\n---\n# /ship-check\n`,
        { status: 200 },
      );
    }
    if (u.includes("shipping-artifacts/SKILL.md")) {
      return new Response(
        `---\nname: shipping-artifacts\ndescription: The durable documentation set that makes an AI-built app reviewable\nauthor: Paweł Huryn\n---\n# Shipping Artifacts\n`,
        { status: 200 },
      );
    }
    return new Response("---\ndescription: generic\n---\n", { status: 200 });
  };

  const result = await discoverRepoSkillsAndCommands("https://github.com/phuryn/pm-skills", {
    fetch: mockFetch,
  });

  assertEquals(result.ok, true);
  assertEquals(result.stats.usedTreesApi, true);
  assertEquals(result.stats.skillCount, 3);
  assertEquals(result.stats.commandCount, 3);
  assertEquals(result.stats.pluginCount, 2);

  // Skills inspection
  const shippingSkill = result.skills.find((s) => s.name === "shipping-artifacts");
  assert(shippingSkill, "Must find shipping-artifacts skill");
  assertEquals(shippingSkill.plugin, "pm-ai-shipping");
  assertEquals(shippingSkill.category, "ai-shipping");
  assertEquals(shippingSkill.author, "Paweł Huryn");
  assertStringIncludes(shippingSkill.description, "durable documentation set");
  assertEquals(shippingSkill.id, "pm-ai-shipping-shipping-artifacts");
  assertEquals(shippingSkill.files, ["SKILL.md", "scripts/run.py"]);

  // Commands inspection
  const shipCheck = result.commands.find((c) => c.name === "ship-check");
  assert(shipCheck, "Must find ship-check command");
  assertEquals(shipCheck.plugin, "pm-ai-shipping");
  assertEquals(shipCheck.argumentHint, "<repo path>");
  assertStringIncludes(shipCheck.description, "reviewer-ready shipping packet");
  assertEquals(shipCheck.id, "pm-ai-shipping-ship-check");
});

Deno.test("discoverRepoSkillsAndCommands scopes discovery when URL targets a subfolder", async () => {
  const treeData = {
    sha: "abc12345",
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

Deno.test("crawlContents respects walked directory budget without being halted by file count", async () => {
  // Directory 'skills' has 70 files; crawl should not drop subsequent directory 'more-skills'
  const contents = {
    "": [
      { type: "dir", name: "skills", path: "skills" },
      { type: "dir", name: "more-skills", path: "more-skills" },
    ],
    "skills": Array.from({ length: 70 }, (_, i) => ({
      type: "file",
      name: `file${i}.txt`,
      path: `skills/file${i}.txt`,
    })),
    "more-skills": [
      { type: "file", name: "SKILL.md", path: "more-skills/SKILL.md" },
    ],
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/")) return new Response("Not found", { status: 404 });
    const m = u.match(/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents(?:\/(.*?))?\?ref=/);
    if (m) {
      const p = decodeURIComponent(m[1] ?? "").replace(/\/$/, "");
      return new Response(JSON.stringify(contents[p] ?? []), { status: 200 });
    }
    return new Response("---\ndescription: ok\n---\n", { status: 200 });
  };

  // maxDirWalk = 10 (allows walking both skills and more-skills)
  const res = await discoverRepoSkillsAndCommands("https://github.com/budget/test", {
    fetch: mockFetch,
    maxDirWalk: 10,
    fetchContent: false,
  });

  assertEquals(res.skills.length, 1);
  assertEquals(res.skills[0].path, "more-skills/SKILL.md");
});

Deno.test("discoverRepoSkillsAndCommands enforces rate-limit detection during content enrichment", async () => {
  const treeData = {
    sha: "enrich-rl",
    truncated: false,
    tree: [
      { path: "skills/a/SKILL.md", type: "blob", size: 100 },
    ],
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/")) {
      return new Response(JSON.stringify(treeData), { status: 200 });
    }
    // Rate-limit during content reading
    return new Response("secondary rate limit", { status: 429 });
  };

  await assertRejects(
    async () => {
      await discoverRepoSkillsAndCommands("https://github.com/foo/bar", {
        fetch: mockFetch,
        fetchContent: true,
      });
    },
    Error,
    "rate-limited",
  );
});

Deno.test("root-level SKILL.md generates slugified ID without doubling repo name and scopes files", async () => {
  const treeData = {
    sha: "root-tree",
    truncated: false,
    tree: [
      { path: "SKILL.md", type: "blob", size: 100 },
      { path: "scripts/run.js", type: "blob", size: 200 },
      { path: "nested-skill/SKILL.md", type: "blob", size: 100 },
      { path: "nested-skill/helper.js", type: "blob", size: 300 },
    ],
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/")) {
      return new Response(JSON.stringify(treeData), { status: 200 });
    }
    return new Response("---\ndescription: test\n---\n", { status: 200 });
  };

  const result = await discoverRepoSkillsAndCommands("https://github.com/my-org/my-skill", {
    fetch: mockFetch,
    fetchContent: false,
  });

  assertEquals(result.skills.length, 2);

  const rootSkill = result.skills.find((s) => s.path === "SKILL.md");
  assert(rootSkill, "Must find root skill");
  // ID must be 'my-skill', not 'my-skill-my-skill'
  assertEquals(rootSkill.id, "my-skill");
  // Root skill files must include scripts/run.js but exclude nested-skill files
  assertEquals(rootSkill.files, ["SKILL.md", "scripts/run.js"]);

  const nestedSkill = result.skills.find((s) => s.path === "nested-skill/SKILL.md");
  assert(nestedSkill, "Must find nested skill");
  assertEquals(nestedSkill.id, "my-skill-nested-skill");
  assertEquals(nestedSkill.files, ["SKILL.md", "helper.js"]);
});

Deno.test("discoverRepoSkillsAndCommands deterministically parses committed 68-skill and 42-command fixture", async () => {
  // Deterministic committed fixture containing the full phuryn/pm-skills tree (unconditional on all machines)
  const fixtureUrl = new URL("./fixtures/pm-skills-tree.json", import.meta.url);
  const realTreeData = JSON.parse(await Deno.readTextFile(fixtureUrl));

  const marketplaceData = {
    name: "pm-skills",
    version: "2.1.0",
    description: "Structured PM skills",
    plugins: [
      { name: "pm-product-discovery", source: "./pm-product-discovery", category: "discovery" },
      { name: "pm-product-strategy", source: "./pm-product-strategy", category: "strategy" },
      { name: "pm-execution", source: "./pm-execution", category: "execution" },
      { name: "pm-market-research", source: "./pm-market-research", category: "research" },
      { name: "pm-data-analytics", source: "./pm-data-analytics", category: "analytics" },
      { name: "pm-go-to-market", source: "./pm-go-to-market", category: "gtm" },
      { name: "pm-marketing-growth", source: "./pm-marketing-growth", category: "growth" },
      { name: "pm-toolkit", source: "./pm-toolkit", category: "toolkit" },
      { name: "pm-ai-shipping", source: "./pm-ai-shipping", category: "ai-shipping" },
    ],
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/main?recursive=1")) {
      return new Response(JSON.stringify(realTreeData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("marketplace.json")) {
      return new Response(JSON.stringify(marketplaceData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("ship-check.md")) {
      return new Response(
        `---\ndescription: Turn a vibe-coded repo into a reviewer-ready shipping packet\nargument-hint: "<repo path or area; defaults to the whole repository>"\n---\n# /ship-check\n`,
        { status: 200 },
      );
    }
    if (u.includes("shipping-artifacts/SKILL.md")) {
      return new Response(
        `---\nname: shipping-artifacts\ndescription: The durable documentation set that makes an AI-built app reviewable\nauthor: Paweł Huryn\n---\n# Shipping Artifacts\n`,
        { status: 200 },
      );
    }
    // Generic response with populated frontmatter
    if (u.includes("commands/")) {
      return new Response(
        `---\ndescription: Automated workflow command\nargument-hint: "<args>"\n---\n`,
        { status: 200 },
      );
    }
    return new Response(
      `---\nname: Sample Skill\ndescription: A structured skill\nauthor: Paweł Huryn\n---\n`,
      { status: 200 },
    );
  };

  const result = await discoverRepoSkillsAndCommands("https://github.com/phuryn/pm-skills/tree/main", {
    fetch: mockFetch,
    fetchContent: true,
  });

  // Acceptance criteria verification:
  assertEquals(result.stats.skillCount, 68, "Must discover exactly 68 skills");
  assertEquals(result.stats.commandCount, 42, "Must discover exactly 42 commands");
  assertEquals(result.stats.pluginCount, 9, "Must map exactly 9 plugins");
  assertEquals(result.plugins.length, 9, "Plugins list must have length 9");

  // Verify specific command with argument hint and frontmatter
  const shipCheck = result.commands.find((c) => c.name === "ship-check");
  assert(shipCheck, "ship-check command must be discovered");
  assertEquals(shipCheck.argumentHint, "<repo path or area; defaults to the whole repository>");
  assertStringIncludes(shipCheck.description, "reviewer-ready shipping packet");
  assertEquals(shipCheck.plugin, "pm-ai-shipping");

  // Verify all commands have argumentHint and description
  for (const cmd of result.commands) {
    assert(cmd.argumentHint.length > 0, `Command ${cmd.path} must have argumentHint`);
    assert(cmd.description.length > 0, `Command ${cmd.path} must have description`);
  }

  // Verify specific skill with frontmatter
  const shippingArtifacts = result.skills.find((s) => s.name === "shipping-artifacts");
  assert(shippingArtifacts, "shipping-artifacts skill must be discovered");
  assertStringIncludes(shippingArtifacts.description, "durable documentation set");
  assertEquals(shippingArtifacts.author, "Paweł Huryn");
  assertEquals(shippingArtifacts.plugin, "pm-ai-shipping");

  // Verify all skills have frontmatter populated
  for (const skill of result.skills) {
    assert(skill.description.length > 0, `Skill ${skill.path} must have description`);
    assert(skill.author.length > 0, `Skill ${skill.path} must have author`);
  }
});
