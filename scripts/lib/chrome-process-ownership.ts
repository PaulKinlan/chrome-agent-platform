// 9rmz: a reviewer must not treat Chrome's mutable /proc cmdline display as
// its original argv vector. Some builds flatten the whole display into argv[0].
//
// Ownership comes from the caller's OWN launched PID and an earlier startTicks
// capture, plus parent/executable when captured. Never manufacture the expected
// identity from the snapshot being checked. Recheck after opening the socket,
// before sending commands; keep using the endpoint from that child's stderr.
//
// The caller supplies requiredArgs from its own launch intent (including its
// profile/extension flags), never from the observed display. This helper does
// not construct or choose launch flags. Text only CORROBORATES that intent. A flattened
// display is lossy: space boundaries cannot distinguish an argument from text
// inside an argument. This is not an argv parser, an effective-flag-precedence
// check, or proof that the expected extension loaded (verify that over CDP).
// It is also not an authentication boundary against a hostile local process.

export interface ChromeProcessIdentity {
  pid: number;
  startTicks: string;
  ppid?: number;
  executable?: string;
}
export interface ChromeProcessSnapshot extends ChromeProcessIdentity {
  /** Already NUL-split /proc cmdline, retaining a one-element flattened form. */
  argv: readonly string[];
}
/** Throws on missing/mismatched ownership or absent corroborating flags.
 * Errors name the failed property, never print arbitrary process/argv contents.
 * Pure and offline-testable; this does not launch, connect, kill or alter gates. */
export function assertChromeProcessOwnership(
  owner: ChromeProcessIdentity,
  observed: ChromeProcessSnapshot | null,
  requiredArgs: readonly string[],
): "argv" | "flattened" {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
    typeof owner.startTicks !== "string" || !/^\d+$/.test(owner.startTicks) ||
    (owner.ppid !== undefined && (!Number.isSafeInteger(owner.ppid) || owner.ppid <= 0)) ||
    (owner.executable !== undefined && (typeof owner.executable !== "string" || !owner.executable))) {
    throw new Error("Chrome ownership: invalid expected identity");
  }
  if (!observed) throw new Error("Chrome ownership: process missing");
  for (const field of ["pid", "startTicks", "ppid", "executable"] as const) {
    if (owner[field] !== undefined && observed[field] !== owner[field]) {
      throw new Error(`Chrome ownership: ${field} mismatch`);
    }
  }
  if (!Array.isArray(requiredArgs) || !requiredArgs.length ||
    requiredArgs.some(a => typeof a !== "string" || !a.length || /[\0\r\n]/.test(a))) {
    throw new Error("Chrome ownership: invalid required arguments");
  }
  const argv = observed.argv;
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== "string" || a.includes("\0"))) {
    throw new Error("Chrome ownership: invalid cmdline snapshot");
  }
  const flattened = argv.length === 1 ? ` ${argv[0]} ` : null;
  for (const flag of requiredArgs) {
    if (!argv.includes(flag) && !flattened?.includes(` ${flag} `)) {
      throw new Error("Chrome ownership: required flag not corroborated");
    }
  }
  return argv.length === 1 ? "flattened" : "argv";
}
