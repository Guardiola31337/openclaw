// Presents plugin approvals that belong to the active TUI session.
import {
  SelectList,
  Text,
  type Component,
  type OverlayHandle,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { isApprovalStaleError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import { selectListTheme, theme } from "./theme/theme.js";
import type {
  TuiApprovalDecision,
  TuiBackend,
  TuiExternalApprovalDecision,
  TuiPluginApproval,
  TuiPreparedExternalApprovalAction,
} from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";

type ApprovalSelector = Component & {
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  setSelectedIndex?: (index: number) => void;
};

const APPROVAL_BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const FENCED_PRESENTATION_RE = /(?:^|\n)(```|~~~)[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/g;
const MAX_COMPACT_PRESENTATION_CHARS = 480;
const MAX_APPROVAL_PROMPT_ROWS = 24;
const TERMINAL_BLACK_ON_WHITE = "\x1b[47m\x1b[30m";
const TERMINAL_RESET = "\x1b[0m";

function sanitizeApprovalText(text: string): string {
  const flattened = text.replace(APPROVAL_BIDI_CONTROL_RE, "").replace(/\s+/g, " ").trim();
  return sanitizeRenderableText(flattened);
}

type FencedPresentation = {
  content: string;
  fallback: string;
};

function compactPresentationText(text: string): string {
  const compact = sanitizeApprovalText(text);
  const characters = Array.from(compact);
  return characters.length <= MAX_COMPACT_PRESENTATION_CHARS
    ? compact
    : `${characters.slice(0, MAX_COMPACT_PRESENTATION_CHARS - 1).join("")}…`;
}

function extractLatestFencedPresentation(
  presentations: readonly string[],
): FencedPresentation | null {
  let latest: FencedPresentation | null = null;
  for (const presentation of presentations) {
    const sanitized = sanitizeRenderableText(presentation).replace(APPROVAL_BIDI_CONTROL_RE, "");
    FENCED_PRESENTATION_RE.lastIndex = 0;
    for (
      let match = FENCED_PRESENTATION_RE.exec(sanitized);
      match;
      match = FENCED_PRESENTATION_RE.exec(sanitized)
    ) {
      const matchEnd = match.index + match[0].length;
      latest = {
        content: match[2] ?? "",
        fallback: compactPresentationText(sanitized.slice(matchEnd)),
      };
    }
  }
  return latest;
}

function formatCompactPresentation(presentations: readonly string[]): string {
  const fenced = extractLatestFencedPresentation(presentations);
  if (fenced !== null) {
    const content = fenced.content
      .split("\n")
      .map((line) => `${TERMINAL_BLACK_ON_WHITE}${line}${TERMINAL_RESET}`)
      .join("\n");
    return fenced.fallback ? `${fenced.fallback}\n${content}` : content;
  }
  const latest = presentations.at(-1);
  return latest ? compactPresentationText(latest) : "";
}

class PluginApprovalPrompt implements Component {
  private readonly title: Text;
  private readonly metadata: Text;
  private readonly description: Text;
  private readonly externalResolution: Text;
  private readonly challenge: Text;
  private readonly confirmation = new Text();

  constructor(
    surfaceLabel: string,
    approval: TuiPluginApproval,
    private readonly selector: ApprovalSelector,
    presentations: readonly string[] = [],
  ) {
    const title = sanitizeApprovalText(approval.request.title);
    const description = sanitizeApprovalText(approval.request.description ?? "");
    const severity = approval.request.severity ?? "warning";
    const metadata = [
      `Severity: ${severity === "critical" ? "Critical" : severity === "info" ? "Info" : "Warning"}`,
      ...(approval.request.toolName
        ? [`Tool: ${sanitizeApprovalText(approval.request.toolName)}`]
        : []),
      ...(approval.request.pluginId
        ? [`Plugin: ${sanitizeApprovalText(approval.request.pluginId)}`]
        : []),
    ];
    const externalResolution = approval.request.externalResolution;
    const externalLines = externalResolution
      ? [
          sanitizeApprovalText(externalResolution.label),
          "Press Escape to dismiss; the request remains pending.",
        ]
      : [];
    this.title = new Text(theme.header(`${surfaceLabel}: ${title}`));
    this.metadata = new Text(theme.dim(metadata.join("\n")));
    this.description = new Text(theme.system(description ? `Request: ${description}` : ""));
    this.externalResolution = new Text(theme.system(externalLines.join("\n")));
    this.challenge = new Text(formatCompactPresentation(presentations));
  }

  setConfirmation(text: string): void {
    this.confirmation.setText(theme.accent(text));
  }

  invalidate(): void {
    this.title.invalidate();
    this.metadata.invalidate();
    this.description.invalidate();
    this.externalResolution.invalidate();
    this.challenge.invalidate();
    this.confirmation.invalidate();
    this.selector.invalidate();
  }

  render(width: number): string[] {
    const challenge = this.challenge.render(width);
    const confirmation = this.confirmation.render(width);
    const selector = this.selector.render(width);
    const title = this.title.render(width);
    const metadata = this.metadata.render(width);
    const description = this.description.render(width);
    const externalResolution = this.externalResolution.render(width);
    const context = [
      ...title.slice(0, 2),
      ...metadata,
      ...(externalResolution.some((line) => line.trim()) ? externalResolution : []),
      ...(description.some((line) => line.trim()) ? description : []),
    ];
    if (challenge.some((line) => line.trim())) {
      const controls = [
        ...selector,
        ...(confirmation.some((line) => line.trim()) ? confirmation : []),
      ];
      const contextBudget = Math.max(0, MAX_APPROVAL_PROMPT_ROWS - controls.length - 1);
      const visibleContext = context.slice(0, contextBudget);
      const challengeBudget = Math.max(
        1,
        MAX_APPROVAL_PROMPT_ROWS - visibleContext.length - controls.length,
      );
      // Keep authorization context and actions above a potentially tall QR.
      // The challenge fallback is first, and the complete presentation stays in chat.
      return [...visibleContext, ...controls, ...challenge.slice(0, challengeBudget)];
    }
    if (externalResolution.some((line) => line.trim())) {
      const controls = [
        ...(confirmation.some((line) => line.trim()) ? confirmation : []),
        ...selector,
      ];
      const contextBudget = Math.max(0, MAX_APPROVAL_PROMPT_ROWS - controls.length);
      return [...context.slice(0, contextBudget), ...controls];
    }
    return [
      ...context,
      ...(confirmation.some((line) => line.trim()) ? ["", ...confirmation] : []),
      "",
      ...selector,
    ];
  }

  handleInput(data: string): void {
    this.selector.handleInput?.(data);
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
  if (!isRecord(value)) {
    return null;
  }
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (!label || !Array.isArray(value.decisions)) {
    return null;
  }
  const decisions: TuiExternalApprovalDecision[] = [];
  for (const candidate of value.decisions) {
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
  if (!isRecord(payload) || !isRecord(payload.request)) {
    return null;
  }
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const title = typeof payload.request.title === "string" ? payload.request.title.trim() : "";
  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!id || !title || !createdAtMs || !expiresAtMs) {
    return null;
  }
  const rawExternalResolution = payload.request.externalResolution;
  const externalResolution = parseExternalResolution(rawExternalResolution);
  if (rawExternalResolution != null && !externalResolution) {
    return null;
  }
  return {
    id,
    request: {
      title,
      description:
        typeof payload.request.description === "string" ? payload.request.description : null,
      pluginId: typeof payload.request.pluginId === "string" ? payload.request.pluginId : null,
      severity: parseSeverity(payload.request.severity),
      toolName: typeof payload.request.toolName === "string" ? payload.request.toolName : null,
      allowedDecisions: parseAllowedDecisions(payload.request.allowedDecisions),
      externalResolution,
      agentId: typeof payload.request.agentId === "string" ? payload.request.agentId : null,
      sessionKey:
        typeof payload.request.sessionKey === "string" ? payload.request.sessionKey : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

function parseResolvedApprovalId(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.id !== "string") {
    return null;
  }
  return payload.id.trim() || null;
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
  let refreshAgain = false;
  let refreshInFlight: Promise<void> | null = null;
  const mutations = new Map<string, ApprovalMutation>();
  const resolvingIds = new Set<string>();
  const dismissedIds = new Set<string>();
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
    if (!refreshInFlight) {
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

  const matchesActiveSession = (approval: TuiPluginApproval) => {
    const sessionKey = approval.request.sessionKey?.trim();
    if (!sessionKey || sessionKey !== deps.getSessionKey()) {
      return false;
    }
    if (sessionKey !== "global") {
      return true;
    }
    const agentId = approval.request.agentId?.trim();
    return Boolean(agentId && agentId === deps.getAgentId());
  };

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
    const approval = queue.find(
      (candidate) =>
        !resolvingIds.has(candidate.id) &&
        !dismissedIds.has(candidate.id) &&
        matchesActiveSession(candidate),
    );
    if (!approval) {
      return;
    }
    activeId = approval.id;
    const surfaceLabel = approvalSurfaceLabel(approval);

    const externalDecisions = approval.request.externalResolution?.decisions ?? [];
    const decisions = approval.request.externalResolution
      ? approval.request.allowedDecisions === undefined
        ? (["deny"] as const)
        : approval.request.allowedDecisions.filter((decision) => decision === "deny")
      : (approval.request.allowedDecisions ?? DEFAULT_DECISIONS);
    const canDispatchExternal = Boolean(
      deps.client.prepareExternalPluginApproval && deps.client.startExternalPluginApproval,
    );
    const preparedActions = new Map<
      TuiExternalApprovalDecision,
      Promise<
        { ok: true; action: TuiPreparedExternalApprovalAction } | { ok: false; error: unknown }
      >
    >();
    if (canDispatchExternal) {
      for (const decision of externalDecisions) {
        preparedActions.set(
          decision,
          deps.client.prepareExternalPluginApproval!(approval.id, decision).then(
            (action) => ({ ok: true as const, action }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
      }
    }
    const items = [
      ...(canDispatchExternal
        ? externalDecisions.map((decision) => EXTERNAL_DECISION_ITEMS[decision])
        : []),
      ...decisions.map((decision) => DECISION_ITEMS[decision]),
    ];
    const selector = createSelector(items);
    let allowDecisionArmed = false;
    let prompt: PluginApprovalPrompt | null = null;
    const denyIndex = items.findIndex((item) => item.value === "deny");
    let selectedValue = items[denyIndex >= 0 ? denyIndex : 0]?.value;
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
        const prepared = await preparedActions.get(decision);
        if (!prepared) {
          throw new Error("external approval action preparation is unavailable");
        }
        if (!prepared.ok) {
          throw prepared.error;
        }
        if (!deps.client.startExternalPluginApproval) {
          throw new Error("external approval action dispatch is unavailable");
        }
        const result = await deps.client.startExternalPluginApproval(
          approval.id,
          decision,
          prepared.action.actionToken,
        );
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
      } catch (error) {
        deps.chatLog.addSystem(`${surfaceLabel} failed: ${formatErrorMessage(error)}`);
      }
      resolvingIds.delete(approval.id);
      presentNext();
      if (!disposed) {
        deps.requestRender();
      }
    };

    selector.onSelect = (item) => {
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
    selector.onCancel = () => {
      if (approval.request.externalResolution) {
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
      externalPresentations.get(approval.id),
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

  const refreshOnce = async () => {
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
  };

  const refreshApprovals = async (): Promise<void> => {
    if (disposed || !deps.client.listPluginApprovals) {
      return;
    }
    if (refreshInFlight) {
      refreshAgain = true;
      return await refreshInFlight;
    }
    refreshInFlight = (async () => {
      do {
        refreshAgain = false;
        await refreshOnce();
      } while (refreshAgain);
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
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
