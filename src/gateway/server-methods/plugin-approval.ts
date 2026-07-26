// Gateway RPC handlers for plugin approval requests and decisions.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../../infra/plugin-approval-canonical-decisions.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import {
  normalizePluginExternalResolution,
  resolvePluginApprovalTimeoutMs,
} from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import { runApprovalRequestDeliveries } from "./approval-request-delivery.js";
import {
  bindApprovalRequesterMetadata,
  bindApprovalReviewerDeviceIds,
  buildRequestedApprovalEvent,
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  listVisiblePendingApprovalRequests,
  registerPendingApprovalRecord,
  resolveApprovalDecisionParams,
} from "./approval-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

type PluginApprovalIosPushDelivery = {
  handleRequested?: (
    request: PluginApprovalRequest,
    opts?: {
      isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
    },
  ) => Promise<boolean>;
  handleResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
  handleExpired?: (request: PluginApprovalRequest) => Promise<void>;
};

/** Create plugin approval handlers backed by the shared approval manager. */
export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: { forwarder?: ExecApprovalForwarder; iosPushDelivery?: PluginApprovalIosPushDelivery },
): GatewayRequestHandlers {
  return {
    "plugin.approval.list": async ({ respond, client }) => {
      respond(true, listVisiblePendingApprovalRequests({ manager, client }), undefined);
    },
    "plugin.approval.request": async ({ params, client, respond, context }) => {
      const internalRequest =
        client?.internal?.approvalRuntime === true &&
        typeof params === "object" &&
        params !== null &&
        !Array.isArray(params);
      const rawParams = internalRequest ? (params as Record<string, unknown>) : null;
      const publicParams = rawParams
        ? Object.fromEntries(
            Object.entries(rawParams).filter(
              ([key]) => key !== "externalResolution" && key !== "runId" && key !== "sessionId",
            ),
          )
        : params;
      if (!validatePluginApprovalRequestParams(publicParams)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.request params: ${formatValidationErrors(
              validatePluginApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = publicParams as {
        pluginId?: string | null;
        title: string;
        description: string;
        detail?: string | null;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        allowedDecisions?: string[] | null;
        agentId?: string | null;
        sessionKey?: string | null;
        approvalReviewerDeviceIds?: string[];
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      let externalResolution: PluginApprovalRequestPayload["externalResolution"];
      try {
        externalResolution = internalRequest
          ? normalizePluginExternalResolution(
              rawParams?.externalResolution as PluginApprovalRequestPayload["externalResolution"],
            )
          : null;
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid external verification: ${String(error)}`),
        );
        return;
      }
      const runId = internalRequest
        ? normalizeOptionalString(rawParams?.runId as string | undefined)
        : null;
      const pluginId = normalizeOptionalString(p.pluginId ?? undefined);
      const toolName = normalizeOptionalString(p.toolName ?? undefined);
      if (externalResolution && !runId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "external verification requires a host-derived run id",
          ),
        );
        return;
      }
      if (externalResolution && (!pluginId || !toolName)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "external verification requires host-derived plugin and tool ownership",
          ),
        );
        return;
      }
      if (
        externalResolution &&
        p.allowedDecisions?.some(
          (decision) => decision === "allow-once" || decision === "allow-always",
        )
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "generic and external allow decisions cannot overlap",
          ),
        );
        return;
      }
      const twoPhase = p.twoPhase === true;
      const timeoutMs = resolvePluginApprovalTimeoutMs(p.timeoutMs);

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;

      const request: PluginApprovalRequestPayload = {
        pluginId: pluginId ?? null,
        title: p.title,
        description: p.description,
        detail: normalizeTrimmedString(p.detail),
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        toolName: toolName ?? null,
        toolCallId: p.toolCallId ?? null,
        ...(externalResolution ? { externalResolution } : {}),
        ...(Array.isArray(p.allowedDecisions)
          ? {
              allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions({
                allowedDecisions: p.allowedDecisions,
                externalResolution,
              }),
            }
          : {}),
        agentId: p.agentId ?? null,
        sessionKey: p.sessionKey ?? null,
        sessionId: internalRequest
          ? normalizeOptionalString(rawParams?.sessionId as string | undefined)
          : null,
        runId,
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
      };

      // The abort owner records its tombstone before sweeping approvals. Keep
      // this check adjacent to creation so an already-aborted run cannot park.
      if (runId && context.chatRunState.hasAbortMarker(runId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval run already aborted", {
            details: { reason: "PLUGIN_APPROVAL_RUN_ABORTED" },
          }),
        );
        return;
      }

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      bindApprovalRequesterMetadata({ record, client });
      if (client?.internal?.approvalRuntime === true) {
        bindApprovalReviewerDeviceIds({
          record,
          deviceIds: p.approvalReviewerDeviceIds,
        });
      }

      const decisionPromise = registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs,
        respond,
        context,
      });
      if (!decisionPromise) {
        return;
      }

      const requestEvent = buildRequestedApprovalEvent(record);
      const forwardRequest = opts?.forwarder?.handlePluginApprovalRequested?.bind(opts.forwarder);
      const iosPushRequest = opts?.iosPushDelivery?.handleRequested?.bind(opts.iosPushDelivery);

      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context,
        clientConnId: client?.connId,
        requestEventName: "plugin.approval.requested",
        requestEvent,
        twoPhase,
        approvalKind: "plugin",
        deliverRequest: () =>
          runApprovalRequestDeliveries({
            context,
            record,
            forward: forwardRequest
              ? [() => forwardRequest(requestEvent), "plugin approvals: forward request failed"]
              : undefined,
            iosPush: iosPushRequest
              ? [
                  (isTargetVisible) => iosPushRequest(requestEvent, { isTargetVisible }),
                  "plugin approvals: iOS push request failed",
                ]
              : undefined,
          }),
        afterDecision: async (decision) => {
          if (decision === null) {
            await opts?.iosPushDelivery?.handleExpired?.(requestEvent);
          }
        },
        afterDecisionErrorLabel: "plugin approvals: iOS push expire failed",
      });
    },

    "plugin.approval.waitDecision": async ({ params, respond, client }) => {
      await handleApprovalWaitDecision({
        manager,
        inputId: (params as { id?: string }).id,
        client,
        respond,
      });
    },

    "plugin.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validatePluginApprovalResolveParams,
        methodName: "plugin.approval.resolve",
        respond,
      });
      if (!resolveParams) {
        return;
      }
      const { inputId, decision } = resolveParams;
      await handleApprovalResolve({
        approvalKind: "plugin",
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        exposeAmbiguousPrefixError: false,
        validateDecision: (snapshot) =>
          resolveCanonicalPluginApprovalRequestAllowedDecisions(snapshot.request).includes(decision)
            ? null
            : {
                message: `${decision} is unavailable for this plugin approval`,
                details: {
                  allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions(
                    snapshot.request,
                  ),
                },
              },
        resolvedEventName: "plugin.approval.resolved",
        buildResolvedEvent: ({
          approvalId,
          decision: decisionLocal,
          resolvedBy,
          snapshot,
          nowMs,
        }) =>
          ({
            id: approvalId,
            decision: decisionLocal,
            resolvedBy,
            ts: nowMs,
            request: snapshot.request,
          }) satisfies PluginApprovalResolved,
        forwardResolved: (resolvedEvent) =>
          opts?.forwarder?.handlePluginApprovalResolved?.(resolvedEvent),
        forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
        extraResolvedHandlers: opts?.iosPushDelivery?.handleResolved
          ? [
              {
                run: (resolvedEvent) => opts.iosPushDelivery!.handleResolved!(resolvedEvent),
                errorLabel: "plugin approvals: iOS push resolve failed",
              },
            ]
          : undefined,
      });
    },
  };
}
