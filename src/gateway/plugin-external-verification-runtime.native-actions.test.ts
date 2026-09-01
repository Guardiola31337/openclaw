import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
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

let runtime: PluginExternalVerificationRuntime | null = null;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    runtime?.shutdown();
    runtime = null;
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
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

describe("PluginExternalVerificationRuntime native actions", () => {
  it("issues stable native action generations and rejects stale retry replacement", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: `Verify attempt ${attempt.id}.` });
    });
    createHarness(handler);

    const firstAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    expect(
      runtime!.prepareNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
      }),
    ).toEqual(firstAction);
    expect(firstAction.intent).toBe("start");

    const first = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: firstAction.token,
    });
    const replay = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: firstAction.token,
    });
    expect(replay).toEqual({ ...first, outcome: "replay" });
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:other",
        decision: "allow-once",
        token: firstAction.token,
      }),
    ).rejects.toThrow("external verification action is invalid");
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-always",
        token: firstAction.token,
      }),
    ).rejects.toThrow("external verification action is invalid");

    const retryAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    expect(retryAction.intent).toBe("retry");
    expect(retryAction.token).not.toBe(firstAction.token);

    const newer = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      interactionId: "f".repeat(64),
      present: async () => undefined,
    });
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: firstAction.token,
      }),
    ).resolves.toMatchObject({
      outcome: "stale-action",
      attempt: { id: newer.id },
      presentations: [`Verify attempt ${newer.id}.`],
    });
    const staleRetry = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: retryAction.token,
    });
    expect(staleRetry).toMatchObject({
      outcome: "stale-action",
      attempt: { id: newer.id },
      presentations: [`Verify attempt ${newer.id}.`],
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("binds native action tokens and presentation replay to one reviewer device", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: `Verify attempt ${attempt.id}.` });
    });
    createHarness(handler);

    const deviceAAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      reviewerDeviceId: "device-a",
    });
    expect(
      runtime!.prepareNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-a",
      }),
    ).toEqual(deviceAAction);
    const deviceBAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      reviewerDeviceId: "device-b",
    });
    expect(deviceBAction.token).not.toBe(deviceAAction.token);

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-b",
        token: deviceAAction.token,
      }),
    ).rejects.toThrow("external verification action is invalid");

    const started = await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      reviewerDeviceId: "device-a",
      token: deviceAAction.token,
    });
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-b",
        token: deviceBAction.token,
      }),
    ).resolves.toMatchObject({
      outcome: "stale-action",
      attempt: { id: started.attempt.id },
      presentations: [],
    });
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        reviewerDeviceId: "device-a",
        token: deviceAAction.token,
      }),
    ).resolves.toEqual({ ...started, outcome: "replay" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects a stale weaker native action after a stronger attempt starts", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: `Verify attempt ${attempt.id}.` });
    });
    const { databaseOptions } = createHarness(handler);
    const weakerAction = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    await runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: weakerAction.token,
    });
    const stronger = await runtime!.start({
      approvalId: "plugin:runtime-approval",
      decision: "allow-always",
      interactionId: "f".repeat(64),
      present: async () => undefined,
    });

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: weakerAction.token,
      }),
    ).rejects.toThrow("external verification action is stale; prepare a fresh action");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });
    expect(stronger.context.decision).toBe("allow-always");
  });

  it("coalesces concurrent native dispatches until every presentation is ready", async () => {
    let releaseSetup = () => {};
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let signalFirstPresentation = () => {};
    const firstPresentation = new Promise<void>((resolve) => {
      signalFirstPresentation = resolve;
    });
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "First reviewer instruction." });
      signalFirstPresentation();
      await setupGate;
      await attempt.present({ message: "Second reviewer instruction." });
    });
    createHarness(handler);
    const action = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });

    const firstDispatch = runtime!.dispatchNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
      token: action.token,
    });
    await firstPresentation;
    let replaySettled = false;
    const replayDispatch = runtime!
      .dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: action.token,
      })
      .finally(() => {
        replaySettled = true;
      });
    await Promise.resolve();
    expect(replaySettled).toBe(false);

    releaseSetup();
    const [first, replay] = await Promise.all([firstDispatch, replayDispatch]);
    expect(first).toMatchObject({
      outcome: "started",
      presentations: ["First reviewer instruction.", "Second reviewer instruction."],
    });
    expect(replay).toEqual({ ...first, outcome: "replay" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays a native setup failure without reporting an empty success", async () => {
    let invocation = 0;
    const handler = vi.fn(() => {
      invocation += 1;
      throw new Error(`setup failed ${invocation}`);
    });
    const { databaseOptions } = createHarness(handler);
    const action = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    const dispatch = () =>
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: action.token,
      });

    await expect(dispatch()).rejects.toThrow("setup failed 1");
    await expect(dispatch()).resolves.toMatchObject({
      outcome: "replay",
      presentations: [],
      attempt: {
        outcome: "failed",
        terminalSource: "verifier-error",
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(readApproval(databaseOptions)).toMatchObject({ status: "pending" });

    const retry = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    expect(retry.token).not.toBe(action.token);
    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: retry.token,
      }),
    ).rejects.toThrow("setup failed 2");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("invalidates a prepared native action when the registered verifier instance changes", async () => {
    const handler = vi.fn(async (attempt: PluginExternalVerificationAttempt) => {
      await attempt.present({ message: "Verify this attempt." });
    });
    const { setVerifier } = createHarness(handler);
    const prepared = runtime!.prepareNativeAction({
      approvalId: "plugin:runtime-approval",
      decision: "allow-once",
    });
    setVerifier({
      pluginId: "agentkit",
      pluginName: "Replacement AgentKit",
      owner: {},
      handler,
      source: "/plugins/agentkit/replacement.js",
    });

    await expect(
      runtime!.dispatchNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
        token: prepared.token,
      }),
    ).rejects.toThrow("external verification action is invalid");
    expect(handler).not.toHaveBeenCalled();
    expect(
      runtime!.prepareNativeAction({
        approvalId: "plugin:runtime-approval",
        decision: "allow-once",
      }).token,
    ).not.toBe(prepared.token);
  });
});
