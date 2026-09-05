// scripts/lib/seed-profile.ts
// Seeds an unpacked profile with agents, artifacts, and demo runs through the real routes.
// CAP-FB-20260830-SEEDED-PROFILE-GATES-01

export interface SeedProfileOptions {
  agents?: number;
  artifacts?: number;
  runs?: number;
  onProgress?: (step: string, current: number, total: number) => void;
}

export interface SeedProfileResult {
  agentsCreated: number;
  artifactsCreated: number;
  runsCreated: number;
  durationMs: number;
}

export async function seedProfile(
  evalIn: ((expr: string) => Promise<any>) | { evl: (s: string, expr: string) => Promise<any> },
  opts: SeedProfileOptions = {},
  sessionId?: string,
): Promise<SeedProfileResult> {
  const evl: (expr: string) => Promise<any> = typeof evalIn === "function"
    ? evalIn
    : (expr: string) => (evalIn as any).evl(sessionId ?? "", expr);

  const numAgents = opts.agents ?? 5;
  const numArtifacts = opts.artifacts ?? 50;
  const numRuns = opts.runs ?? 60;
  const startedAt = Date.now();

  // 1. Ensure provider is set to demo
  await evl(`(async () => await chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo" } }))()`);

  // 2. Create agents
  for (let i = 1; i <= numAgents; i++) {
    await evl(`(async () => await chrome.runtime.sendMessage({
      type: "named-agent.create",
      name: "Seeded Agent ${i}",
      role: "Assists with task ${i}"
    }))()`);
    opts.onProgress?.("agents", i, numAgents);
  }

  // 3. Create artifacts
  for (let i = 1; i <= numArtifacts; i++) {
    await evl(`(async () => await chrome.runtime.sendMessage({
      type: "asset.create",
      name: "Seeded Artifact ${i}.md",
      assetType: "note",
      content: "# Seeded Document ${i}\\nContent for seeded artifact ${i}."
    }))()`);
    opts.onProgress?.("artifacts", i, numArtifacts);
  }

  // 4. Run tasks
  for (let i = 1; i <= numRuns; i++) {
    await evl(`(async () => await chrome.runtime.sendMessage({
      type: "agent.run",
      task: "Seed task ${i}: report status in one sentence.",
      id: String(Date.now()),
      runId: "seed-" + ${i} + "-" + Date.now(),
      history: []
    }))()`);
    opts.onProgress?.("runs", i, numRuns);
  }

  return {
    agentsCreated: numAgents,
    artifactsCreated: numArtifacts,
    runsCreated: numRuns,
    durationMs: Date.now() - startedAt,
  };
}
