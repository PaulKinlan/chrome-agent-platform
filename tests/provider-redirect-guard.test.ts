// @ts-nocheck
// tests/provider-redirect-guard.test.ts — chrome-agent-platform-37fzt (awaom round-2).
//
// THE DEFECT. The round-2 fence (modelAuthoredBaseURLRefusal) validates the
// model-authored baseURL string BEFORE the dial, but the provider transport
// itself called plain fetch with the SDK's init — redirect defaults to
// "follow", and the extension's host_permissions <all_urls> covers every hop.
// Measured in Chrome (2026-11-11, reviewer): a 307 from the dialed URL issues
// the request to the Location target. So a model-chosen PUBLIC baseURL that is
// an open redirector still lands the agent's traffic on 127.0.0.1 /
// 169.254.169.254 / RFC1918 after the owner approved a harmless-looking public
// host — defeating both the fence and the card's "owner-only" promise, and
// breaking THREAT_MODEL T6's own invariant ("a hostile origin cannot 302 the
// extension at loopback/metadata hosts, and the request to such a target is
// never issued") which every other egress surface already enforces
// (createGuardedMcpFetch, fetchWithSafeRedirects, site-docs-fallback).
//
// WHAT THIS DRIVES. The REAL fetchProviderWithGuardedRedirects from
// extension/lib/provider-redirect-guard.js against a recording fake fetch:
// the recording is the assertion surface — what matters is that the request
// to the private hop was never ISSUED, not merely that the call failed. The
// wiring test drives the guard through makeLoggingFetch, the single fetch
// chokepoint every provider adapter installs (openai-model.js,
// anthropic-native-model.js:35, gemini-native-model.js:43), so one guard
// covers all provider transports.
//
// THE MUTANT THIS FILE IS CALIBRATED AGAINST: revert the guard to a
// pass-through (`(input, init, opts) => (opts.fetchImpl ?? fetch)(input, init)`
// — i.e. the pre-fix transport) and every refusal test goes RED: with
// redirect:"follow" semantics the recorder shows the hop request issued
// toward 127.0.0.1/169.254.169.254, exactly the reviewer's repro. Restore the
// old "check only the first URL" shape (fetchWithSafeRedirects semantics) and
// the owner-loopback-preset test goes RED instead: the guard deliberately
// does NOT re-check the CONFIGURED destination — that is the owner's choice
// (ollama/lm-studio presets live on 127.0.0.1) or was fenced pre-dial when
// the model authored it — it checks every HOP.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  PROVIDER_MAX_REDIRECT_HOPS,
  ProviderRedirectRefusedError,
  fetchProviderWithGuardedRedirects,
} from "../extension/lib/provider-redirect-guard.js";

const OPENAI = "https://api.public.example/v1/chat/completions";
const AUTH = { authorization: "Bearer agent-stored-key", "content-type": "application/json" };

/** A fetch that answers from a script and records every request it issues. */
function recordingFetch(script) {
  const issued = [];
  const fetchImpl = async (input, init) => {
    issued.push({ url: String(input instanceof URL ? input.href : input), init });
    const next = script.shift();
    if (!next) throw new Error(`recordingFetch: unscripted request to ${input}`);
    return await next(input, init);
  };
  return { fetchImpl, issued };
}

const ok = (body = "{}") => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const redirect = (to, status = 307) => new Response(null, { status, headers: { location: to } });
// What a browser service worker actually returns for redirect:"manual".
const opaque = () => ({ type: "opaqueredirect", status: 0, headers: new Headers() });

function headerValue(init, name) {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => String(k).toLowerCase() === name)?.[1];
  for (const [k, v] of Object.entries(h)) if (String(k).toLowerCase() === name) return v;
  return undefined;
}

Deno.test("37fzt acceptance: a public baseURL that 307s to loopback is refused BEFORE the hop request is issued", async () => {
  const { fetchImpl, issued } = recordingFetch([() => redirect("http://127.0.0.1:9999/target")]);
  await assertRejects(
    () => fetchProviderWithGuardedRedirects(OPENAI, { method: "POST", headers: AUTH, body: "{}" }, { fetchImpl }),
    ProviderRedirectRefusedError,
  );
  // The hop request to the private target was NEVER issued — exactly one
  // request left the guard, to the configured (owner-approved) URL.
  assertEquals(issued.length, 1);
  assertEquals(issued[0].url, OPENAI);
  assertEquals(issued[0].init.redirect, "manual", "the guard always overwrites the caller's redirect policy");
});

Deno.test("cloud-metadata hop (169.254.169.254) is refused before issuance, and the refusal does not name the destination", async () => {
  const { fetchImpl, issued } = recordingFetch([() => redirect("http://169.254.169.254/latest/meta-data/")]);
  const err = await assertRejects(
    () => fetchProviderWithGuardedRedirects(OPENAI, { method: "POST", headers: AUTH }, { fetchImpl }),
    ProviderRedirectRefusedError,
  );
  assertEquals(issued.length, 1);
  assertStringIncludes(err.message, OPENAI.replace("/v1/chat/completions", "")) // names the REQUESTED url
  assert(!err.message.includes("169.254"), "refusal must not echo the redirect destination");
});

Deno.test("opaqueredirect is refused fail-closed — never followed and never probed (iaccg shape)", async () => {
  const { fetchImpl, issued } = recordingFetch([() => opaque()]);
  await assertRejects(
    () => fetchProviderWithGuardedRedirects(OPENAI, { method: "POST", headers: AUTH }, { fetchImpl }),
    ProviderRedirectRefusedError,
  );
  assertEquals(issued.length, 1, "no probe request may follow an opaque redirect");
});

Deno.test("an inspectable PUBLIC hop is followed, and the cross-origin hop drops the credential headers", async () => {
  const { fetchImpl, issued } = recordingFetch([
    () => redirect("https://api.moved.example/v1/chat/completions"),
    () => ok(),
  ]);
  const res = await fetchProviderWithGuardedRedirects(
    OPENAI,
    { method: "POST", headers: { ...AUTH }, body: "{\"model\":\"x\"}" },
    { fetchImpl },
  );
  assertEquals(res.status, 200);
  assertEquals(issued.length, 2);
  assertEquals(issued[1].url, "https://api.moved.example/v1/chat/completions");
  assertEquals(issued[1].init.method, "POST", "method survives the hop");
  assertEquals(headerValue(issued[1].init, "authorization"), undefined, "Authorization is stripped on a cross-origin hop (browser semantics, enforced manually)");
  assertEquals(headerValue(issued[1].init, "content-type"), "application/json", "non-credential headers survive");
});

Deno.test("a same-origin hop keeps the Authorization header", async () => {
  const { fetchImpl, issued } = recordingFetch([
    () => redirect("https://api.public.example/v2/chat/completions", 308),
    () => ok(),
  ]);
  const res = await fetchProviderWithGuardedRedirects(
    OPENAI,
    { method: "POST", headers: { ...AUTH } },
    { fetchImpl },
  );
  assertEquals(res.status, 200);
  assertEquals(issued.length, 2);
  assertEquals(headerValue(issued[1].init, "authorization"), "Bearer agent-stored-key");
});

Deno.test("a 3xx without an inspectable Location is refused — never blindly followed", async () => {
  const { fetchImpl, issued } = recordingFetch([() => new Response(null, { status: 302 })]);
  await assertRejects(
    () => fetchProviderWithGuardedRedirects(OPENAI, { method: "POST", headers: AUTH }, { fetchImpl }),
    ProviderRedirectRefusedError,
  );
  assertEquals(issued.length, 1);
});

Deno.test("inspectable hops are bounded at PROVIDER_MAX_REDIRECT_HOPS", async () => {
  let n = 0;
  const { fetchImpl, issued } = recordingFetch(
    Array.from({ length: PROVIDER_MAX_REDIRECT_HOPS + 2 }, () => () => redirect(`https://h${n++}.public.example/`)),
  );
  const err = await assertRejects(
    () => fetchProviderWithGuardedRedirects(OPENAI, { method: "POST", headers: AUTH }, { fetchImpl }),
    ProviderRedirectRefusedError,
  );
  assertStringIncludes(err.message, "bound");
  assertEquals(issued.length, PROVIDER_MAX_REDIRECT_HOPS + 1);
});

Deno.test("the CONFIGURED destination is not re-checked: the owner's loopback preset (ollama) keeps working", async () => {
  const { fetchImpl, issued } = recordingFetch([() => ok()]);
  const res = await fetchProviderWithGuardedRedirects(
    "http://127.0.0.1:11434/v1/chat/completions",
    { method: "POST", headers: { "content-type": "application/json" } },
    { fetchImpl },
  );
  assertEquals(res.status, 200);
  assertEquals(issued.length, 1);
  // A redirect FROM the owner's loopback endpoint to a public hop is still
  // hop-checked like any other (private->public is not a smuggling path, but
  // private->private must stay refused — covered by the metadata test).
});

Deno.test("non-redirect responses pass through unchanged", async () => {
  const { fetchImpl, issued } = recordingFetch([() => ok("{\"choices\":[]}")]);
  const res = await fetchProviderWithGuardedRedirects(OPENAI, { method: "POST", headers: AUTH, body: "b" }, { fetchImpl });
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "{\"choices\":[]}");
  assertEquals(issued.length, 1);
  assertEquals(issued[0].init.body, "b");
});

Deno.test("wiring: makeLoggingFetch — the single chokepoint every provider adapter installs — routes through the guard", async () => {
  const { makeLoggingFetch } = await import("../extension/lib/models/openai-model.js");
  const { fetchImpl, issued } = recordingFetch([() => redirect("http://127.0.0.1:1/x")]);
  const loggingFetch = makeLoggingFetch(["agent-stored-key"], { fetch: fetchImpl });
  await assertRejects(
    () => loggingFetch(OPENAI, { method: "POST", headers: AUTH }),
    ProviderRedirectRefusedError,
  );
  assertEquals(issued.length, 1, "the hop toward loopback was never issued through the adapter chokepoint");
});
