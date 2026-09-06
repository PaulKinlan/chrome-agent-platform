// scripts/lib/kat-finalizer.ts — Reusable fail-closed browser and profile teardown helper for KATs (06qj).
// Guarantees independent execution of every teardown phase, confirmed process exit after SIGKILL,
// strict error aggregation, profile unlinking, and poison slot detection.

export interface TeardownChromeAndProfileOptions {
  cdp?: {
    send(method: string, params?: unknown): Promise<unknown>;
    close(): void;
  } | null;
  chrome?: {
    proc: {
      status: Promise<{ success: boolean; code?: number }>;
      kill(signal?: string): void;
    };
  } | null;
  profilePath?: string | null;
  poisonPath?: string;
  withTimeout: <T>(promise: Promise<T>, ms: number) => Promise<T>;
  removeDir?: (path: string) => Promise<void>;
  statFile?: (path: string) => Promise<boolean>;
}

export interface TeardownResult {
  cleanupError: string | null;
  poisonDetected: boolean;
}

export async function teardownChromeAndProfile(
  options: TeardownChromeAndProfileOptions,
): Promise<TeardownResult> {
  const {
    cdp,
    chrome,
    profilePath,
    poisonPath = "/tmp/cap-chrome-slot-POISON",
    withTimeout,
    removeDir = (path) => Deno.remove(path, { recursive: true }),
    statFile = async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (
          error instanceof Deno.errors.NotFound ||
          (error as any)?.name === "NotFound" ||
          (error as any)?.code === "ENOENT" ||
          String(error).includes("NotFound")
        ) {
          return false;
        }
        throw error;
      }
    },
  } = options;

  let cleanupError: string | null = null;
  function recordCleanupError(msg: string) {
    cleanupError = cleanupError ? `${cleanupError}; ${msg}` : msg;
    console.error(msg);
  }

  // 1. CDP teardown (Browser.close and CDP transport close independently guarded)
  if (cdp) {
    try {
      await withTimeout(cdp.send("Browser.close"), 4_000).catch(() => {});
    } catch (err) {
      recordCleanupError(
        `cdp_browser_close_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      cdp.close();
    } catch (err) {
      recordCleanupError(
        `cdp_close_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Chrome process termination (ALWAYS runs even if CDP close threw)
  if (chrome) {
    try {
      await withTimeout(chrome.proc.status, 8_000).catch(async () => {
        try {
          chrome?.proc.kill("SIGKILL");
        } catch {
          /* process may already have exited */
        }
        await withTimeout(chrome.proc.status, 4_000);
      });
    } catch (procErr) {
      recordCleanupError(
        `browser_teardown_failed: ${procErr instanceof Error ? procErr.message : String(procErr)}`,
      );
    }
  }

  // 3. Profile directory cleanup (ALWAYS runs even if process or CDP cleanup threw)
  if (profilePath) {
    try {
      await removeDir(profilePath);
    } catch (rmErr) {
      const rmMsg = `profile_cleanup_failed: ${
        rmErr instanceof Error ? rmErr.message : String(rmErr)
      }`;
      recordCleanupError(rmMsg);
    }
  }

  // 4. Poison slot detection
  let poisonDetected = false;
  try {
    const exists = await statFile(poisonPath);
    if (exists) {
      poisonDetected = true;
      recordCleanupError("poison_slot_detected");
    }
  } catch (statErr) {
    recordCleanupError(
      `poison_stat_failed: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
    );
  }

  return { cleanupError, poisonDetected };
}
