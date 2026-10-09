import { assert, assertEquals } from "jsr:@std/assert@1";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));

Deno.test("76qp: optional-permission baseline is sampled after boot but before the owner's /tabs grant gesture", () => {
  const capture = 'const capState0 = await msgValue({ type: "capabilities.status" });';
  const captures = source.split(capture).length - 1;
  assertEquals(captures, 1, "one immutable boot-state snapshot, not a later refresh after JIT grants");
  const boot = source.indexOf('check("initial SW boot observed via pre-attached restart", bootObserved);');
  const sample = source.indexOf(capture);
  const ownerTab = source.indexOf('"multi-slash: typing /tabs: after a resolved reference opens the tabs popup"', sample);
  assert(boot >= 0 && sample > boot && ownerTab > sample,
    "the real worker must be awake and the capability snapshot must precede the first owner /tabs selection");
  assert(source.slice(sample, sample + 260).includes('console.log("permissions baseline raw:", JSON.stringify(capState0));'),
    "record the actual id->boolean snapshot for either pass or fail");
});

Deno.test("76qp: the later Settings check still strictly requires every driven optional capability to start ungranted", () => {
  const assertion = source.lastIndexOf('"permissions: optional capabilities start ungranted (JIT) and the mandatory boot set is granted"');
  assert(assertion >= 0, "keep the named baseline check");
  const condition = source.slice(assertion, assertion + 450);
  assert(condition.includes('capState0["storage"] === true') && condition.includes('capState0["alarms"] === true'),
    "mandatory boot permissions remain asserted");
  assert(condition.includes('capState0[id] === false'),
    "optional grants must not become expected true or silently be dropped");
});
