import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpToLine,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  HelpCircle,
  GitBranch,
  GitFork,
  Gauge,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Moon,
  Pause,
  Pencil,
  Plus,
  Play,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Skull,
  SquareTerminal,
  Trash2,
  Zap,
  X
} from "lucide-react";
import { cursorLineDown, insertNewlineAndIndent } from "@codemirror/commands";
import { minimalSetup } from "codemirror";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
  gutter,
  keymap,
  placeholder as codeMirrorPlaceholder
} from "@codemirror/view";
import {
  Children,
  type ComponentPropsWithoutRef,
  FormEvent,
  KeyboardEvent,
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import type { AppShellOutletContext, PrimaryInputFocusCommand } from "./AppShell.js";
import type {
  AccessMode,
  ApprovalMode,
  ApprovalDecision,
  ApprovalRequest,
  BtwDeltaPayload,
  BtwExchange,
  ChatMessage,
  CodexSkill,
  CodexModelCatalogResponse,
  CollaborationMode,
  MessageContentPart,
  GitWorkspaceSummary,
  HeavyCommand,
  ManagedSession,
  PlanActionChoice,
  QuestionAnswerRequest,
  QuestionRequest,
  QueuedInput,
  SessionEvent,
  SessionDocumentSummary,
  SessionModelSettings,
  SessionAction,
  SessionActionResponse,
  TranscriptPageResponse,
  TranscriptSearchMatch,
  TranscriptItem as CoreTranscriptItem
} from "@muxpilot/core";
import {
  appendSkillNamesToText,
  canToggleFastMode,
  gitWorkflowEventContext,
  gitWorkflowEventDirection,
  gitWorkflowEventFromPayload,
  gitWorkflowEventSummary,
  hasCompleteProposedPlan,
  heavyCommandQueueCommandSummary,
  heavyCommandQueueEventDirection,
  heavyCommandQueueEventFromPayload,
  heavyCommandQueueEventSummary,
  itemFirstSequence,
  itemLastSequence,
  normalizeGitWorkspaceSummary,
  normalizeGitWorkflowEvent,
  normalizeHeavyCommandQueueEvent,
  normalizeSessionWaitEvent,
  normalizeSubagentNotificationText,
  normalizeUserContextText,
  serializeSessionWaitEvent,
  sessionWaitEventFromPayload,
  sessionWaitEventSummary,
  transcriptMessages,
  withGitWorkflowEventPayload,
  withHeavyCommandQueueEventPayload,
  withSessionWaitEventPayload
} from "@muxpilot/core";
import { api, ApiError } from "../api/client.js";
import { CodeBlock, codeBlockText } from "../components/CodeBlock.js";
import { ContextMenu, ContextMenuItem, useContextMenuTrigger, useDismissableContextMenu } from "../components/ContextMenu.js";
import { LoadingStatusPill, StatusPill } from "../components/StatusPill.js";
import { SessionLoadingSkeleton } from "../components/LoadingSkeleton.js";
import { Modal } from "../components/Modal.js";
import { copyImage, copyText } from "../utils/clipboard.js";
import { codeMirrorComposerFieldAttributes, freeformComposerField, noAutofillTextField } from "../utils/formFields.js";
import { sessionDisplayName } from "../utils/sessionLabels.js";
import { childSessionAttentionItems, sessionStatusPresentation, type ChildSessionAttentionItem } from "../utils/sessionStatus.js";
import { appendBtwDelta, BtwDrawer, parseBtwComposerInput, upsertBtwExchange } from "../components/BtwDrawer.js";
import { effectiveModelSettings, ModelSettingsDrawer } from "../components/ModelSettingsDrawer.js";

const MESSAGE_PAGE_SIZE = 80;
const MESSAGE_TOP_LOAD_THRESHOLD_PX = 80;
const MESSAGE_BOTTOM_LOAD_THRESHOLD_PX = 120;
export const SESSION_RECONCILE_INTERVAL_MS = 30_000;
export const ACTIVE_HEAVY_COMMAND_RECONCILE_INTERVAL_MS = 2_000;
export const SESSION_BOOTSTRAP_TIMEOUT_MS = 10_000;
export const SESSION_BOOTSTRAP_NOTICE_MS = 5_000;
export const SESSION_BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const SESSION_DOCUMENTS_RECONCILE_INTERVAL_MS = 5_000;
const COPIED_PATH_FEEDBACK_MS = 1_600;
const SKILL_REFRESH_INTERVAL_MS = 60_000;
const SKILL_REFRESH_STALE_MS = 10_000;
// "none" explicitly preserves the viewport; "idle" means there is no pending transcript scroll request.
export type ScrollBehavior = "bottom" | "top" | "preserve" | "none" | "idle";
export type ScrollUpdateReason = "initial" | "explicit_bottom" | "send" | "live" | "older_page" | "manual_newer";
export type PlanAction = PlanActionChoice;

interface TranscriptInteractionOutcome {
  kind: "plan" | "approval" | "question";
  status: "answered" | "failed" | "closed";
  submittedAt: string;
  decision?: PlanActionChoice | ApprovalDecision;
  answers?: QuestionAnswerRequest["answers"];
  error?: string;
  resolvedBy?: "user" | "auto" | "full";
  reviewerModel?: string;
  reviewerExplanation?: string;
}
export type ScrollAnchorSnapshot = { itemId: string | null; offsetTop: number; scrollTop: number; scrollHeight: number };
export type MessageListAutoPageAction = "older" | "newer" | null;
export interface SessionDocumentReference { scopeId: string; name: string; path: string; fragment?: string }
export type MarkdownLinkTarget =
  | { kind: "link" }
  | { kind: "file"; path: string; document: SessionDocumentReference | null };
interface ReferencedDocumentSource {
  sessionId: string;
  sessionName: string;
  documents: SessionDocumentSummary[];
}

type ImageContentPart = Extract<MessageContentPart, { type: "image" }>;
interface SessionImageTarget extends ImageContentPart { sessionId: string }
interface MessageCopyTarget { label: string; text: string }
interface MessageActionMenuState {
  x: number;
  y: number;
  copyTarget?: MessageCopyTarget;
  image?: SessionImageTarget;
}
export type TranscriptVimNavigationCommand = "jumpTop" | "jumpBottom" | "halfUp" | "halfDown" | "pageUp" | "pageDown" | "find";
export type PendingActionRefresh = "approval" | "question" | null;
export interface PendingUserMessage {
  id: string;
  sessionId: string;
  text: string;
  content?: MessageContentPart[];
  mode: CollaborationMode;
  timestamp: string;
  matchAfter?: string;
}

interface RefreshOwner {
  token: number;
  queuedRefresh: (() => Promise<boolean>) | null;
}

export class LatestGenerationRefreshGate {
  private owner: RefreshOwner | null = null;
  private latestToken = Number.NEGATIVE_INFINITY;

  async run(token: number, refresh: () => Promise<boolean>): Promise<void> {
    if (token < this.latestToken) return;
    if (token > this.latestToken) this.latestToken = token;
    if (this.owner?.token === token) {
      this.owner.queuedRefresh = refresh;
      return;
    }

    const owner: RefreshOwner = { token, queuedRefresh: null };
    this.owner = owner;
    try {
      let nextRefresh: (() => Promise<boolean>) | null = refresh;
      while (nextRefresh && this.latestToken === token) {
        owner.queuedRefresh = null;
        const canRepeat = await nextRefresh();
        nextRefresh = canRepeat ? owner.queuedRefresh : null;
      }
    } finally {
      if (this.owner === owner) this.owner = null;
    }
  }
}

export class LiveTranscriptRefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private burstStartedAt = 0;
  private pending: (() => void) | null = null;

  constructor(
    private readonly debounceMs = 100,
    private readonly maxWaitMs = 500,
    private readonly now: () => number = () => Date.now()
  ) {}

  schedule(refresh: () => void): void {
    const now = this.now();
    if (!this.burstStartedAt) this.burstStartedAt = now;
    this.pending = refresh;
    if (this.timer) clearTimeout(this.timer);
    const remaining = Math.max(0, this.maxWaitMs - (now - this.burstStartedAt));
    this.timer = setTimeout(() => this.flush(), Math.min(this.debounceMs, remaining));
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.burstStartedAt = 0;
  }

  private flush(): void {
    const refresh = this.pending;
    this.timer = null;
    this.pending = null;
    this.burstStartedAt = 0;
    refresh?.();
  }
}

const COMPOSER_DRAFT_STORAGE_PREFIX = "muxpilot.session-draft.v1:";
const QUESTION_ANSWER_DRAFT_STORAGE_PREFIX = "muxpilot.question-answer-draft.v1:";
export const VIM_MODE_STORAGE_KEY = "muxpilot.vim-mode.v1";
export const DESKTOP_VIM_MEDIA_QUERY = "(min-width: 560px) and (any-hover: hover) and (any-pointer: fine)";
const composerRootInputHints: Record<string, string | boolean> = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "sentences",
  spellCheck: true,
  inputMode: "text"
};

export function composerDraftStorageKey(sessionId: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${sessionId}`;
}

export function loadComposerDraft(sessionId: string): string {
  if (!sessionId || typeof window === "undefined") return "";
  try {
    const value = window.localStorage.getItem(composerDraftStorageKey(sessionId));
    if (!value) return "";
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || !("text" in parsed)) return "";
    const text = (parsed as { text?: unknown }).text;
    return typeof text === "string" ? text.replace(/\[\[muxpilot-upload:[A-Za-z0-9_-]+\]\]/g, "[Image upload interrupted]") : "";
  } catch {
    return "";
  }
}

export function saveComposerDraft(sessionId: string, value: string): void {
  if (!sessionId || typeof window === "undefined") return;
  try {
    const key = composerDraftStorageKey(sessionId);
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ text: value }));
  } catch {
    // Draft persistence is best effort; the composer must stay usable.
  }
}

export interface QuestionAnswerDraft {
  selectedOption: string | null;
  other: string;
}

export function questionAnswerDraftStorageKey(sessionId: string): string {
  return `${QUESTION_ANSWER_DRAFT_STORAGE_PREFIX}${sessionId}`;
}

export function loadQuestionAnswerDraft(question: QuestionRequest): Record<string, QuestionAnswerDraft> {
  if (!question.sessionId || typeof window === "undefined") return {};
  const key = questionAnswerDraftStorageKey(question.sessionId);
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return {};
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { questionId?: unknown }).questionId !== question.id) {
      window.localStorage.removeItem(key);
      return {};
    }
    const storedAnswers = (parsed as { answers?: unknown }).answers;
    if (!storedAnswers || typeof storedAnswers !== "object" || Array.isArray(storedAnswers)) {
      window.localStorage.removeItem(key);
      return {};
    }
    return sanitizeQuestionAnswerDraft(question, storedAnswers as Record<string, unknown>);
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage remains best effort.
    }
    return {};
  }
}

export function saveQuestionAnswerDraft(
  question: QuestionRequest,
  answers: Record<string, QuestionAnswerDraft>
): void {
  if (!question.sessionId || typeof window === "undefined") return;
  try {
    const key = questionAnswerDraftStorageKey(question.sessionId);
    const sanitized = sanitizeQuestionAnswerDraft(question, answers);
    if (Object.keys(sanitized).length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ questionId: question.id, answers: sanitized }));
  } catch {
    // Draft persistence is best effort; question controls must stay usable.
  }
}

export function clearQuestionAnswerDraft(question: QuestionRequest): void {
  if (!question.sessionId || typeof window === "undefined") return;
  try {
    const key = questionAnswerDraftStorageKey(question.sessionId);
    const value = window.localStorage.getItem(key);
    if (!value) return;
    const parsed = JSON.parse(value) as { questionId?: unknown };
    if (parsed?.questionId === question.id) window.localStorage.removeItem(key);
  } catch {
    // Invalid draft data is harmless and can be replaced by the next edit.
  }
}

function sanitizeQuestionAnswerDraft(
  question: QuestionRequest,
  answers: Record<string, unknown>
): Record<string, QuestionAnswerDraft> {
  const sanitized: Record<string, QuestionAnswerDraft> = {};
  for (const prompt of question.questions) {
    const value = answers[prompt.id];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = value as { selectedOption?: unknown; other?: unknown };
    const selectedOption = typeof candidate.selectedOption === "string"
      && prompt.options.some((option) => option.label === candidate.selectedOption)
      ? candidate.selectedOption
      : null;
    const other = typeof candidate.other === "string" ? candidate.other : "";
    if (selectedOption || other) sanitized[prompt.id] = { selectedOption, other };
  }
  return sanitized;
}

export function composerHasContent(value: string): boolean {
  return Boolean(value.trim());
}

const IMAGE_TOKEN = /\[\[muxpilot-image:([A-Za-z0-9_-]+\.(?:png|jpg|webp)):(image\/(?:png|jpeg|webp))\]\]/g;
export function composerContent(value: string): { text: string; content: MessageContentPart[] } {
  const content: MessageContentPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(IMAGE_TOKEN)) {
    if (match.index! > cursor) content.push({ type: "text", text: value.slice(cursor, match.index) });
    content.push({ type: "image", id: match[1]!, mimeType: match[2]! as "image/png" | "image/jpeg" | "image/webp" });
    cursor = match.index! + match[0].length;
  }
  if (cursor < value.length) content.push({ type: "text", text: value.slice(cursor) });
  return { text: content.filter((part) => part.type === "text").map((part) => part.text).join(""), content };
}

function composerSource(text: string, content?: MessageContentPart[]): string {
  return content?.length
    ? content.map((part) => part.type === "text" ? part.text : `[[muxpilot-image:${part.id}:${part.mimeType}]]`).join("")
    : text;
}

export function loadVimModePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(VIM_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveVimModePreference(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIM_MODE_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Preference persistence is best effort; the editor must stay usable.
  }
}

export function isDesktopVimAvailable(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DESKTOP_VIM_MEDIA_QUERY).matches;
}

function useDesktopVimAvailable(): boolean {
  const [available, setAvailable] = useState(isDesktopVimAvailable);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(DESKTOP_VIM_MEDIA_QUERY);
    const update = () => setAvailable(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return available;
}

export function isLiveManagedSession(session: (Pick<ManagedSession, "archived" | "status"> & Partial<Pick<ManagedSession, "agentOwnership">>) | null): boolean {
  return Boolean(session && !session.archived && session.status !== "missing" && !session.agentOwnership?.completedAt);
}

export function hasActiveHeavyCommand(commands: readonly Pick<HeavyCommand, "state">[]): boolean {
  return commands.some((command) => command.state === "waiting" || command.state === "reserved" || command.state === "running" || command.state === "stalled" || command.state === "terminating" || command.state === "reporting");
}

export function isLatestSessionRefresh(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

export function sessionBootstrapRetryDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), SESSION_BOOTSTRAP_RETRY_DELAYS_MS.length - 1));
  return SESSION_BOOTSTRAP_RETRY_DELAYS_MS[index]!;
}

export function terminalSessionBootstrapError(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404) return "This session could not be found.";
  return null;
}

export function inputModeAction(mode: CollaborationMode): SessionAction {
  return { type: "setInputMode", mode };
}

export function sessionWithPendingInputMode(session: ManagedSession, pendingMode: CollaborationMode | null): ManagedSession {
  return pendingMode ? { ...session, inputMode: pendingMode } : session;
}

export function fastModeAction(enabled: boolean): SessionAction {
  return { type: "setFastMode", enabled };
}

export function sessionWithPendingFastMode(session: ManagedSession, pendingFastMode: boolean | null): ManagedSession {
  return pendingFastMode === null ? session : { ...session, fastMode: pendingFastMode };
}

export function shouldQueueComposerInput(
  session: Pick<ManagedSession, "status" | "initializing"> | null,
  queuedInputs: Pick<QueuedInput, "status">[]
): boolean {
  if (queuedInputs.length > 0) return true;
  return !session || session.initializing === true || (session.status !== "waiting" && session.status !== "idle");
}

export function canSteerComposerInput(
  session: Pick<ManagedSession, "capabilities" | "status" | "initializing" | "runtime"> | null,
  heavyCommandActive: boolean
): boolean {
  if (!session || !session.capabilities?.steer) return false;
  if (session.initializing || heavyCommandActive) return false;
  if (session.runtime?.kind !== "systemd_service" || session.runtime.state !== "connected") return false;
  return session.status === "working"
    || session.status === "generating"
    || session.status === "executing"
    || session.status === "running"
    || session.status === "planning";
}

export function isNearMessageListBottom(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  thresholdPx = MESSAGE_BOTTOM_LOAD_THRESHOLD_PX
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

export interface TranscriptJumpVisibility {
  top: boolean;
  bottom: boolean;
}

export function transcriptJumpVisibility(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  hasMoreBefore: boolean,
  hasMoreAfter: boolean
): TranscriptJumpVisibility {
  const scrollable = metrics.scrollHeight > metrics.clientHeight;
  const atAbsoluteTop = metrics.scrollTop <= 1 && !hasMoreBefore;
  const atAbsoluteBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 1 && !hasMoreAfter;
  return {
    top: !atAbsoluteTop,
    bottom: (scrollable || hasMoreAfter) && !atAbsoluteBottom
  };
}

export function scrollBehaviorForTranscriptUpdate(reason: ScrollUpdateReason, isNearBottom: boolean): ScrollBehavior {
  if (reason === "older_page") return "preserve";
  if (reason === "manual_newer") return "none";
  if (reason === "live") return isNearBottom ? "bottom" : "none";
  return "bottom";
}

export function scrollBehaviorForBottomContentUpdate(
  behavior: ScrollBehavior,
  bottomContentChanged: boolean,
  wasNearBottom: boolean
): ScrollBehavior {
  if (behavior !== "idle") return behavior;
  return bottomContentChanged && wasNearBottom ? "bottom" : "none";
}

export function restoreScrollTopForAnchor(
  snapshot: ScrollAnchorSnapshot,
  current: Pick<HTMLElement, "offsetTop"> | null,
  scrollHeight: number
): number {
  if (snapshot.itemId && current) return current.offsetTop - snapshot.offsetTop;
  return scrollHeight - snapshot.scrollHeight + snapshot.scrollTop;
}

export function scrollMessageListToBottom(container: Pick<HTMLElement, "scrollHeight" | "scrollTop">): void {
  container.scrollTop = container.scrollHeight;
}

export function scrollMessageListByRatio(
  container: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  ratio: number
): void {
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.min(maxScrollTop, Math.max(0, container.scrollTop + container.clientHeight * ratio));
}

export function shouldIgnoreTranscriptVimKeyTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined") return false;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, button, [contenteditable='true'], .cm-editor, .transcript-find-bar"));
}

export function shouldHandleSessionBackShortcut(
  event: Pick<globalThis.KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "target">,
  ownerDocument: Pick<Document, "querySelector"> | null = typeof document === "undefined" ? null : document
): boolean {
  if (event.key !== "Backspace" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (isSessionBackShortcutEditableTarget(event.target)) return false;
  return !ownerDocument?.querySelector("[role='dialog'], [role='menu']");
}

function isSessionBackShortcutEditableTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: unknown } | null;
  if (typeof candidate?.closest !== "function") return false;
  return Boolean(
    candidate.closest(
      "input, textarea, select, button, [contenteditable]:not([contenteditable='false']), .cm-content, .cm-editor, .transcript-find-bar"
    )
  );
}

export function transcriptVimNavigationCommand(
  event: Pick<globalThis.KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  pendingG: boolean
): { command: TranscriptVimNavigationCommand | null; pendingG: boolean; preventDefault: boolean } {
  if (event.metaKey || event.altKey) return { command: null, pendingG: false, preventDefault: false };
  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === "u") return { command: "halfUp", pendingG: false, preventDefault: true };
    if (key === "d") return { command: "halfDown", pendingG: false, preventDefault: true };
    if (key === "b") return { command: "pageUp", pendingG: false, preventDefault: true };
    if (key === "f") return { command: "pageDown", pendingG: false, preventDefault: true };
    return { command: null, pendingG: false, preventDefault: false };
  }
  if (event.key === "g" && !event.shiftKey) {
    return pendingG
      ? { command: "jumpTop", pendingG: false, preventDefault: true }
      : { command: null, pendingG: true, preventDefault: true };
  }
  if (event.key === "G" || (event.key === "g" && event.shiftKey)) {
    return { command: "jumpBottom", pendingG: false, preventDefault: true };
  }
  if (event.key === "/") return { command: "find", pendingG: false, preventDefault: true };
  return { command: null, pendingG: false, preventDefault: false };
}

export interface TranscriptFindEntry {
  id: string;
  text: string;
}

export function visibleTranscriptFindEntries(
  items: CoreTranscriptItem[],
  expandedStacks: ReadonlySet<string>,
  expandedRangeItems: Record<string, CoreTranscriptItem[]>
): TranscriptFindEntry[] {
  const entries: TranscriptFindEntry[] = [];
  for (const item of items) {
    entries.push(transcriptFindEntry(item));
    if (item.type === "range" && expandedStacks.has(item.id)) {
      entries.push(...visibleTranscriptFindEntries(expandedRangeItems[item.id] ?? [], expandedStacks, expandedRangeItems));
    }
  }
  return entries.filter((entry) => entry.text.trim());
}

export function transcriptFindMatches(entries: TranscriptFindEntry[], query: string): number[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];
  return entries.flatMap((entry, index) => (entry.text.toLowerCase().includes(normalizedQuery) ? [index] : []));
}

export function inputDeliveryFailureDetail(messages: ChatMessage[]): string {
  const latestUser = messages.findLast((message) => message.role === "user");
  const submission = latestUser?.payload.muxpilotSubmission;
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) return "";
  const detail = (submission as Record<string, unknown>).failureReason;
  return typeof detail === "string" ? detail : "";
}

function transcriptFindEntry(item: CoreTranscriptItem): TranscriptFindEntry {
  if (item.type === "range") return { id: item.id, text: item.label };
  const queueEvent = heavyCommandQueueEventFromPayload(item.message.payload);
  if (queueEvent) {
    return {
      id: item.id,
      text: `${heavyCommandQueueEventDirection(queueEvent.event)} ${heavyCommandQueueEventSummary(queueEvent.event)} ${queueEvent.event.commandDisplay}`
    };
  }
  const workflowEvent = gitWorkflowEventFromPayload(item.message.payload);
  if (workflowEvent) {
    return {
      id: item.id,
      text: `${gitWorkflowEventDirection(workflowEvent.event)} ${gitWorkflowEventSummary(workflowEvent.event)} ${gitWorkflowEventContext(workflowEvent.event)} ${workflowEvent.event.targetBranch} ${workflowEvent.event.sessionBranch ?? ""}`
    };
  }
  return { id: item.id, text: copyableMessageText(item.message) };
}

export function messageListAutoPageAction(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  state: {
    initialScrollReady: boolean;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    firstSequence: number;
    lastSequence: number;
    loadingOlder: boolean;
    loadingNewer: boolean;
    previousScrollTop: number;
    topThresholdPx?: number;
    bottomThresholdPx?: number;
  }
): MessageListAutoPageAction {
  if (!state.initialScrollReady) return null;
  if (metrics.scrollHeight <= metrics.clientHeight) return null;
  const scrollingUp = metrics.scrollTop < state.previousScrollTop;
  const scrollingDown = metrics.scrollTop > state.previousScrollTop;
  const topThresholdPx = state.topThresholdPx ?? MESSAGE_TOP_LOAD_THRESHOLD_PX;
  const bottomThresholdPx = state.bottomThresholdPx ?? MESSAGE_BOTTOM_LOAD_THRESHOLD_PX;
  if (scrollingUp && state.hasMoreBefore && !state.loadingOlder && state.firstSequence > 0 && metrics.scrollTop <= topThresholdPx) {
    return "older";
  }
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  if (scrollingDown && state.hasMoreAfter && !state.loadingNewer && state.lastSequence > 0 && distanceFromBottom <= bottomThresholdPx) {
    return "newer";
  }
  return null;
}

export function createPendingUserMessage(
  sessionId: string,
  text: string,
  mode: CollaborationMode,
  timestamp = new Date().toISOString(),
  content?: MessageContentPart[]
): PendingUserMessage {
  return {
    id: `pending-user-${timestamp}`,
    sessionId,
    text,
    mode,
    timestamp,
    content
  };
}

export function pendingUserMessageToChatMessage(message: PendingUserMessage): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    sequence: Number.MAX_SAFE_INTEGER,
    type: "user",
    role: "user",
    timestamp: message.timestamp,
    text: message.text,
    payload: { collaborationMode: message.mode, ...(message.content?.length ? { content: message.content } : {}) }
  };
}

export function sentQueuedInputToPendingUserMessage(input: QueuedInput): PendingUserMessage | null {
  if (input.status !== "sent" || !input.sentAt) return null;
  return {
    id: `pending-queued-user-${input.id}`,
    sessionId: input.sessionId,
    text: input.text,
    ...(input.content?.length ? { content: input.content } : {}),
    mode: input.mode,
    timestamp: input.sentAt,
    matchAfter: input.createdAt
  };
}

export function latestUnmatchedPendingUserMessage(
  items: CoreTranscriptItem[],
  messages: Array<PendingUserMessage | null>
): PendingUserMessage | null {
  return messages
    .filter((message): message is PendingUserMessage => Boolean(message))
    .filter((message) => !transcriptItemsContainPendingUserMessage(items, message))
    .sort((first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp))[0] ?? null;
}

export function retainLatestSentQueuedUserMessage(
  current: PendingUserMessage | null,
  inputs: QueuedInput[]
): PendingUserMessage | null {
  return inputs
    .map(sentQueuedInputToPendingUserMessage)
    .filter((message): message is PendingUserMessage => Boolean(message))
    .sort((first, second) => Date.parse(second.timestamp) - Date.parse(first.timestamp))[0] ?? current;
}

export function transcriptItemsContainPendingUserMessage(items: CoreTranscriptItem[], pending: PendingUserMessage): boolean {
  return transcriptMessages(items).some((message) => {
    if (message.sessionId !== pending.sessionId || message.role !== "user") return false;
    if (pending.content?.length && messageContentMatches(message, pending.content)) return true;
    const visibleText = displayText(message);
    if (visibleText === pending.text) return true;
    if (visibleText && userTextDisplayParts(visibleText).body === pending.text) return true;
    return isCodexPastedContentPlaceholder(visibleText) && messageCreatedAtOrAfterPending(message, pending);
  });
}

function messageContentMatches(message: ChatMessage, content: MessageContentPart[]): boolean {
  return Array.isArray(message.payload.content) && JSON.stringify(message.payload.content) === JSON.stringify(content);
}

const CODEX_PASTED_CONTENT_PLACEHOLDERS_PATTERN = /^(?:\[Pasted Content \d+ chars\])+$/;

export function isCodexPastedContentPlaceholder(text: string | null): boolean {
  return Boolean(text?.match(CODEX_PASTED_CONTENT_PLACEHOLDERS_PATTERN));
}

function messageCreatedAtOrAfterPending(message: ChatMessage, pending: PendingUserMessage): boolean {
  const messageTime = Date.parse(message.timestamp);
  const pendingTime = Date.parse(pending.matchAfter ?? pending.timestamp);
  return Number.isFinite(messageTime) && Number.isFinite(pendingTime) && messageTime >= pendingTime;
}

export function shouldShowSessionLoading(
  session: (Pick<ManagedSession, "id"> & Partial<Pick<ManagedSession, "initializing">>) | null,
  routeSessionId: string,
  initialTranscriptSessionId: string | null
): boolean {
  return !session || session.id !== routeSessionId || initialTranscriptSessionId !== routeSessionId;
}

export function loadingSessionFromLocationState(state: unknown, routeSessionId: string): ManagedSession | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { loadingSession?: unknown }).loadingSession;
  if (!value || typeof value !== "object") return null;
  const loadingSession = value as Partial<ManagedSession>;
  if (
    loadingSession.id !== routeSessionId ||
    typeof loadingSession.name !== "string" ||
    typeof loadingSession.cwd !== "string" ||
    !loadingSession.repo ||
    !loadingSession.models ||
    (loadingSession.inputMode !== "default" && loadingSession.inputMode !== "plan")
  ) {
    return null;
  }
  return loadingSession as ManagedSession;
}

export function shouldHideInitialMessageList(initialTranscriptSessionId: string | null, routeSessionId: string, initialScrollReady: boolean): boolean {
  return initialTranscriptSessionId === routeSessionId && !initialScrollReady;
}

export function shouldResetInitialTranscriptForLiveTail(
  sourceChanged: boolean,
  initialTranscriptSessionId: string | null,
  routeSessionId: string
): boolean {
  return sourceChanged || initialTranscriptSessionId !== routeSessionId;
}

const HEAVY_STATE_PRIORITY: Record<HeavyCommand["state"], number> = {
  terminating: 4,
  reporting: 3,
  stalled: 3,
  running: 2,
  reserved: 2,
  waiting: 1
};

export function HeavyCommandIndicator({ commands, onOpen }: { commands: HeavyCommand[]; onOpen: () => void }) {
  if (commands.length === 0) return null;
  const primary = [...commands].sort((left, right) => HEAVY_STATE_PRIORITY[right.state] - HEAVY_STATE_PRIORITY[left.state])[0]!;
  const reference = primary.lastActivityAt ?? primary.lastOutputAt ?? primary.startedAt ?? primary.queuedAt;
  const elapsed = compactDuration(Date.now() - Date.parse(reference));
  const title = `${heavyStateLabel(primary.state)}: ${primary.commandDisplay} · ${primary.startedAt ? `progress ${elapsed} ago` : `waiting ${elapsed}`}${commands.length > 1 ? ` · ${commands.length} active` : ""}`;
  return (
    <button
      type="button"
      className="heavy-command-indicator"
      data-state={primary.state}
      onClick={onOpen}
      title={title}
      aria-label={`Open heavyweight command details. ${title}`}
    >
      <Gauge size={15} aria-hidden="true" />
      {commands.length > 1 ? <span>{commands.length}</span> : null}
    </button>
  );
}

export function HeavyCommandsModal({
  open,
  commands,
  outputs,
  error,
  terminatingRun,
  onClose,
  onTerminate
}: {
  open: boolean;
  commands: HeavyCommand[];
  outputs: Record<string, string>;
  error: string;
  terminatingRun: string | null;
  onClose: () => void;
  onTerminate: (runId: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Heavyweight commands" panelClassName="heavy-command-modal">
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {commands.length === 0 ? <p className="muted">No heavyweight commands are active.</p> : (
        <div className="heavy-command-list">
          {commands.map((command) => {
            const silence = command.lastOutputAt ? compactDuration(now - Date.parse(command.lastOutputAt)) : null;
            const activityAge = command.lastActivityAt ? compactDuration(now - Date.parse(command.lastActivityAt)) : silence;
            const elapsed = compactDuration(now - Date.parse(command.startedAt ?? command.queuedAt));
            return (
              <article className="heavy-command-detail" key={command.runId} data-state={command.state}>
                <div className="heavy-command-detail-head">
                  <span className="heavy-command-state">{heavyStateLabel(command.state)}</span>
                  <span>{command.state === "reporting" ? "preparing completion" : command.startedAt ? `${elapsed} running` : `${elapsed} waiting`}</span>
                </div>
                <code className="heavy-command-command">{command.commandDisplay}</code>
                <dl className="heavy-command-facts">
                  <div><dt>Working directory</dt><dd>{command.cwd}</dd></div>
                  <div><dt>Slot / PID</dt><dd>{command.slot ?? "queued"} / {command.childPid ?? "not started"}</dd></div>
                  {command.state === "waiting" ? <div><dt>Queue position</dt><dd>{command.queuePosition ?? "calculating"}</dd></div> : null}
                  {command.state === "reserved" ? <div><dt>Resume claim</dt><dd>{command.resumeDeadlineAt ? `${compactDuration(Math.max(0, Date.parse(command.resumeDeadlineAt) - now))} remaining` : "waiting for session"}</dd></div> : null}
                  <div><dt>Output silence</dt><dd>{silence ?? "not started"}</dd></div>
                  <div><dt>Observed activity</dt><dd>{activityAge ?? "not started"} ago · {command.activity?.processCount ?? "?"} processes · {command.activity?.runningContainers ?? "?"} running / {command.activity?.createdContainers ?? "?"} created containers</dd></div>
                  <div><dt>Limits</dt><dd>warn {compactDuration(command.deadlines.inactivityWarnMs)} idle · stop {compactDuration(command.deadlines.inactivityTimeoutMs)} idle · {compactDuration(command.deadlines.runtimeTimeoutMs)} total · {compactDuration(command.deadlines.terminationGraceMs)} grace</dd></div>
                  <div><dt>Package manager</dt><dd>{command.packageDiagnostics?.declared ?? "not declared"} · {command.packageDiagnostics?.resolvedVersion ?? "version unavailable"} · {command.packageDiagnostics?.resolvedPath ?? "path unavailable"}</dd></div>
                  <div><dt>Package store</dt><dd>{command.packageDiagnostics?.storePath ?? "unavailable"}</dd></div>
                  <div><dt>Cache paths</dt><dd>{formatHeavyCachePaths(command)}</dd></div>
                  <div><dt>Log</dt><dd>{command.logPath ?? "unavailable"}</dd></div>
                </dl>
                {command.packageDiagnostics?.warnings.length ? <p className="heavy-command-warning">{command.packageDiagnostics.warnings.join(" · ")}</p> : null}
                <pre className="heavy-command-output" aria-label={`Live output for ${command.commandDisplay}`}>{outputs[command.runId] ?? "Loading output…"}</pre>
                <div className="heavy-command-actions">
                  {confirming === command.runId ? (
                    <>
                      <span>Terminate this command and its process group?</span>
                      <button type="button" className="danger-button" disabled={terminatingRun === command.runId} onClick={() => { setConfirming(null); onTerminate(command.runId); }}>Terminate</button>
                      <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" disabled={command.state === "terminating" || command.state === "reporting"} onClick={() => setConfirming(command.runId)}>{command.state === "terminating" ? "Terminating…" : command.state === "reporting" ? "Command finished" : "Terminate command"}</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

export function DocumentsModal({
  open,
  sessionId,
  sourceSessionName,
  currentSession = true,
  documents,
  requestedDocument,
  requestedFragment,
  requestedNavigation = 0,
  listLoading,
  listError,
  onOpenDocument,
  onReturnToCurrent,
  onClose
}: {
  open: boolean;
  sessionId: string;
  sourceSessionName?: string | null;
  currentSession?: boolean;
  documents: SessionDocumentSummary[];
  requestedDocument?: string | null;
  requestedFragment?: string | null;
  requestedNavigation?: number;
  listLoading: boolean;
  listError: string;
  onOpenDocument?: (reference: SessionDocumentReference) => Promise<boolean> | boolean;
  onReturnToCurrent?: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loadedContentKey, setLoadedContentKey] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState("");
  const [navigationError, setNavigationError] = useState("");
  const [pendingFragment, setPendingFragment] = useState<{ name: string; fragment: string } | null>(null);
  const viewerRef = useRef<HTMLElement>(null);
  const displayedDocumentRef = useRef<string | null>(null);
  const appliedRequestedDocumentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      appliedRequestedDocumentRef.current = null;
      return;
    }
    const requestedMatch = documents.find((document) => document.name === requestedDocument)?.name ?? null;
    const requestKey = requestedMatch ? `${sessionId}\u0000${requestedMatch}\u0000${requestedFragment ?? ""}\u0000${requestedNavigation}` : null;
    const applyRequestedDocument = requestKey !== null && appliedRequestedDocumentRef.current !== requestKey;
    if (applyRequestedDocument) appliedRequestedDocumentRef.current = requestKey;
    if (applyRequestedDocument && requestedMatch) {
      setPendingFragment(requestedFragment ? { name: requestedMatch, fragment: requestedFragment } : null);
      setNavigationError("");
    }
    setSelected((current) => (applyRequestedDocument ? requestedMatch : null)
      ?? (documents.some((document) => document.name === current) ? current : null)
      ?? documents.find((document) => document.name.toLowerCase() === "index.md")?.name
      ?? documents[0]?.name
      ?? null);
  }, [documents, open, requestedDocument, requestedFragment, requestedNavigation, sessionId]);

  const selectedVersion = documents.find((document) => document.name === selected)?.updatedAt ?? "";
  const selectedDocumentKey = selected ? `${sessionId}\u0000${selected}` : null;
  const selectedContentKey = selectedDocumentKey ? `${selectedDocumentKey}\u0000${selectedVersion}` : null;
  const documentMarkdownComponents = fileAwareMarkdownComponentsValue;
  useEffect(() => {
    if (!open || !selected) {
      setContent("");
      setLoadedContentKey(null);
      setContentLoading(false);
      setContentError("");
      if (!open) displayedDocumentRef.current = null;
      return undefined;
    }
    let cancelled = false;
    setContentLoading(true);
    setContentError("");
    void api.sessionDocument(sessionId, selected).then(
      (response) => {
        if (cancelled) return;
        setContent(response.document.content);
        setLoadedContentKey(selectedContentKey);
        setContentLoading(false);
        setContentError("");
      },
      (error) => {
        if (cancelled) return;
        setLoadedContentKey(null);
        setContentLoading(false);
        setContentError(error instanceof Error ? error.message : "Unable to load document");
      }
    );
    return () => { cancelled = true; };
  }, [open, selected, selectedContentKey, sessionId]);

  const contentReady = selectedContentKey !== null && loadedContentKey === selectedContentKey;
  const viewerBusy = Boolean(selected && !contentError && (contentLoading || !contentReady));

  useLayoutEffect(() => {
    if (!contentReady || !selectedDocumentKey || !viewerRef.current) return;
    if (pendingFragment?.name === selected) {
      const heading = Array.from(viewerRef.current.querySelectorAll<HTMLElement>("[id]"))
        .find((candidate) => candidate.id === pendingFragment.fragment);
      if (heading) {
        heading.scrollIntoView({ block: "start" });
        setNavigationError("");
      } else {
        setNavigationError(`Section #${pendingFragment.fragment} was not found in ${selected}.`);
      }
      setPendingFragment(null);
    } else if (selectedDocumentKey !== displayedDocumentRef.current) {
      viewerRef.current.scrollTop = 0;
    }
    displayedDocumentRef.current = selectedDocumentKey;
  }, [contentReady, loadedContentKey, pendingFragment, selected, selectedDocumentKey]);

  function selectDocument(name: string, fragment?: string) {
    setNavigationError("");
    setPendingFragment(fragment ? { name, fragment } : null);
    setSelected(name);
  }

  function navigateToFragment(fragment: string) {
    if (!selected || !contentReady || !viewerRef.current) {
      if (selected) setPendingFragment({ name: selected, fragment });
      return;
    }
    const heading = Array.from(viewerRef.current.querySelectorAll<HTMLElement>("[id]"))
      .find((candidate) => candidate.id === fragment);
    if (heading) {
      heading.scrollIntoView({ block: "start" });
      setNavigationError("");
    } else {
      setNavigationError(`Section #${fragment} was not found in ${selected}.`);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Documents" panelClassName="documents-modal">
      {!currentSession ? (
        <div className="documents-source-context">
          <span>Viewing documents from <strong>{sourceSessionName ?? "another session"}</strong></span>
          {onReturnToCurrent ? <button type="button" onClick={onReturnToCurrent}>Back to current session</button> : null}
        </div>
      ) : null}
      {listError ? <p className="error-text" role="alert">{listError}</p> : null}
      {listLoading && documents.length === 0 ? <p className="muted">Loading documents…</p> : documents.length === 0 && !listError ? <p className="muted">This session has no documents yet.</p> : (
        <div className="documents-layout">
          <nav className="documents-list" aria-label="Session documents">
            {documents.map((document) => (
              <button key={document.name} type="button" data-active={selected === document.name || undefined} aria-current={selected === document.name ? "page" : undefined} onClick={() => selectDocument(document.name)}>
                <FileText size={15} aria-hidden="true" />
                <span><strong>{document.name}</strong><small>{formatDocumentBytes(document.sizeBytes)}</small></span>
              </button>
            ))}
          </nav>
          <article ref={viewerRef} className="documents-viewer" aria-label={selected ?? "Document viewer"} aria-busy={viewerBusy || undefined}>
            {viewerBusy ? (
              <div className="documents-loading-indicator" role="status" aria-live="polite">
                <span><LoaderCircle className="spin" size={16} aria-hidden="true" /></span>
                <span className="sr-only">Loading {selected}</span>
              </div>
            ) : null}
            {contentError ? <p className="error-text" role="alert">{contentError}</p> : loadedContentKey ? (
              <div key={selectedDocumentKey} className="documents-viewer-content" data-loading={viewerBusy || undefined} aria-hidden={viewerBusy || undefined}>
                <MarkdownLinkBehaviorProvider documents={documents} onOpenDocument={onOpenDocument} onSelectDocument={selectDocument} onNavigateFragment={navigateToFragment} onNavigationError={setNavigationError}>
                  <MarkdownBlock text={content} components={documentMarkdownComponents} headingAnchors />
                </MarkdownLinkBehaviorProvider>
                {navigationError ? <p className="error-text" role="alert">{navigationError}</p> : null}
              </div>
            ) : viewerBusy ? (
              <div className="documents-viewer-skeleton" aria-hidden="true">
                <span /><span /><span /><span /><span />
              </div>
            ) : null}
          </article>
        </div>
      )}
    </Modal>
  );
}

export function DocumentsButton({ documentCount, open, onOpen }: { documentCount: number; open: boolean; onOpen: () => void }) {
  if (documentCount === 0) return null;
  return (
    <button
      className="session-documents-button"
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="Open session documents"
      title="Documents"
    >
      <FileText size={17} />
      <span className="session-action-label">Documents</span>
    </button>
  );
}

function heavyStateLabel(state: HeavyCommand["state"]): string {
  return { waiting: "Waiting for slot", reserved: "Resuming session", running: "Running", stalled: "No observed progress", terminating: "Terminating", reporting: "Reporting result" }[state];
}

function compactDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "now";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatDocumentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function formatHeavyCachePaths(command: HeavyCommand): string {
  const entries = Object.entries(command.packageDiagnostics?.cachePaths ?? {});
  return entries.length ? entries.map(([name, value]) => `${name}=${value.path} (${value.writable ? "writable" : "not writable"})`).join(" · ") : "not configured";
}

interface TranscriptSourceIdentity {
  sessionId: string;
  codexSessionId: string | null;
  codexJsonlPath: string | null;
}

export function transcriptSourceKey(source: TranscriptSourceIdentity): string {
  return [source.sessionId, source.codexSessionId ?? "", source.codexJsonlPath ?? ""].join("\u0000");
}

export function sessionTranscriptSource(session: ManagedSession): TranscriptSourceIdentity {
  return {
    sessionId: session.id,
    codexSessionId: session.codexSessionId,
    codexJsonlPath: session.codexJsonlPath
  };
}

export function sessionCreateSessionCwd(session: { cwd: string; repo: Pick<ManagedSession["repo"], "root">; gitWorkspace?: Pick<GitWorkspaceSummary, "entryPath"> | null }): string {
  return session.gitWorkspace?.entryPath ?? session.repo.root ?? session.cwd;
}

export function shouldReplaceTranscriptForSource(currentSourceKey: string | null, nextSourceKey: string): boolean {
  return currentSourceKey !== null && currentSourceKey !== nextSourceKey;
}

export const PLAN_ACTION_LABELS: Record<PlanAction, string> = {
  implement: "Yes, implement the plan",
  clear_context_implement: "Yes, clear context and implement",
  stay_in_plan: "No, stay in plan mode"
};

export function shouldCompactSessionHeaderStatus({
  headerWidth,
  backWidth,
  headerGap,
  titleRequiredWidth,
  runtimeNonStatusWidth,
  runtimeGap,
  runtimeNonStatusItems,
  fullStatusWidth
}: {
  headerWidth: number;
  backWidth: number;
  headerGap: number;
  titleRequiredWidth: number;
  runtimeNonStatusWidth: number;
  runtimeGap: number;
  runtimeNonStatusItems: number;
  fullStatusWidth: number;
}): boolean {
  const runtimeWidth = runtimeNonStatusWidth + fullStatusWidth + runtimeGap * runtimeNonStatusItems;
  return backWidth + headerGap * 2 + titleRequiredWidth + runtimeWidth > headerWidth + 0.5;
}

function useAdaptiveSessionHeaderStatus(measurementKey: string) {
  const headerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<HTMLDivElement>(null);
  const statusProbeRef = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const title = titleRef.current;
    const runtime = runtimeRef.current;
    const statusProbe = statusProbeRef.current;
    if (!header || !title || !runtime || !statusProbe) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      if (!window.matchMedia("(max-width: 819px)").matches) {
        setCompact(false);
        return;
      }
      const back = header.querySelector<HTMLElement>(":scope > .icon-button");
      const fullStatus = statusProbe.querySelector<HTMLElement>(".status");
      if (!back || !fullStatus) return;
      const headerStyles = window.getComputedStyle(header);
      const runtimeStyles = window.getComputedStyle(runtime);
      const runtimeItems = Array.from(runtime.children).filter((child): child is HTMLElement => {
        if (!(child instanceof HTMLElement) || child === statusProbe || child.classList.contains("status")) return false;
        const styles = window.getComputedStyle(child);
        return styles.display !== "none" && styles.position !== "absolute";
      });
      const heading = title.querySelector<HTMLElement>(".session-title-heading");
      const titleRequiredWidth = Math.max(
        heading ? intrinsicRowWidth(heading) : intrinsicElementWidth(title.querySelector<HTMLElement>(":scope > h1")),
        intrinsicRowWidth(title.querySelector<HTMLElement>(".session-header-meta"))
      );
      setCompact(shouldCompactSessionHeaderStatus({
        headerWidth: header.clientWidth,
        backWidth: back.getBoundingClientRect().width,
        headerGap: cssPixels(headerStyles.columnGap),
        titleRequiredWidth,
        runtimeNonStatusWidth: runtimeItems.reduce((total, item) => total + item.getBoundingClientRect().width, 0),
        runtimeGap: cssPixels(runtimeStyles.columnGap),
        runtimeNonStatusItems: runtimeItems.length,
        fullStatusWidth: fullStatus.getBoundingClientRect().width
      }));
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(header);
    observer.observe(title);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [measurementKey]);

  return { compact, headerRef, runtimeRef, statusProbeRef, titleRef };
}

function intrinsicRowWidth(row: HTMLElement | null): number {
  if (!row) return 0;
  const visibleChildren = Array.from(row.children).filter((child): child is HTMLElement => {
    return child instanceof HTMLElement && window.getComputedStyle(child).display !== "none";
  });
  if (visibleChildren.length === 0) return row.scrollWidth;
  const gap = cssPixels(window.getComputedStyle(row).columnGap);
  return visibleChildren.reduce((total, child) => total + Math.max(child.scrollWidth, child.getBoundingClientRect().width), 0)
    + gap * Math.max(0, visibleChildren.length - 1);
}

function intrinsicElementWidth(element: HTMLElement | null): number {
  return element ? Math.max(element.scrollWidth, element.getBoundingClientRect().width) : 0;
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function resolveSessionDocumentReference(
  reference: SessionDocumentReference,
  currentSession: ManagedSession,
  currentDocuments: SessionDocumentSummary[],
  visibleSessions: ManagedSession[],
  loadAllSessions: () => Promise<ManagedSession[]>,
  loadDocuments: (sessionId: string) => Promise<SessionDocumentSummary[]>
): Promise<{ session: ManagedSession; documents: SessionDocumentSummary[] } | null> {
  const visible = [currentSession, ...visibleSessions.filter((candidate) => candidate.id !== currentSession.id)];
  let owner = visible.find((candidate) => candidate.documentScopeId === reference.scopeId) ?? null;
  if (!owner) {
    owner = (await loadAllSessions()).find((candidate) => candidate.documentScopeId === reference.scopeId) ?? null;
  }
  if (!owner) return null;

  let ownerDocuments = owner.id === currentSession.id ? currentDocuments : [];
  if (!ownerDocuments.some((document) => document.name === reference.name)) {
    ownerDocuments = await loadDocuments(owner.id);
  }
  return ownerDocuments.some((document) => document.name === reference.name)
    ? { session: owner, documents: ownerDocuments }
    : null;
}

export function SessionView() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    refreshSessionStoplight,
    syncSessionStoplight,
    sessions: shellSessions,
    openCreateSession,
    openForkSession,
    registerCreateSessionCwdPrefill,
    registerPromptHistoryPrefill,
    registerPrimaryInputFocus,
    connectionEpoch,
    accessMode,
    subscribeSessionEvents
  } = useOutletContext<AppShellOutletContext>();
  const [session, setSession] = useState<ManagedSession | null>(null);
  const [transcriptItems, setTranscriptItems] = useState<CoreTranscriptItem[]>([]);
  const [initialTranscriptSessionId, setInitialTranscriptSessionId] = useState<string | null>(null);
  const [initialScrollReady, setInitialScrollReady] = useState(false);
  const [text, setText] = useState(() => loadComposerDraft(id));
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<ApprovalDecision | null>(null);
  const [approvalError, setApprovalError] = useState("");
  const [question, setQuestion] = useState<QuestionRequest | null>(null);
  const [questionBusy, setQuestionBusy] = useState(false);
  const [questionError, setQuestionError] = useState("");
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([]);
  const [planActionBusy, setPlanActionBusy] = useState<PlanAction | null>(null);
  const [planActionError, setPlanActionError] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [composerUploading, setComposerUploading] = useState(false);
  const [actionBusy, setActionBusy] = useState<SessionAction["type"] | null>(null);
  const [inputDeliveryError, setInputDeliveryError] = useState("");
  const [agentGuardError, setAgentGuardError] = useState("");
  const [sessionLoadError, setSessionLoadError] = useState("");
  const [sessionLoadRetrying, setSessionLoadRetrying] = useState(false);
  const [sessionLoadRetryNonce, setSessionLoadRetryNonce] = useState(0);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [requestedDocument, setRequestedDocument] = useState<string | null>(null);
  const [requestedDocumentFragment, setRequestedDocumentFragment] = useState<string | null>(null);
  const [requestedDocumentNavigation, setRequestedDocumentNavigation] = useState(0);
  const [documents, setDocuments] = useState<SessionDocumentSummary[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState("");
  const [referencedDocumentSource, setReferencedDocumentSource] = useState<ReferencedDocumentSource | null>(null);
  const [btwOpen, setBtwOpen] = useState(false);
  const [btwExchanges, setBtwExchanges] = useState<BtwExchange[]>([]);
  const [btwLoading, setBtwLoading] = useState(true);
  const [btwError, setBtwError] = useState("");
  const [btwSubmitting, setBtwSubmitting] = useState(false);
  const [btwCompletedWhileClosed, setBtwCompletedWhileClosed] = useState(false);
  const [heavyCommands, setHeavyCommands] = useState<HeavyCommand[]>([]);
  const [heavyCommandsOpen, setHeavyCommandsOpen] = useState(false);
  const [heavyOutputs, setHeavyOutputs] = useState<Record<string, string>>({});
  const [heavyCommandError, setHeavyCommandError] = useState("");
  const [terminatingHeavyRun, setTerminatingHeavyRun] = useState<string | null>(null);
  const [inputModeError, setInputModeError] = useState("");
  const [fastModeError, setFastModeError] = useState("");
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalogResponse | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelSettingsError, setModelSettingsError] = useState("");
  const [modelSettingsApplying, setModelSettingsApplying] = useState<CollaborationMode | null>(null);
  const [approvalModeApplying, setApprovalModeApplying] = useState(false);
  const [approvalModeError, setApprovalModeError] = useState("");
  const [copiedAttachCommand, setCopiedAttachCommand] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageActionMenuState | null>(null);
  const [imagePreview, setImagePreview] = useState<SessionImageTarget | null>(null);
  const [messageActionError, setMessageActionError] = useState("");
  const [codexSkills, setCodexSkills] = useState<CodexSkill[]>([]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState<{ nonce: number; command: PrimaryInputFocusCommand } | null>(null);
  const [vimEnabled, setVimEnabled] = useState(loadVimModePreference);
  const [transcriptFindOpen, setTranscriptFindOpen] = useState(false);
  const [transcriptFindQuery, setTranscriptFindQuery] = useState("");
  const [transcriptFindMatchIndex, setTranscriptFindMatchIndex] = useState(0);
  const [transcriptFindMatches, setTranscriptFindMatches] = useState<TranscriptSearchMatch[]>([]);
  const [transcriptFindLoading, setTranscriptFindLoading] = useState(false);
  const [transcriptFindError, setTranscriptFindError] = useState("");
  const vimAvailable = useDesktopVimAvailable();
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [hasMoreAfter, setHasMoreAfter] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [jumpBusy, setJumpBusy] = useState<"top" | "bottom" | null>(null);
  const [jumpVisibility, setJumpVisibility] = useState<TranscriptJumpVisibility>({ top: false, bottom: false });
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const [sentQueuedUserMessage, setSentQueuedUserMessage] = useState<PendingUserMessage | null>(null);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set());
  const [expandedRangeItems, setExpandedRangeItems] = useState<Record<string, CoreTranscriptItem[]>>({});
  const [loadingRanges, setLoadingRanges] = useState<Set<string>>(() => new Set());
  const adaptiveHeaderStatus = useAdaptiveSessionHeaderStatus([
    id,
    session?.status ?? "",
    session?.contextUsage?.contextPercent ?? "",
    session?.agentOwnership?.parentSessionId ?? "",
    session?.forkedFrom?.sessionName ?? "",
    session ? sessionDisplayName(session) : ""
  ].join("\0"));
  const messageListRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ManagedSession | null>(null);
  const requestTokenRef = useRef(0);
  const sessionRefreshRequestRef = useRef(0);
  const approvalRefreshRequestRef = useRef(0);
  const questionRefreshRequestRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadingSearchPageRef = useRef(false);
  const transcriptRefreshGateRef = useRef(new LatestGenerationRefreshGate());
  const liveTailRefreshSchedulerRef = useRef(new LiveTranscriptRefreshScheduler());
  const pendingInputModeRef = useRef<CollaborationMode | null>(null);
  const pendingFastModeRef = useRef<boolean | null>(null);
  const modelCatalogRequestSessionRef = useRef<string | null>(null);
  const transcriptSourceKeyRef = useRef<string | null>(null);
  const initialTranscriptSessionIdRef = useRef<string | null>(null);
  const hasMoreAfterRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const lastSequenceRef = useRef(0);
  const lastMessageListScrollTopRef = useRef(0);
  const preserveScrollRef = useRef<ScrollAnchorSnapshot | null>(null);
  const scrollBehaviorRef = useRef<ScrollBehavior>("bottom");
  const bottomContentKeyRef = useRef("");
  const skillsRefreshRunningRef = useRef(false);
  const skillsLastRefreshRef = useRef(0);
  const activeIdRef = useRef(id);
  const previousEffectIdRef = useRef(id);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const btwOpenRef = useRef(false);
  const transcriptFindInputRef = useRef<HTMLInputElement>(null);
  const transcriptFindRequestRef = useRef(0);
  const documentReferenceRequestRef = useRef(0);
  const referencedDocumentSourceRef = useRef<ReferencedDocumentSource | null>(null);
  const vimPendingGRef = useRef(false);
  const vimPendingGTimerRef = useRef<number | null>(null);
  const promptHistoryPrefillTextRef = useRef(text);
  activeIdRef.current = id;
  btwOpenRef.current = btwOpen;
  referencedDocumentSourceRef.current = referencedDocumentSource;
  promptHistoryPrefillTextRef.current = text;

  const closeGitPanel = useCallback(() => {
    setGitPanelOpen(false);
  }, []);

  const loadedMessages = useMemo(() => transcriptMessages(transcriptItems), [transcriptItems]);
  const inputDeliveryFailure = useMemo(() => inputDeliveryFailureDetail(loadedMessages), [loadedMessages]);
  const lastSequence = useMemo(() => transcriptItems.at(-1)?.lastSequence ?? 0, [transcriptItems]);
  const firstSequence = useMemo(() => transcriptItems[0]?.firstSequence ?? 0, [transcriptItems]);
  lastSequenceRef.current = lastSequence;
  const pendingPlan = useMemo(() => pendingProposedPlanMessage(loadedMessages), [loadedMessages]);
  const childAttention = useMemo(
    () => session ? childSessionAttentionItems(session, [session, ...shellSessions.filter((candidate) => candidate.id !== session.id)]) : [],
    [session, shellSessions]
  );
  const showWorkingIndicator = !session?.transcriptSyncing && shouldShowWorkingIndicator(session?.status, hasMoreAfter);
  const showQueuedIndicator = !session?.transcriptSyncing && shouldShowQueuedIndicator(session?.status, hasMoreAfter);
  const showTranscriptSyncIndicator = session?.transcriptSyncing === true && !hasMoreAfter;
  const effectivePendingUserMessage = useMemo(
    () => latestUnmatchedPendingUserMessage(transcriptItems, [pendingUserMessage, sentQueuedUserMessage]),
    [pendingUserMessage, sentQueuedUserMessage, transcriptItems]
  );
  const pendingUserChatMessage = useMemo(
    () => (effectivePendingUserMessage ? pendingUserMessageToChatMessage(effectivePendingUserMessage) : null),
    [effectivePendingUserMessage]
  );
  const lastUserPromptAt = useMemo(
    () => latestUserPromptTimestamp(pendingUserChatMessage ? [...loadedMessages, pendingUserChatMessage] : loadedMessages),
    [loadedMessages, pendingUserChatMessage]
  );
  const composerLock = session?.agentOwnership?.completedAt
    ? "This agent-managed session is complete. Its transcript is read-only."
    : session?.status === "input_failed"
    ? "Resolve the failed input delivery before sending another message."
    : composerLockReason(Boolean(question), Boolean(pendingPlan), session?.runtimeUnavailableReason ?? session?.startupError);
  const composerLocked = Boolean(composerLock);
  const effectiveVimEnabled = vimAvailable && vimEnabled;
  const currentTranscriptFindMatch = transcriptFindMatches[transcriptFindMatchIndex] ?? null;
  const questionRenderedInline = Boolean(
    question &&
      (transcriptItems.some((item) => transcriptItemContainsMessageId(item, question.messageId)) ||
        Object.values(expandedRangeItems).some((items) => items.some((item) => transcriptItemContainsMessageId(item, question.messageId))))
  );
  const approvalRenderedInline = Boolean(
    approval &&
      (transcriptItems.some((item) => transcriptItemContainsMessageId(item, approval.messageId)) ||
        Object.values(expandedRangeItems).some((items) => items.some((item) => transcriptItemContainsMessageId(item, approval.messageId))))
  );
  const bottomContentKey = [
    id,
    pendingUserChatMessage?.id ?? "",
    showTranscriptSyncIndicator ? "sync" : "",
    showWorkingIndicator ? `working:${session?.status ?? ""}` : "",
    showQueuedIndicator ? "queued" : "",
    question && !questionRenderedInline ? `question:${question.messageId}` : "",
    approval ? `approval:${approval.id}` : "",
    childAttention.map((item) => `${item.session.id}:${item.status}`).join(","),
    queuedInputs.map((input) => `${input.id}:${input.status}`).join(","),
    hasMoreAfter ? "newer" : ""
  ].join("\0");

  const refreshCodexSkills = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!id || skillsRefreshRunningRef.current) return;
      const now = Date.now();
      if (!options.force && now - skillsLastRefreshRef.current < SKILL_REFRESH_STALE_MS) return;
      skillsRefreshRunningRef.current = true;
      try {
        const response = await api.codexSkills(id);
        if (activeIdRef.current === id) {
          setCodexSkills(response.skills);
          skillsLastRefreshRef.current = Date.now();
        }
      } catch {
        if (activeIdRef.current === id && options.force) setCodexSkills([]);
      } finally {
        skillsRefreshRunningRef.current = false;
      }
    },
    [id]
  );

  useEffect(() => {
    setCodexSkills([]);
    skillsLastRefreshRef.current = 0;
    void refreshCodexSkills({ force: true });
    const interval = window.setInterval(() => void refreshCodexSkills(), SKILL_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshCodexSkills]);

  useEffect(() => registerPromptHistoryPrefill(() => promptHistoryPrefillTextRef.current), [registerPromptHistoryPrefill]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(
    () => registerCreateSessionCwdPrefill(() => (sessionRef.current ? sessionCreateSessionCwd(sessionRef.current) : "")),
    [registerCreateSessionCwdPrefill]
  );

  useEffect(
    () =>
      registerPrimaryInputFocus((command) => {
        if (!sessionRef.current || approval || submitBusy || composerLocked) return false;
        setComposerFocusRequest((current) => ({ nonce: (current?.nonce ?? 0) + 1, command }));
        return true;
      }),
    [approval, composerLocked, registerPrimaryInputFocus, submitBusy]
  );

  useEffect(() => {
    const handleSessionBackShortcut = (event: globalThis.KeyboardEvent) => {
      if (!shouldHandleSessionBackShortcut(event, document)) return;
      event.preventDefault();
      navigate("/");
    };
    document.addEventListener("keydown", handleSessionBackShortcut);
    return () => document.removeEventListener("keydown", handleSessionBackShortcut);
  }, [navigate]);

  useEffect(() => {
    if (!transcriptFindOpen) return undefined;
    const animationFrame = window.requestAnimationFrame(() => transcriptFindInputRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [transcriptFindOpen]);

  useEffect(() => {
    if (!transcriptFindOpen) {
      transcriptFindRequestRef.current += 1;
      setTranscriptFindMatches([]);
      setTranscriptFindLoading(false);
      setTranscriptFindError("");
      return undefined;
    }
    const query = transcriptFindQuery.trim();
    setTranscriptFindMatchIndex(0);
    if (!query) {
      transcriptFindRequestRef.current += 1;
      setTranscriptFindMatches([]);
      setTranscriptFindLoading(false);
      setTranscriptFindError("");
      return undefined;
    }

    const request = transcriptFindRequestRef.current + 1;
    transcriptFindRequestRef.current = request;
    setTranscriptFindLoading(true);
    setTranscriptFindError("");
    const timeout = window.setTimeout(() => {
      void api
        .messageSearch(id, query)
        .then((response) => {
          if (transcriptFindRequestRef.current !== request || activeIdRef.current !== id) return;
          if (response.sessionId !== id) return;
          const expectedSourceKey = transcriptSourceKeyRef.current;
          if (expectedSourceKey && transcriptSourceKey(response) !== expectedSourceKey) return;
          setTranscriptFindMatches(response.matches);
        })
        .catch(() => {
          if (transcriptFindRequestRef.current === request && activeIdRef.current === id) {
            setTranscriptFindMatches([]);
            setTranscriptFindError("Search failed");
          }
        })
        .finally(() => {
          if (transcriptFindRequestRef.current === request && activeIdRef.current === id) setTranscriptFindLoading(false);
        });
    }, 200);

    return () => window.clearTimeout(timeout);
  }, [id, transcriptFindOpen, transcriptFindQuery]);

  useEffect(() => {
    if (!transcriptFindMatches.length) {
      if (transcriptFindMatchIndex !== 0) setTranscriptFindMatchIndex(0);
      return;
    }
    if (transcriptFindMatchIndex >= transcriptFindMatches.length) {
      setTranscriptFindMatchIndex(0);
    }
  }, [transcriptFindMatchIndex, transcriptFindMatches.length]);

  useEffect(() => {
    if (!transcriptFindOpen || !currentTranscriptFindMatch) return;
    const container = messageListRef.current;
    if (container && transcriptItemElement(container, currentTranscriptFindMatch.itemId)) {
      scrollToTranscriptItem(currentTranscriptFindMatch.itemId);
      return;
    }
    void loadTranscriptFindMatchPage(currentTranscriptFindMatch);
  }, [currentTranscriptFindMatch, transcriptFindOpen, transcriptItems]);

  useEffect(() => {
    const handleFindKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "f") return;
      if (effectiveVimEnabled && !shouldIgnoreTranscriptVimKeyTarget(event.target)) return;
      event.preventDefault();
      setTranscriptFindOpen(true);
      window.requestAnimationFrame(() => {
        transcriptFindInputRef.current?.focus();
        transcriptFindInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleFindKeyDown);
    return () => window.removeEventListener("keydown", handleFindKeyDown);
  }, [effectiveVimEnabled]);

  useEffect(() => {
    if (!effectiveVimEnabled) {
      clearPendingTranscriptVimPrefix();
      return undefined;
    }

    const handleTranscriptVimKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreTranscriptVimKeyTarget(event.target)) return;
      const result = transcriptVimNavigationCommand(event, vimPendingGRef.current);
      clearPendingTranscriptVimPrefix();
      if (result.pendingG) {
        vimPendingGRef.current = true;
        vimPendingGTimerRef.current = window.setTimeout(clearPendingTranscriptVimPrefix, 800);
      }
      if (result.preventDefault) event.preventDefault();
      if (!result.command) return;
      runTranscriptVimCommand(result.command);
    };

    window.addEventListener("keydown", handleTranscriptVimKeyDown);
    return () => {
      window.removeEventListener("keydown", handleTranscriptVimKeyDown);
      clearPendingTranscriptVimPrefix();
    };
  }, [effectiveVimEnabled, id, jumpBusy]);

  useDismissableContextMenu(Boolean(messageMenu), messageMenuRef, () => setMessageMenu(null));

  function openMessageMenu(message: ChatMessage, x: number, y: number) {
    const text = copyableMessageText(message);
    if (!text.trim()) return;
    setMessageActionError("");
    setMessageMenu({ copyTarget: { label: copyMessageActionLabel(message), text }, x, y });
  }

  function openImageMenu(image: SessionImageTarget, copyTarget: MessageCopyTarget | undefined, x: number, y: number) {
    setMessageActionError("");
    setMessageMenu({ image, copyTarget, x, y });
  }

  async function toggleExpandedItem(item: CoreTranscriptItem) {
    if (item.type !== "range") return;
    if (!expandedStacks.has(item.id) && !expandedRangeItems[item.id]) {
      const expectedSourceKey = transcriptSourceKeyRef.current;
      setLoadingRanges((current) => new Set(current).add(item.id));
      try {
        const response = await api.messageRange(id, item.firstSequence, item.lastSequence);
        if (!isCurrentTranscriptResponse(id, requestTokenRef.current, response)) return;
        if (!expectedSourceKey || transcriptSourceKey(response) !== expectedSourceKey) return;
        setExpandedRangeItems((current) => ({ ...current, [item.id]: response.items }));
      } finally {
        setLoadingRanges((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    }
    setExpandedStacks((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  async function openDocumentReference(reference: SessionDocumentReference): Promise<boolean> {
    if (!session) return false;
    const request = documentReferenceRequestRef.current + 1;
    documentReferenceRequestRef.current = request;
    try {
      const resolved = await resolveSessionDocumentReference(
        reference,
        session,
        documents,
        shellSessions,
        async () => (await api.transferableSessions()).sessions,
        async (sessionId) => (await api.sessionDocuments(sessionId)).documents
      );
      if (documentReferenceRequestRef.current !== request) return true;
      if (!resolved) return false;

      if (resolved.session.id === session.id) {
        setDocuments(resolved.documents);
        setReferencedDocumentSource(null);
      } else {
        setReferencedDocumentSource({
          sessionId: resolved.session.id,
          sessionName: sessionDisplayName(resolved.session),
          documents: resolved.documents
        });
      }
      setRequestedDocument(reference.name);
      setRequestedDocumentFragment(reference.fragment ?? null);
      setRequestedDocumentNavigation((current) => current + 1);
      setDocumentsOpen(true);
      return true;
    } catch (error) {
      console.error("Unable to open referenced session document", error);
      return false;
    }
  }

  function closeDocuments() {
    documentReferenceRequestRef.current += 1;
    setDocumentsOpen(false);
    setRequestedDocument(null);
    setRequestedDocumentFragment(null);
    setReferencedDocumentSource(null);
  }

  function showCurrentDocuments(requested: string | null = null) {
    documentReferenceRequestRef.current += 1;
    setReferencedDocumentSource(null);
    setRequestedDocument(requested);
    setRequestedDocumentFragment(null);
    setDocumentsOpen(true);
  }

  function renderTranscriptItem(item: CoreTranscriptItem): ReactNode {
    if (item.type === "message") {
      return (
        <MessageBubble
          key={item.message.id}
          itemId={item.id}
          message={item.message}
          onOpenDocument={openDocumentReference}
          onOpenMenu={openMessageMenu}
          onOpenImage={setImagePreview}
          onOpenImageMenu={openImageMenu}
          planAction={
            pendingPlan?.id === item.message.id ? (
              <PlanActionBanner
                busy={planActionBusy}
                disabled={session?.initializing === true}
                error={planActionError}
                onAction={submitPlanAction}
              />
            ) : null
          }
          planOutcome={interactionOutcome(item.message)}
          approvalAction={
            approval?.messageId === item.message.id ? (
              <ApprovalBanner
                approval={approval}
                automationMode={session?.approvalMode ?? "ask"}
                busy={approvalBusy}
                disabled={session?.initializing === true}
                error={approvalError}
                onDecision={resolveApproval}
              />
            ) : null
          }
          questionAction={
            question?.messageId === item.message.id ? (
              <QuestionBanner
                key={question.id}
                question={question}
                busy={questionBusy}
                submitDisabled={session?.initializing === true}
                error={questionError}
                onAnswer={answerQuestion}
              />
            ) : null
          }
        />
      );
    }
    if (item.type === "user_action") return <UserAction key={item.message.id} itemId={item.id} message={item.message} onOpenMenu={openMessageMenu} />;
    return (
      <TranscriptRange
        key={item.id}
        itemId={item.id}
        item={item}
        expanded={expandedStacks.has(item.id)}
        loading={loadingRanges.has(item.id)}
        expandedItems={expandedRangeItems[item.id] ?? []}
        onToggle={() => void toggleExpandedItem(item)}
        renderItem={renderTranscriptItem}
      />
    );
  }

  useEffect(() => {
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    const idChanged = previousEffectIdRef.current !== id;
    previousEffectIdRef.current = id;
    if (idChanged || connectionEpoch === 0) {
      setSession(null);
      setTranscriptItems([]);
      clearInitialTranscriptSessionId();
      setInitialScrollReady(false);
      setText(loadComposerDraft(id));
      setApproval(null);
      setApprovalBusy(null);
      setApprovalError("");
      setQuestion(null);
      setQuestionBusy(false);
      setQuestionError("");
      setQueuedInputs([]);
      setPlanActionBusy(null);
      setPlanActionError("");
      setSubmitBusy(false);
      setActionBusy(null);
      setAgentGuardError("");
      pendingFastModeRef.current = null;
      setInputModeError("");
      setFastModeError("");
      setModelSettingsOpen(false);
      setModelCatalog(null);
      setModelCatalogLoading(false);
      setModelSettingsError("");
      setModelSettingsApplying(null);
      modelCatalogRequestSessionRef.current = null;
      setCopiedAttachCommand(false);
      setMessageMenu(null);
      setImagePreview(null);
      setMessageActionError("");
      setGitPanelOpen(false);
      setDocumentsOpen(false);
      setRequestedDocument(null);
      setRequestedDocumentFragment(null);
      setDocuments([]);
      setDocumentsLoading(true);
      setDocumentsError("");
      setReferencedDocumentSource(null);
      documentReferenceRequestRef.current += 1;
      setHeavyCommands([]);
      setHeavyCommandsOpen(false);
      setHeavyOutputs({});
      setHeavyCommandError("");
      setTerminatingHeavyRun(null);
      setComposerFocused(false);
      setTranscriptFindOpen(false);
      setTranscriptFindQuery("");
      setTranscriptFindMatchIndex(0);
      setTranscriptFindMatches([]);
      setTranscriptFindLoading(false);
      setTranscriptFindError("");
      transcriptFindRequestRef.current += 1;
      setPagination(false, false);
      setLoadingOlder(false);
      setLoadingNewer(false);
      setJumpBusy(null);
      setJumpVisibility({ top: false, bottom: false });
      setPendingUserMessage(null);
      setSentQueuedUserMessage(null);
      setExpandedRangeItems({});
      setLoadingRanges(new Set());
      transcriptSourceKeyRef.current = null;
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
      isNearBottomRef.current = true;
      lastMessageListScrollTopRef.current = 0;
      preserveScrollRef.current = null;
      scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("initial", true);
      setExpandedStacks(new Set());
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    let noticeTimer: number | null = null;
    let activeController: AbortController | null = null;
    let latestRetryableError = "The connection was interrupted while loading this session.";
    let retryAttempt = 0;
    let terminalFailure = false;

    const clearRetryTimer = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    function scheduleRetry() {
      if (cancelled || initialTranscriptSessionIdRef.current === id || retryTimer !== null) return;
      const delayMs = sessionBootstrapRetryDelay(retryAttempt);
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (document.visibilityState === "visible") void bootstrap();
        else scheduleRetry();
      }, delayMs);
    }
    async function bootstrap() {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), SESSION_BOOTSTRAP_TIMEOUT_MS);
      try {
        const applied = await loadSnapshot(id, token, true, controller.signal);
        if (cancelled || !isCurrentRequest(id, token)) return;
        if (applied) {
          clearRetryTimer();
          setSessionLoadError("");
          setSessionLoadRetrying(false);
          return;
        }
        scheduleRetry();
      } catch (error) {
        if (cancelled || !isCurrentRequest(id, token)) return;
        const terminalError = terminalSessionBootstrapError(error);
        if (terminalError) {
          terminalFailure = true;
          clearRetryTimer();
          setSessionLoadError(terminalError);
          setSessionLoadRetrying(false);
          return;
        }
        latestRetryableError = error instanceof DOMException && error.name === "AbortError"
          ? "Loading this session timed out."
          : "The connection was interrupted while loading this session.";
        scheduleRetry();
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = null;
      }
    }

    setSessionLoadError("");
    setSessionLoadRetrying(false);
    noticeTimer = window.setTimeout(() => {
      if (!cancelled && !terminalFailure && initialTranscriptSessionIdRef.current !== id) {
        setSessionLoadError(latestRetryableError);
        setSessionLoadRetrying(true);
      }
    }, SESSION_BOOTSTRAP_NOTICE_MS);
    void bootstrap();
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible" || !isLiveManagedSession(sessionRef.current)) return;
      void loadSnapshot(id, token, false).catch(() => undefined);
    }, SESSION_RECONCILE_INTERVAL_MS);
    return () => {
      cancelled = true;
      activeController?.abort();
      clearRetryTimer();
      if (noticeTimer !== null) window.clearTimeout(noticeTimer);
      clearInterval(interval);
    };
  }, [connectionEpoch, id, sessionLoadRetryNonce]);

  useEffect(() => {
    return () => liveTailRefreshSchedulerRef.current.cancel();
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const refreshDocuments = async () => {
      if (refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try {
        const response = await api.sessionDocuments(id);
        if (cancelled) return;
        setDocuments(response.documents);
        setDocumentsError("");
        if (response.documents.length === 0 && !referencedDocumentSourceRef.current) setDocumentsOpen(false);
      } catch (error) {
        if (!cancelled) setDocumentsError(error instanceof Error ? error.message : "Unable to load documents");
      } finally {
        if (!cancelled) setDocumentsLoading(false);
        refreshing = false;
      }
    };
    void refreshDocuments();
    const interval = window.setInterval(
      () => void refreshDocuments(),
      SESSION_DOCUMENTS_RECONCILE_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connectionEpoch, id]);

  useEffect(() => {
    let cancelled = false;
    setBtwLoading(true);
    setBtwExchanges([]);
    setBtwError("");
    setBtwSubmitting(false);
    setBtwCompletedWhileClosed(false);
    void api.btwExchanges(id)
      .then((response) => {
        if (!cancelled) {
          setBtwExchanges((current) => response.exchanges.reduce(upsertBtwExchange, current));
          setBtwError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setBtwError(error instanceof Error ? error.message : "Unable to load BTW history");
      })
      .finally(() => {
        if (!cancelled) setBtwLoading(false);
      });
    return () => { cancelled = true; };
  }, [connectionEpoch, id]);

  useEffect(() => {
    return subscribeSessionEvents((event) => {
      if (event.sessionId !== id) return;
      if (event.type === "btw.started") {
        setBtwExchanges((current) => upsertBtwExchange(current, event.payload as BtwExchange));
        return;
      }
      if (event.type === "btw.delta") {
        setBtwExchanges((current) => appendBtwDelta(current, event.payload as BtwDeltaPayload));
        return;
      }
      if (event.type === "btw.updated") {
        setBtwExchanges((current) => upsertBtwExchange(current, event.payload as BtwExchange));
        return;
      }
      if (event.type === "btw.finished") {
        setBtwExchanges((current) => upsertBtwExchange(current, event.payload as BtwExchange));
        if (!btwOpenRef.current) setBtwCompletedWhileClosed(true);
        return;
      }
      if (event.type === "documents.updated") {
        const token = requestTokenRef.current;
        void api.sessionDocuments(id).then((response) => {
          if (!isCurrentRequest(id, token)) return;
          setDocuments(response.documents);
          setDocumentsError("");
          setDocumentsLoading(false);
        }).catch((error) => {
          if (!isCurrentRequest(id, token)) return;
          setDocumentsError(error instanceof Error ? error.message : "Unable to load documents");
        });
        return;
      }
      sessionRefreshRequestRef.current += 1;
      const token = requestTokenRef.current;
      if (event.type === "message.appended") {
        const nextMessage = event.payload as ChatMessage;
        if (!hasMoreAfterRef.current) {
          liveTailRefreshSchedulerRef.current.schedule(() => void refreshLiveTailMessages(id, token));
        }
        if (nextMessage.type === "approval_request") void loadApproval(id, token);
        if (nextMessage.type === "question_request") void loadQuestion(id, token);
        return;
      }
      if (event.type === "queue.updated") {
        void loadQueuedInputs(id, token);
        return;
      }
      if (event.type === "session.updated") {
        const nextSession = sessionWithPendingFastMode(
          sessionWithPendingInputMode(event.payload as ManagedSession, pendingInputModeRef.current),
          pendingFastModeRef.current
        );
        clearTranscriptOnSessionSourceChange(nextSession);
        setSession(nextSession);
        syncSessionStoplight(nextSession);
        refreshPendingActionForEvent(event);
        return;
      }
      if (event.type === "status.changed") {
        void loadSession(id, token);
        refreshPendingActionForEvent(event);
      }

      function refreshPendingActionForEvent(sessionEvent: Pick<SessionEvent, "type" | "payload">): void {
        const pendingAction = pendingActionRefreshForEvent(sessionEvent);
        if (pendingAction === "approval") void loadApproval(id, token);
        if (pendingAction === "question") void loadQuestion(id, token);
      }
    });
  }, [id, subscribeSessionEvents]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await api.heavyCommands(id);
        if (cancelled) return;
        setHeavyCommands(response.commands.map((command) =>
          command.runId === terminatingHeavyRun ? { ...command, state: "terminating" } : command
        ));
        setHeavyCommandError("");
        if (heavyCommandsOpen) {
          const outputs = await Promise.all(response.commands.map(async (command) => {
            try {
              const result = await api.heavyCommandOutput(id, command.runId);
              return [command.runId, `${result.truncated ? "[showing the last 128 KiB]\n" : ""}${result.output}`] as const;
            }
            catch { return [command.runId, "Output is unavailable."] as const; }
          }));
          if (!cancelled) setHeavyOutputs(Object.fromEntries(outputs));
        }
      } catch (error) {
        if (!cancelled) setHeavyCommandError(error instanceof Error ? error.message : "Unable to load heavyweight commands");
      }
    };
    void refresh();
    const intervalMs = heavyCommandsOpen || hasActiveHeavyCommand(heavyCommands)
      ? ACTIVE_HEAVY_COMMAND_RECONCILE_INTERVAL_MS
      : SESSION_RECONCILE_INTERVAL_MS;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && isLiveManagedSession(sessionRef.current)) void refresh();
    }, intervalMs);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [heavyCommandsOpen, id, terminatingHeavyRun, hasActiveHeavyCommand(heavyCommands)]);

  async function terminateHeavyCommand(runId: string) {
    setTerminatingHeavyRun(runId);
    setHeavyCommands((commands) => commands.map((command) => command.runId === runId ? { ...command, state: "terminating" } : command));
    try {
      await api.terminateHeavyCommand(id, runId);
      setHeavyCommandError("");
    } catch (error) {
      setHeavyCommandError(error instanceof Error ? error.message : "Unable to terminate heavyweight command");
      setTerminatingHeavyRun(null);
    }
  }

  const loadModelCatalog = useCallback(async () => {
    modelCatalogRequestSessionRef.current = id;
    setModelCatalogLoading(true);
    setModelSettingsError("");
    try {
      const catalog = await api.codexModels();
      setModelCatalog(catalog);
    } catch (error) {
      setModelSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelCatalogLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!session || modelCatalog || modelCatalogLoading || modelCatalogRequestSessionRef.current === id) return;
    void loadModelCatalog();
  }, [id, loadModelCatalog, modelCatalog, modelCatalogLoading, session]);

  async function applyModelSettings(mode: CollaborationMode, model: string, reasoningEffort: string | null): Promise<void> {
    setModelSettingsApplying(mode);
    setModelSettingsError("");
    try {
      const response = await api.action(id, { type: "setModelSettings", mode, model, reasoningEffort });
      if (!response.session) throw new Error("The session is no longer available.");
      setSession(response.session);
    } catch (error) {
      setModelSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelSettingsApplying(null);
    }
  }

  async function applyApprovalMode(mode: ApprovalMode): Promise<void> {
    setApprovalModeApplying(true);
    setApprovalModeError("");
    try {
      const response = await api.action(id, { type: "setApprovalMode", mode });
      if (!response.session) throw new Error("The session is no longer available.");
      setSession(response.session);
    } catch (error) {
      setApprovalModeError(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalModeApplying(false);
    }
  }

  function updateComposerText(value: string) {
    setText(value);
    saveComposerDraft(id, value);
  }

  function updateVimMode(enabled: boolean) {
    setVimEnabled(enabled);
    saveVimModePreference(enabled);
  }

  const sessionLoading = shouldShowSessionLoading(session, id, initialTranscriptSessionId);

  useLayoutEffect(() => {
    if (sessionLoading) return;
    const container = messageListRef.current;
    if (!container) return;
    const bottomContentChanged = bottomContentKeyRef.current !== bottomContentKey;
    bottomContentKeyRef.current = bottomContentKey;
    const behavior = scrollBehaviorForBottomContentUpdate(scrollBehaviorRef.current, bottomContentChanged, isNearBottomRef.current);
    scrollBehaviorRef.current = "idle";
    const preserved = preserveScrollRef.current;
    preserveScrollRef.current = null;
    if (container && behavior === "preserve" && preserved) {
      const anchor = preserved.itemId ? transcriptItemElement(container, preserved.itemId) : null;
      container.scrollTop = restoreScrollTopForAnchor(preserved, anchor, container.scrollHeight);
      updateMessageListScrollState(container);
      return;
    }
    if (container && behavior === "top") {
      container.scrollTop = 0;
      updateMessageListScrollState(container);
      return;
    }
    if (behavior === "none" || behavior === "idle") {
      updateMessageListScrollState(container);
      return;
    }
    scrollMessageListToBottom(container);
    updateMessageListScrollState(container);
    const animationFrame = window.requestAnimationFrame(() => {
      scrollMessageListToBottom(container);
      updateMessageListScrollState(container);
      if (initialTranscriptSessionId === id && !initialScrollReady) setInitialScrollReady(true);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [bottomContentKey, hasMoreAfter, hasMoreBefore, id, initialScrollReady, initialTranscriptSessionId, sessionLoading, transcriptItems]);

  async function trackRefreshRequest<T>(request: () => Promise<T>): Promise<T> {
    return request();
  }

  async function loadSnapshot(
    targetId = id,
    token = requestTokenRef.current,
    initial = false,
    signal?: AbortSignal
  ): Promise<boolean> {
    let applied = false;
    await transcriptRefreshGateRef.current.run(token, async () => {
      const refreshRequestId = sessionRefreshRequestRef.current + 1;
      sessionRefreshRequestRef.current = refreshRequestId;
      const response = await trackRefreshRequest(() => api.sessionSnapshot(targetId, MESSAGE_PAGE_SIZE, signal));
      if (!isCurrentRequest(targetId, token) || !isLatestSessionRefresh(refreshRequestId, sessionRefreshRequestRef.current) || response.messages.sessionId !== targetId) return false;
      const nextSession = sessionWithPendingFastMode(
        sessionWithPendingInputMode(response.session, pendingInputModeRef.current),
        pendingFastModeRef.current
      );
      sessionRef.current = nextSession;
      clearTranscriptOnSessionSourceChange(nextSession);
      setSession(nextSession);
      syncSessionStoplight(nextSession);
      setApproval(response.approval);
      if (!response.approval) setApprovalError("");
      setQuestion(response.question);
      if (!response.question) setQuestionError("");
      setQueuedInputs(response.queuedInputs);
      setSentQueuedUserMessage((current) => retainLatestSentQueuedUserMessage(current, response.queuedInputs));

      scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate(initial ? "initial" : "live", initial || isNearBottomRef.current);
      const sourceChanged = acceptTranscriptSource(response.messages);
      const replaceAll = initial || sourceChanged || initialTranscriptSessionIdRef.current !== targetId;
      setTranscriptItems((current) => replaceAll
        ? appendUniqueTranscriptItems([], response.messages.items)
        : replaceTranscriptTail(current, response.messages.items));
      reconcilePendingUserMessage(response.messages.items);
      setPagination(response.messages.hasMoreBefore, response.messages.hasMoreAfter);
      if (replaceAll) markInitialTranscriptSessionId(targetId);
      applied = true;
      return isLiveManagedSession(nextSession);
    });
    return applied || initialTranscriptSessionIdRef.current === targetId;
  }

  async function loadSession(targetId = id, token = requestTokenRef.current) {
    const refreshRequestId = sessionRefreshRequestRef.current + 1;
    sessionRefreshRequestRef.current = refreshRequestId;
    const response = await trackRefreshRequest(() => api.session(targetId));
    if (!isCurrentRequest(targetId, token) || !isLatestSessionRefresh(refreshRequestId, sessionRefreshRequestRef.current)) return;
    const nextSession = sessionWithPendingFastMode(
      sessionWithPendingInputMode(response.session, pendingInputModeRef.current),
      pendingFastModeRef.current
    );
    clearTranscriptOnSessionSourceChange(nextSession);
    setSession(nextSession);
    syncSessionStoplight(nextSession);
  }

  async function loadRecentMessages(targetId = id, token = requestTokenRef.current) {
    scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("initial", true);
    const response = await trackRefreshRequest(() => api.messages(targetId, { limit: MESSAGE_PAGE_SIZE }));
    if (!isCurrentTranscriptResponse(targetId, token, response)) return;
    acceptTranscriptSource(response);
    setTranscriptItems(appendUniqueTranscriptItems([], response.items));
    reconcilePendingUserMessage(response.items);
    setPagination(response.hasMoreBefore, response.hasMoreAfter);
    markInitialTranscriptSessionId(targetId);
  }

  async function refreshLiveTailMessages(targetId = id, token = requestTokenRef.current) {
    if (hasMoreAfterRef.current) return;
    await transcriptRefreshGateRef.current.run(token, async () => {
      scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("live", isNearBottomRef.current);
      const response = await trackRefreshRequest(() => api.messages(targetId, { limit: MESSAGE_PAGE_SIZE }));
      if (!isCurrentTranscriptResponse(targetId, token, response)) return false;
      const sourceChanged = acceptTranscriptSource(response);
      if (shouldResetInitialTranscriptForLiveTail(sourceChanged, initialTranscriptSessionIdRef.current, targetId)) {
        scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("initial", true);
        markInitialTranscriptSessionId(targetId);
        setInitialScrollReady(false);
      }
      setTranscriptItems((current) => (sourceChanged ? appendUniqueTranscriptItems([], response.items) : replaceTranscriptTail(current, response.items)));
      reconcilePendingUserMessage(response.items);
      setHasMoreBefore((current) => current || response.hasMoreBefore);
      setHasMoreAfterState(response.hasMoreAfter);
      return !response.hasMoreAfter;
    });
  }

  async function loadEarliestMessages(targetId = id, token = requestTokenRef.current) {
    scrollBehaviorRef.current = "top";
    const response = await trackRefreshRequest(() =>
      api.messages(targetId, { position: "oldest", limit: MESSAGE_PAGE_SIZE })
    );
    if (!isCurrentTranscriptResponse(targetId, token, response)) return;
    acceptTranscriptSource(response);
    setTranscriptItems(appendUniqueTranscriptItems([], response.items));
    reconcilePendingUserMessage(response.items);
    setPagination(response.hasMoreBefore, response.hasMoreAfter);
    markInitialTranscriptSessionId(targetId);
  }

  async function loadOlderMessages() {
    if (loadingOlderRef.current || !hasMoreBefore || firstSequence <= 0) return;
    const targetId = id;
    const token = requestTokenRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const response = await trackRefreshRequest(() =>
        api.messages(targetId, { before: firstSequence, limit: MESSAGE_PAGE_SIZE })
      );
      if (!isCurrentTranscriptPage(targetId, token, response)) return;
      preserveScrollRef.current = captureScrollAnchor(messageListRef.current);
      scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("older_page", isNearBottomRef.current);
      setTranscriptItems((current) => appendUniqueTranscriptItems(current, response.items));
      reconcilePendingUserMessage(response.items);
      setHasMoreBefore(response.hasMoreBefore);
    } finally {
      if (isCurrentRequest(targetId, token)) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }

  async function loadNewerMessages() {
    if (loadingNewerRef.current || !hasMoreAfter || lastSequence <= 0) return;
    scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("manual_newer", isNearBottomRef.current);
    const targetId = id;
    const token = requestTokenRef.current;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    try {
      const response = await trackRefreshRequest(() =>
        api.messages(targetId, { after: lastSequence, limit: MESSAGE_PAGE_SIZE })
      );
      if (!isCurrentTranscriptPage(targetId, token, response)) return;
      setTranscriptItems((current) => appendUniqueTranscriptItems(current, response.items));
      reconcilePendingUserMessage(response.items);
      setHasMoreAfterState(response.hasMoreAfter);
    } finally {
      if (isCurrentRequest(targetId, token)) {
        loadingNewerRef.current = false;
        setLoadingNewer(false);
      }
    }
  }

  async function loadTranscriptFindMatchPage(match: TranscriptSearchMatch) {
    if (loadingSearchPageRef.current) return;
    const targetId = id;
    const token = requestTokenRef.current;
    loadingSearchPageRef.current = true;
    try {
      const response = await trackRefreshRequest(() =>
        api.messages(targetId, { around: match.sequence, limit: MESSAGE_PAGE_SIZE })
      );
      if (!isCurrentTranscriptPage(targetId, token, response)) return;
      scrollBehaviorRef.current = "none";
      setTranscriptItems(appendUniqueTranscriptItems([], response.items));
      reconcilePendingUserMessage(response.items);
      setPagination(response.hasMoreBefore, response.hasMoreAfter);
      markInitialTranscriptSessionId(targetId);
      setInitialScrollReady(true);
    } finally {
      if (isCurrentRequest(targetId, token)) loadingSearchPageRef.current = false;
    }
  }

  async function loadApproval(targetId = id, token = requestTokenRef.current) {
    const refreshRequestId = approvalRefreshRequestRef.current + 1;
    approvalRefreshRequestRef.current = refreshRequestId;
    const response = await trackRefreshRequest(() => api.approval(targetId));
    if (!isCurrentRequest(targetId, token) || !isLatestSessionRefresh(refreshRequestId, approvalRefreshRequestRef.current)) return;
    setApproval(response.approval);
    if (!response.approval) setApprovalError("");
  }

  async function loadQuestion(targetId = id, token = requestTokenRef.current) {
    const refreshRequestId = questionRefreshRequestRef.current + 1;
    questionRefreshRequestRef.current = refreshRequestId;
    const response = await trackRefreshRequest(() => api.question(targetId));
    if (!isCurrentRequest(targetId, token) || !isLatestSessionRefresh(refreshRequestId, questionRefreshRequestRef.current)) return;
    setQuestion(response.question);
    if (!response.question) setQuestionError("");
  }

  async function loadQueuedInputs(targetId = id, token = requestTokenRef.current) {
    const response = await trackRefreshRequest(() => api.queuedInputs(targetId));
    if (!isCurrentRequest(targetId, token)) return;
    setQueuedInputs(response.queuedInputs);
    setSentQueuedUserMessage((current) => retainLatestSentQueuedUserMessage(current, response.queuedInputs));
  }

  function isCurrentRequest(targetId: string, token: number): boolean {
    return activeIdRef.current === targetId && requestTokenRef.current === token;
  }

  function isCurrentTranscriptResponse(targetId: string, token: number, response: TranscriptPageResponse): boolean {
    return isCurrentRequest(targetId, token) && response.sessionId === targetId;
  }

  function isCurrentTranscriptPage(targetId: string, token: number, response: TranscriptPageResponse): boolean {
    return isCurrentTranscriptResponse(targetId, token, response) && transcriptSourceKey(response) === transcriptSourceKeyRef.current;
  }

  function acceptTranscriptSource(response: TranscriptPageResponse): boolean {
    const nextSourceKey = transcriptSourceKey(response);
    const sourceChanged = shouldReplaceTranscriptForSource(transcriptSourceKeyRef.current, nextSourceKey);
    transcriptSourceKeyRef.current = nextSourceKey;
    if (sourceChanged) clearTranscriptSourceCaches();
    return sourceChanged;
  }

  function clearTranscriptSourceCaches() {
    setExpandedRangeItems({});
    setLoadingRanges(new Set());
    setExpandedStacks(new Set());
  }

  function markInitialTranscriptSessionId(targetId: string) {
    initialTranscriptSessionIdRef.current = targetId;
    setInitialTranscriptSessionId(targetId);
  }

  function clearInitialTranscriptSessionId() {
    initialTranscriptSessionIdRef.current = null;
    setInitialTranscriptSessionId(null);
  }

  function clearTranscriptOnSessionSourceChange(nextSession: ManagedSession) {
    const currentSourceKey = transcriptSourceKeyRef.current;
    if (!currentSourceKey) return;
    const nextSourceKey = transcriptSourceKey(sessionTranscriptSource(nextSession));
    if (nextSourceKey === currentSourceKey) return;
    transcriptSourceKeyRef.current = null;
    setTranscriptItems([]);
    clearInitialTranscriptSessionId();
    setInitialScrollReady(false);
    setPagination(false, false);
    clearTranscriptSourceCaches();
  }

  function setPagination(before: boolean, after: boolean) {
    setHasMoreBefore(before);
    setHasMoreAfterState(after);
  }

  function setHasMoreAfterState(value: boolean) {
    hasMoreAfterRef.current = value;
    setHasMoreAfter(value);
  }

  function updateNearBottomState(container: HTMLElement) {
    isNearBottomRef.current = isNearMessageListBottom(container);
  }

  function updateJumpVisibility(container: HTMLElement) {
    const next = transcriptJumpVisibility(container, hasMoreBefore, hasMoreAfter);
    setJumpVisibility((current) => current.top === next.top && current.bottom === next.bottom ? current : next);
  }

  function updateMessageListScrollState(container: HTMLElement) {
    updateNearBottomState(container);
    updateJumpVisibility(container);
    lastMessageListScrollTopRef.current = container.scrollTop;
  }

  function reconcilePendingUserMessage(items: CoreTranscriptItem[]) {
    setPendingUserMessage((pending) => (pending && transcriptItemsContainPendingUserMessage(items, pending) ? null : pending));
    setSentQueuedUserMessage((pending) => (pending && transcriptItemsContainPendingUserMessage(items, pending) ? null : pending));
  }

  function handleMessageListScroll() {
    const container = messageListRef.current;
    if (!container) return;
    const previousScrollTop = lastMessageListScrollTopRef.current;
    updateNearBottomState(container);
    updateJumpVisibility(container);
    lastMessageListScrollTopRef.current = container.scrollTop;
    const action = messageListAutoPageAction(container, {
      initialScrollReady,
      hasMoreBefore,
      hasMoreAfter,
      firstSequence,
      lastSequence,
      loadingOlder: loadingOlderRef.current,
      loadingNewer: loadingNewerRef.current,
      previousScrollTop
    });
    if (action === "older") void loadOlderMessages();
    if (action === "newer") void loadNewerMessages();
  }

  function clearPendingTranscriptVimPrefix() {
    vimPendingGRef.current = false;
    if (vimPendingGTimerRef.current !== null) {
      window.clearTimeout(vimPendingGTimerRef.current);
      vimPendingGTimerRef.current = null;
    }
  }

  function runTranscriptVimCommand(command: TranscriptVimNavigationCommand) {
    if (command === "jumpTop") {
      void jumpToTop();
      return;
    }
    if (command === "jumpBottom") {
      void jumpToBottom();
      return;
    }
    if (command === "find") {
      setTranscriptFindOpen(true);
      return;
    }
    const container = messageListRef.current;
    if (!container) return;
    if (command === "halfUp") scrollMessageListByRatio(container, -0.5);
    if (command === "halfDown") scrollMessageListByRatio(container, 0.5);
    if (command === "pageUp") scrollMessageListByRatio(container, -1);
    if (command === "pageDown") scrollMessageListByRatio(container, 1);
    updateMessageListScrollState(container);
  }

  function scrollToTranscriptItem(itemId: string) {
    const container = messageListRef.current;
    if (!container) return;
    const element = transcriptItemElement(container, itemId);
    if (!element) return;
    container.scrollTop = Math.max(0, element.offsetTop - 12);
    updateMessageListScrollState(container);
  }

  function closeTranscriptFind() {
    setTranscriptFindOpen(false);
    messageListRef.current?.focus();
  }

  function moveTranscriptFindMatch(direction: 1 | -1) {
    const count = transcriptFindMatches.length;
    if (!count) return;
    setTranscriptFindMatchIndex((current) => (current + direction + count) % count);
  }

  async function jumpToTop() {
    if (jumpBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setJumpBusy("top");
    try {
      await loadEarliestMessages(targetId, token);
    } finally {
      if (isCurrentRequest(targetId, token)) setJumpBusy(null);
    }
  }

  async function jumpToBottom() {
    if (jumpBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setJumpBusy("bottom");
    try {
      scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("explicit_bottom", true);
      await loadRecentMessages(targetId, token);
    } finally {
      if (isCurrentRequest(targetId, token)) setJumpBusy(null);
    }
  }

  async function submit(event: Pick<FormEvent, "preventDefault">, delivery: "auto" | "steer" | "queue" = "auto") {
    event.preventDefault();
    if (submitBusy || btwSubmitting || composerLocked || composerUploading) return;
    if (!composerHasContent(text)) return;
    const value = text.trimEnd();
    const parsedContent = composerContent(value);
    const btwInput = parseBtwComposerInput(parsedContent.text);
    if (btwInput) {
      if (parsedContent.content.some((part) => part.type === "image")) {
        setInputDeliveryError("BTW questions do not support images; send this to the main session instead.");
        return;
      }
      blurActiveElementForVimSubmit(effectiveVimEnabled, document.activeElement);
      openBtwDrawer();
      updateComposerText("");
      if (!btwInput.question) return;
      if (!await askBtwQuestion(btwInput.question)) updateComposerText(value);
      return;
    }
    const pendingMessage = createPendingUserMessage(id, parsedContent.text, session?.inputMode ?? "default", undefined, parsedContent.content);
    blurActiveElementForVimSubmit(effectiveVimEnabled, document.activeElement);
    updateComposerText("");
    setPendingUserMessage(pendingMessage);
    setSubmitBusy(true);
    isNearBottomRef.current = true;
    scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("send", true);
    try {
      const queued = delivery === "queue" || (delivery === "auto" && shouldQueueComposerInput(session, queuedInputs));
      if (queued) {
        await api.enqueueInput(id, parsedContent.text, session?.inputMode ?? "default", parsedContent.content);
        await loadQueuedInputs(id, requestTokenRef.current);
        setPendingUserMessage((current) => (current?.id === pendingMessage.id ? null : current));
      } else {
        const response = await api.send(id, parsedContent.text, session?.inputMode ?? "default", delivery === "steer" ? "steer" : "auto", parsedContent.content);
        if (response.queuedInput) {
          await loadQueuedInputs(id, requestTokenRef.current);
          setPendingUserMessage((current) => (current?.id === pendingMessage.id ? null : current));
        } else {
          setSession(response.session);
          syncSessionStoplight(response.session);
          setPendingUserMessage((current) => (current?.id === pendingMessage.id ? null : current));
          setTranscriptItems((current) => appendUniqueTranscriptItems(current, [{
            type: "message",
            id: response.message.id,
            message: response.message,
            firstSequence: response.message.sequence,
            lastSequence: response.message.sequence
          }]));
        }
      }
    } catch (error) {
      updateComposerText(value);
      setPendingUserMessage((current) => (current?.id === pendingMessage.id ? null : current));
      throw error;
    } finally {
      setSubmitBusy(false);
    }
  }

  function openBtwDrawer() {
    setBtwOpen(true);
    setBtwCompletedWhileClosed(false);
  }

  async function askBtwQuestion(question: string): Promise<boolean> {
    if (btwSubmitting || btwExchanges.some((exchange) => exchange.status === "running")) return false;
    const targetId = id;
    setBtwSubmitting(true);
    setBtwError("");
    setBtwOpen(true);
    try {
      const response = await api.askBtw(targetId, question);
      if (activeIdRef.current !== targetId) return true;
      setBtwExchanges((current) => upsertBtwExchange(current, response.exchange));
      return true;
    } catch (error) {
      if (activeIdRef.current === targetId) {
        setBtwError(error instanceof Error ? error.message : "Could not ask the BTW agent");
      }
      return false;
    } finally {
      if (activeIdRef.current === targetId) setBtwSubmitting(false);
    }
  }

  async function cancelBtwQuestion(exchangeId: string): Promise<void> {
    const targetId = id;
    setBtwError("");
    try {
      const response = await api.cancelBtw(targetId, exchangeId);
      if (activeIdRef.current !== targetId) return;
      setBtwExchanges((current) => upsertBtwExchange(current, response.exchange));
    } catch (error) {
      if (activeIdRef.current === targetId) {
        setBtwError(error instanceof Error ? error.message : "Could not cancel the BTW question");
      }
    }
  }

  async function runAction(action: SessionAction) {
    if (actionBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setActionBusy(action.type);
    try {
      const response = await api.action(targetId, action);
      if (response.session && isCurrentRequest(targetId, token)) setSession(response.session);
      void refreshSessionStoplight().catch(() => undefined);
    } finally {
      if (isCurrentRequest(targetId, token)) setActionBusy(null);
    }
  }

  async function resolveInputDelivery(action: Extract<SessionAction, { type: "retryInputDelivery" | "dismissInputDeliveryFailure" }>) {
    if (actionBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setActionBusy(action.type);
    setInputDeliveryError("");
    try {
      const response = await api.action(targetId, action);
      if (!isCurrentRequest(targetId, token)) return;
      if (response.session) setSession(response.session);
      void refreshSessionStoplight().catch(() => undefined);
    } catch (error) {
      if (isCurrentRequest(targetId, token)) setInputDeliveryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentRequest(targetId, token)) setActionBusy(null);
    }
  }

  async function resolveAgentGuard(action: Extract<SessionAction, { type: "extendAgentBudget" }>) {
    if (actionBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setActionBusy(action.type);
    setAgentGuardError("");
    try {
      const response = await api.action(targetId, action);
      if (!isCurrentRequest(targetId, token)) return;
      if (response.session) setSession(response.session);
      void refreshSessionStoplight().catch(() => undefined);
    } catch (error) {
      if (isCurrentRequest(targetId, token)) setAgentGuardError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentRequest(targetId, token)) setActionBusy(null);
    }
  }

  function killSession() {
    if (actionBusy || !confirm("Kill this session runtime? The conversation remains available to restore.")) return;
    const targetId = id;
    navigate("/", { state: { optimisticallyRemovedSessionId: targetId } });
    void api
      .action(targetId, { type: "kill" })
      .then(() => refreshSessionStoplight())
      .catch((error) => {
        console.error(error);
      });
  }

  async function setInputMode(mode: CollaborationMode) {
    if (!session || session.inputMode === mode || actionBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    pendingInputModeRef.current = mode;
    setActionBusy("setInputMode");
    setInputModeError("");
    setSession((current) => (current ? { ...current, inputMode: mode } : current));
    try {
      const response = await api.action(targetId, inputModeAction(mode));
      if (!isCurrentRequest(targetId, token)) return;
      if (response.session) setSession(response.session);
    } catch (error) {
      if (!isCurrentRequest(targetId, token)) return;
      setInputModeError(error instanceof Error ? error.message : String(error));
      pendingInputModeRef.current = null;
      await loadSession(targetId, token);
    } finally {
      if (isCurrentRequest(targetId, token)) {
        pendingInputModeRef.current = null;
        setActionBusy(null);
      }
    }
  }

  async function setFastMode(enabled: boolean) {
    if (!session || session.fastMode === enabled || actionBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    pendingFastModeRef.current = enabled;
    setActionBusy("setFastMode");
    setFastModeError("");
    setSession((current) => (current ? { ...current, fastMode: enabled } : current));
    try {
      const response = await api.action(targetId, fastModeAction(enabled));
      if (!isCurrentRequest(targetId, token)) return;
      if (response.session) setSession(response.session);
    } catch (error) {
      if (!isCurrentRequest(targetId, token)) return;
      setFastModeError(error instanceof Error ? error.message : String(error));
      pendingFastModeRef.current = null;
      await loadSession(targetId, token);
    } finally {
      if (isCurrentRequest(targetId, token)) {
        pendingFastModeRef.current = null;
        setActionBusy(null);
      }
    }
  }

  async function copyAttachCommand() {
    if (!session) return;
    const command = runtimeAttachCommand(session);
    try {
      await copyText(command);
      setCopiedAttachCommand(true);
      window.setTimeout(() => setCopiedAttachCommand(false), 1600);
    } catch {
      setCopiedAttachCommand(false);
    }
  }

  async function copyMessageFromMenu() {
    if (!messageMenu?.copyTarget) return;
    const text = messageMenu.copyTarget.text;
    setMessageMenu(null);
    try {
      await copyText(text);
    } catch (error) {
      console.error(error);
    }
  }

  async function copyImageFromMenu() {
    if (!messageMenu?.image) return;
    const url = api.imageUrl(messageMenu.image.sessionId, messageMenu.image.id);
    setMessageMenu(null);
    setMessageActionError("");
    try {
      await copyImage(url);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "Could not copy the image");
    }
  }

  async function resolveApproval(decision: ApprovalDecision) {
    if (!approval) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setApprovalBusy(decision);
    setApprovalError("");
    try {
      await api.resolveApproval(targetId, { decision, messageId: approval.messageId } as Parameters<typeof api.resolveApproval>[1]);
      if (!isCurrentRequest(targetId, token)) return;
      setApproval(null);
      await Promise.all([loadSession(targetId, token), loadApproval(targetId, token)]);
    } catch (error) {
      if (!isCurrentRequest(targetId, token)) return;
      setApprovalError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentRequest(targetId, token)) setApprovalBusy(null);
    }
  }

  async function answerQuestion(request: QuestionAnswerRequest) {
    if (!question) return;
    const targetId = id;
    const token = requestTokenRef.current;
    const answeredQuestion = question;
    setQuestionBusy(true);
    setQuestionError("");
    try {
      await api.answerQuestion(targetId, { ...request, messageId: question.messageId } as Parameters<typeof api.answerQuestion>[1]);
      if (answeredQuestion) clearQuestionAnswerDraft(answeredQuestion);
      if (!isCurrentRequest(targetId, token)) return;
      setQuestion(null);
      await Promise.all([loadSession(targetId, token), loadQuestion(targetId, token)]);
    } catch (error) {
      if (!isCurrentRequest(targetId, token)) return;
      setQuestionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentRequest(targetId, token)) setQuestionBusy(false);
    }
  }

  async function submitPlanAction(action: PlanAction) {
    if (planActionBusy || !pendingPlan) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setPlanActionBusy(action);
    setPlanActionError("");
    try {
      const response = await api.action(targetId, planActionRequest(action, pendingPlan.id));
      if (!applyPlanActionResponse(response, targetId, token, isCurrentRequest, setSession, syncSessionStoplight)) return;
    } catch (error) {
      if (!isCurrentRequest(targetId, token)) return;
      setPlanActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentRequest(targetId, token)) setPlanActionBusy(null);
    }
  }

  async function updateQueuedInput(inputId: string, value: string, mode: CollaborationMode) {
    const targetId = id;
    const token = requestTokenRef.current;
    const parsed = composerContent(value);
    await api.updateQueuedInput(targetId, inputId, parsed.text, mode, parsed.content);
    await loadQueuedInputs(targetId, token);
  }

  async function deleteQueuedInput(inputId: string) {
    const targetId = id;
    const token = requestTokenRef.current;
    await api.deleteQueuedInput(targetId, inputId);
    await loadQueuedInputs(targetId, token);
  }

  const loadingSession = session ?? loadingSessionFromLocationState(location.state, id);
  if (sessionLoading) {
    return (
      <SessionLoadingView
        session={loadingSession}
        error={sessionLoadError}
        retrying={sessionLoadRetrying}
        onRetry={() => setSessionLoadRetryNonce((current) => current + 1)}
        onBack={() => navigate("/")}
        onNewSession={() => openCreateSession(loadingSession ? sessionCreateSessionCwd(loadingSession) : "")}
      />
    );
  }
  const readySession = session;
  const steerAvailable = canSteerComposerInput(readySession, hasActiveHeavyCommand(heavyCommands));
  if (!readySession) {
    return (
      <SessionLoadingView
        session={loadingSession}
        error={sessionLoadError}
        retrying={sessionLoadRetrying}
        onRetry={() => setSessionLoadRetryNonce((current) => current + 1)}
        onBack={() => navigate("/")}
        onNewSession={() => openCreateSession()}
      />
    );
  }
  const readyWorkspace = normalizeGitWorkspaceSummary(readySession.gitWorkspace);
  const completed = Boolean(readySession.agentOwnership?.completedAt);
  const approvalModeParent = readySession.agentOwnership
    ? shellSessions.find((candidate) => candidate.id === readySession.agentOwnership?.parentSessionId)
    : null;
  const statusPresentation = sessionStatusPresentation(readySession, shellSessions.some((candidate) => candidate.id === readySession.id) ? shellSessions : [readySession, ...shellSessions]);
  const statusSource = shellSessions.find((candidate) => candidate.id === statusPresentation.sourceSessionId);
  const statusDetail = statusPresentation.inherited && statusSource ? `from ${sessionDisplayName(statusSource, shellSessions)}` : null;

  return (
    <section className={composerFocused ? "session-view session-view-composer-focused" : "session-view"}>
      <div
        ref={adaptiveHeaderStatus.headerRef}
        className={adaptiveHeaderStatus.compact ? "session-header session-header-status-compact" : "session-header"}
      >
        <button className="icon-button" onClick={() => navigate("/")} aria-label="Back">
          <ArrowLeft size={19} />
        </button>
        <div ref={adaptiveHeaderStatus.titleRef} className="session-title">
          <SessionTitleHeading
            name={sessionDisplayName(readySession)}
            onFork={() => openForkSession(readySession)}
            forkDisabled={Boolean(actionBusy) || readySession.initializing === true || Boolean(readySession.startupError) || !readySession.codexSessionId}
          />
          <div className="session-title-meta">
            <SessionHeaderMeta session={readySession} />
          </div>
        </div>
        <div ref={adaptiveHeaderStatus.runtimeRef} className="session-header-runtime">
          <HeavyCommandIndicator commands={heavyCommands} onOpen={() => setHeavyCommandsOpen(true)} />
          <ModelSettingsButton
            compact
            session={readySession}
            catalog={modelCatalog}
            onOpen={() => setModelSettingsOpen(true)}
          />
          <RuntimeAttachButton
            session={readySession}
            copied={copiedAttachCommand}
            accessMode={accessMode}
            enabled={!completed && readySession.capabilities?.terminalAttach !== false}
            onCopy={() => void copyAttachCommand()}
          />
          <span ref={adaptiveHeaderStatus.statusProbeRef} className="session-header-status-probe" aria-hidden="true">
            {readySession.initializing ? <LoadingStatusPill /> : <StatusPill status={statusPresentation.status} detail={statusDetail} />}
          </span>
          {readySession.initializing ? <LoadingStatusPill /> : <StatusPill status={statusPresentation.status} detail={statusDetail} />}
        </div>
      </div>

      {readySession.startupError ? (
        <p className="session-startup-error-banner" role="alert">{readySession.startupError}</p>
      ) : null}

      {readySession.runtimeUnavailableReason ? (
        <p className="session-startup-error-banner" role="alert">{readySession.runtimeUnavailableReason}</p>
      ) : null}

      {readySession.status === "input_failed" ? (
        <InputDeliveryFailureBanner
          busyAction={actionBusy}
          detail={inputDeliveryFailure}
          error={inputDeliveryError}
          onRetry={() => void resolveInputDelivery({ type: "retryInputDelivery" })}
          onDismiss={() => void resolveInputDelivery({ type: "dismissInputDeliveryFailure" })}
        />
      ) : null}

      <HeavyCommandsModal
        open={heavyCommandsOpen}
        commands={heavyCommands}
        outputs={heavyOutputs}
        error={heavyCommandError}
        terminatingRun={terminatingHeavyRun}
        onClose={() => setHeavyCommandsOpen(false)}
        onTerminate={(runId) => void terminateHeavyCommand(runId)}
      />
      <DocumentsModal
        open={documentsOpen}
        sessionId={referencedDocumentSource?.sessionId ?? readySession.id}
        sourceSessionName={referencedDocumentSource?.sessionName}
        currentSession={!referencedDocumentSource}
        documents={referencedDocumentSource?.documents ?? documents}
        requestedDocument={requestedDocument}
        requestedFragment={requestedDocumentFragment}
        requestedNavigation={requestedDocumentNavigation}
        listLoading={referencedDocumentSource ? false : documentsLoading}
        listError={referencedDocumentSource ? "" : documentsError}
        onOpenDocument={openDocumentReference}
        onReturnToCurrent={() => showCurrentDocuments()}
        onClose={closeDocuments}
      />
      <BtwDrawer
        open={btwOpen}
        exchanges={btwExchanges}
        loading={btwLoading}
        error={btwError}
        submitting={btwSubmitting}
        onClose={() => setBtwOpen(false)}
        onAsk={askBtwQuestion}
        onCancel={cancelBtwQuestion}
        onOpenDocument={(name) => {
          setBtwOpen(false);
          showCurrentDocuments(name);
        }}
      />
      <ModelSettingsDrawer
        open={modelSettingsOpen}
        title="Session model settings"
        description="Choose a model and reasoning effort, then apply it explicitly to this session's Normal or Plan mode."
        selections={readySession.models}
        activeMode={readySession.inputMode}
        fastMode={readySession.fastMode}
        catalog={modelCatalog}
        loading={modelCatalogLoading}
        error={modelSettingsError}
        applying={modelSettingsApplying}
        approvalMode={readySession.approvalMode}
        approvalModeInheritedFrom={readySession.agentOwnership ? {
          id: readySession.agentOwnership.parentSessionId,
          name: approvalModeParent ? sessionDisplayName(approvalModeParent, shellSessions) : "Parent session"
        } : null}
        approvalModeApplying={approvalModeApplying}
        approvalModeError={approvalModeError}
        onClose={() => setModelSettingsOpen(false)}
        onRetry={() => void loadModelCatalog()}
        onApply={applyModelSettings}
        onApprovalModeChange={applyApprovalMode}
      />

      <div className="session-actions">
        <div className="session-action-group session-tool-actions">
          <button
            className="session-new-session-button"
            type="button"
            onClick={() => openCreateSession(sessionCreateSessionCwd(readySession))}
            aria-label="New session"
            title="New session"
          >
            <Plus size={18} />
            <span className="session-new-session-button-label">New session</span>
          </button>
          <DocumentsButton documentCount={documents.length} open={documentsOpen} onOpen={() => {
            showCurrentDocuments();
          }} />
          <button
            type="button"
            className="btw-button"
            onClick={openBtwDrawer}
            disabled={readySession.initializing === true || !readySession.codexSessionId || Boolean(readySession.startupError) || Boolean(readySession.runtimeUnavailableReason)}
            aria-haspopup="dialog"
            aria-expanded={btwOpen}
            aria-label="Open BTW side questions"
            title="Ask without interrupting this session"
          >
            {btwExchanges.some((exchange) => exchange.status === "running")
              ? <LoaderCircle className="spin" size={16} />
              : <MessageSquare size={16} />}
            <span className="session-action-label">BTW</span>
            {btwCompletedWhileClosed ? <span className="btw-unread-dot" aria-label="New BTW answer" /> : null}
          </button>
          {readyWorkspace ? (
            <button
              className="git-workspace-chip"
              type="button"
              onClick={() => setGitPanelOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={gitPanelOpen}
              aria-label={`Open Git workspace controls for ${readyWorkspace.targetBranch} · ${gitWorkspaceChipState(readyWorkspace)}`}
              title={`Git workspace: ${readyWorkspace.targetBranch} · ${gitWorkspaceChipState(readyWorkspace)}`}
              data-state={readyWorkspace.state}
            >
              <GitBranch size={14} />
              <span>{readyWorkspace.targetBranch}</span>
            </button>
          ) : null}
        </div>
        <div className="session-action-group session-runtime-actions">
          {readySession.agentOwnership ? (
            <button
              disabled={completed || Boolean(actionBusy)}
              aria-busy={actionBusy === "setAgentParent"}
              aria-label={actionBusy === "setAgentParent" ? "Detaching child session" : "Detach child session"}
              onClick={() => void runAction({ type: "setAgentParent", parentSessionId: null })}
              title="Return this session to the top level"
            >
              <GitFork size={16} />
              <span className="session-action-label">
                {actionBusy === "setAgentParent" ? "Detaching" : "Detach child"}
              </span>
            </button>
          ) : null}
          <button
            disabled={completed || readySession.initializing === true || Boolean(actionBusy) || readySession.capabilities?.interrupt === false || readySession.runtime?.kind === "systemd_service" && readySession.runtime.state === "hibernated"}
            aria-busy={actionBusy === "interrupt"}
            aria-label={actionBusy === "interrupt" ? "Interrupting session" : "Interrupt session"}
            data-busy={actionBusy === "interrupt" || undefined}
            onClick={() => runAction({ type: "interrupt" })}
            title="Interrupt"
          >
            <Pause size={16} />
            <span className="session-action-label">{actionBusy === "interrupt" ? "Interrupting" : "Interrupt"}</span>
          </button>
          {readySession.capabilities?.hibernate && readySession.runtime?.kind === "systemd_service" ? (
            <button
              disabled={completed || readySession.initializing === true || Boolean(actionBusy)}
              aria-busy={actionBusy === "hibernate" || actionBusy === "wake"}
              aria-label={readySession.runtime.state === "hibernated" ? "Wake session" : "Hibernate session"}
              onClick={() => void runAction({ type: readySession.runtime?.kind === "systemd_service" && readySession.runtime.state === "hibernated" ? "wake" : "hibernate" })}
              title={readySession.runtime.state === "hibernated" ? "Wake app-server runtime" : "Hibernate idle app-server runtime"}
            >
              {readySession.runtime.state === "hibernated" ? <Play size={16} /> : <Moon size={16} />}
              <span className="session-action-label">
                {actionBusy === "wake" ? "Waking" : actionBusy === "hibernate" ? "Hibernating" : readySession.runtime.state === "hibernated" ? "Wake" : "Hibernate"}
              </span>
            </button>
          ) : null}
          <button
            className="danger"
            disabled={completed || readySession.initializing === true || Boolean(actionBusy) || readySession.capabilities?.kill === false}
            aria-busy={actionBusy === "kill"}
            aria-label={actionBusy === "kill" ? "Killing session" : "Kill session"}
            data-busy={actionBusy === "kill" || undefined}
            onClick={killSession}
            title="Kill session"
          >
            <Skull size={16} />
            <span className="session-action-label">{actionBusy === "kill" ? "Killing" : "Kill"}</span>
          </button>
        </div>
      </div>

      {messageMenu ? (
        <ContextMenu
          className="message-action-menu"
          ref={messageMenuRef}
          position={messageMenu}
          label={messageMenu.image ? "Image actions" : "Message actions"}
        >
          {messageMenu.image ? (
            <ContextMenuItem icon={<Copy size={16} />} onClick={() => void copyImageFromMenu()}>
              Copy image
            </ContextMenuItem>
          ) : null}
          {messageMenu.copyTarget ? (
            <ContextMenuItem icon={<Copy size={16} />} onClick={() => void copyMessageFromMenu()}>
              {messageMenu.copyTarget.label}
            </ContextMenuItem>
          ) : null}
        </ContextMenu>
      ) : null}

      <ImagePreviewModal image={imagePreview} onClose={() => setImagePreview(null)} />
      {messageActionError ? <p className="message-action-error" role="alert">{messageActionError}</p> : null}

      <div className="transcript-pane">
        {transcriptFindOpen ? (
          <form className="transcript-find-bar" role="search" onSubmit={(event) => event.preventDefault()}>
            <input
              ref={transcriptFindInputRef}
              type="search"
              value={transcriptFindQuery}
              onChange={(event) => setTranscriptFindQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeTranscriptFind();
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  moveTranscriptFindMatch(event.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Find transcript"
              aria-label="Find transcript"
            />
            <span className="transcript-find-count" aria-live="polite">
              {transcriptFindError
                ? transcriptFindError
                : transcriptFindLoading
                  ? "Searching"
                  : transcriptFindQuery.trim()
                    ? transcriptFindMatches.length
                      ? `${transcriptFindMatchIndex + 1} / ${transcriptFindMatches.length}`
                      : "No matches"
                    : "0 / 0"}
            </span>
            <button type="button" onClick={() => moveTranscriptFindMatch(-1)} disabled={!transcriptFindMatches.length} aria-label="Previous match">
              <ArrowUpToLine size={15} />
            </button>
            <button type="button" onClick={() => moveTranscriptFindMatch(1)} disabled={!transcriptFindMatches.length} aria-label="Next match">
              <ArrowDownToLine size={15} />
            </button>
            <button type="button" onClick={closeTranscriptFind} aria-label="Close transcript find">
              <X size={15} />
            </button>
          </form>
        ) : null}

        <div
          className={
            shouldHideInitialMessageList(initialTranscriptSessionId, id, initialScrollReady)
              ? "message-list message-list-initializing"
              : "message-list"
          }
          ref={messageListRef}
          onScroll={handleMessageListScroll}
          tabIndex={-1}
        >
          {hasMoreBefore ? (
            <button
              className="load-older-messages"
              type="button"
              disabled={loadingOlder}
              aria-busy={loadingOlder}
              data-busy={loadingOlder || undefined}
              onClick={loadOlderMessages}
            >
              {loadingOlder ? "Loading older messages" : "Load older messages"}
            </button>
          ) : null}
          {transcriptItems.map((item) => renderTranscriptItem(item))}
          {pendingUserChatMessage ? (
            <MessageBubble
              message={pendingUserChatMessage}
              pending
              onOpenMenu={openMessageMenu}
              onOpenImage={setImagePreview}
              onOpenImageMenu={openImageMenu}
            />
          ) : null}
          {showTranscriptSyncIndicator ? <TranscriptSyncIndicator /> : null}
          {showWorkingIndicator ? <WorkingIndicator status={readySession.status} lastUserPromptAt={lastUserPromptAt} /> : null}
          {showQueuedIndicator ? <QueuedIndicator /> : null}
          {question && !questionRenderedInline ? (
            <QuestionBanner
              key={question.id}
              question={question}
              busy={questionBusy}
              submitDisabled={readySession.initializing === true}
              error={questionError}
              onAnswer={answerQuestion}
            />
          ) : null}
          {hasMoreAfter ? (
            <button
              className="load-older-messages"
              type="button"
              disabled={loadingNewer}
              aria-busy={loadingNewer}
              data-busy={loadingNewer || undefined}
              onClick={loadNewerMessages}
            >
              {loadingNewer ? "Loading newer messages" : "Load newer messages"}
            </button>
          ) : null}
        </div>
        {jumpVisibility.top || jumpVisibility.bottom ? (
          <div className="transcript-jump-rail" role="group" aria-label="Transcript navigation">
            {jumpVisibility.top ? (
              <button
                type="button"
                disabled={Boolean(jumpBusy)}
                aria-busy={jumpBusy === "top"}
                aria-label={jumpBusy === "top" ? "Loading top of chat" : "Jump to top of chat"}
                data-busy={jumpBusy === "top" || undefined}
                onClick={jumpToTop}
                title="Jump to top"
              >
                {jumpBusy === "top" ? <LoaderCircle className="spin" size={17} /> : <ArrowUpToLine size={17} />}
              </button>
            ) : null}
            {jumpVisibility.bottom ? (
              <button
                type="button"
                disabled={Boolean(jumpBusy)}
                aria-busy={jumpBusy === "bottom"}
                aria-label={jumpBusy === "bottom" ? "Loading bottom of chat" : "Jump to bottom of chat"}
                data-busy={jumpBusy === "bottom" || undefined}
                onClick={jumpToBottom}
                title="Jump to bottom"
              >
                {jumpBusy === "bottom" ? <LoaderCircle className="spin" size={17} /> : <ArrowDownToLine size={17} />}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="session-input-stack">
        {childAttention.length > 0 ? (
          <ChildSessionAttentionTray items={childAttention} onOpen={(sessionId) => navigate(`/sessions/${sessionId}`)} />
        ) : null}
        {approval && !approvalRenderedInline ? (
          <ApprovalBanner
            approval={approval}
            automationMode={readySession.approvalMode}
            busy={approvalBusy}
            disabled={readySession.initializing === true}
            error={approvalError}
            onDecision={resolveApproval}
          />
        ) : readySession.status === "blocked" && readySession.agentOwnership ? (
          <AgentGuardBanner
            session={readySession}
            busyAction={actionBusy}
            error={agentGuardError}
            onAction={(action) => void resolveAgentGuard(action)}
          />
        ) : (
          <div className="composer-stack">
          {queuedInputs.length ? (
            <QueuedInputList
              sessionId={id}
              inputs={queuedInputs}
              skills={codexSkills}
              vimEnabled={effectiveVimEnabled}
              onSkillSearch={() => void refreshCodexSkills()}
              onUpdate={updateQueuedInput}
              onDelete={deleteQueuedInput}
              onOpenImage={setImagePreview}
              onOpenImageMenu={openImageMenu}
            />
          ) : null}
          {inputModeError ? <p className="mode-toggle-error" role="alert">{inputModeError}</p> : null}
          {fastModeError ? <p className="mode-toggle-error" role="alert">{fastModeError}</p> : null}
          <form
            className={vimAvailable ? "composer composer-vim-available" : "composer"}
            ref={composerFormRef}
            onSubmit={(event) => void submit(event, steerAvailable ? "steer" : "auto")}
          >
            <div className="composer-settings" role="group" aria-label="Composer settings">
              <ModeToggle
                mode={readySession.inputMode}
                busy={completed || readySession.initializing === true || actionBusy === "setInputMode" || Boolean(readySession.startupError) || readySession.runtime?.kind === "systemd_service" && readySession.runtime.state === "hibernated"}
                onChange={setInputMode}
              />
              <FastModeToggle
                enabled={readySession.fastMode === true}
                available={readySession.fastModeAvailable ?? null}
                busy={completed || readySession.initializing === true || actionBusy === "setFastMode" || readySession.runtime?.kind === "systemd_service" && readySession.runtime.state === "hibernated"}
                status={readySession.status}
                onChange={setFastMode}
              />
              {vimAvailable ? <VimModeToggle enabled={vimEnabled} onChange={updateVimMode} /> : null}
            </div>
            <SkillTextArea
              value={text}
              onChange={updateComposerText}
              vimEnabled={effectiveVimEnabled}
              onSubmitShortcut={() => {
                if (submitBusy || btwSubmitting || composerLocked) return;
                composerFormRef.current?.requestSubmit();
              }}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              skills={codexSkills}
              onSkillSearch={() => void refreshCodexSkills()}
              placeholder={
                composerLock ??
                (shouldQueueComposerInput(readySession, queuedInputs)
                  ? readySession.inputMode === "plan"
                    ? "Queue plan message"
                    : "Queue message"
                  : readySession.inputMode === "plan"
                    ? "Plan with Codex"
                    : "Message Codex")
              }
              focusRequestKey={composerFocusRequest ? String(composerFocusRequest.nonce) : null}
              focusCommand={composerFocusRequest?.command ?? "focus"}
              disabled={submitBusy || btwSubmitting || composerLocked}
              sessionId={id}
              onUploadingChange={setComposerUploading}
            />
            {steerAvailable ? (
              <div className="composer-action-stack">
                <button
                  className="send-button composer-steer-button"
                  type="submit"
                  aria-busy={submitBusy}
                  aria-label={submitBusy ? "Steering" : "Steer now"}
                  title="Steer now"
                  data-busy={submitBusy || undefined}
                  disabled={submitBusy || btwSubmitting || composerLocked || composerUploading || !composerHasContent(text)}
                >
                  {submitBusy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
                </button>
                <button
                  className="send-button composer-queue-button"
                  type="button"
                  aria-label="Queue"
                  title="Queue"
                  disabled={submitBusy || btwSubmitting || composerLocked || composerUploading || !composerHasContent(text)}
                  onClick={(event) => void submit(event, "queue")}
                >
                  <Clock3 size={16} />
                </button>
              </div>
            ) : (
              <button
                className="send-button"
                type="submit"
                aria-busy={submitBusy}
                aria-label={submitBusy ? "Sending" : shouldQueueComposerInput(readySession, queuedInputs) ? "Queue" : "Send"}
                data-busy={submitBusy || undefined}
                disabled={submitBusy || btwSubmitting || composerLocked || composerUploading || !composerHasContent(text)}
              >
                {submitBusy ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}
              </button>
            )}
          </form>
          </div>
        )}
      </div>
      {gitPanelOpen && readyWorkspace ? (
        <GitWorkspacePanel
          workspace={readyWorkspace}
          onClose={closeGitPanel}
        />
      ) : null}
    </section>
  );
}

export function InputDeliveryFailureBanner({
  busyAction,
  detail,
  error,
  onRetry,
  onDismiss
}: {
  busyAction: SessionAction["type"] | null;
  detail: string;
  error: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="session-input-failed-banner" role="alert">
      <div>
        <strong>Input delivery could not be verified.</strong>
        <p>{detail || "Codex did not acknowledge the last input."} The message remains preserved for retry or dismissal.</p>
        {error ? <p className="session-input-failed-error">{error}</p> : null}
      </div>
      <div className="session-input-failed-actions">
        <button type="button" disabled={Boolean(busyAction)} onClick={onRetry}>
          {busyAction === "retryInputDelivery" ? "Retrying…" : "Retry input"}
        </button>
        <button type="button" disabled={Boolean(busyAction)} onClick={onDismiss}>Dismiss</button>
      </div>
    </section>
  );
}

export function ChildSessionAttentionTray({
  items,
  onOpen
}: {
  items: ChildSessionAttentionItem[];
  onOpen: (sessionId: string) => void;
}) {
  const label = items.length === 1 ? "1 child session needs attention" : `${items.length} child sessions need attention`;
  return (
    <section className="child-attention-tray" aria-label={label} aria-live="polite">
      <div className="child-attention-heading">
        <AlertTriangle size={17} aria-hidden="true" />
        <strong>{label}</strong>
      </div>
      <div className="child-attention-list">
        {items.map((item) => (
          <button
            key={item.session.id}
            className="child-attention-item"
            type="button"
            onClick={() => onOpen(item.session.id)}
            aria-label={`Open ${sessionDisplayName(item.session)}: ${item.detail}`}
          >
            <span className="child-attention-copy">
              <strong>{sessionDisplayName(item.session)}</strong>
              <small>{item.detail}</small>
            </span>
            <StatusPill status={item.status} />
            <span className="child-attention-open">Open child</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

type AgentGuardAction = Extract<SessionAction, { type: "extendAgentBudget" }>;

export function AgentGuardBanner({
  session,
  busyAction,
  error,
  onAction
}: {
  session: ManagedSession;
  busyAction: SessionAction["type"] | null;
  error: string;
  onAction: (action: AgentGuardAction) => void;
}) {
  const [budgetReason, setBudgetReason] = useState("");
  const [additionalTokens, setAdditionalTokens] = useState("1000000");
  const budgetBlocked = Boolean(session.agentOwnership?.budgetExhaustedAt);
  const parsedTokens = Number(additionalTokens);
  const tokensValid = Number.isSafeInteger(parsedTokens) && parsedTokens >= 1 && parsedTokens <= 2_000_000;
  function extendBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!budgetReason.trim() || !tokensValid || busyAction) return;
    onAction({ type: "extendAgentBudget", additionalTokens: parsedTokens, reason: budgetReason.trim() });
  }

  return (
    <section className="agent-guard-banner" role="alert">
      <div className="agent-guard-heading">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>Agent session paused</strong>
          <p>Resolve the active guard before sending the next instruction.</p>
        </div>
      </div>
      {budgetBlocked ? (
        <form className="agent-guard-form" onSubmit={extendBudget}>
          <div>
            <strong>Work-token budget exhausted</strong>
            <p>Extend the delegated budget before continuing this child session.</p>
          </div>
          <label>
            <span>Additional tokens</span>
            <input type="number" min={1} max={2_000_000} step={100_000} value={additionalTokens} onChange={(event) => setAdditionalTokens(event.target.value)} />
          </label>
          <label>
            <span>Reason</span>
            <input {...noAutofillTextField} maxLength={1_000} value={budgetReason} onChange={(event) => setBudgetReason(event.target.value)} placeholder="Why is more delegated budget needed?" />
          </label>
          <button type="submit" disabled={Boolean(busyAction) || !budgetReason.trim() || !tokensValid} aria-busy={busyAction === "extendAgentBudget"}>
            {busyAction === "extendAgentBudget" ? <LoaderCircle className="spin" size={16} /> : <Gauge size={16} />}
            {busyAction === "extendAgentBudget" ? "Extending" : "Extend budget"}
          </button>
        </form>
      ) : null}
      {!budgetBlocked ? (
        <p className="agent-guard-unknown">Muxpilot could not identify the active guard. Refresh the session before retrying.</p>
      ) : null}
      {error ? <p className="agent-guard-error">{error}</p> : null}
    </section>
  );
}

export function pendingActionRefreshForStatus(status: ManagedSession["status"] | undefined): PendingActionRefresh {
  if (status === "approval" || status === "question") return status;
  return null;
}

export function pendingActionRefreshForEvent(event: Pick<SessionEvent, "type" | "payload">): PendingActionRefresh {
  if (event.type === "session.updated") {
    return pendingActionRefreshForStatus((event.payload as Partial<ManagedSession>).status);
  }
  if (event.type === "status.changed") {
    return pendingActionRefreshForStatus((event.payload as { status?: ManagedSession["status"] }).status);
  }
  return null;
}

export function SessionLoadingView({
  session,
  error,
  retrying = true,
  onRetry,
  onBack,
  onNewSession
}: {
  session: ManagedSession | null;
  error?: string;
  retrying?: boolean;
  onRetry?: () => void;
  onBack: () => void;
  onNewSession: () => void;
}) {
  const workspace = session ? normalizeGitWorkspaceSummary(session.gitWorkspace) : null;
  const adaptiveHeaderStatus = useAdaptiveSessionHeaderStatus([
    session?.id ?? "",
    session?.status ?? "",
    session?.contextUsage?.contextPercent ?? "",
    session?.agentOwnership?.parentSessionId ?? "",
    session?.forkedFrom?.sessionName ?? "",
    session ? sessionDisplayName(session) : "Loading session"
  ].join("\0"));
  return (
    <SessionLoadingSkeleton
      header={
        <div
          ref={adaptiveHeaderStatus.headerRef}
          className={adaptiveHeaderStatus.compact ? "session-header session-header-status-compact" : "session-header"}
        >
          <button className="icon-button" onClick={onBack} aria-label="Back">
            <ArrowLeft size={19} />
          </button>
          <div ref={adaptiveHeaderStatus.titleRef} className="session-title">
            <h1>{session ? sessionDisplayName(session) : "Loading session"}</h1>
            {session ? (
              <div className="session-title-meta">
                <SessionHeaderMeta session={session} />
              </div>
            ) : <p className="session-header-meta">Starting session</p>}
          </div>
          <div ref={adaptiveHeaderStatus.runtimeRef} className="session-header-runtime">
            {session ? <ModelSettingsButton compact session={session} catalog={null} /> : null}
            <span ref={adaptiveHeaderStatus.statusProbeRef} className="session-header-status-probe" aria-hidden="true">
              <LoadingStatusPill />
            </span>
            <LoadingStatusPill />
          </div>
        </div>
      }
      actions={
        <div className="session-actions">
          <div className="session-action-group session-tool-actions">
            <button
              className="session-new-session-button"
              type="button"
              onClick={onNewSession}
              aria-label="New session"
              title="New session"
            >
              <Plus size={18} />
              <span className="session-new-session-button-label">New session</span>
            </button>
            {workspace ? (
              <button
                className="git-workspace-chip"
                type="button"
                disabled
                aria-label={`Git workspace ${workspace.targetBranch} loading`}
              >
                <GitBranch size={14} />
                <span>{workspace.targetBranch}</span>
              </button>
            ) : null}
          </div>
          <div className="session-action-group session-runtime-actions">
            <button type="button" disabled aria-label="Interrupt session unavailable while loading" title="Interrupt">
              <Pause size={16} />
              <span className="session-action-label">Interrupt</span>
            </button>
            <button className="danger" type="button" disabled aria-label="Kill session unavailable while loading" title="Kill session">
              <Skull size={16} />
              <span className="session-action-label">Kill</span>
            </button>
          </div>
        </div>
      }
      notice={error ? (
        <div className="session-loading-notice" role="alert">
          <AlertTriangle size={24} aria-hidden="true" />
          <div>
            <strong>Still loading this session</strong>
            <p>{error}{retrying ? " Muxpilot will keep trying automatically." : " Retry when the session becomes available."}</p>
            {onRetry ? <button type="button" className="primary-button" onClick={onRetry}>Retry now</button> : null}
          </div>
        </div>
      ) : undefined}
    />
  );
}

export function GitWorkspacePanel({
  workspace,
  onClose
}: {
  workspace: GitWorkspaceSummary;
  onClose: () => void;
}) {
  const current = normalizeGitWorkspaceSummary(workspace);
  const [worktreeCopied, setWorktreeCopied] = useState(false);
  if (!current) return null;

  async function copyWorktreeName() {
    if (!current?.sessionBranch) return;
    try {
      await copyText(current.sessionBranch);
      setWorktreeCopied(true);
      window.setTimeout(() => setWorktreeCopied(false), 1600);
    } catch {
      setWorktreeCopied(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={<><GitBranch size={18} /> Git workspace</>}
      panelClassName="git-workspace-panel"
      backdropClassName="git-panel-backdrop"
      closeLabel="Close Git workspace controls"
    >
        <div className="git-panel-summary">
          <div><span>Target branch</span><strong>{current.targetBranch}</strong>{current.targetSha ? <code>{shortSha(current.targetSha)}</code> : null}</div>
          {current.sessionBranch ? (
            <button
              type="button"
              className="git-worktree-copy"
              data-copied={worktreeCopied || undefined}
              onClick={() => void copyWorktreeName()}
              aria-label={worktreeCopied ? `Copied worktree name ${current.sessionBranch}` : `Copy worktree name ${current.sessionBranch}`}
              title={`Copy ${current.sessionBranch}`}
            >
              <span>Worktree</span>
              <strong title={current.worktreePath ?? undefined}>{current.sessionBranch}</strong>
              <small aria-live="polite">{worktreeCopied ? <><Check size={14} aria-hidden="true" /> Copied</> : <><Copy size={14} aria-hidden="true" /> Copy worktree name</>}</small>
            </button>
          ) : <div><span>Worktree</span><strong>No implementation worktree</strong></div>}
          <div><span>State</span><strong>{gitWorkspaceChipState(current)}</strong>{current.updatedAt ? <small>{current.updatedAt}</small> : null}</div>
        </div>
        {current.lastError ? <p className="git-panel-error" role="alert">{current.lastError}</p> : null}
    </Modal>
  );
}

export function gitWorkspaceChipState(workspace: GitWorkspaceSummary): string {
  const current = normalizeGitWorkspaceSummary(workspace);
  if (!current || current.state === "idle") return "idle";
  if (current.state === "worktree") return "isolated";
  return current.state;
}

function shortSha(value: string): string {
  return value.slice(0, 8);
}

export function shouldSubmitComposer(event: Pick<KeyboardEvent<HTMLTextAreaElement>, "ctrlKey" | "key">): boolean {
  return event.ctrlKey && event.key === "Enter";
}

export function blurActiveElementForVimSubmit(vimEnabled: boolean, activeElement: Element | null): void {
  if (!vimEnabled || typeof HTMLElement === "undefined" || !(activeElement instanceof HTMLElement)) return;
  activeElement.blur();
}

export function composerLockReason(hasPendingQuestion: boolean, hasPendingPlan: boolean, startupError?: string | null): string | null {
  if (startupError) return startupError;
  if (hasPendingQuestion) return "Answer the pending question below to continue";
  if (hasPendingPlan) return "Choose a proposed plan action below to continue";
  return null;
}

export interface ActiveSkillToken {
  start: number;
  end: number;
  query: string;
}

type SkillSuggestionCommand = "next" | "previous" | "accept" | "dismiss";

export function activeSkillToken(text: string, caret: number): ActiveSkillToken | null {
  const boundedCaret = Math.max(0, Math.min(caret, text.length));
  let start = boundedCaret;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  const token = text.slice(start, boundedCaret);
  if (!token.startsWith("$")) return null;

  let end = boundedCaret;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1;
  return { start, end, query: token.slice(1) };
}

export function skillSuggestions(skills: CodexSkill[], query: string, limit = 8): CodexSkill[] {
  const normalizedQuery = query.toLowerCase();
  return skills
    .map((skill) => ({ skill, score: skillSuggestionScore(skill.name, normalizedQuery) }))
    .filter((match): match is { skill: CodexSkill; score: number } => match.score !== null)
    .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .map((match) => match.skill)
    .slice(0, limit);
}

export function skillSuggestionScore(name: string, query: string): number | null {
  if (!query) return 0;
  const normalizedName = name.toLowerCase();
  if (normalizedName === query) return 0;
  if (normalizedName.startsWith(query)) return 10 + normalizedName.length - query.length;
  const index = normalizedName.indexOf(query);
  if (index >= 0) return 30 + index;

  let cursor = 0;
  let score = 60;
  let previousIndex = -1;
  for (const char of query) {
    const nextIndex = normalizedName.indexOf(char, cursor);
    if (nextIndex < 0) return null;
    if (previousIndex >= 0) score += nextIndex - previousIndex - 1;
    if (isSkillWordBoundary(normalizedName, nextIndex)) score -= 4;
    previousIndex = nextIndex;
    cursor = nextIndex + 1;
  }
  return score + normalizedName.length - query.length;
}

function isSkillWordBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  return /[-_:]/.test(value[index - 1] ?? "");
}

export function replaceSkillToken(text: string, token: ActiveSkillToken, skillName: string): { text: string; caret: number } {
  const replacement = `$${skillName} `;
  const nextText = `${text.slice(0, token.start)}${replacement}${text.slice(token.end).replace(/^\s/, "")}`;
  return { text: nextText, caret: token.start + replacement.length };
}

function parsePixelValue(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement, mirror: HTMLElement | null): void {
  const styles = window.getComputedStyle(textarea);
  const minHeight = parsePixelValue(styles.minHeight) ?? 0;
  const maxHeight = parsePixelValue(styles.maxHeight) ?? Number.POSITIVE_INFINITY;
  textarea.dataset.composerResizing = "true";
  textarea.style.height = "auto";
  const contentHeight = textarea.scrollHeight;
  const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
  const height = `${nextHeight}px`;
  const overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  textarea.style.height = height;
  textarea.style.setProperty("--composer-content-height", height);
  delete textarea.dataset.composerResizing;
  textarea.style.overflowY = overflowY;
  if (!mirror) return;
  mirror.style.height = height;
  mirror.style.setProperty("--composer-content-height", height);
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
}

export function relativeLineNumber(lineNo: number, cursorLineNo: number): string {
  return String(Math.abs(lineNo - cursorLineNo));
}

class RelativeLineNumberMarker extends GutterMarker {
  elementClass = "";

  constructor(private readonly label: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RelativeLineNumberMarker && other.label === this.label;
  }

  toDOM(): Node {
    const element = document.createElement("span");
    element.textContent = this.label;
    return element;
  }
}

export function vimRelativeLineNumbers(): Extension {
  const markerForLine = (view: EditorView, lineFrom: number): RelativeLineNumberMarker => {
    const lineNo = view.state.doc.lineAt(lineFrom).number;
    const cursorLineNo = view.state.doc.lineAt(view.state.selection.main.head).number;
    return new RelativeLineNumberMarker(relativeLineNumber(lineNo, cursorLineNo));
  };

  return gutter({
    class: "cm-lineNumbers cm-relativeLineNumbers",
    lineMarker: (view, line) => markerForLine(view, line.from),
    lineMarkerChange: (update) => update.selectionSet || update.docChanged || update.viewportChanged,
    initialSpacer: (view) => new RelativeLineNumberMarker(String(view.state.doc.lines)),
    updateSpacer: (_spacer, update) => new RelativeLineNumberMarker(String(update.state.doc.lines))
  });
}

function codeMirrorSkillHighlightExtension(skillNames: Set<string>): Extension {
  const matcher = new MatchDecorator({
    regexp: /\$([A-Za-z0-9][A-Za-z0-9_:-]*)/g,
    decoration: (match) => {
      const skillName = match[1];
      return skillName && skillNames.has(skillName) ? Decoration.mark({ class: "composer-skill-reference" }) : null;
    }
  });

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view);
      }

      update(update: ViewUpdate) {
        this.decorations = matcher.updateDeco(update, this.decorations);
      }
    },
    {
      decorations: (value) => value.decorations
    }
  );
}

class ComposerImageWidget extends WidgetType {
  constructor(private readonly src: string, private readonly pending: boolean) { super(); }
  eq(other: ComposerImageWidget): boolean { return other.src === this.src && other.pending === this.pending; }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = `composer-inline-image${this.pending ? " composer-inline-image-pending" : ""}`;
    const image = document.createElement("img");
    image.src = this.src;
    image.alt = this.pending ? "Uploading image" : "Pasted image";
    wrapper.append(image);
    return wrapper;
  }
  ignoreEvent(): boolean { return false; }
}

function composerImageExtension(sessionId: string, previews: Map<string, string>): Extension {
  const matcher = new MatchDecorator({
    regexp: /\[\[muxpilot-(image|upload):([^\]]+)\]\]/g,
    decoration: (match) => {
      if (match[1] === "upload") return Decoration.replace({ widget: new ComposerImageWidget(previews.get(match[2]!) ?? "", true) });
      const [id] = match[2]!.split(":");
      return Decoration.replace({ widget: new ComposerImageWidget(api.imageUrl(sessionId, id!), false) });
    }
  });
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = matcher.createDeco(view); }
    update(update: ViewUpdate) { this.decorations = matcher.updateDeco(update, this.decorations); }
  }, {
    decorations: (value) => value.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
  });
}

export function runVimCtrlJCommand(view: EditorView): boolean {
  const cm = getCM(view);
  const vimState = cm?.state.vim ?? null;
  if (cm && vimState && !vimState.insertMode) {
    const handled = Vim.handleKey(cm, "j", "user");
    return handled === true || cursorLineDown(view);
  }
  return insertNewlineAndIndent(view);
}

export function runVimEscapeCommand(view: EditorView): boolean {
  const cm = getCM(view);
  const vimState = cm?.state.vim ?? null;
  if (!cm || !vimState || vimState.insertMode) return false;
  view.contentDOM.blur();
  view.dom.blur();
  return true;
}

export function resetVimToNormalMode(view: EditorView): boolean {
  const cm = getCM(view);
  const vimState = cm?.state.vim ?? null;
  if (!cm || !vimState) return false;
  if (vimState.insertMode) {
    Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0], true);
  } else if (vimState.visualMode) {
    Vim.exitVisualMode(cm as Parameters<typeof Vim.exitVisualMode>[0], true);
  } else {
    return false;
  }
  cm.refresh();
  return true;
}

export function runVimFocusCommand(view: EditorView, command: PrimaryInputFocusCommand): boolean {
  view.focus();
  const cm = getCM(view);
  if (!cm) return command === "focus";
  const vimState = Vim.maybeInitVimState_(cm);
  const handleNormalKey = (key: "a" | "i") => {
    const vim = cm.state.vim ?? vimState;
    vim.status = (vim.status || "") + key;
    const handled = Vim.multiSelectHandleKey(cm, key, "user");
    cm.refresh();
    return handled === true || Boolean(cm.state.vim?.insertMode);
  };
  const enterInsertMode = () => (cm.state.vim?.insertMode ? true : handleNormalKey("i"));
  if (command === "focus") return true;
  if (command === "insertStart") {
    view.dispatch({ selection: { anchor: 0 } });
    return enterInsertMode();
  }
  if (command === "appendEnd") {
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    return enterInsertMode();
  }
  if (cm.state.vim?.insertMode) return true;
  return handleNormalKey(command === "append" ? "a" : "i");
}

function VimPromptEditor({
  value,
  onChange,
  onSubmitShortcut,
  onSuggestionCommand,
  onFocus,
  onBlur,
  skills,
  placeholder,
  disabled,
  vimEnabled,
  selectionRequest,
  focusRequestKey,
  focusCommand = "focus",
  onCaretChange,
  sessionId,
  onUploadingChange
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmitShortcut?: () => void;
  onSuggestionCommand?: (command: SkillSuggestionCommand) => boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  skills: CodexSkill[];
  placeholder?: string;
  disabled?: boolean;
  vimEnabled: boolean;
  selectionRequest: { caret: number; nonce: number } | null;
  focusRequestKey?: string | null;
  focusCommand?: PrimaryInputFocusCommand;
  onCaretChange: (caret: number) => void;
  sessionId: string;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSubmitShortcutRef = useRef(onSubmitShortcut);
  const onSuggestionCommandRef = useRef(onSuggestionCommand);
  const onFocusRef = useRef(onFocus);
  const onBlurRef = useRef(onBlur);
  const onCaretChangeRef = useRef(onCaretChange);
  const rebuildCaretRef = useRef(0);
  const rebuildFocusedRef = useRef(false);
  const skillNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);
  const skillNamesKey = useMemo(() => [...skillNames].sort().join("\0"), [skillNames]);
  const skillHighlightCompartment = useMemo(() => new Compartment(), []);
  const placeholderCompartment = useMemo(() => new Compartment(), []);
  const previewsRef = useRef(new Map<string, string>());
  const uploadCountRef = useRef(0);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSubmitShortcutRef.current = onSubmitShortcut;
    onSuggestionCommandRef.current = onSuggestionCommand;
    onFocusRef.current = onFocus;
    onBlurRef.current = onBlur;
    onCaretChangeRef.current = onCaretChange;
  }, [onBlur, onCaretChange, onChange, onFocus, onSubmitShortcut, onSuggestionCommand]);

  useEffect(() => {
    valueRef.current = value;
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    const head = Math.min(view.state.selection.main.head, value.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: head }
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !selectionRequest) return;
    const caret = Math.max(0, Math.min(selectionRequest.caret, view.state.doc.length));
    view.focus();
    view.dispatch({ selection: { anchor: caret } });
  }, [selectionRequest]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !focusRequestKey || disabled) return;
    view.focus();
    if (focusCommand === "focus") return;
    requestAnimationFrame(() => {
      if (viewRef.current === view && view.hasFocus) runVimFocusCommand(view, focusCommand);
    });
  }, [disabled, focusCommand, focusRequestKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const extensions: Extension[] = [
      Prec.highest(
        keymap.of([
          {
            key: "ArrowDown",
            run: () => onSuggestionCommandRef.current?.("next") ?? false
          },
          {
            key: "ArrowUp",
            run: () => onSuggestionCommandRef.current?.("previous") ?? false
          },
          {
            key: "Enter",
            run: () => onSuggestionCommandRef.current?.("accept") ?? false
          },
          {
            key: "Tab",
            run: () => onSuggestionCommandRef.current?.("accept") ?? false
          },
          {
            key: "Escape",
            run: (view) => {
              if (onSuggestionCommandRef.current?.("dismiss")) return true;
              return runVimEscapeCommand(view);
            }
          },
          {
            key: "Ctrl-Enter",
            run: () => {
              onSubmitShortcutRef.current?.();
              return true;
            }
          },
          {
            key: "Ctrl-j",
            run: (view) => {
              if (onSuggestionCommandRef.current?.("next")) return true;
              return runVimCtrlJCommand(view);
            }
          }
        ])
      ),
      minimalSetup,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(codeMirrorComposerFieldAttributes),
      skillHighlightCompartment.of(codeMirrorSkillHighlightExtension(skillNames)),
      placeholderCompartment.of(placeholder ? codeMirrorPlaceholder(placeholder) : []),
      EditorState.readOnly.of(Boolean(disabled)),
      EditorView.editable.of(!disabled),
      composerImageExtension(sessionId, previewsRef.current),
      EditorView.domEventHandlers({
        paste(event, view) {
          const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          insertComposerImages(view, files, view.state.selection.main.from, view.state.selection.main.to);
          return true;
        },
        drop(event, view) {
          const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
          insertComposerImages(view, files, position, position);
          return true;
        }
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const nextValue = update.state.doc.toString();
          valueRef.current = nextValue;
          onChangeRef.current(nextValue);
        }
        if (update.docChanged || update.selectionSet) {
          onCaretChangeRef.current(update.state.selection.main.head);
        }
        if (update.focusChanged) {
          if (update.view.hasFocus) onFocusRef.current?.();
          else {
            resetVimToNormalMode(update.view);
            onBlurRef.current?.();
          }
        }
      })
    ];

    function insertComposerImages(view: EditorView, files: File[], position: number, selectionTo: number): void {
      const existing = (view.state.doc.toString().match(/\[\[muxpilot-(?:image|upload):/g) ?? []).length;
      for (const file of files.slice(0, Math.max(0, 10 - existing))) {
        const uploadId = crypto.randomUUID();
        const token = `[[muxpilot-upload:${uploadId}]]`;
        previewsRef.current.set(uploadId, URL.createObjectURL(file));
        view.dispatch({ changes: { from: position, to: selectionTo, insert: token }, selection: { anchor: position + token.length } });
        selectionTo = position;
        position += token.length;
        uploadCountRef.current += 1;
        onUploadingChange?.(true);
        void api.uploadImage(sessionId, file).then(({ image }) => {
          const current = view.state.doc.toString();
          const from = current.indexOf(token);
          if (from >= 0) view.dispatch({ changes: { from, to: from + token.length, insert: `[[muxpilot-image:${image.id}:${image.mimeType}]]` } });
        }).catch(() => {
          const current = view.state.doc.toString();
          const from = current.indexOf(token);
          if (from >= 0) view.dispatch({ changes: { from, to: from + token.length, insert: "[Image upload failed]" } });
        }).finally(() => {
          const preview = previewsRef.current.get(uploadId);
          if (preview) URL.revokeObjectURL(preview);
          previewsRef.current.delete(uploadId);
          uploadCountRef.current -= 1;
          onUploadingChange?.(uploadCountRef.current > 0);
        });
      }
    }

    if (vimEnabled) extensions.splice(1, 0, vim({ status: true }), vimRelativeLineNumbers());

    const view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: valueRef.current,
        extensions
      })
    });
    const rebuildCaret = Math.max(0, Math.min(rebuildCaretRef.current, view.state.doc.length));
    if (rebuildCaret) view.dispatch({ selection: { anchor: rebuildCaret } });
    if ((rebuildFocusedRef.current || focusRequestKey) && !disabled) view.focus();
    viewRef.current = view;
    onCaretChangeRef.current(view.state.selection.main.head);

    return () => {
      rebuildCaretRef.current = view.state.selection.main.head;
      rebuildFocusedRef.current = view.hasFocus;
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [disabled, placeholderCompartment, sessionId, skillHighlightCompartment, vimEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.reconfigure(placeholder ? codeMirrorPlaceholder(placeholder) : [])
    });
  }, [placeholder, placeholderCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: skillHighlightCompartment.reconfigure(codeMirrorSkillHighlightExtension(skillNames))
    });
  }, [skillHighlightCompartment, skillNamesKey]);

  return (
    <div
      {...composerRootInputHints}
      className={vimEnabled ? "vim-editor" : "prompt-editor"}
      ref={rootRef}
    />
  );
}

export function SkillTextArea({
  value,
  onChange,
  vimEnabled,
  onSubmitShortcut,
  onFocus,
  onBlur,
  skills,
  onSkillSearch,
  placeholder,
  focusRequestKey,
  focusCommand = "focus",
  disabled,
  sessionId = "",
  onUploadingChange
}: {
  value: string;
  onChange: (value: string) => void;
  vimEnabled?: boolean;
  onSubmitShortcut?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  skills: CodexSkill[];
  onSkillSearch?: () => void;
  placeholder?: string;
  focusRequestKey?: string | null;
  focusCommand?: PrimaryInputFocusCommand;
  disabled?: boolean;
  sessionId?: string;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissedTokenStart, setDismissedTokenStart] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [vimSelectionRequest, setVimSelectionRequest] = useState<{ caret: number; nonce: number } | null>(null);
  const vimSelectionNonceRef = useRef(0);
  const token = activeSkillToken(value, caret);
  const suggestions = useMemo(() => (token && !disabled ? skillSuggestions(skills, token.query) : []), [disabled, skills, token?.query]);
  const open = focused && Boolean(token) && token?.start !== dismissedTokenStart && suggestions.length > 0;
  const skillNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);

  useEffect(() => {
    setSelectedIndex(0);
    setDismissedTokenStart(null);
  }, [token?.start, token?.query]);

  useEffect(() => {
    if (focused && token) onSkillSearch?.();
  }, [focused, onSkillSearch, token?.start, token?.query]);

  function acceptSkill(skill: CodexSkill) {
    if (!token) return;
    const next = replaceSkillToken(value, token, skill.name);
    onChange(next.text);
    vimSelectionNonceRef.current += 1;
    setVimSelectionRequest({ caret: next.caret, nonce: vimSelectionNonceRef.current });
    setCaret(next.caret);
  }

  function handleSuggestionCommand(command: SkillSuggestionCommand): boolean {
    if (!open || suggestions.length === 0) return false;
    if (command === "next") {
      setSelectedIndex((current) => (current + 1) % suggestions.length);
      return true;
    }
    if (command === "previous") {
      setSelectedIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if (command === "accept") {
      const selectedSkill = suggestions[selectedIndex] ?? suggestions[0];
      if (selectedSkill) acceptSkill(selectedSkill);
      return true;
    }
    setDismissedTokenStart(token?.start ?? null);
    return true;
  }

  return (
    <div className={`skill-textarea${vimEnabled ? " skill-textarea-vim" : ""}`}>
      <VimPromptEditor
          value={value}
          onChange={onChange}
          onSubmitShortcut={onSubmitShortcut}
          onSuggestionCommand={handleSuggestionCommand}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          skills={skills}
          placeholder={placeholder}
          disabled={disabled}
          vimEnabled={Boolean(vimEnabled)}
          selectionRequest={vimSelectionRequest}
          focusRequestKey={focusRequestKey}
          focusCommand={focusCommand}
          onCaretChange={setCaret}
          sessionId={sessionId}
          onUploadingChange={onUploadingChange}
        />
      {open ? (
        <div className="skill-suggestions" role="listbox" aria-label="Codex skills">
          {suggestions.map((skill, index) => (
            <button
              key={skill.name}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={index === selectedIndex ? "skill-suggestion-selected" : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                acceptSkill(skill);
              }}
            >
              <span className="skill-suggestion-name">${skill.name}</span>
              {skill.description ? <span className="skill-suggestion-description">{skill.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function renderComposerHighlights(text: string, skillNames: Set<string>): ReactNode {
  if (!text) return "\u00a0";
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SKILL_REFERENCE_PATTERN)) {
    const fullMatch = match[0];
    const skillName = match[1];
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    if (skillName && skillNames.has(skillName)) {
      nodes.push(
        <span className="composer-skill-reference" key={`${skillName}-${index}`}>
          {fullMatch}
        </span>
      );
    } else {
      nodes.push(fullMatch);
    }
    cursor = index + fullMatch.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function SessionTitleHeading({
  name,
  onFork,
  forkDisabled = false
}: {
  name: string;
  onFork: () => void;
  forkDisabled?: boolean;
}) {
  return (
    <div className="session-title-heading">
      <h1>{name}</h1>
      <button
        className="session-title-fork-button"
        type="button"
        onClick={onFork}
        disabled={forkDisabled}
        aria-label="Fork session"
        title="Fork session"
      >
        <GitFork size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function SessionHeaderMeta({ session }: {
  session: Pick<ManagedSession, "repo" | "gitWorkspace" | "forkedFrom" | "agentOwnership"> &
    Partial<Pick<ManagedSession, "contextUsage" | "runtime" | "resourceUsage">>;
}) {
  const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
  const dirty = workspace?.state === "worktree" || session.repo.dirty;
  const title = `${session.repo.name}${dirty ? " · dirty" : ""}`;

  return (
    <p className="session-header-meta" title={title}>
      <span className="session-header-repo">{session.repo.name}</span>
      <SessionContextUsage session={session} />
      {dirty ? (
        <>
          <span className="session-header-meta-separator" aria-hidden="true">
            ·
          </span>
          <span className="session-header-dirty dirty">dirty</span>
        </>
      ) : null}
      <span className="session-header-meta-separator session-header-runtime-detail-separator" aria-hidden="true">·</span>
      <span className="session-header-runtime-detail" title={runtimeDetail(session)}>{runtimeLabel(session)}</span>
      {session.resourceUsage ? (
        <>
          <span className="session-header-meta-separator session-header-memory-usage-separator" aria-hidden="true">·</span>
          <span className="session-header-memory-usage" title={`Memory limit ${formatRuntimeBytes(session.resourceUsage.memoryMaxBytes)}`}>
            {formatRuntimeBytes(session.resourceUsage.memoryCurrentBytes)} memory
          </span>
        </>
      ) : null}
      {session.forkedFrom ? (
        <>
          <span className="session-header-meta-separator" aria-hidden="true">·</span>
          {session.forkedFrom.sessionId ? (
            <Link to={`/sessions/${session.forkedFrom.sessionId}`}>Forked from {session.forkedFrom.sessionName}</Link>
          ) : (
            <span>Forked from {session.forkedFrom.sessionName}</span>
          )}
        </>
      ) : null}
      {session.agentOwnership ? (
        <>
          <span className="session-header-meta-separator" aria-hidden="true">·</span>
          <Link to={`/sessions/${session.agentOwnership.parentSessionId}`}>Agent-managed child</Link>
        </>
      ) : null}
    </p>
  );
}

export function SessionContextUsage({ session }: { session: Partial<Pick<ManagedSession, "contextUsage">> }) {
  if (!session.contextUsage) return null;
  const percent = Math.round(session.contextUsage.contextPercent);
  const detail = `${session.contextUsage.activeTokens.toLocaleString()} of ${session.contextUsage.contextWindowTokens.toLocaleString()} active context tokens`;
  return (
    <span className="session-context-usage" title={detail} aria-label={`${percent}% context used; ${detail}`}>
      <span>{percent}%</span>
      <span className="session-context-usage-label">context</span>
    </span>
  );
}

export function appendUniqueMessages(current: ChatMessage[], incoming: ChatMessage[], sessionId: string): ChatMessage[] {
  const next = [...current];

  for (const message of incoming) {
    if (message.sessionId !== sessionId) continue;
    const existingIndex = next.findIndex((currentMessage) => currentMessage.id === message.id || currentMessage.sequence === message.sequence);
    if (existingIndex >= 0) {
      next[existingIndex] = message;
      continue;
    }
    next.push(message);
  }

  return next.sort((a, b) => a.sequence - b.sequence);
}

export function appendUniqueTranscriptItems(current: CoreTranscriptItem[], incoming: CoreTranscriptItem[]): CoreTranscriptItem[] {
  const next = [...current];

  for (const item of incoming) {
    const existingIndex = next.findIndex(
      (currentItem) =>
        currentItem.id === item.id ||
        (itemFirstSequence(currentItem) === itemFirstSequence(item) && itemLastSequence(currentItem) === itemLastSequence(item))
    );
    if (existingIndex >= 0) {
      next[existingIndex] = item;
      continue;
    }
    next.push(item);
  }

  return next.sort((a, b) => itemFirstSequence(a) - itemFirstSequence(b));
}

export function replaceTranscriptTail(current: CoreTranscriptItem[], incoming: CoreTranscriptItem[]): CoreTranscriptItem[] {
  const firstIncoming = incoming[0];
  if (!firstIncoming) return current;
  const firstSequence = itemFirstSequence(firstIncoming);
  const preserved = current.filter((item) => itemLastSequence(item) < firstSequence);
  return appendUniqueTranscriptItems(preserved, incoming);
}

type TranscriptItem =
  | { type: "message"; message: ChatMessage }
  | { type: "user_action"; message: ChatMessage }
  | { type: "stack"; id: string; messages: ChatMessage[] }
  | { type: "activity"; id: string; messages: ChatMessage[] };

export function ModeToggle({
  mode,
  busy,
  onChange
}: {
  mode: CollaborationMode;
  busy: boolean;
  onChange: (mode: CollaborationMode) => void;
}) {
  return (
    <div className="mode-toggle" role="group" aria-label="Input mode" aria-busy={busy}>
      <button
        type="button"
        className={`mode-toggle-normal${mode === "default" ? " selected" : ""}`}
        disabled={busy}
        aria-label="Normal"
        title="Normal"
        onClick={() => onChange("default")}
      >
        <MessageSquare className="mode-toggle-icon" size={15} aria-hidden="true" />
        <span className="mode-toggle-text">Normal</span>
      </button>
      <button
        type="button"
        className={`mode-toggle-plan${mode === "plan" ? " selected" : ""}`}
        disabled={busy}
        aria-label="Plan"
        title="Plan"
        onClick={() => onChange("plan")}
      >
        <ListChecks className="mode-toggle-icon" size={15} aria-hidden="true" />
        <span className="mode-toggle-text">Plan</span>
      </button>
    </div>
  );
}

export function FastModeToggle({
  enabled,
  available,
  busy,
  status,
  onChange
}: {
  enabled: boolean;
  available: boolean | null;
  busy: boolean;
  status: ManagedSession["status"];
  onChange: (enabled: boolean) => void;
}) {
  const unavailable = available === false;
  const allowed = canToggleFastMode(status);
  const disabled = busy || unavailable || !allowed;
  const title = unavailable
    ? "Fast mode is unavailable for this model"
    : !allowed
      ? "Fast mode cannot be changed in the session's current state"
      : enabled
        ? "Disable Fast mode (also updates the default for future Codex sessions)"
        : "Enable Fast mode (uses more credits and updates the default for future Codex sessions)";
  return (
    <button
      type="button"
      className={`fast-mode-toggle${enabled ? " selected" : ""}`}
      disabled={disabled}
      aria-label={enabled ? "Disable Fast mode" : "Enable Fast mode"}
      aria-pressed={enabled}
      aria-busy={busy}
      title={title}
      onClick={() => onChange(!enabled)}
    >
      <Zap size={15} aria-hidden="true" />
      <span>Fast</span>
    </button>
  );
}

export function VimModeToggle({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <button
      className={`vim-toggle${enabled ? " selected" : ""}`}
      type="button"
      aria-label={enabled ? "Disable Vim mode" : "Enable Vim mode"}
      aria-pressed={enabled}
      title={enabled ? "Vim mode on" : "Vim mode off"}
      onClick={() => onChange(!enabled)}
    >
      <VimLogoMark />
    </button>
  );
}

function VimLogoMark() {
  return (
    <svg className="vim-logo" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <path className="vim-logo-shape" d="M6 8.2 18 2l12 6.2v16.9L18 34 6 25.1Z" />
      <path className="vim-logo-v" d="M10.5 10.5 17.7 27 25.5 10.5" />
      <path className="vim-logo-cut" d="M14.3 10.5h7.8" />
    </svg>
  );
}

export function ModelSettingsButton({
  session,
  catalog,
  compact = false,
  onOpen
}: {
  session: ManagedSession;
  catalog: CodexModelCatalogResponse | null;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const model = sessionModelDisplay(session, catalog);
  const content = (
    <>
      <SlidersHorizontal className="model-settings-icon" size={15} aria-hidden="true" />
      <span className="model-settings-label">
        <span className="model-settings-model">{model.model}</span>
        <span className="model-settings-effort">{model.reasoningEffort}</span>
      </span>
    </>
  );
  const className = `model-settings-button${compact ? " model-settings-metadata" : ""}`;
  const selectable = Boolean(onOpen);
  if (!selectable) {
    return (
      <div className={`${className} model-settings-display`} title={`${model.model} / ${model.reasoningEffort}`} aria-label={`${model.model} ${model.reasoningEffort}`}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onOpen}
      title={`Change model settings · ${model.model} / ${model.reasoningEffort}`}
      aria-label={`Change model settings, current ${model.model} ${model.reasoningEffort}`}
      aria-haspopup="dialog"
    >
      {content}
    </button>
  );
}

export function RuntimeAttachButton({
  session,
  copied,
  accessMode,
  enabled,
  onCopy
}: {
  session: Pick<ManagedSession, "runtime">;
  copied: boolean;
  accessMode: AccessMode | null;
  enabled: boolean;
  onCopy: () => void;
}) {
  if (accessMode !== "local") return null;

  return (
    <button
      className="icon-button runtime-attach-button"
      type="button"
      disabled={!enabled}
      onClick={onCopy}
      title={enabled ? copied ? "Runtime attach command copied" : "Copy runtime attach command" : "Runtime attach is unavailable for this session"}
      aria-label={copied ? "Runtime attach command copied" : "Copy runtime attach command"}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <SquareTerminal size={16} aria-hidden="true" />}
    </button>
  );
}

export function sessionModelDisplay(
  session: Pick<ManagedSession, "inputMode" | "models">,
  catalog: CodexModelCatalogResponse | null = null
): { model: string; reasoningEffort: string } {
  const settings = catalog
    ? effectiveModelSettings(session, catalog.defaults, session.inputMode)
    : session.models[session.inputMode];
  const fallback = fallbackModelSettings(session.models.default, session.models.plan);
  return {
    model: settings.model ?? fallback.model ?? "Model unknown",
    reasoningEffort: settings.reasoningEffort ?? fallback.reasoningEffort ?? "Effort unknown"
  };
}

function fallbackModelSettings(...settings: SessionModelSettings[]): SessionModelSettings {
  return {
    model: settings.find((setting) => setting.model)?.model ?? null,
    reasoningEffort: settings.find((setting) => setting.reasoningEffort)?.reasoningEffort ?? null
  };
}

export function runtimeAttachCommand(session: Pick<ManagedSession, "runtime">): string {
  if (session.runtime?.kind !== "systemd_service") throw new Error("Session has no attachable app-server runtime");
  return `codex --remote ${shellQuote(`unix://${session.runtime.socketPath}`)}`;
}

export function runtimeLabel(session: Partial<Pick<ManagedSession, "runtime">>): string {
  if (session.runtime?.kind !== "systemd_service") return "App server";
  return session.runtime.state === "hibernated" ? "App server · sleeping" : `App server · ${session.runtime.state}`;
}

function runtimeDetail(session: Partial<Pick<ManagedSession, "runtime">>): string {
  if (session.runtime?.kind !== "systemd_service") return runtimeLabel(session);
  return `${runtimeLabel(session)} · ${session.runtime.unit}${session.runtime.codexVersion ? ` · Codex ${session.runtime.codexVersion}` : ""}`;
}

function formatRuntimeBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 ** 3) return `${Math.round(value / 1024 ** 2)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function ApprovalBanner({
  approval,
  automationMode = "ask",
  busy,
  disabled = false,
  error,
  onDecision
}: {
  approval: ApprovalRequest;
  automationMode?: ApprovalMode;
  busy: ApprovalDecision | null;
  disabled?: boolean;
  error: string;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const subject = approval.command ?? approval.toolName ?? approval.title;
  return (
    <section className="approval-banner" aria-live="polite">
      <div className="approval-title">
        <AlertTriangle size={18} />
        <div>
          <strong>{approval.title}</strong>
          <p>{subject}</p>
        </div>
      </div>
      <dl className="approval-details">
        {approval.cwd ? (
          <>
            <dt>cwd</dt>
            <dd>{approval.cwd}</dd>
          </>
        ) : null}
        {approval.reason ? (
          <>
            <dt>reason</dt>
            <dd>{approval.reason}</dd>
          </>
        ) : null}
        {approval.prefixRule?.length ? (
          <>
            <dt>prefix</dt>
            <dd>{approval.prefixRule.join(" ")}</dd>
          </>
        ) : null}
      </dl>
      {approval.reviewStatus === "escalated" ? (
        <p className="approval-review-status">
          Auto review escalated to you{approval.reviewerExplanation ? `: ${approval.reviewerExplanation}` : "."}
        </p>
      ) : automationMode !== "ask" ? (
        <p className="approval-review-status">
          {automationMode === "auto" ? "Reviewing this request for automatic approval…" : "Granting this request automatically…"}
        </p>
      ) : null}
      {error ? <p className="approval-error">{error}</p> : null}
      <div className="approval-actions">
        {approval.options.map((option) => (
          <button
            key={option.decision}
            className={option.decision === "deny" ? "danger" : undefined}
            disabled={disabled || Boolean(busy)}
            aria-busy={busy === option.decision}
            data-busy={busy === option.decision || undefined}
            title={option.description || undefined}
            onClick={() => onDecision(option.decision)}
          >
            {approvalDecisionIcon(option.decision)} {busy === option.decision ? "Submitting" : option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function approvalDecisionIcon(decision: ApprovalDecision): ReactNode {
  if (decision === "deny") return <X size={16} />;
  if (decision === "approve_once") return <Check size={16} />;
  return <ShieldCheck size={16} />;
}

function QueuedInputList({
  sessionId,
  inputs,
  skills,
  vimEnabled,
  onSkillSearch,
  onUpdate,
  onDelete,
  onOpenImage,
  onOpenImageMenu
}: {
  sessionId: string;
  inputs: QueuedInput[];
  skills: CodexSkill[];
  vimEnabled: boolean;
  onSkillSearch: () => void;
  onUpdate: (inputId: string, text: string, mode: CollaborationMode) => Promise<void>;
  onDelete: (inputId: string) => Promise<void>;
  onOpenImage: (image: SessionImageTarget) => void;
  onOpenImageMenu: (image: SessionImageTarget, copyTarget: MessageCopyTarget | undefined, x: number, y: number) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  function startEdit(input: QueuedInput) {
    if (!queuedInputEditable(input)) return;
    setEditingId(input.id);
    setDraft(composerSource(input.text, input.content));
    setError("");
  }

  async function saveEdit(input: QueuedInput) {
    if (!composerHasContent(draft) || busyId) return;
    const value = draft.trimEnd();
    setBusyId(input.id);
    setError("");
    try {
      await onUpdate(input.id, value, input.mode);
      setEditingId(null);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(input: QueuedInput) {
    if (!queuedInputRemovable(input) || busyId) return;
    setBusyId(input.id);
    setError("");
    try {
      await onDelete(input.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="queued-inputs" aria-live="polite">
      <div className="queued-inputs-title">
        <strong>Queued messages</strong>
      </div>
      <div className="queued-input-list">
        {inputs.map((input) => {
          const editable = queuedInputEditable(input);
          const removable = queuedInputRemovable(input);
          const busy = busyId === input.id;
          const editing = editingId === input.id;
          const multiline = queuedInputHasLineBreaks(input.text);
          return (
            <article key={input.id} className={`queued-input queued-input-${input.status}`}>
              {editing ? (
                <>
                  <SkillTextArea
                    value={draft}
                    onChange={setDraft}
                    vimEnabled={vimEnabled}
                    skills={skills}
                    onSkillSearch={onSkillSearch}
                    disabled={busy}
                    sessionId={sessionId}
                  />
                  {input.error ? <p className="queued-input-error">{input.error}</p> : null}
                  <div className="queued-input-actions">
                    <button
                      type="button"
                      disabled={busy || !composerHasContent(draft)}
                      aria-busy={busy}
                      data-busy={busy || undefined}
                      onClick={() => void saveEdit(input)}
                    >
                      {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save
                    </button>
                    <button type="button" disabled={busy} onClick={() => setEditingId(null)}>
                      <X size={16} /> Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className={`queued-input-read${multiline ? " queued-input-read-multiline" : ""}`}>
                    <MixedUserContent
                      sessionId={sessionId}
                      text={input.text}
                      content={input.content}
                      copyTarget={input.text.trim() ? { label: "Copy user message", text: input.text } : undefined}
                      onOpenImage={onOpenImage}
                      onOpenImageMenu={onOpenImageMenu}
                    />
                    <div className="queued-input-actions">
                      <button type="button" disabled={!editable || busy} onClick={() => startEdit(input)}>
                        <Pencil size={16} /> Edit
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={!removable || busy}
                        aria-busy={busy}
                        data-busy={busy || undefined}
                        onClick={() => void remove(input)}
                      >
                        {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} Remove
                      </button>
                    </div>
                  </div>
                  {input.error ? <p className="queued-input-error">{input.error}</p> : null}
                </>
              )}
            </article>
          );
        })}
      </div>
      {error ? <p className="queued-input-error">{error}</p> : null}
    </section>
  );
}

export function queuedInputHasLineBreaks(text: string): boolean {
  return /[\r\n]/.test(text);
}

export function queuedInputEditable(input: Pick<QueuedInput, "status">): boolean {
  return input.status === "queued" || input.status === "failed";
}

export function queuedInputRemovable(input: Pick<QueuedInput, "status">): boolean {
  return input.status === "queued" || input.status === "failed" || input.status === "sent";
}

function QuestionBanner({
  question,
  busy,
  submitDisabled = false,
  error,
  onAnswer
}: {
  question: QuestionRequest;
  busy: boolean;
  submitDisabled?: boolean;
  error: string;
  onAnswer: (request: QuestionAnswerRequest) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerDraft>>(() => loadQuestionAnswerDraft(question));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const remainingSeconds = questionRemainingSeconds(question, nowMs);
  const complete = question.questions.every((prompt) => questionAnswerDraftComplete(answers[prompt.id]));

  useEffect(() => {
    setAnswers(loadQuestionAnswerDraft(question));
  }, [question.id]);

  useEffect(() => {
    if (!question.countdownExpiresAt) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [question.countdownExpiresAt]);

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitDisabled || !complete) return;
    onAnswer(buildQuestionAnswerRequest(question, answers));
  }

  function updateAnswers(update: (current: Record<string, QuestionAnswerDraft>) => Record<string, QuestionAnswerDraft>) {
    setAnswers((current) => {
      const next = update(current);
      saveQuestionAnswerDraft(question, next);
      return next;
    });
  }

  return (
    <form className="question-banner" aria-live="polite" onSubmit={submitQuestion}>
      <div className="question-title">
        <HelpCircle size={18} />
        <div>
          <strong>Question requested</strong>
          {remainingSeconds !== null ? <p>{remainingSeconds}s remaining</p> : null}
        </div>
      </div>

      <div className="question-list">
        {question.questions.map((prompt) => (
          <fieldset key={prompt.id} className="question-prompt">
            <legend>{prompt.header || "Question"}</legend>
            <p>{prompt.question}</p>
            {prompt.options.length ? (
              <div className="question-options">
                {prompt.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={answers[prompt.id]?.selectedOption === option.label ? "selected" : ""}
                    disabled={busy}
                    onClick={() =>
                      updateAnswers((current) => {
                        const draft = current[prompt.id] ?? emptyQuestionAnswerDraft();
                        return {
                          ...current,
                          [prompt.id]: {
                            ...draft,
                            selectedOption: draft.selectedOption === option.label ? null : option.label
                          }
                        };
                      })
                    }
                  >
                    <span>{option.label}</span>
                    {option.description ? <small>{option.description}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              {...noAutofillTextField}
              value={answers[prompt.id]?.other ?? ""}
              onChange={(event) =>
                updateAnswers((current) => ({
                  ...current,
                  [prompt.id]: {
                    ...(current[prompt.id] ?? emptyQuestionAnswerDraft()),
                    other: event.target.value
                  }
                }))
              }
              placeholder="Other"
              disabled={busy}
            />
          </fieldset>
        ))}
      </div>

      {error ? <p className="question-error">{error}</p> : null}
      <div className="question-actions">
        <button
          type="submit"
          disabled={busy || submitDisabled || !complete}
          aria-busy={busy}
          data-busy={busy || undefined}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} {busy ? "Sending" : "Send answer"}
        </button>
      </div>
    </form>
  );
}

const NONE_OF_THE_ABOVE_ANSWER = "None of the above";

function emptyQuestionAnswerDraft(): QuestionAnswerDraft {
  return { selectedOption: null, other: "" };
}

function questionAnswerDraftComplete(draft: QuestionAnswerDraft | undefined): boolean {
  return Boolean(draft?.selectedOption?.trim() || draft?.other.trim());
}

function PlanActionBanner({
  busy,
  disabled = false,
  error,
  onAction
}: {
  busy: PlanAction | null;
  disabled?: boolean;
  error: string;
  onAction: (action: PlanAction) => void;
}) {
  return (
    <section className="question-banner plan-action-banner" aria-live="polite">
      <div className="question-title">
        <Check size={18} />
        <div>
          <strong>Proposed plan ready</strong>
          <p>Choose how to continue this session.</p>
        </div>
      </div>

      <div className="question-options plan-action-options">
        {PLAN_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            disabled={disabled || Boolean(busy)}
            aria-busy={busy === action}
            data-busy={busy === action || undefined}
            onClick={() => onAction(action)}
          >
            <span>
              {busy === action ? <LoaderCircle className="spin" size={16} /> : null}
              {PLAN_ACTION_LABELS[action]}
            </span>
            <small>{PLAN_ACTION_DESCRIPTIONS[action]}</small>
          </button>
        ))}
      </div>

      {error ? <p className="question-error">{error}</p> : null}
    </section>
  );
}

function captureScrollAnchor(container: HTMLElement | null): ScrollAnchorSnapshot | null {
  if (!container) return null;
  const items = Array.from(container.querySelectorAll<HTMLElement>("[data-transcript-item-id]"));
  const anchor = items.find((item) => item.offsetTop + item.offsetHeight >= container.scrollTop);
  const itemId = anchor?.dataset.transcriptItemId;
  return {
    itemId: itemId ?? null,
    offsetTop: anchor ? anchor.offsetTop - container.scrollTop : 0,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight
  };
}

function transcriptItemElement(container: HTMLElement, itemId: string): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLElement>("[data-transcript-item-id]")).find(
      (item) => item.dataset.transcriptItemId === itemId
    ) ?? null
  );
}

const PLAN_ACTIONS: PlanAction[] = ["implement", "clear_context_implement", "stay_in_plan"];

const PLAN_ACTION_DESCRIPTIONS: Record<PlanAction, string> = {
  implement: "Start execution using the current context.",
  clear_context_implement: "Compacts context before starting execution.",
  stay_in_plan: "Keep refining the proposed plan."
};

export function planActionText(action: PlanAction): string {
  return PLAN_ACTION_LABELS[action];
}

export function planActionRequest(action: PlanAction, messageId = "pending-plan"): SessionAction {
  return { type: "choosePlanAction", action, messageId } as SessionAction;
}

export function applyPlanActionResponse(
  response: SessionActionResponse,
  targetId: string,
  requestToken: number,
  isCurrentRequest: (targetId: string, requestToken: number) => boolean,
  setCurrentSession: (session: ManagedSession) => void,
  syncSession: (session: ManagedSession) => void
): boolean {
  if (!response.session || !isCurrentRequest(targetId, requestToken)) return false;
  setCurrentSession(response.session);
  syncSession(response.session);
  return true;
}

export function questionRemainingSeconds(question: QuestionRequest, nowMs = Date.now()): number | null {
  return secondsUntil(question.countdownExpiresAt, nowMs);
}

export function secondsUntil(expiresAt: string | null, nowMs = Date.now()): number | null {
  if (!expiresAt) return null;
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return null;
  return Math.max(0, Math.ceil((expiresMs - nowMs) / 1000));
}

export function buildQuestionAnswerRequest(
  question: QuestionRequest,
  values: Record<string, QuestionAnswerDraft>
): QuestionAnswerRequest {
  const answers: QuestionAnswerRequest["answers"] = {};
  for (const prompt of question.questions) {
    const draft = values[prompt.id];
    const selectedOption = draft?.selectedOption?.trim();
    const other = draft?.other.trim();
    const valuesForPrompt: string[] = [];
    if (selectedOption) valuesForPrompt.push(selectedOption);
    if (other) {
      if (prompt.options.length > 0 && !selectedOption) valuesForPrompt.push(NONE_OF_THE_ABOVE_ANSWER);
      valuesForPrompt.push(other);
    }
    if (valuesForPrompt.length > 0) answers[prompt.id] = { answers: valuesForPrompt };
  }
  return { answers };
}

export function pendingProposedPlanMessage(messages: ChatMessage[], _legacySuppressedMessageId: string | null = null): ChatMessage | null {
  const visibleMessages = displayMessages(messages);
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages[index];
    if (!message) continue;
    if (message.role === "user") return null;
    if (isRegularAssistantMessage(message) && hasCompleteProposedPlan(displayText(message) ?? "")) {
      return interactionOutcome(message) ? null : message;
    }
  }
  return null;
}

export function shouldShowWorkingIndicator(status: ManagedSession["status"] | undefined, hasMoreAfter = false): boolean {
  return isWorkingSessionStatus(status) && !hasMoreAfter;
}

export function shouldShowQueuedIndicator(status: ManagedSession["status"] | undefined, hasMoreAfter = false): boolean {
  return status === "queued" && !hasMoreAfter;
}

function isWorkingSessionStatus(status: ManagedSession["status"] | undefined): boolean {
  return status === "working" || status === "running" || status === "generating" || status === "executing" || status === "planning";
}

export function latestUserPromptTimestamp(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.timestamp;
  }
  return null;
}

export function elapsedSince(timestamp: string | null, nowMs = Date.now()): number | null {
  if (!timestamp) return null;
  const sentAtMs = new Date(timestamp).getTime();
  if (!Number.isFinite(sentAtMs)) return null;
  return Math.max(0, Math.floor((nowMs - sentAtMs) / 1000));
}

export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}

export function WorkingIndicator({
  status = "working",
  lastUserPromptAt,
  nowMs
}: {
  status?: ManagedSession["status"];
  lastUserPromptAt?: string | null;
  nowMs?: number;
}) {
  const label = status === "planning"
    ? "Codex is planning..."
    : status === "running"
      ? "Heavyweight command is running"
      : "Codex is working";
  const [currentNowMs, setCurrentNowMs] = useState(() => nowMs ?? Date.now());
  const elapsedSeconds = elapsedSince(lastUserPromptAt ?? null, nowMs ?? currentNowMs);

  useEffect(() => {
    if (!lastUserPromptAt || nowMs !== undefined) return undefined;
    setCurrentNowMs(Date.now());
    const timer = setInterval(() => setCurrentNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lastUserPromptAt, nowMs]);

  return (
    <article className="message message-assistant message-working-indicator" aria-live="polite" role="status">
      <div className="message-meta">
        <span className="message-meta-main">
          <span>Codex</span>
        </span>
      </div>
      <div className="working-indicator-content">
        <span className="working-indicator-label">
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
          <span>{label}</span>
        </span>
        {elapsedSeconds !== null ? (
          <time className="working-indicator-elapsed" dateTime={lastUserPromptAt ?? undefined} title={`Since ${lastUserPromptAt}`}>
            {formatElapsedSeconds(elapsedSeconds)}
          </time>
        ) : null}
      </div>
    </article>
  );
}

export function TranscriptSyncIndicator() {
  return (
    <article className="message message-assistant message-working-indicator" aria-live="polite" role="status">
      <div className="message-meta">
        <span className="message-meta-main">
          <span>Codex</span>
        </span>
      </div>
      <div className="working-indicator-content">
        <span className="working-indicator-label">
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
          <span>Syncing transcript...</span>
        </span>
      </div>
    </article>
  );
}

export function QueuedIndicator() {
  return (
    <article className="message message-assistant message-working-indicator message-queued-indicator" aria-live="polite" role="status">
      <div className="message-meta">
        <span className="message-meta-main">
          <span>Codex</span>
        </span>
      </div>
      <div className="working-indicator-content">
        <span className="working-indicator-label">
          <Clock3 size={18} aria-hidden="true" />
          <span className="queued-indicator-copy">
            <span>Codex is queued</span>
            <small>Waiting for a heavyweight command slot</small>
          </span>
        </span>
      </div>
    </article>
  );
}

export function MessageBubble({
  message,
  itemId,
  pending = false,
  planAction = null,
  planOutcome = null,
  approvalAction = null,
  questionAction = null,
  onOpenDocument,
  onOpenMenu,
  onOpenImage,
  onOpenImageMenu
}: {
  message: ChatMessage;
  itemId?: string;
  pending?: boolean;
  planAction?: ReactNode;
  planOutcome?: TranscriptInteractionOutcome | null;
  approvalAction?: ReactNode;
  questionAction?: ReactNode;
  onOpenDocument?: (reference: SessionDocumentReference) => Promise<boolean> | boolean;
  onOpenMenu?: (message: ChatMessage, x: number, y: number) => void;
  onOpenImage?: (image: SessionImageTarget) => void;
  onOpenImageMenu?: (image: SessionImageTarget, copyTarget: MessageCopyTarget | undefined, x: number, y: number) => void;
}) {
  const menuTrigger = useContextMenuTrigger(message, onOpenMenu ?? (() => undefined), { disabled: !onOpenMenu });
  const delegated = delegatedSessionId(message);
  return (
    <article
      className={`message message-${message.role} message-type-${message.type}${delegated ? " message-agent-delegated" : ""}${pending ? " message-pending" : ""}${onOpenMenu ? " message-copyable" : ""}`}
      data-transcript-item-id={itemId}
      aria-busy={pending || undefined}
      {...menuTrigger.triggerProps}
    >
      <div className="message-meta">
        <span className="message-meta-main">
          <span>{label(message)}</span>
          {isPlanModeMessage(message) ? <span className="message-mode-badge">Plan</span> : null}
        </span>
        <time>{new Date(message.timestamp).toLocaleTimeString()}</time>
      </div>
      <MessageContent
        message={message}
        planAction={planAction}
        planOutcome={planOutcome}
        onOpenDocument={onOpenDocument}
        onOpenImage={onOpenImage}
        onOpenImageMenu={onOpenImageMenu}
      />
      {approvalAction}
      {questionAction}
      {!approvalAction && !questionAction && message.type !== "assistant" ? (
        <ResolvedInteractionCard message={message} outcome={interactionOutcome(message)} />
      ) : null}
    </article>
  );
}

export function ImagePreviewModal({ image, onClose }: { image: SessionImageTarget | null; onClose: () => void }) {
  return (
    <Modal
      open={Boolean(image)}
      title="Image preview"
      onClose={onClose}
      panelClassName="image-preview-modal"
      backdropClassName="image-preview-backdrop"
    >
      {image ? <img src={api.imageUrl(image.sessionId, image.id)} alt="User-provided image preview" /> : null}
    </Modal>
  );
}

export function UserAction({
  message,
  itemId,
  onOpenMenu
}: {
  message: ChatMessage;
  itemId?: string;
  onOpenMenu?: (message: ChatMessage, x: number, y: number) => void;
}) {
  const menuTrigger = useContextMenuTrigger(message, onOpenMenu ?? (() => undefined), { disabled: !onOpenMenu });
  const waitEvent = sessionWaitEventFromPayload(message.payload);
  if (waitEvent) {
    const tone = waitEvent.kind === "timeout" ? "warning" : "success";
    return (
      <details
        className={`queue-automation-event session-wait-event${onOpenMenu ? " user-action-copyable" : ""}`}
        data-tone={tone}
        data-transcript-item-id={itemId}
        {...menuTrigger.triggerProps}
      >
        <summary>
          <span className="queue-automation-main">
            <span className="session-wait-badge">{waitEvent.kind === "timeout" ? "Timed out" : "Resumed"}</span>
            <strong>{sessionWaitEventSummary(waitEvent)}</strong>
            <span className="queue-automation-command">{sessionWaitTargetsSummary(waitEvent.sessions)}</span>
          </span>
          <time>{new Date(message.timestamp).toLocaleTimeString()}</time>
        </summary>
        <div className="queue-automation-details">
          <dl>
            {waitEvent.sessions.map((session, index) => (
              <div key={waitSessionKey(session, index)}>
                <dt>{waitSessionName(session, index)}</dt>
                <dd>{waitSessionStatus(session)}</dd>
              </div>
            ))}
          </dl>
          <details className="queue-automation-payload">
            <summary>Raw automation payload</summary>
            <pre>{serializeSessionWaitEvent(waitEvent)}</pre>
          </details>
        </div>
      </details>
    );
  }
  const queueEvent = heavyCommandQueueEventFromPayload(message.payload);
  if (queueEvent) {
    const { event, rawText, legacy } = queueEvent;
    return (
      <details
        className={`queue-automation-event${onOpenMenu ? " user-action-copyable" : ""}`}
        data-transcript-item-id={itemId}
        {...menuTrigger.triggerProps}
      >
        <summary>
          <span className="queue-automation-main">
            <span className="queue-automation-direction">{heavyCommandQueueEventDirection(event)}</span>
            <strong>{heavyCommandQueueEventSummary(event)}</strong>
            <span className="queue-automation-command">{heavyCommandQueueCommandSummary(event)}</span>
          </span>
          <time>{new Date(message.timestamp).toLocaleTimeString()}</time>
        </summary>
        <div className="queue-automation-details">
          <dl>
            <div><dt>Run</dt><dd>{event.runId}</dd></div>
            {event.slot !== undefined ? <div><dt>Slot</dt><dd>{event.slot}</dd></div> : null}
            <div><dt>Format</dt><dd>{legacy ? "Legacy" : "Structured"}</dd></div>
          </dl>
          <CodeBlock text={event.resumeCommand ?? event.commandDisplay} />
          <details className="queue-automation-payload">
            <summary>Raw automation payload</summary>
            <pre>{rawText}</pre>
          </details>
        </div>
      </details>
    );
  }
  const workflowEvent = gitWorkflowEventFromPayload(message.payload);
  if (workflowEvent) {
    const { event, rawText } = workflowEvent;
    const tone = event.kind === "workflow_blocked" || event.kind === "review_required"
      ? "warning"
      : event.kind === "workflow_failed" ? "error" : "success";
    return (
      <details
        className={`queue-automation-event workflow-automation-event${onOpenMenu ? " user-action-copyable" : ""}`}
        data-tone={tone}
        data-transcript-item-id={itemId}
        {...menuTrigger.triggerProps}
      >
        <summary>
          <span className="queue-automation-main">
            <span className="queue-automation-direction">{gitWorkflowEventDirection(event)}</span>
            <strong>{gitWorkflowEventSummary(event)}</strong>
            <span className="queue-automation-command">{gitWorkflowEventContext(event)}</span>
          </span>
          <time>{new Date(message.timestamp).toLocaleTimeString()}</time>
        </summary>
        <div className="queue-automation-details">
          <dl>
            <div><dt>Operation</dt><dd>{event.operation}</dd></div>
            <div><dt>Target</dt><dd>{event.targetBranch}</dd></div>
            {event.previousTargetBranch ? <div><dt>Previous target</dt><dd>{event.previousTargetBranch}</dd></div> : null}
            {event.sessionBranch ? <div><dt>Task branch</dt><dd>{event.sessionBranch}</dd></div> : null}
            {event.targetSha ? <div><dt>Commit</dt><dd>{event.targetSha}</dd></div> : null}
            {event.cleanup ? <div><dt>Worktree cleanup</dt><dd>{event.cleanup}</dd></div> : null}
            {event.reviewRequired !== undefined ? <div><dt>Review</dt><dd>{event.reviewRequired ? "required" : "not required"}</dd></div> : null}
            {event.broker ? <div><dt>Broker</dt><dd>{event.broker}</dd></div> : null}
            {event.reason ? <div><dt>Reason</dt><dd>{event.reason}</dd></div> : null}
            {event.error ? <div><dt>Error</dt><dd>{event.error}</dd></div> : null}
            {event.worktreePath ? <div><dt>Worktree path</dt><dd>{event.worktreePath}</dd></div> : null}
          </dl>
          <details className="queue-automation-payload">
            <summary>Raw automation payload</summary>
            <pre>{rawText}</pre>
          </details>
        </div>
      </details>
    );
  }
  return (
    <div className={`user-action${onOpenMenu ? " user-action-copyable" : ""}`} data-transcript-item-id={itemId} {...menuTrigger.triggerProps}>
      <span>{message.text}</span>
      <time>{new Date(message.timestamp).toLocaleTimeString()}</time>
    </div>
  );
}

function TranscriptRange({
  itemId,
  item,
  expanded,
  loading,
  expandedItems,
  onToggle,
  renderItem
}: {
  itemId?: string;
  item: Extract<CoreTranscriptItem, { type: "range" }>;
  expanded: boolean;
  loading: boolean;
  expandedItems: CoreTranscriptItem[];
  onToggle: () => void;
  renderItem: (item: CoreTranscriptItem) => ReactNode;
}) {
  return (
    <section
      className={`message-stack${item.rangeKind === "activity" ? " message-activity" : ""}${expanded ? " stack-expanded" : ""}`}
      data-transcript-item-id={itemId}
    >
      <button className="stack-toggle" onClick={onToggle} aria-expanded={expanded}>
        <span>{item.label}</span>
        <span>{loading ? "Loading" : expanded ? "Collapse" : "Expand"}</span>
      </button>
      {expanded ? <div className="stack-items">{expandedItems.map((item) => renderItem(item))}</div> : null}
    </section>
  );
}

function label(message: ChatMessage): string {
  if (sessionWaitEventFromPayload(message.payload)) return "Session wait";
  if (heavyCommandQueueEventFromPayload(message.payload)) return "Muxpilot queue";
  if (gitWorkflowEventFromPayload(message.payload)) return "Git workflow";
  if (isSubagentMessage(message)) return "Subagent";
  if (isAssistantUpdate(message)) return "Progress";
  if (message.type === "tool_call") return "Tool";
  if (message.type === "command_output") return "Command";
  if (message.type === "parser_notice") return "Parser";
  const delegated = delegatedSessionId(message);
  if (delegated) return `Delegated by ${delegated.slice(0, 8)}`;
  return message.role;
}

function delegatedSessionId(message: ChatMessage): string | null {
  const submission = message.payload.muxpilotSubmission;
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) return null;
  const actor = (submission as Record<string, unknown>).actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return null;
  const record = actor as Record<string, unknown>;
  return record.kind === "session" && typeof record.sessionId === "string" ? record.sessionId : null;
}

function MessageContent({
  message,
  planAction = null,
  planOutcome = null,
  onOpenDocument,
  onOpenImage,
  onOpenImageMenu
}: {
  message: ChatMessage;
  planAction?: ReactNode;
  planOutcome?: TranscriptInteractionOutcome | null;
  onOpenDocument?: (reference: SessionDocumentReference) => Promise<boolean> | boolean;
  onOpenImage?: (image: SessionImageTarget) => void;
  onOpenImageMenu?: (image: SessionImageTarget, copyTarget: MessageCopyTarget | undefined, x: number, y: number) => void;
}) {
  const components = fileAwareMarkdownComponentsValue;

  if (isToolOutput(message)) {
    return (
      <details className="tool-output">
        <summary>
          <span>{toolSummary(message)}</span>
          <span>{lineCount(message.text)} lines</span>
        </summary>
        <pre>{message.text}</pre>
      </details>
    );
  }

  if (message.role === "assistant") {
    const segments = parseProposedPlanSegments(displayText(message) ?? "");
    const lastPlanSegmentIndex = lastSegmentIndex(segments, "plan");
    return (
      <MarkdownLinkBehaviorProvider onOpenDocument={onOpenDocument}>
        <div className="rendered assistant-content">
          {segments.map((segment, index) => {
            if (segment.type === "plan") {
              return <ProposedPlanBlock
                key={index}
                text={segment.text}
                components={components}
                action={index === lastPlanSegmentIndex ? planAction : null}
                outcome={index === lastPlanSegmentIndex ? planOutcome : null}
              />;
            }
            return <MarkdownBlock key={index} text={segment.text} components={components} />;
          })}
        </div>
      </MarkdownLinkBehaviorProvider>
    );
  }

  if (message.role === "user") {
    return <UserMessageContent message={message} onOpenImage={onOpenImage} onOpenImageMenu={onOpenImageMenu} />;
  }

  return <PlainText text={message.text} />;
}

function displayText(message: ChatMessage): string | null {
  if (message.role === "assistant") return stripAssistantSideChannelBlocks(message.text);
  if (message.role === "user") {
    const normalized = normalizeUserContextText(message.text);
    return normalized.kind === "message" ? normalized.text : null;
  }
  return message.text;
}

export function copyableMessageText(message: ChatMessage): string {
  const waitEvent = sessionWaitEventFromPayload(message.payload);
  if (waitEvent) return serializeSessionWaitEvent(waitEvent);
  const queueEvent = heavyCommandQueueEventFromPayload(message.payload);
  if (queueEvent) return queueEvent.rawText;
  const workflowEvent = gitWorkflowEventFromPayload(message.payload);
  if (workflowEvent) return workflowEvent.rawText;
  if (isToolOutput(message)) return message.text;
  if (message.role === "assistant") {
    return parseProposedPlanSegments(displayText(message) ?? "")
      .map((segment) => segment.text)
      .join("")
      .trimEnd();
  }
  if (message.role === "user") {
    const text = displayText(message);
    return text ? userTextDisplayParts(text).body : "";
  }
  return displayText(message) ?? "";
}

export function copyMessageActionLabel(message: Pick<ChatMessage, "role">): string {
  if (message.role === "user") return "Copy user message";
  if (message.role === "assistant") return "Copy assistant message";
  if (message.role === "tool") return "Copy tool output";
  return "Copy system message";
}

const SESSION_DOCUMENT_SCOPE = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_DOCUMENT_NAME = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i;
const MUXPILOT_APP_PATH = /^\/(?:$|access(?:\/|$)|api(?:\/|$)|sessions(?:\/|$))/;

export function markdownLinkTarget(href: string | null | undefined): MarkdownLinkTarget {
  const value = href?.trim();
  if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//")) return { kind: "link" };
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase() ?? null;
  if (scheme && scheme !== "file" && !/^[a-z]:[\\/]/i.test(value)) return { kind: "link" };
  if (value.startsWith("/") && MUXPILOT_APP_PATH.test(value)) return { kind: "link" };

  const path = filesystemPathFromHref(value);
  if (!path) return { kind: "link" };
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const documentIndex = segments.length - 2;
  const scopeId = documentIndex > 0 ? segments[documentIndex - 1] : null;
  const name = segments.at(-1) ?? null;
  const fragment = fragmentFromHref(value);
  const document = segments[documentIndex] === "documents" && scopeId && name
    && SESSION_DOCUMENT_SCOPE.test(scopeId) && SESSION_DOCUMENT_NAME.test(name)
    ? { scopeId, name, path, ...(fragment ? { fragment } : {}) }
    : null;
  return { kind: "file", path, document };
}

function filesystemPathFromHref(href: string): string | null {
  let raw = href;
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = `${url.host ? `//${url.host}` : ""}${url.pathname}`;
    } catch {
      raw = raw.replace(/^file:\/\//i, "");
    }
  } else {
    const boundary = [raw.indexOf("?"), raw.indexOf("#")].filter((index) => index >= 0).sort((first, second) => first - second)[0];
    if (boundary !== undefined) raw = raw.slice(0, boundary);
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Preserve a malformed-but-usable path exactly as authored.
  }
  return raw.replace(/(?::\d+){1,2}$/, "") || null;
}

type FileAwareMarkdownLinkProps = ComponentPropsWithoutRef<"a"> & {
  onOpenDocument?: (reference: SessionDocumentReference) => Promise<boolean> | boolean;
};

interface MarkdownLinkBehavior {
  documents?: SessionDocumentSummary[];
  onOpenDocument?: (reference: SessionDocumentReference) => Promise<boolean> | boolean;
  onSelectDocument?: (name: string, fragment?: string) => void;
  onNavigateFragment?: (fragment: string) => void;
  onNavigationError?: (message: string) => void;
}

const MarkdownLinkBehaviorContext = createContext<MarkdownLinkBehavior>({});

function MarkdownLinkBehaviorProvider({
  documents,
  onOpenDocument,
  onSelectDocument,
  onNavigateFragment,
  onNavigationError,
  children
}: MarkdownLinkBehavior & { children: ReactNode }) {
  const value = useMemo(
    () => ({ documents, onOpenDocument, onSelectDocument, onNavigateFragment, onNavigationError }),
    [documents, onNavigateFragment, onNavigationError, onOpenDocument, onSelectDocument]
  );
  return <MarkdownLinkBehaviorContext.Provider value={value}>{children}</MarkdownLinkBehaviorContext.Provider>;
}

function FileAwareMarkdownLink({ href, children, onOpenDocument, ...props }: FileAwareMarkdownLinkProps) {
  const target = markdownLinkTarget(href);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  if (target.kind === "link") {
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  }

  async function activate() {
    if (target.kind !== "file") return;
    try {
      const opened = target.document && onOpenDocument ? await onOpenDocument(target.document) : false;
      if (opened) return;
      await copyText(target.path);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, COPIED_PATH_FEEDBACK_MS);
    } catch (error) {
      console.error("Unable to copy file path", error);
      setCopied(false);
    }
  }

  return (
    <a
      {...props}
      href={href}
      title={copied ? `Copied: ${target.path}` : target.path}
      aria-label={copied ? `Copied path: ${target.path}` : `Copy path: ${target.path}`}
      data-file-path="true"
      data-copied={copied || undefined}
      onClick={(event) => {
        event.preventDefault();
        event.currentTarget.blur();
        void activate();
      }}
    >
      {children}
      {copied ? <span className="file-path-copied" aria-hidden="true">Copied</span> : null}
    </a>
  );
}

function FileAwareMarkdownAnchor({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  const { documents, onOpenDocument, onSelectDocument, onNavigateFragment, onNavigationError } = useContext(MarkdownLinkBehaviorContext);
  const fragment = fragmentFromHref(href);
  if (href?.startsWith("#") && fragment && onNavigateFragment) {
    return (
      <a {...props} href={href} onClick={(event) => {
        event.preventDefault();
        event.currentTarget.blur();
        onNavigateFragment(fragment);
      }}>{children}</a>
    );
  }
  const relativeHref = href && !href.startsWith("/") && !href.startsWith("//") && !/^[a-z][a-z\d+.-]*:/i.test(href)
    ? href
    : null;
  const pathname = relativeHref?.split("#", 1)[0]?.split("?", 1)[0];
  const rawCandidate = pathname?.startsWith("./") ? pathname.slice(2) : pathname;
  let candidate = rawCandidate;
  try {
    if (candidate) candidate = decodeURIComponent(candidate);
  } catch {
    // Match the authored name when percent decoding is malformed.
  }
  const linkedDocument = documents?.find((document) => document.name === candidate);
  if (!linkedDocument && candidate?.toLowerCase().endsWith(".md") && onNavigationError) {
    return (
      <a {...props} href={href} onClick={(event) => {
        event.preventDefault();
        event.currentTarget.blur();
        onNavigationError(`Document ${candidate} was not found.`);
      }}>{children}</a>
    );
  }
  if (!linkedDocument || !onSelectDocument) {
    return <FileAwareMarkdownLink {...props} href={href} onOpenDocument={onOpenDocument}>{children}</FileAwareMarkdownLink>;
  }
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        event.currentTarget.blur();
        onSelectDocument(linkedDocument.name, fragment ?? undefined);
      }}
    >
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
  pre({ children }) {
    const code = children && typeof children === "object" && "props" in children
      ? children as { props: { children?: ReactNode; className?: string } }
      : null;
    return (
      <CodeBlock
        text={codeBlockText(code?.props.children ?? children)}
        codeClassName={code?.props.className}
      />
    );
  }
};

const fileAwareMarkdownComponentsValue: Components = {
  ...markdownComponents,
  a({ node: _node, ...props }) {
    return <FileAwareMarkdownAnchor {...props} />;
  }
};

function fragmentFromHref(href: string | null | undefined): string | null {
  const hash = href?.indexOf("#") ?? -1;
  if (hash < 0 || !href || hash === href.length - 1) return null;
  const fragment = href.slice(hash + 1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function markdownHeadingText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(markdownHeadingText).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return markdownHeadingText(value.props.children);
  return "";
}

export function markdownHeadingSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

type MarkdownHeadingProps = ComponentPropsWithoutRef<"h1"> & { node?: unknown };

function markdownComponentsWithHeadingAnchors(components: Components): Components {
  const occurrences = new Map<string, number>();
  const heading = (tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => (
    { node: _node, children, ...props }: MarkdownHeadingProps
  ) => {
    const slug = markdownHeadingSlug(markdownHeadingText(children));
    const occurrence = occurrences.get(slug) ?? 0;
    occurrences.set(slug, occurrence + 1);
    return createElement(tag, { ...props, id: occurrence === 0 ? slug : `${slug}-${occurrence}` }, children);
  };
  return {
    ...components,
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6")
  };
}

export function MarkdownBlock({
  text,
  components = markdownComponents,
  headingAnchors = false
}: {
  text: string;
  components?: Components;
  headingAnchors?: boolean;
}) {
  if (!text) return null;
  const renderedComponents = headingAnchors ? markdownComponentsWithHeadingAnchors(components) : components;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={renderedComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ProposedPlanBlock({
  text,
  components = markdownComponents,
  action = null,
  outcome = null
}: {
  text: string;
  components?: Components;
  action?: ReactNode;
  outcome?: TranscriptInteractionOutcome | null;
}) {
  if (outcome) {
    return (
      <details className="proposed-plan interaction-history">
        <summary>
          <span>Proposed plan</span>
          <strong>{interactionOutcomeLabel(outcome)}</strong>
        </summary>
        <div className="markdown proposed-plan-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
        </div>
      </details>
    );
  }
  return (
    <section className="proposed-plan">
      <div className="proposed-plan-head">Proposed plan</div>
      <div className="markdown proposed-plan-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </div>
      {action}
    </section>
  );
}

export function interactionOutcome(message: ChatMessage): TranscriptInteractionOutcome | null {
  const value = message.payload.interactionOutcome;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outcome = value as Partial<TranscriptInteractionOutcome>;
  if (
    (outcome.kind !== "plan" && outcome.kind !== "approval" && outcome.kind !== "question") ||
    (outcome.status !== "answered" && outcome.status !== "failed" && outcome.status !== "closed") ||
    typeof outcome.submittedAt !== "string"
  ) return null;
  return outcome as TranscriptInteractionOutcome;
}

function interactionOutcomeLabel(outcome: TranscriptInteractionOutcome): string {
  if (outcome.status === "failed") return "Submission failed";
  if (outcome.status === "closed") return "Closed without a response";
  if (outcome.kind === "plan") return PLAN_ACTION_LABELS[outcome.decision as PlanAction] ?? "Answered";
  if (outcome.kind === "approval") {
    const labels: Partial<Record<ApprovalDecision, string>> = {
      approve_once: "Approved once",
      approve_for_session: "Approved for session",
      approve_always: "Always approved",
      approve_for_prefix: "Approved for prefix",
      deny: "Denied"
    };
    const label = labels[outcome.decision as ApprovalDecision] ?? "Answered";
    if (outcome.resolvedBy === "auto") return `Auto ${label.toLowerCase()}`;
    if (outcome.resolvedBy === "full") return `Full approval · ${label.toLowerCase()}`;
    return label;
  }
  return "Answered";
}

function ResolvedInteractionCard({ message, outcome }: { message: ChatMessage; outcome: TranscriptInteractionOutcome | null }) {
  if (!outcome) return null;
  const request = message.payload.question as QuestionRequest | undefined;
  const approval = message.payload.approval as ApprovalRequest | undefined;
  return (
    <details className="interaction-history">
      <summary>
        <span>{outcome.kind === "question" ? "Question" : "Approval"}</span>
        <strong>{interactionOutcomeLabel(outcome)}</strong>
      </summary>
      {outcome.kind === "question" && request && outcome.answers ? (
        <dl className="interaction-history-answers">
          {request.questions.map((prompt) => (
            <div key={prompt.id}>
              <dt>{prompt.header || "Question"}</dt>
              <dd>
                <span>{prompt.question}</span>
                <strong>{outcome.answers?.[prompt.id]?.answers.join(", ") ?? "No recorded answer"}</strong>
              </dd>
            </div>
          ))}
        </dl>
      ) : outcome.kind === "approval" && approval ? (
        <dl className="interaction-history-answers">
          <div><dt>Request</dt><dd>{approval.command ?? approval.toolName ?? approval.title}</dd></div>
          {approval.reason ? <div><dt>Reason</dt><dd>{approval.reason}</dd></div> : null}
          {approval.cwd ? <div><dt>Working directory</dt><dd>{approval.cwd}</dd></div> : null}
          {approval.prefixRule?.length ? <div><dt>Approved prefix</dt><dd>{approval.prefixRule.join(" ")}</dd></div> : null}
          {outcome.reviewerModel ? <div><dt>Reviewer</dt><dd>{outcome.reviewerModel}</dd></div> : null}
          {outcome.reviewerExplanation ? <div><dt>Review</dt><dd>{outcome.reviewerExplanation}</dd></div> : null}
        </dl>
      ) : <p>{message.text}</p>}
    </details>
  );
}

type AssistantSegment = { type: "markdown" | "plan"; text: string };

const PROPOSED_PLAN_OPEN = "<proposed_plan>";
const PROPOSED_PLAN_CLOSE = "</proposed_plan>";
const ASSISTANT_SIDE_CHANNEL_BLOCKS = ["oai-mem-citation"] as const;

export function stripAssistantSideChannelBlocks(text: string): string {
  let result = text;
  for (const tag of ASSISTANT_SIDE_CHANNEL_BLOCKS) {
    result = stripXmlLikeBlock(result, tag);
  }
  return result.trimEnd();
}

function stripXmlLikeBlock(text: string, tag: string): string {
  const blockPattern = new RegExp(`\\n*<${tag}>[\\s\\S]*?<\\/${tag}>\\s*`, "g");
  return text.replace(blockPattern, (match, offset) => (offset === 0 ? "" : "\n"));
}

export function parseProposedPlanSegments(text: string): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openIndex = text.indexOf(PROPOSED_PLAN_OPEN, cursor);
    if (openIndex === -1) {
      appendMarkdownSegment(segments, text.slice(cursor));
      break;
    }

    const closeIndex = text.indexOf(PROPOSED_PLAN_CLOSE, openIndex + PROPOSED_PLAN_OPEN.length);
    if (closeIndex === -1) {
      appendMarkdownSegment(segments, text.slice(cursor));
      break;
    }

    appendMarkdownSegment(segments, text.slice(cursor, openIndex));
    segments.push({
      type: "plan",
      text: trimPlanWrapperWhitespace(text.slice(openIndex + PROPOSED_PLAN_OPEN.length, closeIndex))
    });
    cursor = closeIndex + PROPOSED_PLAN_CLOSE.length;
  }

  return segments.length ? segments : [{ type: "markdown", text }];
}

function appendMarkdownSegment(segments: AssistantSegment[], text: string): void {
  if (!text) return;
  segments.push({ type: "markdown", text });
}

function lastSegmentIndex(segments: AssistantSegment[], type: AssistantSegment["type"]): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]?.type === type) return index;
  }
  return -1;
}

function trimPlanWrapperWhitespace(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

export function UserText({ text }: { text: string }) {
  const { body, skills } = userTextDisplayParts(text);
  return <MarkdownBlock text={body} components={userMarkdownComponents(skills)} />;
}

function UserMessageContent({
  message,
  onOpenImage,
  onOpenImageMenu
}: {
  message: ChatMessage;
  onOpenImage?: (image: SessionImageTarget) => void;
  onOpenImageMenu?: (image: SessionImageTarget, copyTarget: MessageCopyTarget | undefined, x: number, y: number) => void;
}) {
  const content = Array.isArray(message.payload.content) ? message.payload.content as MessageContentPart[] : null;
  const copyTextValue = copyableMessageText(message);
  return <MixedUserContent
    sessionId={message.sessionId}
    text={message.text}
    content={content ?? undefined}
    copyTarget={copyTextValue.trim() ? { label: copyMessageActionLabel(message), text: copyTextValue } : undefined}
    onOpenImage={onOpenImage}
    onOpenImageMenu={onOpenImageMenu}
  />;
}

export function MixedUserContent({
  sessionId,
  text,
  content,
  copyTarget,
  onOpenImage,
  onOpenImageMenu
}: {
  sessionId: string;
  text: string;
  content?: MessageContentPart[];
  copyTarget?: MessageCopyTarget;
  onOpenImage?: (image: SessionImageTarget) => void;
  onOpenImageMenu?: (image: SessionImageTarget, copyTarget: MessageCopyTarget | undefined, x: number, y: number) => void;
}) {
  if (!content?.some((part) => part.type === "image")) return <UserText text={text} />;
  return <div className="user-mixed-content">{content.map((part, index) => part.type === "text"
    ? <UserText key={index} text={part.text} />
    : <button
        key={index}
        type="button"
        className="user-message-image"
        aria-label="Preview user-provided image"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenImage?.({ ...part, sessionId });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenImageMenu?.({ ...part, sessionId }, copyTarget, event.clientX, event.clientY);
        }}
      >
        <img src={api.imageUrl(sessionId, part.id)} alt="User-provided image" />
      </button>)}</div>;
}

function userMarkdownComponents(skillNames: string[]): Components {
  const withSkillReferences = (children: ReactNode) => renderSkillReferencesInMarkdown(children, skillNames);
  return {
    ...markdownComponents,
    p({ children, node: _node, ...props }) {
      return <p {...props}>{withSkillReferences(children)}</p>;
    },
    li({ children, node: _node, ...props }) {
      return <li {...props}>{withSkillReferences(children)}</li>;
    },
    h1({ children, node: _node, ...props }) {
      return <h1 {...props}>{withSkillReferences(children)}</h1>;
    },
    h2({ children, node: _node, ...props }) {
      return <h2 {...props}>{withSkillReferences(children)}</h2>;
    },
    h3({ children, node: _node, ...props }) {
      return <h3 {...props}>{withSkillReferences(children)}</h3>;
    },
    h4({ children, node: _node, ...props }) {
      return <h4 {...props}>{withSkillReferences(children)}</h4>;
    }
  };
}

function renderSkillReferencesInMarkdown(children: ReactNode, skillNames: string[]): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return renderSkillReferences(child, skillNames);
    if (!isValidElement<{ children?: ReactNode }>(child) || child.type === "code" || child.type === "pre") return child;
    if (child.props.children === undefined) return child;
    return cloneElement(child, undefined, renderSkillReferencesInMarkdown(child.props.children, skillNames));
  });
}

function PlainText({ text, skillNames = [] }: { text: string; skillNames?: string[] }) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="rendered">
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          return <CodeBlock key={index} text={part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")} />;
        }
        return part
          .split("\n\n")
          .map((paragraph, pIndex) => <p key={`${index}-${pIndex}`}>{renderSkillReferences(paragraph, skillNames)}</p>);
      })}
    </div>
  );
}

const COMPACTED_SKILLS_PATTERN = /\n\nSkills:\s*([^\n]+)\s*$/;
const SKILL_REFERENCE_PATTERN = /\$([A-Za-z0-9][A-Za-z0-9_:-]*)/g;

function userTextDisplayParts(text: string): { body: string; skills: string[] } {
  const match = text.match(COMPACTED_SKILLS_PATTERN);
  if (!match?.[1]) return { body: text, skills: [] };
  return {
    body: text.replace(COMPACTED_SKILLS_PATTERN, "").trimEnd(),
    skills: match[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  };
}

function renderSkillReferences(text: string, skillNames: string[]): ReactNode {
  if (skillNames.length === 0) return text;
  const skillSet = new Set(skillNames);
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(SKILL_REFERENCE_PATTERN)) {
    const fullMatch = match[0];
    const skillName = match[1];
    const index = match.index ?? 0;
    if (!skillName || !skillSet.has(skillName)) continue;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(
      <span className="user-skill-reference" title={`Skill used: ${skillName}`} key={`${skillName}-${index}`}>
        {fullMatch}
      </span>
    );
    cursor = index + fullMatch.length;
  }

  if (nodes.length === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function isToolOutput(message: ChatMessage): boolean {
  return message.type === "tool_output" || message.type === "command_output";
}

export function groupStackableMessages(messages: ChatMessage[]): TranscriptItem[] {
  return groupTurnActivity(messages);
}

export function groupTurnActivity(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let turnMessages: ChatMessage[] = [];
  let looseMessages: ChatMessage[] = [];
  let hasPrompt = false;

  function flushLooseMessages() {
    if (looseMessages.length === 0) return;
    items.push(...groupLooseActivityItems(looseMessages));
    looseMessages = [];
  }

  function flushTurnMessages() {
    if (!hasPrompt) {
      flushLooseMessages();
      return;
    }
    appendTurnActivity(items, turnMessages);
    turnMessages = [];
    hasPrompt = false;
  }

  for (const message of displayMessages(messages)) {
    if (isUserActionMessage(message)) {
      if (hasPrompt) flushTurnMessages();
      else flushLooseMessages();
      items.push({ type: "user_action", message });
      continue;
    }

    if (isStandaloneActionMessage(message)) {
      if (hasPrompt) {
        appendTurnActivity(items, turnMessages);
        turnMessages = [];
      } else {
        flushLooseMessages();
      }
      items.push({ type: "message", message });
      continue;
    }

    if (message.role === "user") {
      if (hasPrompt) flushTurnMessages();
      else flushLooseMessages();
      items.push({ type: "message", message });
      hasPrompt = true;
      continue;
    }

    if (hasPrompt) turnMessages.push(message);
    else looseMessages.push(message);
  }

  if (hasPrompt) flushTurnMessages();
  else flushLooseMessages();

  return items;
}

export function groupEventStacks(messages: ChatMessage[]): TranscriptItem[] {
  return groupEventStackItems(displayMessages(messages));
}

function groupEventStackItems(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let stack: ChatMessage[] = [];

  for (const message of messages) {
    if (isUserActionMessage(message)) {
      flushStack(items, stack);
      stack = [];
      items.push({ type: "user_action", message });
      continue;
    }

    if (isStackableMessage(message)) {
      stack.push(message);
      continue;
    }

    flushStack(items, stack);
    stack = [];
    items.push({ type: "message", message });
  }

  flushStack(items, stack);
  return items;
}

function groupLooseActivityItems(messages: ChatMessage[]): TranscriptItem[] {
  return groupAssistantActivity(messages, "stack");
}

function appendTurnActivity(items: TranscriptItem[], messages: ChatMessage[]): void {
  if (messages.length === 0) return;

  items.push(...groupAssistantActivity(messages, "activity"));
}

function groupAssistantActivity(messages: ChatMessage[], fallbackKind: "activity" | "stack"): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let pendingEvents: ChatMessage[] = [];
  let hasAssistantMessage = false;

  for (const message of messages) {
    if (message.role !== "assistant") {
      pendingEvents.push(message);
      continue;
    }

    pushActivity(items, pendingEvents);
    pendingEvents = [];
    items.push({ type: "message", message });
    hasAssistantMessage = true;
  }

  if (hasAssistantMessage || fallbackKind === "stack") items.push(...groupEventStackItems(pendingEvents));
  else pushActivity(items, pendingEvents);
  return items;
}

function pushActivity(items: TranscriptItem[], messages: ChatMessage[]): void {
  const activityMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (isStandaloneActionMessage(message)) {
      pushActivityChunk(items, activityMessages);
      activityMessages.length = 0;
      items.push({ type: "message", message });
      continue;
    }
    activityMessages.push(message);
  }

  pushActivityChunk(items, activityMessages);
}

function pushActivityChunk(items: TranscriptItem[], messages: ChatMessage[]): void {
  if (messages.length === 0) return;
  const first = messages[0];
  if (!first) return;
  const last = messages.at(-1) ?? first;
  items.push({ type: "activity", id: `activity-${first.id}-${last.id}-${messages.length}`, messages });
}

function displayMessages(messages: ChatMessage[]): ChatMessage[] {
  const visibleMessages: ChatMessage[] = [];
  for (const rawMessage of messages) {
    const normalized = rawMessage.role === "user" ? normalizeUserContextText(rawMessage.text) : null;
    if (normalized?.kind === "hidden" && normalized.skillNames.length > 0) {
      mergeSkillNamesIntoPreviousUserMessage(visibleMessages, normalized.skillNames);
      continue;
    }

    const message = displayMessage(rawMessage);
    if (message && replaceDuplicateAssistantUpdateResponse(visibleMessages, message)) continue;
    if (message) visibleMessages.push(message);
  }
  return visibleMessages;
}

function replaceDuplicateAssistantUpdateResponse(messages: ChatMessage[], message: ChatMessage): boolean {
  const previous = messages.at(-1);
  if (!previous || !isAssistantUpdate(previous) || !isRegularAssistantMessage(message)) return false;
  if (displayText(previous) !== displayText(message)) return false;
  messages[messages.length - 1] = message;
  return true;
}

function displayMessage(message: ChatMessage): ChatMessage | null {
  const queueEvent = heavyCommandQueueEventFromPayload(message.payload) ?? normalizeHeavyCommandQueueEvent(message.text);
  if (queueEvent) {
    return {
      ...message,
      role: "system",
      type: "status",
      text: heavyCommandQueueEventSummary(queueEvent.event),
      payload: withHeavyCommandQueueEventPayload(message.payload, queueEvent)
    };
  }
  const workflowEvent = gitWorkflowEventFromPayload(message.payload) ?? normalizeGitWorkflowEvent(message.text);
  if (workflowEvent) {
    return {
      ...message,
      role: "system",
      type: "status",
      text: gitWorkflowEventSummary(workflowEvent.event),
      payload: withGitWorkflowEventPayload(message.payload, workflowEvent)
    };
  }
  const embeddedWaitEvent = sessionWaitEventFromPayload(message.payload);
  const normalizedWaitEvent = embeddedWaitEvent ? null : normalizeSessionWaitEvent(message.text);
  const waitEvent = embeddedWaitEvent ?? normalizedWaitEvent?.event;
  if (waitEvent) {
    return {
      ...message,
      role: "system",
      type: "status",
      text: sessionWaitEventSummary(waitEvent),
      payload: normalizedWaitEvent ? withSessionWaitEventPayload(message.payload, normalizedWaitEvent) : message.payload
    };
  }
  if (message.role !== "user") return message;
  const subagentNotification = normalizeSubagentNotificationText(message.text);
  if (subagentNotification) {
    return {
      ...message,
      role: "system",
      type: "status",
      text: subagentNotification.text,
      payload: { ...message.payload, subagentNotification }
    };
  }
  const normalized = normalizeUserContextText(message.text);
  if (normalized.kind === "action") return { ...message, role: "system", type: "status", text: normalized.text };
  if (normalized.kind === "hidden") return null;
  if (normalized.text === message.text) return message;
  return { ...message, text: normalized.text };
}

function mergeSkillNamesIntoPreviousUserMessage(messages: ChatMessage[], names: string[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (!current || current.role !== "user") continue;
    messages[index] = { ...current, text: appendSkillNamesToText(current.text, names) };
    return;
  }
}


function flushStack(items: TranscriptItem[], stack: ChatMessage[]): void {
  if (stack.length === 0) return;
  const first = stack[0];
  if (!first) return;
  const last = stack.at(-1) ?? first;
  items.push({ type: "stack", id: `stack-${first.id}-${last.id}-${stack.length}`, messages: stack });
}

function isStackableMessage(message: ChatMessage): boolean {
  if (isStandaloneActionMessage(message)) return false;
  if (message.role === "assistant") return false;
  if (message.role === "tool" || message.role === "system") return true;
  return (
    message.type === "tool_call" ||
    message.type === "tool_output" ||
    message.type === "command_output" ||
    message.type === "status" ||
    message.type === "approval_request" ||
    message.type === "parser_notice"
  );
}

function isStandaloneActionMessage(message: ChatMessage): boolean {
  return message.type === "question_request" || message.type === "approval_request";
}

function transcriptItemContainsMessageId(item: CoreTranscriptItem, messageId: string): boolean {
  if (item.type === "message" || item.type === "user_action") return item.message.id === messageId;
  return item.id.includes(messageId);
}

function stackLabel(messages: ChatMessage[]): string {
  const counts = messages.reduce(
    (current, message) => {
      if (message.type === "command_output") current.command += 1;
      else if (message.type === "tool_call" || message.type === "tool_output") current.tool += 1;
      else if (isAssistantUpdate(message)) current.progress += 1;
      else if (isTurnAbortedStatus(message)) current.aborted += 1;
      else if (isSubagentMessage(message)) current.subagent += 1;
      else current.system += 1;
      return current;
    },
    { aborted: 0, command: 0, progress: 0, subagent: 0, system: 0, tool: 0 }
  );
  const parts = [
    counts.aborted ? `${counts.aborted} aborted` : "",
    counts.progress ? `${counts.progress} progress` : "",
    counts.command ? `${counts.command} command` : "",
    counts.tool ? `${counts.tool} tool` : "",
    counts.subagent ? `${counts.subagent} subagent` : "",
    counts.system ? `${counts.system} system` : ""
  ].filter(Boolean);
  return `${messages.length} ${messages.length === 1 ? "event" : "events"}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

function activityLabel(messages: ChatMessage[]): string {
  return `${messages.length} intermediate ${pluralize(messages.length, "event")}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function isRegularAssistantMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && !isAssistantUpdate(message);
}

function isUserActionMessage(message: ChatMessage): boolean {
  return Boolean(heavyCommandQueueEventFromPayload(message.payload))
    || Boolean(gitWorkflowEventFromPayload(message.payload))
    || Boolean(sessionWaitEventFromPayload(message.payload))
    || isTurnAbortedStatus(message)
    || isInstructionsLoadedStatus(message);
}

function sessionWaitTargetsSummary(sessions: Array<Record<string, unknown>>): string {
  if (sessions.length === 0) return "No target snapshot";
  if (sessions.length === 1) return `${waitSessionName(sessions[0]!, 0)} · ${waitSessionStatus(sessions[0]!)}`;
  return `${sessions.length} target sessions`;
}

function waitSessionKey(session: Record<string, unknown>, index: number): string {
  return typeof session.id === "string" ? session.id : `target-${index}`;
}

function waitSessionName(session: Record<string, unknown>, index: number): string {
  if (typeof session.name === "string" && session.name.trim()) return session.name;
  if (typeof session.id === "string" && session.id.trim()) return session.id;
  return `Target ${index + 1}`;
}

function waitSessionStatus(session: Record<string, unknown>): string {
  if (typeof session.effectiveStatus === "string" && session.effectiveStatus.trim()) return session.effectiveStatus;
  if (typeof session.status === "string" && session.status.trim()) return session.status;
  return "unknown";
}

function isTurnAbortedStatus(message: ChatMessage): boolean {
  return message.type === "status" && message.role === "system" && message.text === "Turn aborted";
}

function isInstructionsLoadedStatus(message: ChatMessage): boolean {
  if (message.type !== "status" || message.role !== "system") return false;
  return message.text === "Loaded repository instructions" || /^Loaded [^\n]+\.md instructions for [^\n]+$/i.test(message.text);
}

function isAssistantUpdate(message: ChatMessage): boolean {
  if (message.type === "assistant_update") return true;
  if (message.type !== "assistant" || message.role !== "assistant") return false;
  const payloadType = stringRecord(message.payload)?.type;
  const nestedPayload = stringRecord(message.payload?.payload);
  return payloadType === "event_msg" && nestedPayload?.type === "agent_message";
}

function isSubagentMessage(message: ChatMessage): boolean {
  return Boolean(stringRecord(message.payload)?.subagentNotification);
}

export function isPlanModeMessage(message: ChatMessage): boolean {
  return stringRecord(message.payload)?.collaborationMode === "plan";
}

function stringRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toolSummary(message: ChatMessage): string {
  const firstLine = message.text.split("\n").find((line) => line.trim())?.trim();
  if (!firstLine) return message.type === "command_output" ? "Command output" : "Tool output";
  return firstLine.length > 96 ? `${firstLine.slice(0, 96)}...` : firstLine;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}
