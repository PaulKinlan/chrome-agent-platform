// Deterministic plain-English recurrence parsing for owner-facing schedule fields.
// The persisted scheduler currently supports intervals only; calendar phrases are
// rejected rather than approximated into a schedule that would run on wrong days.

const MAX_PERIOD_MINUTES = 100_000;

function result(periodInMinutes, task) {
  return {
    schedule: { periodInMinutes, task: task ?? null },
    interpretation: `Runs every ${periodInMinutes} minute${periodInMinutes === 1 ? "" : "s"}.`,
    error: null,
  };
}

/**
 * Parse the interval language supported by the existing {periodInMinutes, task}
 * schedule shape. Empty/on-demand input deliberately removes the schedule.
 * @param {unknown} input
 * @param {string | null} task
 */
export function parseEnglishSchedule(input, task = null) {
  const text = String(input ?? "").trim().toLowerCase().replace(/[.]+$/u, "");
  if (!text || text === "on demand" || text === "none" || text === "never") {
    return { schedule: null, interpretation: text ? "Runs on demand." : "", error: null };
  }
  if (/\b(?:at|weekday|weekdays|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/u.test(text)) {
    return {
      schedule: null,
      interpretation: "",
      error: "Exact times and weekdays aren't supported yet.",
    };
  }

  if (text === "every couple of minutes") return result(2, task);
  if (text === "every minute") return result(1, task);
  if (text === "every hour" || text === "hourly") return result(60, task);
  if (text === "every day" || text === "daily") return result(1440, task);
  if (text === "every week" || text === "weekly") return result(10080, task);

  const match = text.match(/^every\s+([1-9]\d*)\s+(minute|minutes|hour|hours|day|days|week|weeks)$/u);
  if (!match) return { schedule: null, interpretation: "", error: "I couldn't understand that schedule." };
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit.startsWith("hour") ? 60 : unit.startsWith("day") ? 1440 : unit.startsWith("week") ? 10080 : 1;
  const periodInMinutes = amount * multiplier;
  if (!Number.isSafeInteger(periodInMinutes) || periodInMinutes > MAX_PERIOD_MINUTES) {
    return { schedule: null, interpretation: "", error: "That schedule is too far apart." };
  }
  return result(periodInMinutes, task);
}
