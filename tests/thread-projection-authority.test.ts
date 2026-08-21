import { assertEquals } from "jsr:@std/assert@1";
import {
  clearAuthoritativeThreadProjection,
  isAuthoritativeThreadResultProjected,
  recordAuthoritativeThreadProjection,
} from "../extension/shared/thread-projection-authority.js";

function terminal(executionId: string, content: string, role = "assistant") {
  return { role, content, executionId };
}

Deno.test("thread projection authority: exact execution/thread/owner/content match suppresses once projected", () => {
  const container = {};
  assertEquals(
    recordAuthoritativeThreadProjection(container, {
      threadId: "thread-1",
      owner: 7,
      generation: 1,
      messages: [
        { role: "user", content: "follow up" },
        terminal("exec-1", "authoritative final"),
      ],
    }),
    true,
  );
  assertEquals(
    isAuthoritativeThreadResultProjected(container, {
      threadId: "thread-1",
      executionId: "exec-1",
      owner: 7,
      content: "authoritative final",
    }),
    true,
  );
});

Deno.test("thread projection authority: other attempts, owners, threads, errors, and revised bytes are not suppressed", () => {
  const container = {};
  recordAuthoritativeThreadProjection(container, {
    threadId: "thread-1",
    owner: 7,
    generation: 2,
    messages: [
      terminal("exec-1", "first final"),
      terminal("exec-error", "failed", "error"),
    ],
  });
  for (
    const query of [
      {
        threadId: "thread-1",
        executionId: "exec-2",
        owner: 7,
        content: "first final",
      },
      {
        threadId: "thread-2",
        executionId: "exec-1",
        owner: 7,
        content: "first final",
      },
      {
        threadId: "thread-1",
        executionId: "exec-1",
        owner: 8,
        content: "first final",
      },
      {
        threadId: "thread-1",
        executionId: "exec-1",
        owner: 7,
        content: "REVISED final",
      },
      {
        threadId: "thread-1",
        executionId: "exec-error",
        owner: 7,
        content: "failed",
      },
    ]
  ) {
    assertEquals(
      isAuthoritativeThreadResultProjected(container, query),
      false,
      JSON.stringify(query),
    );
  }
});

Deno.test("thread projection authority: generation is monotonic within one owned thread and a new owner may replace it", () => {
  const container = {};
  recordAuthoritativeThreadProjection(container, {
    threadId: "thread-1",
    owner: 7,
    generation: 3,
    messages: [terminal("exec-new", "new")],
  });
  assertEquals(
    recordAuthoritativeThreadProjection(container, {
      threadId: "thread-1",
      owner: 7,
      generation: 2,
      messages: [terminal("exec-old", "old")],
    }),
    false,
  );
  assertEquals(
    isAuthoritativeThreadResultProjected(container, {
      threadId: "thread-1",
      executionId: "exec-new",
      owner: 7,
      content: "new",
    }),
    true,
  );

  assertEquals(
    recordAuthoritativeThreadProjection(container, {
      threadId: "thread-1",
      owner: 8,
      generation: 1,
      messages: [terminal("exec-owner-8", "owned")],
    }),
    true,
  );
  assertEquals(
    isAuthoritativeThreadResultProjected(container, {
      threadId: "thread-1",
      executionId: "exec-owner-8",
      owner: 8,
      content: "owned",
    }),
    true,
  );
  assertEquals(clearAuthoritativeThreadProjection(container), true);
  assertEquals(
    isAuthoritativeThreadResultProjected(container, {
      threadId: "thread-1",
      executionId: "exec-owner-8",
      owner: 8,
      content: "owned",
    }),
    false,
  );
});

Deno.test("thread projection authority: hard reload reconstructs exact terminal authority without inheriting the old surface owner", () => {
  const beforeReload = {};
  const persisted = [
    { role: "user", content: "persist me" },
    terminal("exec-persisted", "retained final"),
  ];
  recordAuthoritativeThreadProjection(beforeReload, {
    threadId: "thread-reload",
    owner: 41,
    generation: 9,
    messages: persisted,
  });

  const afterReload = {};
  recordAuthoritativeThreadProjection(afterReload, {
    threadId: "thread-reload",
    owner: 1,
    generation: 1,
    messages: persisted,
  });
  assertEquals(
    isAuthoritativeThreadResultProjected(afterReload, {
      threadId: "thread-reload",
      executionId: "exec-persisted",
      owner: 1,
      content: "retained final",
    }),
    true,
  );
  assertEquals(
    isAuthoritativeThreadResultProjected(afterReload, {
      threadId: "thread-reload",
      executionId: "exec-persisted",
      owner: 41,
      content: "retained final",
    }),
    false,
    "the pre-reload owner cannot authorize a post-reload append decision",
  );
  assertEquals(
    isAuthoritativeThreadResultProjected(afterReload, {
      threadId: "thread-reload",
      executionId: "exec-new-attempt",
      owner: 1,
      content: "retained final",
    }),
    false,
    "identical bytes from a new attempt are still a distinct turn",
  );
});
