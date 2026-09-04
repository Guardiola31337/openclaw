// Renders a single plugin approval prompt (title, metadata, challenge/QR
// with compact-presentation fallback, and confirmation). Split out of
// tui-plugin-approvals.ts to keep each file within the max-lines budget.
import { Text, type Component, type SelectItem } from "@earendil-works/pi-tui";
import { tuiTheme as theme } from "./theme/theme.js";
import type { TuiPluginApproval } from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";

export type ApprovalSelector = Component & {
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

type CompactPresentation = {
  challenge: string;
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

function formatCompactPresentation(presentations: readonly string[]): CompactPresentation {
  const fenced = extractLatestFencedPresentation(presentations);
  if (fenced !== null) {
    return {
      challenge: fenced.content
        .split("\n")
        .map((line) => `${TERMINAL_BLACK_ON_WHITE}${line}${TERMINAL_RESET}`)
        .join("\n"),
      fallback: fenced.fallback,
    };
  }
  const latest = presentations.at(-1);
  return {
    challenge: "",
    fallback: latest ? compactPresentationText(latest) : "",
  };
}

export class PluginApprovalPrompt implements Component {
  private readonly title: Text;
  private readonly metadata: Text;
  private readonly description: Text;
  private readonly externalResolution: Text;
  private readonly challenge: Text;
  private readonly challengeFallback: Text;
  private readonly challengeOverflow = new Text(
    theme.system("Full challenge is in chat. Press Escape to scan it."),
  );
  private readonly confirmation = new Text();
  // True after a render that could not fit the QR inline and fell back to the
  // chat presentation. The controller reads it so Escape minimizes (reveals the
  // chat QR) instead of re-presenting a card the reviewer cannot scan.
  challengeOverflowed = false;

  constructor(
    surfaceLabel: string,
    approval: TuiPluginApproval,
    private readonly selector: ApprovalSelector,
    presentations: readonly string[] = [],
    pendingSessionApprovals = 1,
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
      // Back-to-back cards for a multi-call task look identical; the queue
      // position is what tells the reviewer these are distinct approvals.
      ...(pendingSessionApprovals > 1
        ? [`Pending approvals in this session: ${pendingSessionApprovals}`]
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
    const presentation = formatCompactPresentation(presentations);
    this.challenge = new Text(presentation.challenge);
    this.challengeFallback = new Text(presentation.fallback);
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
    this.challengeFallback.invalidate();
    this.challengeOverflow.invalidate();
    this.confirmation.invalidate();
    this.selector.invalidate();
  }

  render(width: number): string[] {
    this.challengeOverflowed = false;
    const challenge = this.challenge.render(width);
    const challengeFallback = this.challengeFallback.render(width);
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
      const challengeBudget = MAX_APPROVAL_PROMPT_ROWS - controls.length - challengeFallback.length;
      if (challenge.length <= challengeBudget) {
        const contextBudget = Math.max(0, challengeBudget - challenge.length);
        return [
          ...context.slice(0, contextBudget),
          ...controls,
          ...challengeFallback,
          ...challenge,
        ];
      }
      this.challengeOverflowed = true;
      const overflow = this.challengeOverflow.render(width);
      const fallback =
        challengeFallback.length + overflow.length <= MAX_APPROVAL_PROMPT_ROWS - controls.length
          ? challengeFallback
          : [];
      const contextBudget = Math.max(
        0,
        MAX_APPROVAL_PROMPT_ROWS - controls.length - fallback.length - overflow.length,
      );
      const visibleContext = context.slice(0, contextBudget);
      // A cropped QR is invalid. Keep a complete fallback when it fits and direct
      // users to the full pending presentation in chat for oversized challenges.
      return [...visibleContext, ...controls, ...fallback, ...overflow];
    }
    if (externalResolution.some((line) => line.trim())) {
      const controls = [
        ...(confirmation.some((line) => line.trim()) ? confirmation : []),
        ...selector,
      ];
      const fallbackBudget = Math.max(0, MAX_APPROVAL_PROMPT_ROWS - controls.length);
      const fallback = challengeFallback.slice(0, fallbackBudget);
      const contextBudget = Math.max(
        0,
        MAX_APPROVAL_PROMPT_ROWS - controls.length - fallback.length,
      );
      return [...context.slice(0, contextBudget), ...controls, ...fallback];
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
