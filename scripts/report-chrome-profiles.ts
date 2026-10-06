// vk1t: read-only inventory of the shared Chrome profile root. A dead PID is
// diagnostic evidence, never proof that it is safe to delete its profile.
import { MAX_CHROME_PROFILE_DIRS, reportChromeProfileDirs } from "./lib/chrome-profile-dir.ts";

const report = reportChromeProfileDirs();
console.log(JSON.stringify({
  admissionCap: MAX_CHROME_PROFILE_DIRS,
  remainingAdmissions: Math.max(0, MAX_CHROME_PROFILE_DIRS - report.directories),
  ...report,
}, null, 2));
if (report.directories >= MAX_CHROME_PROFILE_DIRS) {
  console.error("Chrome profile admission cap reached: no live/unknown profile is deleted to make room.");
}
