// Presents plugin approvals that belong to the active TUI session.
import {
  SelectList,
  type Component,
  type OverlayHandle,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { isApprovalStaleError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createTuiRefreshCoalescer } from "./coalesced-refresh.js";
import { selectListTheme } from "./theme/theme.js";
import type {
  TuiApprovalDecision,
  TuiBackend,
  TuiExternalApprovalDecision,
  TuiPluginApproval,
} from "./tui-backend.js";
import { PluginApprovalPrompt, type ApprovalSelector } from "./tui-plugin-approval-prompt.js";
import { matchesOwnedTuiSession } from "./tui-session-events.js";

type ApprovalTimer = number | NodeJS.Timeout;
type ApprovalMutation = {
  version: number;
  approval: TuiPluginApproval | null;
};

type TuiPluginApprovalControllerDeps = {
  client: Pick<
    TuiBackend,
    | "listPluginApprovals"
    | "prepareExternalPluginApproval"
    | "resolvePluginApproval"
    | "startExternalPluginApproval"
  >;
  chatLog: {
    addSystem: (line: string) => void;
    addPendingSystem: (id: string, line: string) => void;
    dismissPendingSystem: (id: string) => boolean;
  };
  getAgentId: () => string;
  getSessionKey: () => string;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  requestRender: () => void;
  createSelector?: (items: SelectItem[]) => ApprovalSelector;
  nowMs?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ApprovalTimer;
  clearTimeoutFn?: (timer: ApprovalTimer) => void;
};

const DEFAULT_DECISIONS: readonly TuiApprovalDecision[] = ["allow-once", "allow-always", "deny"];
const EXTERNAL_SELECTION_PREFIX = "external:";

const DECISION_ITEMS: Record<TuiApprovalDecision, SelectItem> = {
  "allow-once": {
    value: "allow-once",
    label: "Allow once",
    description: "Approve this change",
  },
  "allow-always": {
    value: "allow-always",
    label: "Always allow",
    description: "Approve matching future changes",
  },
  deny: {
    value: "deny",
    label: "Deny",
    description: "Do not apply this change",
  },
};

const RETRY_CHALLENGE_SELECTION = "retry-challenge";
const RETRY_CHALLENGE_ITEM: SelectItem = {
  value: RETRY_CHALLENGE_SELECTION,
  label: "Request a new challenge",
  description: "Void the current QR and start a fresh verification",
};

const EXTERNAL_DECISION_ITEMS: Record<TuiExternalApprovalDecision, SelectItem> = {
  "allow-once": {
    value: `${EXTERNAL_SELECTION_PREFIX}allow-once`,
    label: "Verify once",
    description: "Verify this blocked action",
  },
  "allow-always": {
    value: `${EXTERNAL_SELECTION_PREFIX}allow-always`,
    label: "Verify and trust for session",
    description: "Verify and trust matching actions in this session",
  },
};

function parseDecision(value: unknown): TuiApprovalDecision | null {
  return value === "allow-once" || value === "allow-always" || value === "deny" ? value : null;
}

function parseExternalDecision(value: unknown): TuiExternalApprovalDecision | null {
  if (typeof value !== "string" || !value.startsWith(EXTERNAL_SELECTION_PREFIX)) {
    return null;
  }
  const decision = value.slice(EXTERNAL_SELECTION_PREFIX.length);
  return decision === "allow-once" || decision === "allow-always" ? decision : null;
}

function parseAllowedDecisions(value: unknown): TuiApprovalDecision[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const decisions: TuiApprovalDecision[] = [];
  for (const candidate of value) {
    const decision = parseDecision(candidate);
    if (decision && !decisions.includes(decision)) {
      decisions.push(decision);
    }
  }
  return decisions;
}

function parseExternalResolution(
  value: unknown,
): TuiPluginApproval["request"]["externalResolution"] {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return null;
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label || !Array.isArray(record.decisions)) {
    return null;
  }
  const decisions: TuiExternalApprovalDecision[] = [];
  for (const candidate of record.decisions) {
    if (
      (candidate === "allow-once" || candidate === "allow-always") &&
      !decisions.includes(candidate)
    ) {
      decisions.push(candidate);
    }
  }
  return decisions.length > 0 ? { label, decisions } : null;
}

function parseSeverity(value: unknown): TuiPluginApproval["request"]["severity"] {
  return value === "info" || value === "warning" || value === "critical" ? value : null;
}

/** Parses the gateway event/list shape used for pending plugin approvals. */
function parseTuiPluginApproval(payload: unknown): TuiPluginApproval | null {
  const record = asOptionalObjectRecord(payload);
  const request = asOptionalObjectRecord(record?.request);
  if (!record || !request) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const title = typeof request.title === "string" ? request.title.trim() : "";
  const createdAtMs = typeof record.createdAtMs === "number" ? record.createdAtMs : 0;
  const expiresAtMs = typeof record.expiresAtMs === "number" ? record.expiresAtMs : 0;
  if (!id || !title || !createdAtMs || !expiresAtMs) {
    return null;
  }
  const rawExternalResolution = request.externalResolution;
  const externalResolution = parseExternalResolution(rawExternalResolution);
  if (rawExternalResolution != null && !externalResolution) {
    return null;
  }
  return {
    id,
    request: {
      title,
      description: typeof request.description === "string" ? request.description : null,
      pluginId: typeof request.pluginId === "string" ? request.pluginId : null,
      severity: parseSeverity(request.severity),
      toolName: typeof request.toolName === "string" ? request.toolName : null,
      allowedDecisions: parseAllowedDecisions(request.allowedDecisions),
      externalResolution,
      agentId: typeof request.agentId === "string" ? request.agentId : null,
      sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

function parseResolvedApprovalId(payload: unknown): string | null {
  const id = asOptionalObjectRecord(payload)?.id;
  if (typeof id !== "string") {
    return null;
  }
  return id.trim() || null;
}

function decisionLabel(decision: TuiApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "always allowed";
  }
  return "denied";
}

function approvalSurfaceLabel(approval: TuiPluginApproval): string {
  return approval.request.toolName === "skill_workshop"
    ? "workspace skill approval"
    : "plugin approval";
}

/** Coordinates pending plugin approval events with the active TUI overlay. */
export function createTuiPluginApprovalController(deps: TuiPluginApprovalControllerDeps) {
  const createSelector =
    deps.createSelector ??
    ((items: SelectItem[]) => new SelectList(items, items.length, selectListTheme));
  const nowMs = deps.nowMs ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let queue: TuiPluginApproval[] = [];
  let activeId: string | null = null;
  let activeOverlay: OverlayHandle | null = null;
  let expiryTimer: ApprovalTimer | null = null;
  let disposed = false;
  let mutationVersion = 0;
  const refreshRunner = createTuiRefreshCoalescer(async () => await refreshOnce());
  const mutations = new Map<string, ApprovalMutation>();
  const resolvingIds = new Set<string>();
  const dismissedIds = new Set<string>();
  // Approvals whose external challenge is dispatched and awaiting a scan. They
  // re-present a slim Deny + retry control (allow options removed so a stray
  // Enter cannot mint a replacement), keeping refusal one keypress away.
  const challengeDispatchedIds = new Set<string>();
  // A dispatched challenge whose QR is too tall for the overlay renders in the
  // chat instead. Minimizing closes the covering overlay so the reviewer can
  // see and scan it; the approval stays pending (held, fail-closed) until the
  // scan resolves it, and presentNext holds every other approval behind it.
  const minimizedChallengeIds = new Set<string>();
  const lastExternalDecision = new Map<string, TuiExternalApprovalDecision>();
  const externalPresentations = new Map<string, string[]>();
  const externalPresentationId = (approvalId: string) =>
    `plugin-external-verification:${approvalId}`;

  const clearExpiryTimer = () => {
    if (expiryTimer !== null) {
      clearTimeoutFn(expiryTimer);
      expiryTimer = null;
    }
  };

  const closeActiveOverlay = () => {
    const handle = activeOverlay;
    activeOverlay = null;
    if (handle) {
      deps.closeOverlay(handle);
    }
  };

  const recordMutation = (id: string, approval: TuiPluginApproval | null) => {
    if (!refreshRunner.isRunning()) {
      return;
    }
    mutationVersion += 1;
    mutations.set(id, { version: mutationVersion, approval });
  };

  const clearExternalPresentation = (id: string) => {
    externalPresentations.delete(id);
    deps.chatLog.dismissPendingSystem(externalPresentationId(id));
  };

  const remove = (id: string, record = true) => {
    queue = queue.filter((approval) => approval.id !== id);
    dismissedIds.delete(id);
    challengeDispatchedIds.delete(id);
    minimizedChallengeIds.delete(id);
    lastExternalDecision.delete(id);
    clearExternalPresentation(id);
    if (record) {
      recordMutation(id, null);
    }
  };

  const add = (approval: TuiPluginApproval, record = true) => {
    queue = queue.filter((entry) => entry.id !== approval.id);
    queue.push(approval);
    queue.sort((left, right) => left.createdAtMs - right.createdAtMs);
    if (record) {
      recordMutation(approval.id, approval);
    }
  };

  const matchesActiveSession = (approval: TuiPluginApproval) =>
    matchesOwnedTuiSession(deps.getSessionKey(), deps.getAgentId(), approval.request);

  const prune = () => {
    const now = nowMs();
    for (const approval of queue.filter((entry) => entry.expiresAtMs <= now)) {
      remove(approval.id);
    }
  };

  const presentNext = () => {
    if (disposed || activeId) {
      return;
    }
    prune();
    // One ceremony at a time. A dispatched challenge re-presents its own slim
    // Deny + retry card; every other approval is held behind it and stays
    // pending (fail-closed) until the live challenge resolves.
    const dispatchedPending = queue.find(
      (candidate) =>
        challengeDispatchedIds.has(candidate.id) &&
        !resolvingIds.has(candidate.id) &&
        !minimizedChallengeIds.has(candidate.id) &&
        matchesActiveSession(candidate),
    );
    const approval =
      dispatchedPending ??
      (queue.some((candidate) => challengeDispatchedIds.has(candidate.id))
        ? undefined
        : queue.find(
            (candidate) =>
              !resolvingIds.has(candidate.id) &&
              !dismissedIds.has(candidate.id) &&
              matchesActiveSession(candidate),
          ));
    if (!approval) {
      return;
    }
    activeId = approval.id;
    const surfaceLabel = approvalSurfaceLabel(approval);
    const pendingSessionApprovals = queue.filter((candidate) =>
      matchesActiveSession(candidate),
    ).length;

    const externalDecisions = approval.request.externalResolution?.decisions ?? [];
    const decisions = approval.request.externalResolution
      ? approval.request.allowedDecisions == null
        ? (["deny"] as const)
        : approval.request.allowedDecisions.filter((decision) => decision === "deny")
      : approval.request.allowedDecisions?.length
        ? approval.request.allowedDecisions
        : DEFAULT_DECISIONS;
    const canDispatchExternal = Boolean(
      deps.client.prepareExternalPluginApproval && deps.client.startExternalPluginApproval,
    );
    const challengeDispatched = challengeDispatchedIds.has(approval.id);
    // After dispatch the verify options are withheld (re-selecting them would
    // mint a replacement challenge and void the QR being scanned); the reviewer
    // keeps a one-keypress Deny plus an explicit fresh-challenge retry.
    const items = challengeDispatched
      ? [
          ...(canDispatchExternal && externalDecisions.length > 0 ? [RETRY_CHALLENGE_ITEM] : []),
          ...decisions.map((decision) => DECISION_ITEMS[decision]),
        ]
      : [
          ...(canDispatchExternal
            ? externalDecisions.map((decision) => EXTERNAL_DECISION_ITEMS[decision])
            : []),
          ...decisions.map((decision) => DECISION_ITEMS[decision]),
        ];
    const selector = createSelector(items);
    let allowDecisionArmed = false;
    let prompt: PluginApprovalPrompt | null = null;
    const denyIndex = items.findIndex((item) => item.value === "deny");
    let selectedValue = items[Math.max(denyIndex, 0)]?.value;
    if (denyIndex >= 0) {
      selector.setSelectedIndex?.(denyIndex);
    }
    selector.onSelectionChange = (item) => {
      const decision = parseDecision(item.value) ?? parseExternalDecision(item.value);
      if (!decision || item.value === selectedValue) {
        return;
      }
      selectedValue = item.value;
      allowDecisionArmed = decision !== "deny";
      prompt?.setConfirmation("");
    };

    const resolve = async (decision: TuiApprovalDecision) => {
      if (activeId !== approval.id) {
        return;
      }
      clearExpiryTimer();
      activeId = null;
      resolvingIds.add(approval.id);
      closeActiveOverlay();
      deps.requestRender();
      let stale = false;
      try {
        if (!deps.client.resolvePluginApproval) {
          throw new Error("plugin approval resolution is unavailable");
        }
        const result = await deps.client.resolvePluginApproval(approval.id, decision);
        if (result?.ok === false) {
          stale = true;
        } else {
          remove(approval.id);
          deps.chatLog.addSystem(`${surfaceLabel}: ${decisionLabel(decision)}`);
        }
      } catch (error) {
        if (isApprovalStaleError(error)) {
          stale = true;
        } else {
          deps.chatLog.addSystem(`${surfaceLabel} failed: ${formatErrorMessage(error)}`);
        }
      }
      if (stale) {
        remove(approval.id);
        deps.chatLog.addSystem(`${surfaceLabel}: no longer pending`);
        try {
          await refreshApprovals();
        } catch (error) {
          deps.chatLog.addSystem(`${surfaceLabel} refresh failed: ${formatErrorMessage(error)}`);
        }
      }
      resolvingIds.delete(approval.id);
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    const dispatchExternal = async (decision: TuiExternalApprovalDecision) => {
      if (activeId !== approval.id) {
        return;
      }
      clearExpiryTimer();
      activeId = null;
      resolvingIds.add(approval.id);
      closeActiveOverlay();
      clearExternalPresentation(approval.id);
      deps.requestRender();
      try {
        if (!deps.client.prepareExternalPluginApproval) {
          throw new Error("external approval action preparation is unavailable");
        }
        const prepared = await deps.client.prepareExternalPluginApproval(approval.id, decision);
        if (disposed || !queue.some((candidate) => candidate.id === approval.id)) {
          resolvingIds.delete(approval.id);
          return;
        }
        if (!deps.client.startExternalPluginApproval) {
          throw new Error("external approval action dispatch is unavailable");
        }
        const result = await deps.client.startExternalPluginApproval(
          approval.id,
          decision,
          prepared.actionToken,
        );
        if (result.outcome === "stale-action") {
          throw new Error("external approval action is stale; retry from the current prompt");
        }
        if (
          result.presentations.length > 0 &&
          queue.some((candidate) => candidate.id === approval.id)
        ) {
          externalPresentations.set(approval.id, result.presentations);
          deps.chatLog.addPendingSystem(
            externalPresentationId(approval.id),
            result.presentations.join("\n\n"),
          );
        }
        // A successful dispatch re-presents a slim Deny + retry card (built
        // above): the QR lives in the chat log and stays scannable, while
        // refusal is one keypress and a fresh challenge is an explicit choice.
        challengeDispatchedIds.add(approval.id);
        lastExternalDecision.set(approval.id, decision);
        activeId = null;
        closeActiveOverlay();
        deps.chatLog.addSystem(
          `${surfaceLabel}: challenge sent — scan the QR above, or choose Deny to refuse.`,
        );
      } catch (error) {
        if (!disposed && queue.some((candidate) => candidate.id === approval.id)) {
          deps.chatLog.addSystem(`${surfaceLabel} failed: ${formatErrorMessage(error)}`);
        }
      }
      resolvingIds.delete(approval.id);
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    selector.onSelect = (item) => {
      if (item.value === RETRY_CHALLENGE_SELECTION) {
        // Explicit retry: void the stale QR, then re-dispatch the same verify
        // decision as a fresh challenge.
        const retryDecision = lastExternalDecision.get(approval.id);
        if (!retryDecision) {
          return;
        }
        challengeDispatchedIds.delete(approval.id);
        clearExternalPresentation(approval.id);
        void dispatchExternal(retryDecision);
        return;
      }
      const externalDecision = parseExternalDecision(item.value);
      const decision = parseDecision(item.value) ?? externalDecision;
      if (!decision) {
        return;
      }
      if (decision !== "deny" && !allowDecisionArmed) {
        allowDecisionArmed = true;
        prompt?.setConfirmation(`Press Enter again to confirm ${item.label}.`);
        deps.requestRender();
        return;
      }
      if (externalDecision) {
        void dispatchExternal(externalDecision);
        return;
      }
      void resolve(decision);
    };
    const dismiss = () => {
      clearExpiryTimer();
      dismissedIds.add(approval.id);
      activeId = null;
      closeActiveOverlay();
      deps.chatLog.addSystem(`${surfaceLabel}: dismissed; request remains pending`);
      presentNext();
      deps.requestRender();
    };
    // A dispatched challenge whose QR spilled to chat cannot be scanned while the
    // overlay covers it. Minimizing closes the overlay and holds the approval
    // (fail-closed) so the reviewer can scan the chat QR; the scan resolves it.
    const minimizeChallenge = () => {
      minimizedChallengeIds.add(approval.id);
      clearExpiryTimer();
      activeId = null;
      closeActiveOverlay();
      deps.chatLog.addSystem(
        `${surfaceLabel}: scan the QR in chat to verify — the request stays pending.`,
      );
      presentNext();
      deps.requestRender();
    };
    selector.onCancel = () => {
      if (approval.request.externalResolution) {
        // Overflowed challenge: minimize so the chat QR is reachable. A QR that
        // fit inline keeps its slim card so Deny stays one keypress away.
        if (challengeDispatched && prompt?.challengeOverflowed) {
          minimizeChallenge();
          return;
        }
        dismiss();
        return;
      }
      const deny = decisions.includes("deny") ? "deny" : null;
      if (deny) {
        void resolve(deny);
        return;
      }
      dismiss();
    };
    const timer = setTimeoutFn(
      () => {
        if (activeId !== approval.id) {
          return;
        }
        expiryTimer = null;
        activeId = null;
        remove(approval.id);
        closeActiveOverlay();
        deps.chatLog.addSystem(`${surfaceLabel}: expired`);
        presentNext();
        deps.requestRender();
      },
      Math.max(1, approval.expiresAtMs - nowMs()),
    );
    expiryTimer = timer;
    if (typeof timer !== "number") {
      timer.unref?.();
    }
    prompt = new PluginApprovalPrompt(
      surfaceLabel,
      approval,
      selector,
      // The approval overlay covers the chat, so the challenge renders inline
      // in the card — including the dispatched slim card, so the QR stays
      // on screen with Deny and retry one keypress away.
      externalPresentations.get(approval.id),
      pendingSessionApprovals,
    );
    activeOverlay = deps.openOverlay(prompt);
    deps.requestRender();
  };

  const applySnapshot = (approvals: TuiPluginApproval[], startedAtVersion: number) => {
    const next = new Map(approvals.map((approval) => [approval.id, approval]));
    for (const [id, mutation] of mutations) {
      if (mutation.version <= startedAtVersion) {
        mutations.delete(id);
        continue;
      }
      if (mutation.approval) {
        next.set(id, mutation.approval);
      } else {
        next.delete(id);
      }
    }
    for (const id of dismissedIds) {
      if (!next.has(id)) {
        dismissedIds.delete(id);
      }
    }
    queue = [...next.values()].toSorted((left, right) => left.createdAtMs - right.createdAtMs);
  };

  async function refreshOnce(): Promise<void> {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    const startedAtVersion = mutationVersion;
    const payload = await deps.client.listPluginApprovals();
    if (disposed || !Array.isArray(payload)) {
      return;
    }
    const approvals: TuiPluginApproval[] = [];
    for (const entry of payload) {
      const approval = parseTuiPluginApproval(entry);
      if (approval) {
        approvals.push(approval);
      }
    }
    applySnapshot(approvals, startedAtVersion);
    if (activeId && !queue.some((approval) => approval.id === activeId)) {
      clearExpiryTimer();
      activeId = null;
      closeActiveOverlay();
    }
    presentNext();
    deps.requestRender();
  }

  const refreshApprovals = async (): Promise<void> => {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    await refreshRunner.run();
  };

  return {
    handleEvent(event: string, payload: unknown) {
      if (disposed) {
        return;
      }
      if (event === "plugin.approval.requested") {
        const approval = parseTuiPluginApproval(payload);
        if (approval) {
          add(approval);
          presentNext();
        }
        return;
      }
      if (event !== "plugin.approval.resolved" && event !== "plugin.approval.removed") {
        return;
      }
      const id = parseResolvedApprovalId(payload);
      if (!id) {
        return;
      }
      remove(id);
      resolvingIds.delete(id);
      if (activeId === id) {
        clearExpiryTimer();
        activeId = null;
        closeActiveOverlay();
      }
      presentNext();
      deps.requestRender();
    },
    refresh: refreshApprovals,
    sessionChanged() {
      if (disposed) {
        return;
      }
      const activeApproval = activeId
        ? queue.find((approval) => approval.id === activeId)
        : undefined;
      if (activeApproval && !matchesActiveSession(activeApproval)) {
        clearExpiryTimer();
        activeId = null;
        closeActiveOverlay();
        deps.requestRender();
      }
      presentNext();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearExpiryTimer();
      queue = [];
      dismissedIds.clear();
      for (const id of externalPresentations.keys()) {
        deps.chatLog.dismissPendingSystem(externalPresentationId(id));
      }
      externalPresentations.clear();
      mutations.clear();
      resolvingIds.clear();
      if (activeId) {
        activeId = null;
        closeActiveOverlay();
        deps.requestRender();
      }
    },
  };
}
