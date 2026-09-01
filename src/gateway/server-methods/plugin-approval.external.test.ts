// External verification surface of the plugin approval handlers: native
// prepare/start actions, method registration/classification, and param
// validation. Split out of plugin-approval.test.ts to keep that file within
// the max-lines budget; helpers mirror the ones there (same shapes).

import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { isGatewayMethodClassified } from "../method-scopes.js";
import type { PluginExternalVerificationRuntime } from "../plugin-external-verification-runtime.js";
import { listGatewayMethods } from "../server-methods-list.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createManager(testContext: TestContext) {
  return createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
    approvalKind: "plugin",
  });
}

function createLogGatewayMock() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

function createApprovalContext(): GatewayRequestHandlerOptions["context"] {
  return {
    broadcast: vi.fn(),
    logGateway: createLogGatewayMock(),
    hasExecApprovalClients: () => true,
  } as unknown as GatewayRequestHandlerOptions["context"];
}

function createClient(
  params: { deviceId?: string; scopes?: string[] } = {},
): GatewayRequestHandlerOptions["client"] {
  const connect: Record<string, unknown> = {
    client: { id: "test-client", displayName: "Test Client" },
  };
  if (params.deviceId) {
    connect.device = { id: params.deviceId };
  }
  if (params.scopes) {
    connect.scopes = params.scopes;
  }
  return {
    connId: "conn-test-client",
    connect,
  } as unknown as GatewayRequestHandlerOptions["client"];
}

function createMockOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { method, params, id: "req-1" },
    params,
    client: createClient(),
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: createApprovalContext(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

type MockCallSource = { mock: { calls: ArrayLike<ReadonlyArray<unknown>> } };

const requireRecord = createRequireRecord("object", "expected-label");

function mockCall(source: unknown, index: number, label: string) {
  const call = (source as MockCallSource).mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call;
}

function responseCall(source: unknown, index = 0) {
  const call = mockCall(source, index, `response call ${index}`);
  return { ok: call[0], result: call[1], error: call[2] };
}

function responseError(source: unknown, index = 0) {
  return requireRecord(responseCall(source, index).error, `response error ${index}`);
}

function expectResponseRejected(source: unknown, index = 0) {
  expect(responseCall(source, index).ok).toBe(false);
  return responseError(source, index);
}

const externalMethods = [
  "plugin.approval.external.prepare",
  "plugin.approval.external.start",
] as const;

describe("plugin approval external verification handlers", () => {
  let manager: ExecApprovalManager<PluginApprovalRequestPayload>;

  beforeEach((testContext) => {
    manager = createManager(testContext);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists and classifies the external verification methods", () => {
    for (const method of externalMethods) {
      expect(listGatewayMethods()).toContain(method);
      expect(isGatewayMethodClassified(method)).toBe(true);
    }
  });

  it("returns handlers for every plugin approval method", () => {
    const handlers = createPluginApprovalHandlers(manager);
    expect(Object.keys(handlers).toSorted()).toEqual([
      "plugin.approval.external.prepare",
      "plugin.approval.external.start",
      "plugin.approval.list",
      "plugin.approval.request",
      "plugin.approval.resolve",
      "plugin.approval.waitDecision",
    ]);
  });

  describe("native external verification actions", () => {
    it("prepares and starts an action for an authorized paired reviewer", async () => {
      const prepareNativeAction = vi.fn().mockReturnValue({
        intent: "start",
        token: "external-action:test",
      });
      const dispatchNativeAction = vi.fn().mockResolvedValue({
        outcome: "started",
        presentations: ["Scan challenge"],
      });
      const externalVerificationRuntime = {
        prepareNativeAction,
        dispatchNativeAction,
      } as unknown as PluginExternalVerificationRuntime;
      const handlers = createPluginApprovalHandlers(manager, {
        externalVerificationRuntime,
      });
      const client = createClient({
        deviceId: "device-reviewer",
        scopes: ["operator.approvals"],
      });
      const prepareRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.external.prepare"],
        "prepare handler test invariant",
      )(
        createMockOptions(
          "plugin.approval.external.prepare",
          { id: "plugin:approval-1", decision: "allow-once" },
          { client, respond: prepareRespond },
        ),
      );
      expect(prepareRespond).toHaveBeenCalledWith(
        true,
        { intent: "start", actionToken: "external-action:test" },
        undefined,
      );
      expect(prepareNativeAction).toHaveBeenCalledWith({
        approvalId: "plugin:approval-1",
        decision: "allow-once",
        reviewerDeviceId: "device-reviewer",
      });

      const startRespond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.external.start"],
        "start handler test invariant",
      )(
        createMockOptions(
          "plugin.approval.external.start",
          {
            id: "plugin:approval-1",
            decision: "allow-once",
            actionToken: "external-action:test",
          },
          { client, respond: startRespond },
        ),
      );
      expect(startRespond).toHaveBeenCalledWith(
        true,
        { outcome: "started", presentations: ["Scan challenge"] },
        undefined,
      );
      expect(dispatchNativeAction).toHaveBeenCalledWith({
        approvalId: "plugin:approval-1",
        decision: "allow-once",
        reviewerDeviceId: "device-reviewer",
        token: "external-action:test",
      });
    });

    it("rejects a native replay whose verifier attempt already failed", async () => {
      const handlers = createPluginApprovalHandlers(manager, {
        externalVerificationRuntime: {
          dispatchNativeAction: vi.fn().mockResolvedValue({
            outcome: "replay",
            presentations: [],
            attempt: { outcome: "failed" },
          }),
        } as unknown as PluginExternalVerificationRuntime,
      });
      const respond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.external.start"],
        "start handler test invariant",
      )(
        createMockOptions(
          "plugin.approval.external.start",
          {
            id: "plugin:approval-1",
            decision: "allow-once",
            actionToken: "external-action:test",
          },
          {
            client: createClient({
              deviceId: "device-reviewer",
              scopes: ["operator.approvals"],
            }),
            respond,
          },
        ),
      );

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: "external verification attempt failed",
        }),
      );
    });

    it("rejects an approval-scoped client without a paired reviewer device", async () => {
      const prepareNativeAction = vi.fn();
      const handlers = createPluginApprovalHandlers(manager, {
        externalVerificationRuntime: {
          prepareNativeAction,
        } as unknown as PluginExternalVerificationRuntime,
      });
      const respond = vi.fn();
      await expectDefined(
        handlers["plugin.approval.external.prepare"],
        "prepare handler test invariant",
      )(
        createMockOptions(
          "plugin.approval.external.prepare",
          { id: "plugin:approval-1", decision: "allow-once" },
          {
            client: createClient({ scopes: ["operator.approvals"] }),
            respond,
          },
        ),
      );
      expect(responseCall(respond).ok).toBe(false);
      expect(responseError(respond).message).toContain("authorized approval reviewer");
      expect(prepareNativeAction).not.toHaveBeenCalled();
    });
  });

  it.each(externalMethods)("%s rejects invalid params", async (method) => {
    const handlers = createPluginApprovalHandlers(manager);
    const opts = createMockOptions(method, {});
    await expectDefined(handlers[method], "handlers[method] test invariant")(opts);
    expect(responseCall(opts.respond).result).toBeUndefined();
    expect(expectResponseRejected(opts.respond).code).toBeTypeOf("string");
  });
});
