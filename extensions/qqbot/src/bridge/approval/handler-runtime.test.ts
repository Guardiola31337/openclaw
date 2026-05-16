import { describe, expect, it } from "vitest";
import { qqbotApprovalNativeRuntime } from "./handler-runtime.js";

describe("qqbotApprovalNativeRuntime", () => {
  it("renders command-only plugin approval actions without an empty keyboard", async () => {
    const pending = await qqbotApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "main",
      context: undefined,
      request: {
        id: "plugin:req-1",
        request: {
          title: "World proof required",
          description: "Verify with World before the tool runs.",
          pluginId: "agentkit",
          toolName: "shell.exec",
        },
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

    expect(pending.text).toContain("/agentkit approve plugin:req-1 allow-once");
    expect(pending.keyboard).toBeUndefined();
  });
});
