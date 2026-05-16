import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { isLoopbackIpAddress } from "../shared/net/ip.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { getOperatorApprovalRuntimeToken } from "./operator-approval-runtime-token.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./protocol/client-info.js";

function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

type OperatorGatewayClientFactoryParams = Pick<
  GatewayClientOptions,
  "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk" | "onReconnectPaused"
> & {
  config: OpenClawConfig;
  gatewayUrl?: string;
};

function shouldOmitOperatorApprovalDeviceIdentity(params: {
  url: string;
  token?: string;
  password?: string;
}): boolean {
  return Boolean((params.token || params.password) && isLoopbackGatewayUrl(params.url));
}

async function createOperatorScopedGatewayClient(
  params: OperatorGatewayClientFactoryParams & {
    scope: "operator.admin" | "operator.approvals";
    includeApprovalRuntimeToken?: boolean;
  },
): Promise<GatewayClient> {
  const bootstrap = await resolveGatewayClientBootstrap({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    env: process.env,
  });

  return new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    ...(params.includeApprovalRuntimeToken
      ? { approvalRuntimeToken: getOperatorApprovalRuntimeToken() }
      : {}),
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: params.clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: [params.scope],
    deviceIdentity: shouldOmitOperatorApprovalDeviceIdentity({
      url: bootstrap.url,
      token: bootstrap.auth.token,
      password: bootstrap.auth.password,
    })
      ? null
      : undefined,
    onEvent: params.onEvent,
    onHelloOk: params.onHelloOk,
    onConnectError: params.onConnectError,
    onReconnectPaused: params.onReconnectPaused,
    onClose: params.onClose,
  });
}

export async function createOperatorApprovalsGatewayClient(
  params: OperatorGatewayClientFactoryParams,
): Promise<GatewayClient> {
  return await createOperatorScopedGatewayClient({
    ...params,
    scope: "operator.approvals",
    includeApprovalRuntimeToken: !params.gatewayUrl,
  });
}

async function createOperatorAdminGatewayClient(
  params: OperatorGatewayClientFactoryParams,
): Promise<GatewayClient> {
  return await createOperatorScopedGatewayClient({
    ...params,
    scope: "operator.admin",
  });
}

async function withOperatorScopedGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
  createClient: (params: OperatorGatewayClientFactoryParams) => Promise<GatewayClient>,
  readinessLabel: string,
): Promise<T> {
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady();
  };
  const failReady = (err: unknown) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(err);
  };

  const gatewayClient = await createClient({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: params.clientDisplayName,
    onHelloOk: () => {
      markReady();
    },
    onConnectError: (err) => {
      failReady(err);
    },
    onClose: (code, reason) => {
      failReady(new Error(`gateway closed (${code}): ${reason}`));
    },
  });

  try {
    const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, {
      clientOptions: { preauthHandshakeTimeoutMs: params.config.gateway?.handshakeTimeoutMs },
    });
    if (!readiness.ready) {
      throw new Error(
        readiness.aborted
          ? `gateway ${readinessLabel} client start aborted before readiness`
          : `gateway readiness unavailable before ${readinessLabel} client start`,
      );
    }
    await ready;
    return await run(gatewayClient);
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}

export async function withOperatorApprovalsGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  return await withOperatorScopedGatewayClient(
    params,
    run,
    createOperatorApprovalsGatewayClient,
    "approval",
  );
}

async function withOperatorAdminGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  return await withOperatorScopedGatewayClient(
    params,
    run,
    createOperatorAdminGatewayClient,
    "admin",
  );
}

export type ResolveVerifiedPluginApprovalOverGatewayParams = {
  config: OpenClawConfig;
  gatewayUrl?: string;
  clientDisplayName?: string;
  approvalId: string;
  decision: ExecApprovalDecision;
  pluginId: string;
};

export async function resolveVerifiedPluginApprovalOverGateway(
  params: ResolveVerifiedPluginApprovalOverGatewayParams,
): Promise<void> {
  await withOperatorAdminGatewayClient(
    {
      config: params.config,
      gatewayUrl: params.gatewayUrl,
      clientDisplayName: params.clientDisplayName ?? "Verified plugin approval",
    },
    async (client) => {
      await client.request("plugin.approval.resolveVerified", {
        id: params.approvalId,
        decision: params.decision,
        pluginId: params.pluginId,
      });
    },
  );
}
