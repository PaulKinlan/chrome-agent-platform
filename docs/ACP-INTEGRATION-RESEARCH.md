# ACP Integration Research: Connecting Chrome Agent Platform to External Agent Harnesses

**Author**: Chrome Agent Platform Team  
**Date**: 2026-09-12  
**Status**: Approved Architecture & Implementation Plan  
**Target Harnesses**: `pi` (primary / verified test fixture), `claude-code`, `codex`, `antigravity`, `voice`  
**Tracking Epic**: `chrome-agent-platform-qlho`

---

## 1. Executive Summary

Today, Chrome Agent Platform (CAP) connects directly to AI models (via AI SDK providers such as Anthropic, Google Gemini, OpenAI, or local simulated models) running in-process within the browser's Service Worker and Agent Worker. In this model, the extension owns the loop: prompting the model, executing browser tools, managing memory in origin-keyed OPFS, and streaming UI cards.

Paul's directive (*"prioritise that work extreme"*) introduces an architectural leap: **allow CAP to connect to a running agent harness on the host system — specifically `pi`, the harness he uses daily — via the Agent Client Protocol (ACP)**. 

With ACP integration:
- Tasks can be initiated, directed, or triggered directly from the **New Tab Page (NTP)** hero composer.
- The user can select an external harness agent as the default runner or route tasks per-turn using `@pi` or `/agent:acp:pi`.
- The external harness executes on the machine with its full environment (filesystem access, shell tools, installed skills, compiler pipelines, subagents), while CAP acts as the client surface that drives the agent, provides browser context/tools, and visualizes progress in real-time task threads.

---

## 2. What Agent Client Protocol (ACP) Is

The **Agent Client Protocol (ACP)** is an open, standardized communication protocol between a client application (an editor, IDE, or agent platform like CAP) and an autonomous AI agent harness. Codified under `@agentclientprotocol/sdk` and indexed via a central registry (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`), ACP standardizes what was previously an ad-hoc fragmentation of proprietary agent protocols.

### 2.1 Core Protocol Characteristics
- **Transport Framing**: JSON-RPC 2.0 with integer protocol version `protocolVersion: 1`. When run over stream transports (stdio, pipes), messages are newline-delimited (`\n`). When run over WebSockets, each WebSocket text frame represents a discrete JSON-RPC message.
- **Bidirectional Invocations**:
  - *Client-to-Agent Requests*: `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`.
  - *Agent-to-Client Requests*: `session/request_permission` (agent requests user or client permission to run commands, edit files, or execute tools).
  - *Agent-to-Client Notifications*: `session/update` (streaming message text, reasoning/thinking, tool call lifecycles, available commands).
- **Session Durability & Replay**: `session/load` is a true resume primitive. A client can reconnect to an existing session by ID, and the adapter replays previous history and restores internal memory state.
- **Turn Boundaries**: A prompt turn is bounded. The agent streams events during the turn and completes with `{ stopReason: "end_turn" }`.

---

## 3. What an ACP Client Must Implement

An ACP client in CAP must fulfill five fundamental responsibilities:

```
┌────────────────────────────────────────────────────────┐
│             Chrome Agent Platform (CAP)                │
│  ┌──────────────────────┐    ┌──────────────────────┐  │
│  │  NTP Hero Composer   │    │  Task Thread Surface │  │
│  └──────────┬───────────┘    └──────────▲───────────┘  │
│             │                           │              │
│             ▼                           │              │
│  ┌──────────────────────────────────────┴───────────┐  │
│  │               CAP ACP Client Core                │  │
│  │  - JSON-RPC 2.0 Transport (WebSocket / Bridge)    │  │
│  │  - Handshake & Capability Negotiation            │  │
│  │  - Session Manager (session/new, session/load)   │  │
│  │  - Turn Dispatcher (session/prompt)              │  │
│  │  - Streaming Event Router (session/update)       │  │
│  │  - Permission Delegate (session/request_perm)    │  │
│  └──────────────────────┬───────────────────────────┘  │
└─────────────────────────┼──────────────────────────────┘
                          │ WebSocket (ws://127.0.0.1:3210)
                          ▼
┌────────────────────────────────────────────────────────┐
│             Local ACP Bridge (stdio <-> WS)            │
│  - Spawns: node ~/.pi/agent/npm/node_modules/pi-acp    │
└─────────────────────────┬──────────────────────────────┘
                          │ stdio (JSON-RPC 2.0 \n)
                          ▼
┌────────────────────────────────────────────────────────┐
│            pi-acp (ACP Adapter for pi)                 │
│  - Spawns: pi --mode rpc --no-themes                   │
│  - Loads ~/.pi/agent/skills, prompts, tools, sessions  │
└────────────────────────────────────────────────────────┘
```

1. **Transport Layer**:
   - Manages asynchronous request/response correlation via unique request `id`s.
   - Handles connection errors, stream disconnects, and process teardowns without hanging the caller.
   - Exposes clean `request(method, params)` and `onEvent(callback)` abstractions.
2. **Handshake (`initialize`)**:
   - Advertises client capabilities:
     ```json
     {
       "protocolVersion": 1,
       "clientCapabilities": {
         "fs": { "readTextFile": false, "writeTextFile": false },
         "terminal": false
       }
     }
     ```
   - Inspects server capabilities (`agentInfo`, `authMethods`, `agentCapabilities`).
3. **Session Lifecycle (`session/new`, `session/load`)**:
   - `session/new`: Initiates a new conversation with working directory (`cwd`) and optional tool/MCP server bindings.
   - `session/load`: Resumes an existing task session given a `sessionId`, enabling multi-turn conversation memory.
4. **Turn Execution & Event Streaming (`session/prompt`, `session/update`)**:
   - Formats user prompts with text and optional media attachments.
   - Unpacks `session/update` event kinds:
     - `agent_message_chunk`: Concatenates and streams assistant markdown.
     - `agent_thought_chunk`: Renders reasoning / thinking trace.
     - `tool_call` / `tool_call_update`: Renders tool execution progress cards.
     - `available_commands_update`: Discovers available skills and commands.
5. **Permission Negotiation (`session/request_permission`)**:
   - Answers agent permission requests when local operations require consent.
   - Supports both configured auto-grant (unattended execution) and user-interactive confirmation in accordance with CAP's `CONSTITUTION.md`.

---

## 4. How the Extension Hosts or Reaches a Session

### 4.1 Architectural Constraints of Chrome MV3
A Chrome Manifest V3 extension runs inside isolated browser processes (Service Worker, Extension Tab Pages, Side Panel, Offscreen Documents). Unlike Node.js or native applications, **the browser sandbox cannot directly execute `child_process.spawn("pi-acp")` or invoke OS shell binaries**.

### 4.2 Transport Options Evaluated

| Architecture | Mechanism | Setup Friction | Browser Compatibility | Latency & Reliability |
|---|---|---|---|---|
| **Option A: Loopback WebSocket Bridge (Recommended)** | Extension connects via `WebSocket` to `ws://127.0.0.1:<port>`. A lightweight local companion/daemon (`scripts/acp-bridge.mjs` or `isocan acp`) spawns the ACP adapter. | **Zero browser friction**; standard loopback networking allowed under MV3 CSP. | 100% native in Service Worker & Extension pages. | Very low (<1ms loopback); full streaming duplex. |
| **Option B: Chrome Native Messaging** | `chrome.runtime.connectNative("acp_host")` connects to an OS executable on stdio. | **High friction**: requires registering a JSON manifest file in OS-specific Chrome directories with exact extension ID. | Supported in Service Worker. | Native stdio, but rigid install and poor hot-reloading. |
| **Option C: Direct Harness WebSocket** | Extension connects directly to harnesses that natively serve WebSockets. | **Zero friction**, but requires every harness to implement WebSocket servers. | Supported natively. | Minimal overhead, but `pi-acp` and Zed ACP standard currently speak stdio. |

### 4.3 Recommended Solution: Loopback WebSocket Architecture
1. **The Client (in Extension)**: Connects to a configurable loopback endpoint (default `ws://127.0.0.1:3210/acp`). It speaks standard JSON-RPC 2.0 frames over the socket.
2. **The Bridge (on Host)**: A tiny, robust 60-line script (`scripts/acp-bridge.ts` or `npx @isocan/acp-bridge`) that listens on loopback, spawns `pi-acp` (or the configured adapter from `~/.isocan/config.json`), and pipes WebSocket messages to stdin/stdout.
3. **Automatic Fallback & Status Visibility**: If the bridge is not running, the extension reports an honest, actionable message in the composer: *"ACP harness at ws://127.0.0.1:3210 is not reachable. Start the bridge with: npm run acp:bridge"*.

---

## 5. Answers to Key Research Questions

### 5.1 Skills: Are locally-authored skills exposed to the agent as local resources/assets, or not visible?

**Empirical Finding (Verified on live machine with `pi-acp` 2026-09-12):**
- **Yes, locally-authored skills ARE fully visible and exposed to the agent.**
- In our live verification test of `pi-acp`:
  ```
  node pi-acp/dist/index.js -> session/new { cwd: "/home/paulkinlan/journal" }
  ```
  `pi-acp` immediately emitted:
  ```json
  {
    "method": "session/update",
    "params": {
      "update": {
        "sessionUpdate": "available_commands_update",
        "availableCommands": [
          { "name": "skill:beads", "description": "Use when working in a repository that uses bd..." },
          { "name": "skill:impeccable", "description": "Use when the user wants to design..." },
          { "name": "skill:anti-slop-writing", "description": "Use this skill to review..." },
          { "name": "skill:cloudflare", "description": "Comprehensive Cloudflare platform skill..." },
          { "name": "skill:modern-web-guidance", "description": "Search tool for modern web..." },
          ... 25+ skills catalogued
        ]
      }
    }
  }
  ```
- **Why this works**: Because `pi-acp` spawns `pi --mode rpc` with the specified working directory (`cwd`), `pi` natively reads `~/.pi/agent/skills/` and `<cwd>/.agents/skills/`. The harness itself manages, discovers, and executes skills directly from the host filesystem.
- **Extension Skills Injection**: If the user authors a skill inside CAP (e.g. a recipe or browser automation macro), CAP can pass it as prompt context or register an in-memory MCP tool definition during `session/new` via the `mcpServers` parameter.

### 5.2 Cost and Permissions

- **Cost**:
  - **Zero extension API billing**: The Chrome Extension does not consume its own configured API keys, spend credits, or hit browser token quotas for ACP runs.
  - The model calls are made by `pi` on the host machine using the user's existing CLI configuration, API keys, or enterprise subscriptions (e.g. Anthropic, OpenAI Codex, DeepSeek, Gemini).
  - Cost and token telemetry are tracked by `pi` and can be retrieved via session statistics (`session` command or `_meta` in updates).
- **Permissions**:
  - ACP provides native permission negotiation: when the harness attempts an action (e.g. executing bash commands, writing files), it sends a `session/request_permission` request to CAP:
    ```json
    {
      "method": "session/request_permission",
      "params": {
        "toolCall": { "title": "Run bash: git status" },
        "options": [
          { "optionId": "allow_once", "name": "Allow once" },
          { "optionId": "deny", "name": "Deny" }
        ]
      }
    }
    ```
  - CAP can handle this in two configurable modes:
    1. **Interactive Mode**: Renders an inline permission card in the task conversation matching CAP's permission UI. The turn waits until the user clicks Allow or Deny.
    2. **Auto-Grant (Trusted Mode)**: Auto-selects the `allow` option, treating the local harness as an attended developer tool executing with user permissions (matching `isocan rc` behavior).

### 5.3 Is this a different class of agent from named agents in the system?

**Yes. An ACP Agent is a fundamentally distinct class: an "External System Harness Agent".**

| Dimension | Browser Named Agents (`kind: "named"`) | External ACP Harness Agents (`kind: "acp"`) |
|---|---|---|
| **Execution Environment** | Sandboxed in browser Service Worker / Web Worker | Host system process (`pi`, `claude-code`, `codex`) |
| **Tool Execution** | In-browser tools (DOM, CDP, fetch, OPFS, WebAssembly) | Host tools (bash, filesystem, git, compilers, subagents) |
| **Model Hosting** | AI SDK inside browser with browser-stored API keys | Managed by host harness via local environment credentials |
| **Identity & Scope** | Defined by CAP template, system prompt, local memory | Defined by local harness profile, settings, and disk state |
| **Addressing Ref** | `named:<slug>` (e.g. `named:general`) | `acp:<harness>` (e.g. `acp:pi`, `acp:claude-code`) |

### 5.4 UI Configuration & Affordances in CAP

1. **New Tab Page (NTP) Hero Composer**:
   - **Autocomplete & Mentions**: Typing `@pi` or `/agent:acp:pi` selects the `pi` harness agent.
   - **Agent Chip**: Renders an agent badge with the harness icon/initial (`π` or `pi`) and title.
   - **Routing**: Senders can route on a per-task basis or set ACP as the default runner.
2. **Settings Surface**:
   - **Settings → Harness / ACP**:
     - *Harness Endpoint*: URL input (default `ws://127.0.0.1:3210/acp`).
     - *Default Runner Mode*: Radio toggle between `Direct Model (In-Browser)` and `ACP Harness (pi)`.
     - *Working Directory*: Default working directory passed to `session/new` (e.g. `/home/paulkinlan/journal`).
     - *Permissions Policy*: `Always Ask (Inline Cards)` vs `Auto-Approve (Developer Mode)`.
3. **Task Thread Surface**:
   - Streams real-time thoughts (`agent_thought_chunk`) in an expandable "Reasoning" card.
   - Renders tool execution indicators (`tool_call`) with parameters and status.
   - Streams final markdown output (`agent_message_chunk`).
   - Surfaces clean completion or interruption states.

---

## 6. Implementation Architecture & Roadmap

### Stage 1: Core ACP Client (`extension/lib/acp-client.js`)
- Implement `AcpClient` class supporting `WebSocketTransport`.
- Methods: `connect()`, `initialize()`, `newSession()`, `loadSession()`, `prompt()`, `cancel()`, `close()`.
- Event emitter for streaming updates: `chunk`, `thought`, `tool`, `permission`, `end`.

### Stage 2: Loopback Bridge Companion (`scripts/acp-bridge.ts`)
- Standalone bridge connecting WebSocket `ws://127.0.0.1:3210/acp` to spawned `pi-acp`.
- Auto-detects `pi-acp` from npm global or local path.
- Handles multiple concurrent connections, process crash recovery, and clean teardown.

### Stage 3: Agent Registry & Router Integration
- Update `extension/shared/agent-registry.js` to add `"acp"` to `AGENT_KINDS`.
- Add `acp:pi` to registry groups so it appears in the Agent Picker and composer dropdowns.
- Update `service-worker.js` to dispatch `mention.kind === "acp"` to the ACP execution runner.

### Stage 4: UI Affordances in NTP & Side Panel
- Support selecting `@pi` in the composer.
- Display ACP thinking, tool runs, and text chunks in the live conversation stream.
- Add Settings → Harness section for endpoint configuration and status monitoring.

### Stage 5: Verification & Driven Testing
- Driven test suite connecting CAP's `AcpClient` to the live `pi-acp` process.
- Verifies initialize, session creation, streaming thoughts, tool discovery, and prompt completion with evidence capture.
