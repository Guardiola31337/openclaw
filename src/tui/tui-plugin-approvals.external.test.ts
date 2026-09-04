// External-verification behavior of the TUI plugin-approval controller.
// Split out of tui-plugin-approvals.test.ts to keep it within max-lines;
// shared harness lives in tui-plugin-approvals.test-support.ts.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { approvalPayload, createHarness, deferred } from "./tui-plugin-approvals.test-support.js";

describe("TUI plugin approvals — external verification", () => {
  it("renders and dispatches canonical external verification choices", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          title: "World proof required for exec",
          description: `Authorize this protected action. ${"context ".repeat(500)}`,
          pluginId: "openclaw-agentkit",
          toolName: "exec",
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once", "allow-always"],
          },
        },
      }),
    );

    const prompt = harness.openOverlay.mock.calls[0]?.[0];
    const promptLines = expectDefined(prompt, "prompt test invariant").render(100);
    const renderedPrompt = stripAnsi(promptLines.join("\n"));
    expect(promptLines.length).toBeLessThanOrEqual(24);
    expect(renderedPrompt).toContain("plugin approval: World proof required for exec");
    expect(renderedPrompt).toContain("Severity: Warning");
    expect(renderedPrompt).toContain("Tool: exec");
    expect(renderedPrompt).toContain("Plugin: openclaw-agentkit");
    expect(renderedPrompt).toContain("Request:");
    expect(renderedPrompt).toContain("Verify with World");
    expect(renderedPrompt).not.toContain("/approve");
    expect(renderedPrompt).toContain("Press Escape to dismiss; the request remains pending.");
    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual([
      "external:allow-once",
      "external:allow-always",
      "deny",
    ]);
    expect(harness.prepareExternalPluginApproval).not.toHaveBeenCalled();

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });

    await vi.waitFor(() => {
      expect(harness.startExternalPluginApproval).toHaveBeenCalledWith(
        "plugin:world-1",
        "allow-once",
        "action-1",
      );
    });
    expect(harness.prepareExternalPluginApproval).toHaveBeenCalledWith(
      "plugin:world-1",
      "allow-once",
    );
    expect(harness.addPendingSystem).toHaveBeenCalledWith(
      "plugin-external-verification:plugin:world-1",
      "Scan this challenge",
    );
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(harness.closeOverlay).toHaveBeenCalledTimes(1);
  });

  it("minimizes an overflowed dispatched challenge on Escape so the chat QR stays reachable", async () => {
    const harness = createHarness();
    // A World-URL QR is taller than the approval card, so the dispatched slim
    // card overflows to the chat presentation. Model that with a tall fenced
    // block that cannot fit the card budget.
    const tallChallenge = ["```", ...Array.from({ length: 40 }, () => "█".repeat(20)), "```"].join(
      "\n",
    );
    harness.startExternalPluginApproval.mockResolvedValue({
      outcome: "started",
      presentations: [tallChallenge],
    });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-overflow",
        request: {
          ...approvalPayload().request,
          title: "World proof required for exec",
          pluginId: "openclaw-agentkit",
          toolName: "exec",
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once", "allow-always"],
          },
        },
      }),
    );
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-always",
      label: "Verify and trust for session",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-always",
      label: "Verify and trust for session",
    });
    // Dispatch re-presents a slim card whose oversized QR spills to chat.
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    const slimPrompt = harness.openOverlay.mock.calls[1]?.[0];
    const slimLines = stripAnsi(
      expectDefined(slimPrompt, "slim prompt test invariant").render(100).join("\n"),
    );
    expect(slimLines).toContain("Full challenge is in chat. Press Escape to scan it.");

    const overlayCallsBeforeEscape = harness.openOverlay.mock.calls.length;
    // Escape on the overflowed dispatched card minimizes: the overlay closes and
    // is NOT re-presented (pre-fix it redrew the same card, trapping the
    // reviewer), so the chat QR becomes scannable. The approval stays pending.
    harness.selectors[harness.selectors.length - 1]?.onCancel?.();
    expect(harness.openOverlay).toHaveBeenCalledTimes(overlayCallsBeforeEscape);
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      expect.stringContaining("scan the QR in chat to verify"),
    );
  });

  it("never exposes generic allow actions for an external approval", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-no-generic-decisions",
        request: {
          ...approvalPayload().request,
          allowedDecisions: undefined,
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual([
      "external:allow-once",
      "deny",
    ]);
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
  });

  it("rejects malformed external verification metadata instead of exposing generic allows", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-invalid-external",
        request: {
          ...approvalPayload().request,
          allowedDecisions: undefined,
          externalResolution: {
            label: "Verify with World",
            decisions: [],
          },
        },
      }),
    );

    expect(harness.openOverlay).not.toHaveBeenCalled();
    expect(harness.selectors).toHaveLength(0);
  });

  it("does not invent denial when an external approval explicitly omits it", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-external-only",
        request: {
          ...approvalPayload().request,
          allowedDecisions: [],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual(["external:allow-once"]);
  });

  it.each([[[]], [["unsupported"]]])(
    "keeps generic approvals actionable when allowedDecisions is %j",
    (allowedDecisions: string[]) => {
      const harness = createHarness();
      harness.controller.handleEvent(
        "plugin.approval.requested",
        approvalPayload({
          request: {
            ...approvalPayload().request,
            allowedDecisions,
          },
        }),
      );

      expect(harness.selectors[0]?.items.map((item) => item.value)).toEqual([
        "allow-once",
        "allow-always",
        "deny",
      ]);
    },
  );

  it("closes the card after a successful dispatch and routes refusal through chat", async () => {
    const harness = createHarness();
    const qrLines = Array.from(
      { length: 200 },
      (_, index) => ` QR row ${index + 1}${index === 0 ? "\u202e" : ""} `,
    );
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "started",
      presentations: [
        [
          "Verify with World",
          "Scan with World App",
          "```text",
          ...qrLines,
          "```",
          "Link: worldapp://verify/example",
        ].join("\n"),
      ],
    });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-qr",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-qr",
        expect.stringContaining("QR row 200"),
      );
    });

    // After dispatch the card re-presents in a slim state: the QR lives in the
    // chat log, and the reviewer keeps a one-keypress Deny plus an explicit
    // fresh-challenge retry. The verify option is withheld so a stray Enter
    // cannot mint a replacement that voids the scanned QR.
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    const slimSelector = harness.selectors[1];
    const slimValues = slimSelector?.items.map((item) => item.value) ?? [];
    expect(slimValues).toEqual(["retry-challenge", "deny"]);
    expect(slimValues).not.toContain("external:allow-once");
    expect(harness.addSystem).toHaveBeenCalledWith(
      expect.stringContaining("scan the QR above, or choose Deny to refuse"),
    );

    // Deny is reachable and resolves the pending approval from the TUI.
    slimSelector?.onSelect?.({ value: "deny", label: "Deny" });
    await vi.waitFor(() => {
      expect(harness.resolvePluginApproval).toHaveBeenCalledWith("plugin:world-qr", "deny");
    });
  });

  it("publishes the full challenge to chat instead of re-rendering it in the card", async () => {
    const harness = createHarness();
    const qrLines = Array.from({ length: 200 }, (_, index) => ` QR row ${index + 1} `);
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "started",
      presentations: [["```text", ...qrLines, "```"].join("\n")],
    });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-qr-only",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-qr-only",
        expect.stringContaining("QR row 200"),
      );
    });

    // The complete challenge lives in the chat log; the slim re-presented card
    // does not render it inline (that would compete with the scanned QR).
    expect(harness.addPendingSystem).toHaveBeenCalledWith(
      "plugin-external-verification:plugin:world-qr-only",
      expect.stringContaining("QR row 1"),
    );
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    const slimPrompt = harness.openOverlay.mock.calls[1]?.[0];
    const slimRendered = stripAnsi(
      expectDefined(slimPrompt, "slim prompt test invariant").render(80).join("\n"),
    );
    // The approval overlay covers the chat, so the slim card keeps the QR on
    // screen (rendered from the chat presentation) with Deny reachable.
    expect(slimRendered).toContain("Deny");
    expect(slimRendered).not.toContain("Verify once");
  });

  it("does not dispatch after the approval resolves during action preparation", async () => {
    const harness = createHarness();
    const pending = deferred<{ intent: "start"; actionToken: string }>();
    harness.prepareExternalPluginApproval.mockReturnValueOnce(pending.promise);
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-resolves-during-prepare",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.controller.handleEvent("plugin.approval.resolved", {
      id: "plugin:world-resolves-during-prepare",
    });

    pending.resolve({ intent: "start", actionToken: "stale-action" });
    await pending.promise;
    await Promise.resolve();
    expect(harness.startExternalPluginApproval).not.toHaveBeenCalled();
  });

  it("discards a verifier challenge when the approval resolves during dispatch", async () => {
    const harness = createHarness();
    const pending = deferred<{ outcome: "started"; presentations: string[] }>();
    harness.startExternalPluginApproval.mockReturnValueOnce(pending.promise);
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-resolves-during-dispatch",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.startExternalPluginApproval).toHaveBeenCalledOnce();
    });
    harness.controller.handleEvent("plugin.approval.resolved", {
      id: "plugin:world-resolves-during-dispatch",
    });
    const renderCountAfterResolution = harness.requestRender.mock.calls.length;

    pending.resolve({ outcome: "started", presentations: ["Stale challenge"] });
    await vi.waitFor(() => {
      expect(harness.requestRender.mock.calls.length).toBeGreaterThan(renderCountAfterResolution);
    });
    expect(harness.addPendingSystem).not.toHaveBeenCalled();
  });

  it.each(["resolved", "disposed"] as const)(
    "suppresses verifier failure after the approval controller is %s",
    async (transition) => {
      const harness = createHarness();
      const pending = deferred<{ outcome: "started"; presentations: string[] }>();
      const id = `plugin:world-fails-after-${transition}`;
      harness.startExternalPluginApproval.mockReturnValueOnce(pending.promise);
      harness.controller.handleEvent(
        "plugin.approval.requested",
        approvalPayload({
          id,
          request: {
            ...approvalPayload().request,
            allowedDecisions: ["deny"],
            externalResolution: {
              label: "Verify with World",
              decisions: ["allow-once"],
            },
          },
        }),
      );

      harness.selectors[0]?.onSelectionChange?.({
        value: "external:allow-once",
        label: "Verify once",
      });
      harness.selectors[0]?.onSelect?.({
        value: "external:allow-once",
        label: "Verify once",
      });
      await vi.waitFor(() => {
        expect(harness.startExternalPluginApproval).toHaveBeenCalledOnce();
      });
      if (transition === "resolved") {
        harness.controller.handleEvent("plugin.approval.resolved", { id });
      } else {
        harness.controller.dispose();
      }

      pending.reject(new Error("late verifier failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.addSystem).not.toHaveBeenCalled();
    },
  );

  it("reopens with a fresh action instead of rendering a stale-action response", async () => {
    const harness = createHarness();
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "stale-action",
      presentations: ["Stale challenge"],
    });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-stale-action",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.selectors).toHaveLength(2);
    });
    expect(harness.addPendingSystem).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval failed: external approval action is stale; retry from the current prompt",
    );
  });

  it("dismisses external verification without denying", () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onCancel?.();

    expect(harness.startExternalPluginApproval).not.toHaveBeenCalled();
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval: dismissed; request remains pending",
    );
  });

  it("reopens external verification with a fresh action after setup failure", async () => {
    const harness = createHarness();
    harness.prepareExternalPluginApproval
      .mockResolvedValueOnce({ intent: "start", actionToken: "action-1" })
      .mockResolvedValueOnce({ intent: "start", actionToken: "action-2" });
    harness.startExternalPluginApproval
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce({
        outcome: "started",
        presentations: ["Scan replacement challenge"],
      });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.selectors).toHaveLength(2);
    });
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval failed: broker unavailable",
    );

    harness.selectors[1]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[1]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.startExternalPluginApproval).toHaveBeenNthCalledWith(
        2,
        "plugin:world-1",
        "allow-once",
        "action-2",
      );
    });
    expect(harness.addPendingSystem).toHaveBeenCalledWith(
      "plugin-external-verification:plugin:world-1",
      "Scan replacement challenge",
    );
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
  });

  it("holds queued approvals while a dispatched ceremony awaits its scan", async () => {
    const harness = createHarness();
    harness.startExternalPluginApproval.mockResolvedValueOnce({
      outcome: "started",
      presentations: ["Scan challenge one"],
    });
    const external = {
      label: "Verify with World",
      decisions: ["allow-once"],
    };
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-first",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: external,
        },
      }),
    );
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-second",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: external,
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-first",
        expect.stringContaining("Scan challenge one"),
      );
    });

    // The first approval re-presents its own slim card after dispatch
    // (openOverlay 2); the second approval stays held behind the live ceremony.
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    expect(harness.selectors[1]?.items.map((item) => item.value)).toEqual([
      "retry-challenge",
      "deny",
    ]);

    harness.controller.handleEvent("plugin.approval.resolved", { id: "plugin:world-first" });
    expect(harness.openOverlay).toHaveBeenCalledTimes(3);
    const secondPrompt = harness.openOverlay.mock.calls[2]?.[0];
    const rendered = stripAnsi(
      expectDefined(secondPrompt, "held prompt test invariant").render(80).join("\n"),
    );
    expect(rendered).toContain("workspace skill approval:");
  });

  it("keeps the card for retry after a failed dispatch and closes it on success", async () => {
    const harness = createHarness();
    harness.prepareExternalPluginApproval
      .mockResolvedValueOnce({ intent: "start", actionToken: "action-1" })
      .mockResolvedValueOnce({ intent: "retry", actionToken: "action-2" });
    harness.startExternalPluginApproval
      .mockRejectedValueOnce(new Error("dispatch unavailable"))
      .mockResolvedValueOnce({
        outcome: "started",
        presentations: ["Fresh challenge after retry"],
      });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    // A failed dispatch keeps deny one keypress away: the card re-presents.
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });
    expect(harness.addSystem).toHaveBeenCalledWith(
      "workspace skill approval failed: dispatch unavailable",
    );

    harness.selectors[1]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[1]?.onSelect?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-1",
        expect.stringContaining("Fresh challenge after retry"),
      );
    });
    // The successful retry dispatch re-presents the slim card (openOverlay 3:
    // full card, retry re-present, post-retry slim card) with Deny reachable.
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(3);
    });
    expect(harness.selectors[2]?.items.map((item) => item.value)).toEqual([
      "retry-challenge",
      "deny",
    ]);
    expect(harness.addSystem).toHaveBeenCalledWith(
      expect.stringContaining("scan the QR above, or choose Deny to refuse"),
    );
  });

  it("re-dispatches a fresh challenge when the reviewer requests one after dispatch", async () => {
    const harness = createHarness();
    harness.startExternalPluginApproval
      .mockResolvedValueOnce({ outcome: "started", presentations: ["First QR"] })
      .mockResolvedValueOnce({ outcome: "started", presentations: ["Second QR"] });
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-retry",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: { label: "Verify with World", decisions: ["allow-once"] },
        },
      }),
    );

    harness.selectors[0]?.onSelectionChange?.({
      value: "external:allow-once",
      label: "Verify once",
    });
    harness.selectors[0]?.onSelect?.({ value: "external:allow-once", label: "Verify once" });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-retry",
        expect.stringContaining("First QR"),
      );
    });
    await vi.waitFor(() => {
      expect(harness.openOverlay).toHaveBeenCalledTimes(2);
    });

    // The slim card offers an explicit fresh-challenge retry; selecting it
    // voids the old QR and dispatches a new one for the same approval.
    harness.selectors[1]?.onSelect?.({
      value: "retry-challenge",
      label: "Request a new challenge",
    });
    await vi.waitFor(() => {
      expect(harness.addPendingSystem).toHaveBeenCalledWith(
        "plugin-external-verification:plugin:world-retry",
        expect.stringContaining("Second QR"),
      );
    });
    expect(harness.startExternalPluginApproval).toHaveBeenCalledTimes(2);
    // Retry preserved the original verify decision (allow-once), not a downgrade.
    expect(harness.startExternalPluginApproval.mock.calls[1]?.[1]).toBe("allow-once");
    expect(harness.resolvePluginApproval).not.toHaveBeenCalled();
  });

  it("keeps explicit denial available for external verification approvals", async () => {
    const harness = createHarness();
    harness.controller.handleEvent(
      "plugin.approval.requested",
      approvalPayload({
        id: "plugin:world-1",
        request: {
          ...approvalPayload().request,
          allowedDecisions: ["deny"],
          externalResolution: {
            label: "Verify with World",
            decisions: ["allow-once"],
          },
        },
      }),
    );

    harness.selectors[0]?.onSelect?.({ value: "deny", label: "Deny" });

    await vi.waitFor(() => {
      expect(harness.resolvePluginApproval).toHaveBeenCalledWith("plugin:world-1", "deny");
    });
    expect(harness.addSystem).toHaveBeenLastCalledWith("workspace skill approval: denied");
  });
});
