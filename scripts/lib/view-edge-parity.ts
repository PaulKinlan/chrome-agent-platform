// chrome-agent-platform-z4gg: compare in-page browse edges without pretending
// the scrollable Settings iframe has the same viewport as the hub.
export function viewEdgeParity({
  artifacts, directory, settings, hostWidth, settingsWidth, contentMax,
}: {
  artifacts: number | null;
  directory: number | null;
  settings: number | null;
  hostWidth: number | null;
  settingsWidth: number | null;
  contentMax: number | null;
}) {
  const numbers = [artifacts, directory, settings, hostWidth, settingsWidth, contentMax];
  if (numbers.some((n) => n === null || !Number.isFinite(n)) ||
    artifacts! <= 0 || directory! <= 0 || settings! <= 0 ||
    hostWidth! <= 0 || settingsWidth! <= 0 || contentMax! <= 0) {
    return { inPageAligned: false, settingsAccounted: false, expectedSettingsInset: null };
  }
  // Only a centered max-width container shifts when the nested iframe has a
  // narrower scrollport. A full-width container at 1024 retains its 40px gutter.
  const expectedSettingsInset = (Math.max(0, hostWidth! - contentMax!) -
    Math.max(0, settingsWidth! - contentMax!)) / 2;
  return {
    inPageAligned: Math.abs(artifacts! - directory!) <= 1,
    settingsAccounted: Math.abs(directory! - settings! - expectedSettingsInset) <= 1,
    expectedSettingsInset,
  };
}
