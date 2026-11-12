// extension/lib/skill-trust.js — chrome-agent-platform-2ol0n + v9yc8
//
// ONE place that answers "may this catalog row's metadata render as platform
// text?". Two call sites had grown their own copy of the answer and both were
// DENY-LISTS — `source === "imported" || refId.startsWith("imported:")` meant
// fenced, everything else rendered raw:
//
//   acp-runner.js      buildPromptWithSkillContext  (2ol0n)
//   skill-promotion.js isImportedSkill              (v9yc8)
//
// A deny-list fails OPEN. A row whose source is "custom", a future catalog name,
// or simply ABSENT inherited raw rendering — including interpolation into the
// `<cap-skill ref="…" name="…">` attributes on one path and unfenced name/
// description in the promotion section on the other. Nothing exploited that
// (the live catalog emits builtin/imported rows only), which is why it survived:
// the failure mode is a FUTURE source inheriting the hole by saying nothing.
//
// Trust here is POSITIVE. A row must name a source on TRUSTED_SKILL_SOURCES and
// carry no import signal; everything else is data and must be fenced by the
// caller (the fence is the boundary — escaping is not, see nkf75).

/** The ONLY skill sources whose metadata may render raw. `builtin` is the
 *  bundled onDemandSkills catalogue, authored in this repo. Adding a source here
 *  is a claim that its metadata cannot carry natural language, so it belongs in
 *  a reviewed diff rather than in a default. */
export const TRUSTED_SKILL_SOURCES = new Set(["builtin"]);

/** True when a catalog row's metadata is platform-authored and may render raw.
 *  Everything not positively trusted — including a row with no `source` at all —
 *  returns false, so callers fence by default. */
export function isTrustedSkill(skill) {
  if (!skill || typeof skill !== "object") return false;
  if (!TRUSTED_SKILL_SOURCES.has(String(skill.source ?? ""))) return false;
  // Belt and braces: a row that claims a trusted source but carries any import
  // signal is untrusted, so a catalog bug cannot relabel imported content.
  if (skill.untrusted === true) return false;
  if (String(skill.refId ?? skill.id ?? "").startsWith("imported:")) return false;
  return true;
}

/** The inverse, named for call sites whose default action is to fence. */
export function mustFenceSkill(skill) {
  return !isTrustedSkill(skill);
}

/** A DIFFERENT question from isTrustedSkill(): was this row installed from the import
 *  store, i.e. does it have an OPFS-backed body that skill_read can fetch? xhr57: the
 *  fence and the read path are separate decisions, and conflating them told the model
 *  to call skill_read on rows with no imported body. The three answers are independent:
 *  builtin = trusted and unreadable-by-skill_read; imported = fenced AND readable;
 *  unknown source = fenced but NOT readable. */
export function isImportedSkill(skill) {
  if (!skill || typeof skill !== "object") return false;
  if (skill.source === "imported") return true;
  return String(skill.refId ?? skill.id ?? "").startsWith("imported:");
}
