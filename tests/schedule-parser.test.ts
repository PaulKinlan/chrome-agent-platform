import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parseEnglishSchedule } from "../extension/shared/schedule-parser.js";

Deno.test("English schedules: common recurring phrases map deterministically", () => {
  assertEquals(parseEnglishSchedule("every couple of minutes", "check tabs").schedule, {
    periodInMinutes: 2,
    task: "check tabs",
  });
  assertEquals(parseEnglishSchedule("every hour").schedule?.periodInMinutes, 60);
  assertEquals(parseEnglishSchedule("every 10 minutes").schedule?.periodInMinutes, 10);
  assertEquals(parseEnglishSchedule("daily").schedule?.periodInMinutes, 1440);
});

Deno.test("English schedules: calendar phrases are honestly unsupported by the interval shape", () => {
  const parsed = parseEnglishSchedule("weekdays at 9am");
  assertEquals(parsed.schedule, null);
  assertStringIncludes(parsed.error ?? "", "weekdays aren't supported");
});

Deno.test("English schedules: garbage never creates a plausible schedule", () => {
  const parsed = parseEnglishSchedule("whenever the vibes are right");
  assertEquals(parsed.schedule, null);
  assertStringIncludes(parsed.error ?? "", "couldn't understand");
});

Deno.test("English schedules: on-demand language removes the schedule", () => {
  assertEquals(parseEnglishSchedule("on demand"), {
    schedule: null,
    interpretation: "Runs on demand.",
    error: null,
  });
});
