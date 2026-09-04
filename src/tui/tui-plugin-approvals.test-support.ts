// Shared harness and fixtures for the TUI plugin-approval controller tests.
// Imported by tui-plugin-approvals.test.ts and tui-plugin-approvals.external.test.ts
// so each stays within the max-lines budget without duplicating the harness.
import type { Component, OverlayHandle, SelectItem } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { createTuiPluginApprovalController } from "./tui-plugin-approvals.js";

export type TestSelector = Component & {
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex: ReturnType<typeof vi.fn<(index: number) => void>>;
};

export function approvalPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin:skill-1",
    request: {
      title: "Apply workspace skill proposal",
      description: "Apply a pending workspace skill proposal into live workspace skills.",
      pluginId: "workspace-skills",
      severity: "warning",
      toolName: "skill_workshop",
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: "agent:main:main",
    },
    createdAtMs: 1_000,
    expiresAtMs: 6_000,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function createHarness() {
  const selectors: TestSelector[] = [];
  const addSystem = vi.fn();
  const addPendingSystem = vi.fn();
  const dismissPendingSystem = vi.fn(() => true);
  const closeOverlay = vi.fn();
  const overlayHandles: OverlayHandle[] = [];
  const openOverlay = vi.fn((_component: Component) => {
    const handle = {
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: vi.fn(() => true),
    } satisfies OverlayHandle;
    overlayHandles.push(handle);
    return handle;
  });
  const requestRender = vi.fn();
  const resolvePluginApproval = vi.fn().mockResolvedValue({ ok: true });
  const prepareExternalPluginApproval = vi.fn().mockResolvedValue({
    intent: "start",
    actionToken: "action-1",
  });
  const startExternalPluginApproval = vi.fn().mockResolvedValue({
    outcome: "started",
    presentations: ["Scan this challenge"],
  });
  const listPluginApprovals = vi.fn().mockResolvedValue([]);
  const clearTimeoutFn = vi.fn();
  const timers: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
  const setTimeoutFn = vi.fn(() => {
    const timer = { unref: vi.fn() };
    timers.push(timer);
    return timer as unknown as NodeJS.Timeout;
  });
  let agentId = "main";
  let sessionKey = "agent:main:main";
  let now = 1_000;
  const controller = createTuiPluginApprovalController({
    client: {
      listPluginApprovals,
      prepareExternalPluginApproval,
      resolvePluginApproval,
      startExternalPluginApproval,
    },
    chatLog: { addSystem, addPendingSystem, dismissPendingSystem },
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    openOverlay,
    closeOverlay,
    requestRender,
    createSelector: (items) => {
      const selector = {
        items,
        setSelectedIndex: vi.fn<(index: number) => void>(),
        render: () => items.map((item) => item.label),
        handleInput: () => undefined,
        invalidate: () => undefined,
      } satisfies TestSelector;
      selectors.push(selector);
      return selector;
    },
    nowMs: () => now,
    setTimeoutFn,
    clearTimeoutFn,
  });
  return {
    controller,
    selectors,
    addSystem,
    addPendingSystem,
    dismissPendingSystem,
    closeOverlay,
    openOverlay,
    overlayHandles,
    requestRender,
    resolvePluginApproval,
    prepareExternalPluginApproval,
    startExternalPluginApproval,
    listPluginApprovals,
    clearTimeoutFn,
    setTimeoutFn,
    timers,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
