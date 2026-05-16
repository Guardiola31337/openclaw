import { beforeEach, describe, expect, it, vi } from "vitest";

const clientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  startMode: "hello" as "hello" | "close",
  close: { code: 1008, reason: "pairing required" },
  requestSpy: vi.fn(),
  stopSpy: vi.fn(),
  stopAndWaitSpy: vi.fn(async () => undefined),
}));

const bootstrapState = vi.hoisted(() => ({
  url: "ws://127.0.0.1:18789",
  auth: { token: "secret" as string | undefined, password: undefined as string | undefined },
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    clientState.options = opts;
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        if (clientState.startMode === "close") {
          const onClose = this.opts.onClose;
          if (typeof onClose === "function") {
            onClose(clientState.close.code, clientState.close.reason);
          }
          return;
        }
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  async request(method: string, params: unknown): Promise<unknown> {
    return await clientState.requestSpy(method, params);
  }

  stop(): void {
    clientState.stopSpy();
  }

  async stopAndWait(): Promise<void> {
    await clientState.stopAndWaitSpy();
  }
}

vi.mock("./client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: vi.fn(async () => ({
    url: bootstrapState.url,
    auth: bootstrapState.auth,
  })),
}));

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

const { resolveVerifiedPluginApprovalOverGateway, withOperatorApprovalsGatewayClient } =
  await import("./operator-approvals-client.js");

describe("operator approval gateway client helpers", () => {
  beforeEach(() => {
    clientState.options = null;
    clientState.startMode = "hello";
    clientState.close = { code: 1008, reason: "pairing required" };
    clientState.requestSpy.mockReset().mockResolvedValue(undefined);
    clientState.stopSpy.mockReset();
    clientState.stopAndWaitSpy.mockReset().mockResolvedValue(undefined);
    bootstrapState.url = "ws://127.0.0.1:18789";
    bootstrapState.auth = { token: "secret", password: undefined };
  });

  it("waits for hello before running the callback and stops cleanly", async () => {
    await withOperatorApprovalsGatewayClient(
      {
        config: {} as never,
        clientDisplayName: "Matrix approval (@owner:example.org)",
      },
      async (client) => {
        await client.request("exec.approval.resolve", {
          id: "req-123",
          decision: "allow-once",
        });
      },
    );

    expect(clientState.options?.scopes).toEqual(["operator.approvals"]);
    expect(typeof clientState.options?.approvalRuntimeToken).toBe("string");
    expect(clientState.options?.deviceIdentity).toBeNull();
    expect(clientState.requestSpy).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "req-123",
      decision: "allow-once",
    });
    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves verified plugin approvals through a narrow admin-scoped helper", async () => {
    await resolveVerifiedPluginApprovalOverGateway({
      config: {} as never,
      clientDisplayName: "AgentKit proof-backed approval",
      approvalId: "plugin:req-123",
      decision: "allow-once",
      pluginId: "agentkit",
    });

    expect(clientState.options?.scopes).toEqual(["operator.admin"]);
    expect(clientState.options).not.toHaveProperty("approvalRuntimeToken");
    expect(clientState.options?.deviceIdentity).toBeNull();
    expect(clientState.requestSpy).toHaveBeenCalledWith("plugin.approval.resolveVerified", {
      id: "plugin:req-123",
      decision: "allow-once",
      pluginId: "agentkit",
    });
    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps device identity for remote shared-auth approval clients", async () => {
    bootstrapState.url = "wss://gateway.example/ws";

    await withOperatorApprovalsGatewayClient(
      {
        config: {} as never,
        clientDisplayName: "Matrix approval (@owner:example.org)",
      },
      async () => undefined,
    );

    expect(clientState.options).not.toHaveProperty("deviceIdentity", null);
    expect(clientState.options?.deviceIdentity).toBeUndefined();
  });

  it("omits approval runtime token for explicit gateway URL overrides", async () => {
    await withOperatorApprovalsGatewayClient(
      {
        config: {} as never,
        gatewayUrl: "ws://127.0.0.1:18789",
        clientDisplayName: "Matrix approval (@owner:example.org)",
      },
      async () => undefined,
    );

    expect(clientState.options).not.toHaveProperty("approvalRuntimeToken");
  });

  it("keeps device identity for loopback approval clients without shared auth", async () => {
    bootstrapState.auth = { token: undefined, password: undefined };

    await withOperatorApprovalsGatewayClient(
      {
        config: {} as never,
        clientDisplayName: "Matrix approval (@owner:example.org)",
      },
      async () => undefined,
    );

    expect(clientState.options?.deviceIdentity).toBeUndefined();
  });

  it("surfaces close failures before hello", async () => {
    clientState.startMode = "close";

    await expect(
      withOperatorApprovalsGatewayClient(
        {
          config: {} as never,
          clientDisplayName: "Matrix approval (@owner:example.org)",
        },
        async () => undefined,
      ),
    ).rejects.toThrow("gateway closed (1008): pairing required");
  });

  it("falls back to stop when stopAndWait rejects", async () => {
    clientState.stopAndWaitSpy.mockRejectedValueOnce(new Error("close failed"));

    await withOperatorApprovalsGatewayClient(
      {
        config: {} as never,
        clientDisplayName: "Matrix approval (@owner:example.org)",
      },
      async () => undefined,
    );

    expect(clientState.stopAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(clientState.stopSpy).toHaveBeenCalledTimes(1);
  });
});
