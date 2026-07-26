import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { completeExternalVerificationForPlugin } from "../plugins/external-verification-approval-runtime-state.js";
import type { PluginExternalVerificationAttempt } from "../plugins/external-verification-approval-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import type { PluginExternalApprovalVerifierRegistration } from "../plugins/registry-types.js";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { PluginExternalVerificationRuntime } from "./plugin-external-verification-runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

let runtime: PluginExternalVerificationRuntime | null = null;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    runtime?.shutdown();
    runtime = null;
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-external-runtime-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createHarness(
  handler: (attempt: PluginExternalVerificationAttempt) => void | Promise<void>,
  options?: {
    publishResolution?: ConstructorParameters<
      typeof PluginExternalVerificationRuntime
    >[0]["publishResolution"];
    resolveVerifier?: ConstructorParameters<
      typeof PluginExternalVerificationRuntime
    >[0]["resolveVerifier"];
  },
) {
  const databaseOptions = createDatabaseOptions();
  const runtimeEpoch = "runtime-external";
  const owner = {};
  const verifier: PluginExternalApprovalVerifierRegistration = {
    pluginId: "agentkit",
    pluginName: "AgentKit",
    owner,
    handler,
    source: "/plugins/agentkit/index.js",
  };
  const verifierRegistry = createEmptyPluginRegistry();
  verifierRegistry.externalApprovalVerifiers.push(verifier);
  let activeVerifier: PluginExternalApprovalVerifierRegistration | null = verifier;
  const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence: { runtimeEpoch, databaseOptions },
    resolveAllowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions,
    onLifecycle: (event) => runtime?.onApprovalLifecycle(event),
  });
  runtime = new PluginExternalVerificationRuntime({
    manager,
    runtimeEpoch,
    databaseOptions,
    ...(options?.publishResolution ? { publishResolution: options.publishResolution } : {}),
    resolveVerifier:
      options?.resolveVerifier ??
      ((pluginId) => (pluginId === verifier.pluginId ? activeVerifier : null)),
  });
  const request: PluginApprovalRequestPayload = {
    pluginId: "agentkit",
    title: "World verification",
    description: "Verify personhood before continuing.",
    toolName: "dangerous-tool",
    toolCallId: "call-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    runId: "run-1",
    externalResolution: {
      label: "Verify with World",
      decisions: ["allow-once", "allow-always"],
    },
  };
  const record = manager.create(request, 60_000, "plugin:runtime-approval");
  const decision = manager.register(record, 60_000);
  return {
    databaseOptions,
    decision,
    manager,
    owner,
    retireVerifier: () => {
      activeVerifier = null;
      markPluginRegistryRetired(verifierRegistry);
    },
    setVerifier: (next: PluginExternalApprovalVerifierRegistration | null) => {
      activeVerifier = next;
    },
  };
}

function readApproval(databaseOptions: OpenClawStateDatabaseOptions) {
  const lookup = getOperatorApprovalDetailed({
    id: "plugin:runtime-approval",
    databaseOptions,
  });
  return lookup.outcome === "found" ? lookup.record : null;
}

describe("PluginExternalVerificationRuntime", () => {
  it("dispatches one immutable attempt and replays the same reviewer interaction", async () => {
    const attempts: PluginExternalVerificationAttempt[] = [];
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      attempts.push(attempt);
      await attempt.present({ message: "Open the verifier and complete the World proof." });
    });
    const { owner, decision } = createHarness(handler);
    const firstPresent = vi.fn(async () => undefined);
    const replayPresent = vi.fn(async () => undefined);

    const first = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: firstPresent,
    });
    const replay = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: replayPresent,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(firstPresent).toHaveBeenCalledWith("Open the verifier and complete the World proof.");
    expect(replayPresent).toHaveBeenCalledWith("Open the verifier and complete the World proof.");
    expect(replay).toEqual(first);
    expect(attempts[0]).toMatchObject({
      context: {
        approvalId: "plugin:runtime-approval",
        pluginId: "agentkit",
        runId: "run-1",
        toolName: "dangerous-tool",
        toolCallId: "call-1",
        sessionId: "session-1",
        decision: "allow-always",
      },
    });
    expect(Object.isFrozen(attempts[0])).toBe(true);
    expect(Object.isFrozen(attempts[0]?.context)).toBe(true);

    const completed = await runtime!.complete(owner, "agentkit", {
      attemptId: first.id,
      outcome: "succeeded",
    });
    expect(completed).toMatchObject({
      applied: true,
      attempt: { id: first.id, outcome: "succeeded" },
      approval: { status: "allowed", decision: "allow-always" },
      grantAuthorization: { approvalId: "plugin:runtime-approval", attemptId: first.id },
    });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: first.id,
        outcome: "succeeded",
      }),
    ).resolves.toEqual({ ...completed, applied: false });
    await expect(decision).resolves.toBe("allow-always");
  });

  it("keeps the approval pending when the verifier fails before presenting instructions", async () => {
    const { databaseOptions } = createHarness(() => undefined);

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("returned without presenting reviewer instructions");
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });
  });

  it("returns the durable failed attempt when a setup failure is redelivered", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "Verify this request." });
      throw new Error("setup failed");
    });
    createHarness(handler);

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("external verifier failed: setup failed");
    const replayPresent = vi.fn(async () => undefined);
    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: replayPresent,
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      terminalSource: "verifier-error",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(replayPresent).toHaveBeenCalledWith("Verify this request.");
  });

  it("durably fails an attempt when verifier lookup throws", async () => {
    createHarness(() => undefined, {
      resolveVerifier: () => {
        throw new Error("registry unavailable");
      },
    });

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("external verifier lookup failed: registry unavailable");
    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      terminalSource: "verifier-error",
    });
  });

  it("does not count reviewer instructions when delivery fails and the verifier swallows it", async () => {
    const { databaseOptions } = createHarness(async (attempt) => {
      try {
        await attempt.present({ message: "Verify now." });
      } catch {}
    });

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => {
          throw new Error("delivery failed");
        },
      }),
    ).rejects.toThrow("returned without presenting reviewer instructions");
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });
  });

  it("rejects completion from a stale plugin instance", async () => {
    const { owner, databaseOptions } = createHarness(async (attempt) => {
      await attempt.present({ message: "Verify now." });
    });
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(
      runtime!.complete({}, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).rejects.toThrow("not found for this plugin instance");
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });

    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "failed",
      }),
    ).resolves.toMatchObject({ applied: false, attempt: { outcome: "failed" } });
  });

  it("revokes presentation and aborts the attempt when its verifier registry retires", async () => {
    let attempt: PluginExternalVerificationAttempt | undefined;
    const { retireVerifier } = createHarness(async (value) => {
      attempt = value;
      await value.present({ message: "Verify now." });
    });
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    retireVerifier();

    expect(attempt?.signal.aborted).toBe(true);
    await expect(attempt?.present({ message: "stale verifier output" })).rejects.toThrow(
      "verifier-retired",
    );
    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        present: async () => undefined,
      }),
    ).resolves.toMatchObject({
      id: started.id,
      outcome: "cancelled",
      terminalSource: "verifier-retired",
    });
  });

  it("revokes the prior attempt before a retry reports a missing verifier", async () => {
    let attempt: PluginExternalVerificationAttempt | undefined;
    const { setVerifier } = createHarness(async (value) => {
      attempt = value;
      await value.present({ message: "Verify now." });
    });
    await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    setVerifier(null);

    await expect(
      runtime!.start({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        interactionId: "b".repeat(64),
        present: async () => undefined,
      }),
    ).rejects.toThrow("has no active external verifier");
    expect(attempt?.signal.aborted).toBe(true);
    await expect(attempt?.present({ message: "stale retry output" })).rejects.toThrow(
      "reviewer-retry",
    );
  });

  it("rejects completion before the verifier presents reviewer instructions", async () => {
    let earlyCompletion: Promise<unknown> | undefined;
    const harness = createHarness(async (attempt) => {
      earlyCompletion = runtime!.complete(owner, "agentkit", {
        attemptId: attempt.id,
        outcome: "succeeded",
      });
      await expect(earlyCompletion).rejects.toThrow("before reviewer presentation finishes");
      await attempt.present({ message: "Verify now." });
    });
    const owner = harness.owner;

    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(earlyCompletion).rejects.toThrow("before reviewer presentation finishes");
    expect(readApproval(harness.databaseOptions)).toMatchObject({ status: "pending" });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ applied: true });
  });

  it("accepts an immediately resolved verifier after presentation", async () => {
    let completion: Promise<unknown> | undefined;
    const harness = createHarness(async (attempt) => {
      await attempt.present({ message: "Verify now." });
      completion = runtime!.complete(owner, "agentkit", {
        attemptId: attempt.id,
        outcome: "succeeded",
      });
      await expect(completion).resolves.toMatchObject({ applied: true });
    });
    const owner = harness.owner;

    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(completion).resolves.toMatchObject({ applied: true });
    expect(started).toMatchObject({ outcome: "succeeded", terminalSource: "plugin-completion" });
    expect(readApproval(harness.databaseOptions)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
    });
  });

  it("cancels the canonical approval and aborts the handler on graceful shutdown", async () => {
    let signal: AbortSignal | undefined;
    let owner: object;
    let abortCompletion: ReturnType<typeof completeExternalVerificationForPlugin> | undefined;
    const harness = createHarness(async (attempt) => {
      signal = attempt.signal;
      attempt.signal.addEventListener(
        "abort",
        () => {
          abortCompletion = completeExternalVerificationForPlugin(owner, "agentkit", {
            attemptId: attempt.id,
            outcome: "succeeded",
          });
        },
        { once: true },
      );
      await attempt.present({ message: "Verify now." });
    });
    owner = harness.owner;
    await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    runtime!.shutdown();
    runtime = null;

    expect(signal?.aborted).toBe(true);
    expect(readApproval(harness.databaseOptions)).toMatchObject({
      status: "cancelled",
      terminalReason: "gateway-restart",
    });
    await expect(abortCompletion).resolves.toMatchObject({
      applied: false,
      approval: { status: "cancelled" },
      attempt: { outcome: "cancelled" },
    });
    await expect(harness.decision).resolves.toBeNull();
  });

  it("aborts retry and run-cancelled attempts once and permanently closes presentation", async () => {
    const attempts: PluginExternalVerificationAttempt[] = [];
    const abortCounts = new Map<string, number>();
    const { manager, owner, decision } = createHarness(async (attempt) => {
      attempts.push(attempt);
      abortCounts.set(attempt.id, 0);
      attempt.signal.addEventListener(
        "abort",
        () => abortCounts.set(attempt.id, (abortCounts.get(attempt.id) ?? 0) + 1),
        { once: true },
      );
      await attempt.present({ message: "Verify now." });
    });
    const first = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    const second = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "b".repeat(64),
      present: async () => undefined,
    });

    expect(abortCounts.get(first.id)).toBe(1);
    await expect(attempts[0]?.present({ message: "stale retry output" })).rejects.toThrow(
      "reviewer-retry",
    );
    expect(
      manager.forceDenyDetailed(
        "plugin:runtime-approval",
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      ),
    ).toMatchObject({ outcome: "denied", record: { status: "cancelled" } });
    expect(abortCounts.get(second.id)).toBe(1);
    await expect(attempts[1]?.present({ message: "stale cancelled output" })).rejects.toThrow(
      "run-aborted",
    );
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: second.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({
      applied: false,
      attempt: { outcome: "cancelled", terminalSource: "run-aborted" },
    });
    await expect(decision).resolves.toBeNull();
  });

  it("keeps a winning grant when completion commits before a later run cancellation", async () => {
    const { manager, owner, decision } = createHarness(async (attempt) => {
      await attempt.present({ message: "Verify now." });
    });
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    const completed = await runtime!.complete(owner, "agentkit", {
      attemptId: started.id,
      outcome: "succeeded",
    });

    expect(completed).toMatchObject({
      applied: true,
      approval: { status: "allowed", decision: "allow-always" },
      grantAuthorization: { attemptId: started.id, decision: "allow-always" },
    });
    expect(
      manager.forceDenyDetailed(
        "plugin:runtime-approval",
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      ),
    ).toMatchObject({ outcome: "already-terminal", record: { status: "allowed" } });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).resolves.toEqual({ ...completed, applied: false });
    await expect(decision).resolves.toBe("allow-always");
  });

  it("returns durable grant authorization when post-commit publication fails", async () => {
    const publishResolution = vi.fn(async () => {
      throw new Error("push unavailable");
    });
    const { owner, decision, databaseOptions } = createHarness(
      async (attempt) => {
        await attempt.present({ message: "Verify now." });
      },
      { publishResolution },
    );
    const logError = vi.fn();
    runtime!.attachContext({
      getRuntimeConfig: () => ({}),
      logGateway: { error: logError },
    } as unknown as GatewayRequestContext);
    const started = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });

    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: started.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({
      applied: true,
      approval: { status: "allowed", decision: "allow-always" },
      grantAuthorization: { attemptId: started.id, decision: "allow-always" },
    });
    expect(publishResolution).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("publication failed after durable completion: push unavailable"),
    );
    expect(readApproval(databaseOptions)).toMatchObject({
      status: "allowed",
      decision: "allow-always",
    });
    await expect(decision).resolves.toBe("allow-always");
  });

  it("cancels only run A when concurrent approvals share one session", async () => {
    const attemptsByRun = new Map<string, PluginExternalVerificationAttempt>();
    const { manager, owner, decision } = createHarness(async (attempt) => {
      attemptsByRun.set(attempt.context.runId, attempt);
      await attempt.present({ message: `Verify ${attempt.context.runId}.` });
    });
    const secondRequest: PluginApprovalRequestPayload = {
      pluginId: "agentkit",
      title: "Second World verification",
      description: "Verify personhood before continuing.",
      toolName: "dangerous-tool",
      toolCallId: "call-2",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      runId: "run-2",
      externalResolution: {
        label: "Verify with World",
        decisions: ["allow-once"],
      },
    };
    const secondRecord = manager.create(secondRequest, 60_000, "plugin:runtime-approval-2");
    const secondDecision = manager.register(secondRecord, 60_000);
    const first = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      present: async () => undefined,
    });
    const second = await runtime!.start({
      approvalId: "plugin:runtime-approval-2",
      decision: "allow-once",
      interactionId: "b".repeat(64),
      present: async () => undefined,
    });

    expect(
      manager.forceDenyDetailed(
        "plugin:runtime-approval",
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      ),
    ).toMatchObject({ outcome: "denied" });
    expect(attemptsByRun.get("run-1")?.signal.aborted).toBe(true);
    expect(attemptsByRun.get("run-2")?.signal.aborted).toBe(false);
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: second.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ applied: true, approval: { status: "allowed" } });
    await expect(
      runtime!.complete(owner, "agentkit", {
        attemptId: first.id,
        outcome: "succeeded",
      }),
    ).resolves.toMatchObject({ applied: false, attempt: { outcome: "cancelled" } });
    await expect(decision).resolves.toBeNull();
    await expect(secondDecision).resolves.toBe("allow-once");
  });
});
