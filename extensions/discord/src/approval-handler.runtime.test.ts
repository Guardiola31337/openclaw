import { describe, expect, it } from "vitest";
import { discordApprovalNativeRuntime } from "./approval-handler.runtime.js";

describe("discordApprovalNativeRuntime", () => {
  it("renders command-only plugin approval actions as visible text", async () => {
    const pending = await discordApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "main",
      context: {
        token: "discord-token",
        config: {} as never,
      },
      request: {
        id: "plugin:req-1",
        request: {},
      } as never,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:req-1",
        phase: "pending",
        title: "World proof required",
        description: "Verify with World before the tool runs.",
        metadata: [],
        severity: "warning",
        pluginId: "agentkit",
        toolName: "shell.exec",
        expiresAtMs: 1_000,
        actions: [
          {
            kind: "command",
            label: "Verify with World",
            style: "primary",
            command: "/agentkit approve plugin:req-1 allow-once",
          },
        ],
      },
    });

    expect(JSON.stringify(pending.body)).toContain("/agentkit approve plugin:req-1 allow-once");
  });

  it("routes origin approval updates to the Discord thread channel when threadId is present", async () => {
    const prepared = await discordApprovalNativeRuntime.transport.prepareTarget({
      cfg: {} as never,
      accountId: "main",
      context: {
        token: "discord-token",
        config: {} as never,
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "123456789",
          threadId: "777888999",
        },
      },
      request: {
        id: "req-1",
        request: {
          command: "hostname",
        },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      approvalKind: "exec",
      view: {} as never,
      pendingPayload: {} as never,
    });

    expect(prepared).toEqual({
      dedupeKey: "777888999",
      target: {
        discordChannelId: "777888999",
      },
    });
  });
});
