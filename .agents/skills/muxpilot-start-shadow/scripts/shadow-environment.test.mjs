import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isMuxpilotSessionCgroup,
  isShadowExecutionCgroup,
  shadowSocketPathSafety,
  verifyProductionUnchanged
} from "./shadow-environment.mjs";

function snapshot() {
  return {
    processes: {
      supervisor: { pid: 101, cgroup: "/user.slice/muxpilot.service" },
      server: { pid: 102, cgroup: "/user.slice/muxpilot.service" },
      web: { pid: 103, cgroup: "/user.slice/muxpilot.service" }
    },
    appServerServices: [
      { unit: "muxpilot-session-aaaaaaaaaaaaaaaaaaaaaaaa.service", activeState: "active", mainPid: 201 }
    ],
    sessions: [
      { id: "session-1", codexSessionId: "thread-1", providerKind: "codex", providerThreadId: "thread-1" }
    ]
  };
}

test("accepts unchanged app-server production identity", () => {
  const before = snapshot();
  assert.doesNotThrow(() => verifyProductionUnchanged(before, structuredClone(before)));
});

test("rejects changed or missing production process identity", () => {
  const changed = snapshot();
  changed.processes.server.pid = 999;
  assert.throws(() => verifyProductionUnchanged(snapshot(), changed), /production server identity changed/);

  const missing = snapshot();
  delete missing.processes.web;
  assert.throws(() => verifyProductionUnchanged(snapshot(), missing), /production web identity changed/);
});

test("rejects changed or missing app-server service identity", () => {
  const changed = snapshot();
  changed.appServerServices[0].mainPid = 999;
  assert.throws(() => verifyProductionUnchanged(snapshot(), changed), /production app-server service changed/);

  const missing = snapshot();
  missing.appServerServices = [];
  assert.throws(() => verifyProductionUnchanged(snapshot(), missing), /production app-server service changed/);
});

test("rejects changed or missing provider and thread identity", () => {
  const changed = snapshot();
  changed.sessions[0].providerThreadId = "thread-2";
  assert.throws(() => verifyProductionUnchanged(snapshot(), changed), /production session identity changed/);

  const missing = snapshot();
  missing.sessions = [];
  assert.throws(() => verifyProductionUnchanged(snapshot(), missing), /production session identity changed/);
});

test("keeps shadow sockets within the platform path limit", () => {
  const safe = shadowSocketPathSafety("/tmp/muxpilot-shadow");
  assert.equal(safe.safe, true);
  assert.equal(safe.paths.length, 4);

  const unsafe = shadowSocketPathSafety(`/tmp/${"long-segment-".repeat(10)}`);
  assert.equal(unsafe.safe, false);
  assert.ok(unsafe.unsafePaths.every(({ bytes }) => bytes > unsafe.maxBytes));
});

test("distinguishes session cgroups from allowed shadow execution scopes", () => {
  assert.equal(isMuxpilotSessionCgroup("/user.slice/muxpilot-session-aaaaaaaaaaaaaaaaaaaaaaaa.scope/app.scope"), true);
  assert.equal(isMuxpilotSessionCgroup("/user.slice/muxpilot-shadow-start-123-deadbeef.scope"), false);
  assert.equal(isShadowExecutionCgroup("/init.scope"), true);
  assert.equal(isShadowExecutionCgroup("/user.slice/muxpilot-shadow-start-123-deadbeef.scope"), true);
  assert.equal(isShadowExecutionCgroup("/user.slice/muxpilot-session-aaaaaaaaaaaaaaaaaaaaaaaa.scope"), false);
});
