#!/usr/bin/env node
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";

const capabilityPath = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line) void handle(line);
    newline = input.indexOf("\n");
  }
});

async function handle(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    respond(request.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "muxpilot-sessions", version: "1.0.0" } });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, { tools: toolDefinitions() });
    return;
  }
  if (request.method === "ping") {
    respond(request.id, {});
    return;
  }
  if (request.method !== "tools/call") return;
  try {
    const name = String(request.params?.name ?? "");
    const args = request.params?.arguments && typeof request.params.arguments === "object" ? request.params.arguments : {};
    const result = await brokerCall(name, args);
    respond(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  } catch (error) {
    respond(request.id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
  }
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function brokerCall(action, args) {
  if (!capabilityPath) throw new Error("Muxpilot session capability is unavailable");
  const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(capability.socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(65_000, () => socket.destroy(new Error("Muxpilot session broker timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, token: capability.token, action, args })}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\n")) return;
      socket.end();
      try {
        const parsed = JSON.parse(response.trim());
        if (!parsed.ok) reject(new Error(parsed.error ?? "Muxpilot session operation failed"));
        else resolve(parsed.result);
      } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

function toolDefinitions() {
  const object = (properties = {}, required = []) => ({ type: "object", additionalProperties: false, properties, required });
  const sessionId = { type: "string", description: "Exact muxpilot session id" };
  return [
    { name: "list_sessions", description: "List muxpilot sessions with hierarchy, status, context pressure, and remaining work-token budget.", inputSchema: object({ scope: { type: "string", enum: ["all", "tree"] } }) },
    { name: "read_session", description: "Read muxpilot's persisted session record, queued inputs, and a bounded parsed transcript tail with raw message payloads.", inputSchema: object({ sessionId, limit: { type: "integer", minimum: 1, maximum: 30 } }, ["sessionId"]) },
    { name: "list_tmux_panes", description: "Return verbatim tmux list-panes output for independent runtime inspection.", inputSchema: object() },
    { name: "capture_tmux_pane", description: "Return a verbatim bounded capture of an exact tmux pane. Physical wrapping is preserved unless joinWrappedLines is true.", inputSchema: object({ paneId: { type: "string", pattern: "^%[0-9]+$" }, lines: { type: "integer", minimum: 1, maximum: 2000 }, includeAnsi: { type: "boolean" }, joinWrappedLines: { type: "boolean" } }, ["paneId"]) },
    { name: "read_tmux_process_tree", description: "Read direct /proc cmdline, status, cgroup, and child evidence for an exact tmux pane's process tree.", inputSchema: object({ paneId: { type: "string", pattern: "^%[0-9]+$" } }, ["paneId"]) },
    { name: "list_codex_session_files", description: "List recent JSONL files beneath the configured Codex sessions root using filesystem metadata only.", inputSchema: object({ limit: { type: "integer", minimum: 1, maximum: 500 }, offset: { type: "integer", minimum: 0 } }) },
    { name: "read_codex_session_file", description: "Read an exact bounded byte slice from a listed Codex JSONL file as raw UTF-8 text with byte boundaries.", inputSchema: object({ relativePath: { type: "string" }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 262144 } }, ["relativePath"]) },
    { name: "create_session", description: "Create a fresh-context child session in this session's repository and delegate an initial task.", inputSchema: object({ name: { type: "string" }, task: { type: "string", maxLength: 200000 }, mode: { type: "string", enum: ["default", "plan"] } }, ["name", "task"]) },
    { name: "claim_session", description: "Claim an unowned live muxpilot session by exact id and nest it under this session.", inputSchema: object({ sessionId }, ["sessionId"]) },
    { name: "release_session", description: "Release a managed descendant back to the top level without stopping it.", inputSchema: object({ sessionId }, ["sessionId"]) },
    { name: "send_message", description: "Send a message to any live muxpilot session. Descendant work-token budgets apply.", inputSchema: object({ sessionId, text: { type: "string", maxLength: 200000 }, mode: { type: "string", enum: ["default", "plan"] } }, ["sessionId", "text"]) },
    { name: "answer_question", description: "Answer a pending structured question in a managed descendant. Security approvals are not supported.", inputSchema: object({ sessionId, answers: { type: "object" } }, ["sessionId", "answers"]) },
    { name: "choose_plan_action", description: "Choose a pending plan action in a managed descendant.", inputSchema: object({ sessionId, action: { type: "string", enum: ["implement", "clear_context_implement", "stay_in_plan"] } }, ["sessionId", "action"]) },
    { name: "interrupt_session", description: "Interrupt a managed descendant.", inputSchema: object({ sessionId }, ["sessionId"]) },
    { name: "finish_session", description: "Stop a managed descendant and free its root-tree concurrency slot while retaining history.", inputSchema: object({ sessionId }, ["sessionId"]) },
    { name: "extend_budget", description: "Extend a descendant's work-token budget with an audited reason.", inputSchema: object({ sessionId, additionalTokens: { type: "integer", minimum: 1, maximum: 2000000 }, reason: { type: "string" } }, ["sessionId", "additionalTokens", "reason"]) },
    { name: "wait_for_sessions", description: "Arm an event-driven wait. After it succeeds, end the turn immediately; muxpilot will resume this session once a target reaches a terminal or attention state.", inputSchema: object({ sessionIds: { type: "array", minItems: 1, maxItems: 2, items: sessionId }, mode: { type: "string", enum: ["any", "all"] }, timeoutMinutes: { type: "integer", minimum: 1, maximum: 1440 } }, ["sessionIds"]) },
    { name: "cancel_wait", description: "Cancel this session's active orchestration wait.", inputSchema: object() }
  ];
}
