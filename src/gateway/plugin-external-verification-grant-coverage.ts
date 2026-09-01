// Session-grant coverage: authorize the pending approvals a freshly minted
// allow-always session grant already covers. Split out of the durable store so
// each module stays within the max-lines budget.
import { createHash, randomUUID } from "node:crypto";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { ensurePluginExternalVerificationSchema } from "../state/openclaw-state-db-schema-additive.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  readExternalResolution,
  type ExternalVerificationDatabase,
} from "./plugin-external-verification-store.js";

/**
 * Resolve pending approvals already covered by a freshly minted session grant.
 *
 * An allow-always ceremony declares trust for "matching actions in this
 * session"; approvals that were pending when it completed (including calls
 * racing the reviewer's scan) are exactly such actions. Each covered approval
 * is authorized with the same row shape a ceremony completion writes, and the
 * attempts ledger records why no per-approval ceremony exists: a synthetic
 * already-ended succeeded attempt with terminal_source "session-grant-covered"
 * whose interaction id is the recomputable sha256 of the covering grant
 * authorization id and the approval id.
 */
export function resolveApprovalsCoveredBySessionGrant(params: {
  grantAuthorizationId: string;
  grantedApprovalId: string;
  pluginId: string;
  toolName: string;
  sessionKey: string;
  sessionId: string;
  runtimeEpoch: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): Array<{ approvalId: string }> {
  return runOpenClawStateWriteTransaction((database) => {
    ensurePluginExternalVerificationSchema(database.db);
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(database.db);
    const candidates = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("kind", "=", "plugin")
        .where("status", "=", "pending")
        .where("runtime_epoch", "=", params.runtimeEpoch)
        .where("expires_at_ms", ">", nowMs)
        .where("approval_id", "!=", params.grantedApprovalId)
        .where("source_tool_name", "=", params.toolName)
        .where("source_session_key", "=", params.sessionKey)
        .where("source_session_id", "=", params.sessionId),
    ).rows;
    const covered: Array<{ approvalId: string }> = [];
    for (const approval of candidates) {
      const external = readExternalResolution(approval);
      // The grant predicate mirrors the plugin's own lookup: owner plugin,
      // tool, and exact session lifecycle. Anything narrower or malformed
      // keeps its own ceremony; a covered action is allowed exactly once.
      if (!external?.decisions.includes("allow-once") || !approval.source_run_id) {
        continue;
      }
      try {
        const presentation: unknown = JSON.parse(approval.presentation_json);
        const ownerPluginId =
          typeof presentation === "object" && presentation !== null && !Array.isArray(presentation)
            ? (presentation as Record<string, unknown>).pluginId // SAFETY: record shape checked on the line above.
            : null;
        if (ownerPluginId !== params.pluginId) {
          continue;
        }
      } catch {
        continue;
      }
      const approvalUpdate = executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("operator_approvals")
          .set({
            status: "allowed",
            decision: "allow-once",
            terminal_reason: "user",
            resolved_at_ms: nowMs,
            resolver_kind: "runtime",
            resolver_id: `plugin:${params.pluginId}`,
            updated_at_ms: nowMs,
          })
          .where("approval_id", "=", approval.approval_id)
          .where("status", "=", "pending")
          .where("runtime_epoch", "=", params.runtimeEpoch)
          .where("expires_at_ms", ">", nowMs),
      );
      if (approvalUpdate.numAffectedRows !== 1n) {
        continue;
      }
      executeSqliteQuerySync(
        database.db,
        stateDb.insertInto("plugin_external_verification_attempts").values({
          attempt_id: `external:${randomUUID()}`,
          approval_id: approval.approval_id,
          plugin_id: params.pluginId,
          run_id: approval.source_run_id,
          tool_name: params.toolName,
          tool_call_id: approval.source_tool_call_id,
          agent_id: approval.source_agent_id,
          session_key: params.sessionKey,
          session_id: params.sessionId,
          interaction_id: createHash("sha256")
            .update(`session-grant-covered:${params.grantAuthorizationId}:${approval.approval_id}`)
            .digest("hex"),
          decision: "allow-once",
          label: external.label,
          created_at_ms: nowMs,
          expires_at_ms: approval.expires_at_ms,
          ended_at_ms: nowMs,
          outcome: "succeeded",
          error_class: null,
          terminal_source: "session-grant-covered",
          completion_applied: 1,
          grant_authorization_id: null,
          grant_issued_at_ms: null,
          resolver_plugin_id: params.pluginId,
          runtime_epoch: params.runtimeEpoch,
        }),
      );
      covered.push({ approvalId: approval.approval_id });
    }
    return covered;
  }, params.databaseOptions);
}
