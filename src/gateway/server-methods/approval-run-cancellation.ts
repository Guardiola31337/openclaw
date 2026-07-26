// Settles run-bound approvals when their active agent run is aborted.
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type {
  ExecApprovalIosPushDelivery,
  PluginApprovalIosPushDelivery,
} from "./approval-publication.js";
import { publishAppliedApprovalResolution } from "./approval-publication.js";
import type { GatewayRequestContext } from "./types.js";

export function cancelRunBoundApprovals(params: {
  runId: string;
  execManager: ExecApprovalManager;
  pluginManager: ExecApprovalManager<PluginApprovalRequestPayload>;
  context: GatewayRequestContext;
  forwarder?: ExecApprovalForwarder;
  execIosPushDelivery?: ExecApprovalIosPushDelivery;
  pluginIosPushDelivery?: PluginApprovalIosPushDelivery;
}): number {
  let cancelled = 0;
  for (const manager of [params.execManager, params.pluginManager] as const) {
    for (const pending of manager.listPendingRecords()) {
      if (pending.request.runId !== params.runId) {
        continue;
      }
      const result = manager.forceDenyDetailed(
        pending.id,
        "run-aborted",
        { kind: "system", id: null },
        "cancelled",
      );
      if (result.outcome !== "denied" || !result.liveRecord) {
        continue;
      }
      cancelled += 1;
      void publishAppliedApprovalResolution({
        record: result.record,
        liveRecord: result.liveRecord,
        context: params.context,
        forwarder: params.forwarder,
        iosPushDelivery: params.execIosPushDelivery,
        pluginIosPushDelivery: params.pluginIosPushDelivery,
      }).catch((error: unknown) => {
        params.context.logGateway?.error?.(
          `${manager.approvalKind} approvals: run-abort publication failed: ${String(error)}`,
        );
      });
    }
  }
  return cancelled;
}
