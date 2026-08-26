import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpToLine,
  Check,
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
  Pause,
  Pencil,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Skull,
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
  type DecorationSet,
  type ViewUpdate,
  gutter,
  keymap,
  placeholder as codeMirrorPlaceholder
} from "@codemirror/view";
import {
  FormEvent,
  KeyboardEvent,
  type ReactNode,
  useCallback,
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
  ApprovalDecision,
  ApprovalRequest,
  BtwDeltaPayload,
  BtwExchange,
  ChatMessage,
  CodexSkill,
  CollaborationMode,
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
  normalizeSubagentNotificationText,
  normalizeUserContextText,
  transcriptMessages,
  withGitWorkflowEventPayload,
  withHeavyCommandQueueEventPayload
} from "@muxpilot/core";
import { api, ApiError } from "../api/client.js";
import { CodeBlock, codeBlockText } from "../components/CodeBlock.js";
import { ContextMenu, ContextMenuItem, useContextMenuTrigger, useDismissableContextMenu } from "../components/ContextMenu.js";
import { LoadingStatusPill, StatusPill } from "../components/StatusPill.js";
import { SessionLoadingSkeleton } from "../components/LoadingSkeleton.js";
import { Modal } from "../components/Modal.js";
import { copyText } from "../utils/clipboard.js";
import { codeMirrorComposerFieldAttributes, freeformComposerField, noAutofillTextField } from "../utils/formFields.js";
import { sessionDisplayName } from "../utils/sessionLabels.js";
import { sessionStatusPresentation } from "../utils/sessionStatus.js";
import { appendBtwDelta, BtwDrawer, parseBtwComposerInput, upsertBtwExchange } from "../components/BtwDrawer.js";

const MESSAGE_PAGE_SIZE = 80;
const MESSAGE_TOP_LOAD_THRESHOLD_PX = 80;
const MESSAGE_BOTTOM_LOAD_THRESHOLD_PX = 120;
export const SESSION_RECONCILE_INTERVAL_MS = 30_000;
export const ACTIVE_HEAVY_COMMAND_RECONCILE_INTERVAL_MS = 2_000;
export const SESSION_BOOTSTRAP_TIMEOUT_MS = 10_000;
export const SESSION_BOOTSTRAP_NOTICE_MS = 5_000;
export const SESSION_BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const SESSION_DOCUMENTS_RECONCILE_INTERVAL_MS = 5_000;
const SKILL_REFRESH_INTERVAL_MS = 60_000;
const SKILL_REFRESH_STALE_MS = 10_000;
// "none" explicitly preserves the viewport; "idle" means there is no pending transcript scroll request.
export type ScrollBehavior = "bottom" | "top" | "preserve" | "none" | "idle";
export type ScrollUpdateReason = "initial" | "explicit_bottom" | "send" | "live" | "older_page" | "manual_newer";
export type PlanAction = PlanActionChoice;
export type ScrollAnchorSnapshot = { itemId: string | null; offsetTop: number; scrollTop: number; scrollHeight: number };
export type MessageListAutoPageAction = "older" | "newer" | null;
export type TranscriptVimNavigationCommand = "jumpTop" | "jumpBottom" | "halfUp" | "halfDown" | "pageUp" | "pageDown" | "find";
export type PendingActionRefresh = "approval" | "question" | null;
export interface PendingUserMessage {
  id: string;
  sessionId: string;
  text: string;
  mode: CollaborationMode;
  timestamp: string;
  matchAfter?: string;
}

interface RefreshOwner {
  token: number;
  queued: boolean;
}

export class LatestGenerationRefreshGate {
  private owner: RefreshOwner | null = null;
  private latestToken = Number.NEGATIVE_INFINITY;

  async run(token: number, refresh: () => Promise<boolean>): Promise<void> {
    if (token < this.latestToken) return;
    if (token > this.latestToken) this.latestToken = token;
    if (this.owner?.token === token) {
      this.owner.queued = true;
      return;
    }

    const owner: RefreshOwner = { token, queued: false };
    this.owner = owner;
    try {
      let canRepeat: boolean;
      do {
        owner.queued = false;
        canRepeat = await refresh();
      } while (owner.queued && canRepeat && this.latestToken === token);
    } finally {
      if (this.owner === owner) this.owner = null;
    }
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
    return typeof text === "string" ? text : "";
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
  return commands.some((command) => command.state === "waiting" || command.state === "reserved" || command.state === "running" || command.state === "stalled" || command.state === "terminating");
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
  timestamp = new Date().toISOString()
): PendingUserMessage {
  return {
    id: `pending-user-${timestamp}`,
    sessionId,
    text,
    mode,
    timestamp
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
    payload: { collaborationMode: message.mode }
  };
}

export function sentQueuedInputToPendingUserMessage(input: QueuedInput): PendingUserMessage | null {
  if (input.status !== "sent" || !input.sentAt) return null;
  return {
    id: `pending-queued-user-${input.id}`,
    sessionId: input.sessionId,
    text: input.text,
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
    const visibleText = displayText(message);
    if (visibleText === pending.text) return true;
    if (visibleText && userTextDisplayParts(visibleText).body === pending.text) return true;
    return isCodexPastedContentPlaceholder(visibleText) && messageCreatedAtOrAfterPending(message, pending);
  });
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
    !loadingSession.tmux ||
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
                  <span>{command.startedAt ? `${elapsed} running` : `${elapsed} waiting`}</span>
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
                    <button type="button" disabled={command.state === "terminating"} onClick={() => setConfirming(command.runId)}>{command.state === "terminating" ? "Terminating…" : "Terminate command"}</button>
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
  documents,
  listLoading,
  listError,
  onClose
}: {
  open: boolean;
  sessionId: string;
  documents: SessionDocumentSummary[];
  listLoading: boolean;
  listError: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loadedContentKey, setLoadedContentKey] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState("");
  const viewerRef = useRef<HTMLElement>(null);
  const displayedDocumentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected((current) => documents.some((document) => document.name === current)
      ? current
      : documents.find((document) => document.name.toLowerCase() === "index.md")?.name ?? documents[0]?.name ?? null);
  }, [documents, open]);

  const selectedVersion = documents.find((document) => document.name === selected)?.updatedAt ?? "";
  const selectedContentKey = selected ? `${selected}\u0000${selectedVersion}` : null;
  const documentMarkdownComponents = useMemo<Components>(() => ({
    ...markdownComponents,
    a({ href, children, ...props }) {
      const relativeHref = href && !href.startsWith("/") && !href.startsWith("//") && !/^[a-z][a-z\d+.-]*:/i.test(href)
        ? href
        : null;
      const pathname = relativeHref?.split("#", 1)[0]?.split("?", 1)[0];
      const candidate = pathname?.startsWith("./") ? pathname.slice(2) : pathname;
      const linkedDocument = documents.find((document) => document.name === candidate);
      if (!linkedDocument) return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      return (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            event.currentTarget.blur();
            setSelected(linkedDocument.name);
          }}
        >
          {children}
        </a>
      );
    }
  }), [documents]);
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
    if (!loadedContentKey || !viewerRef.current) return;
    const loadedDocument = loadedContentKey.split("\u0000", 1)[0] ?? null;
    if (loadedDocument !== displayedDocumentRef.current) viewerRef.current.scrollTop = 0;
    displayedDocumentRef.current = loadedDocument;
  }, [loadedContentKey]);

  return (
    <Modal open={open} onClose={onClose} title="Documents" panelClassName="documents-modal">
      {listError ? <p className="error-text" role="alert">{listError}</p> : null}
      {listLoading && documents.length === 0 ? <p className="muted">Loading documents…</p> : documents.length === 0 && !listError ? <p className="muted">This session has no documents yet.</p> : (
        <div className="documents-layout">
          <nav className="documents-list" aria-label="Session documents">
            {documents.map((document) => (
              <button key={document.name} type="button" data-active={selected === document.name || undefined} aria-current={selected === document.name ? "page" : undefined} onClick={() => setSelected(document.name)}>
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
              <div key={loadedContentKey} className="documents-viewer-content" data-loading={viewerBusy || undefined} aria-hidden={viewerBusy || undefined}>
                <MarkdownBlock text={content} components={documentMarkdownComponents} />
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
  return { waiting: "Waiting for slot", reserved: "Resuming session", running: "Running", stalled: "No observed progress", terminating: "Terminating" }[state];
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

export function sessionCreateSessionCwd(session: { repo: Pick<ManagedSession["repo"], "root">; tmux: Pick<ManagedSession["tmux"], "cwd">; gitWorkspace?: Pick<GitWorkspaceSummary, "entryPath"> | null }): string {
  return session.gitWorkspace?.entryPath ?? session.repo.root ?? session.tmux.cwd;
}

export function shouldReplaceTranscriptForSource(currentSourceKey: string | null, nextSourceKey: string): boolean {
  return currentSourceKey !== null && currentSourceKey !== nextSourceKey;
}

export const PLAN_ACTION_LABELS: Record<PlanAction, string> = {
  implement: "Yes, implement the plan",
  clear_context_implement: "Yes, clear context and implement",
  stay_in_plan: "No, stay in plan mode"
};

export function SessionView() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    refreshSessionStoplight,
    syncSessionStoplight,
    sessions: shellSessions,
    openCreateSession,
    openSessionTransfer,
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
  const [suppressedPlanMessageId, setSuppressedPlanMessageId] = useState<string | null>(null);
  const [planActionBusy, setPlanActionBusy] = useState<PlanAction | null>(null);
  const [planActionError, setPlanActionError] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<SessionAction["type"] | null>(null);
  const [inputDeliveryError, setInputDeliveryError] = useState("");
  const [sessionLoadError, setSessionLoadError] = useState("");
  const [sessionLoadRetrying, setSessionLoadRetrying] = useState(false);
  const [sessionLoadRetryNonce, setSessionLoadRetryNonce] = useState(0);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [documents, setDocuments] = useState<SessionDocumentSummary[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState("");
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
  const [copiedTmuxCommand, setCopiedTmuxCommand] = useState(false);
  const [messageMenu, setMessageMenu] = useState<{ message: ChatMessage; x: number; y: number } | null>(null);
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
  const messageListRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ManagedSession | null>(null);
  const requestTokenRef = useRef(0);
  const sessionRefreshRequestRef = useRef(0);
  const approvalRefreshRequestRef = useRef(0);
  const questionRefreshRequestRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadingSearchPageRef = useRef(false);
  const liveTailRefreshGateRef = useRef(new LatestGenerationRefreshGate());
  const snapshotRefreshGateRef = useRef(new LatestGenerationRefreshGate());
  const pendingInputModeRef = useRef<CollaborationMode | null>(null);
  const pendingFastModeRef = useRef<boolean | null>(null);
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
  const vimPendingGRef = useRef(false);
  const vimPendingGTimerRef = useRef<number | null>(null);
  const promptHistoryPrefillTextRef = useRef(text);
  activeIdRef.current = id;
  btwOpenRef.current = btwOpen;
  promptHistoryPrefillTextRef.current = text;

  const closeGitPanel = useCallback(() => {
    setGitPanelOpen(false);
  }, []);

  const loadedMessages = useMemo(() => transcriptMessages(transcriptItems), [transcriptItems]);
  const inputDeliveryFailure = useMemo(() => inputDeliveryFailureDetail(loadedMessages), [loadedMessages]);
  const lastSequence = useMemo(() => transcriptItems.at(-1)?.lastSequence ?? 0, [transcriptItems]);
  const firstSequence = useMemo(() => transcriptItems[0]?.firstSequence ?? 0, [transcriptItems]);
  lastSequenceRef.current = lastSequence;
  const pendingPlan = useMemo(() => pendingProposedPlanMessage(loadedMessages, suppressedPlanMessageId), [loadedMessages, suppressedPlanMessageId]);
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
    : composerLockReason(Boolean(question), Boolean(pendingPlan), session?.startupError);
  const composerLocked = Boolean(composerLock);
  const effectiveVimEnabled = vimAvailable && vimEnabled;
  const currentTranscriptFindMatch = transcriptFindMatches[transcriptFindMatchIndex] ?? null;
  const questionRenderedInline = Boolean(
    question &&
      (transcriptItems.some((item) => transcriptItemContainsMessageId(item, question.messageId)) ||
        Object.values(expandedRangeItems).some((items) => items.some((item) => transcriptItemContainsMessageId(item, question.messageId))))
  );
  const bottomContentKey = [
    id,
    pendingUserChatMessage?.id ?? "",
    showTranscriptSyncIndicator ? "sync" : "",
    showWorkingIndicator ? `working:${session?.status ?? ""}` : "",
    showQueuedIndicator ? "queued" : "",
    question && !questionRenderedInline ? `question:${question.messageId}` : "",
    approval ? `approval:${approval.id}` : "",
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
    if (!copyableMessageText(message).trim()) return;
    setMessageMenu({ message, x, y });
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

  function renderTranscriptItem(item: CoreTranscriptItem): ReactNode {
    if (item.type === "message") {
      return (
        <MessageBubble
          key={item.message.id}
          itemId={item.id}
          message={item.message}
          onOpenMenu={openMessageMenu}
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
      setSuppressedPlanMessageId(null);
      setPlanActionBusy(null);
      setPlanActionError("");
      setSubmitBusy(false);
      setActionBusy(null);
      pendingFastModeRef.current = null;
      setInputModeError("");
      setFastModeError("");
      setCopiedTmuxCommand(false);
      setGitPanelOpen(false);
      setDocumentsOpen(false);
      setDocuments([]);
      setDocumentsLoading(true);
      setDocumentsError("");
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
        if (response.documents.length === 0) setDocumentsOpen(false);
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
      if (event.type === "btw.finished") {
        setBtwExchanges((current) => upsertBtwExchange(current, event.payload as BtwExchange));
        if (!btwOpenRef.current) setBtwCompletedWhileClosed(true);
        return;
      }
      sessionRefreshRequestRef.current += 1;
      const token = requestTokenRef.current;
      if (event.type === "message.appended") {
        const nextMessage = event.payload as ChatMessage;
        if (!hasMoreAfterRef.current) void refreshLiveTailMessages(id, token);
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
    await snapshotRefreshGateRef.current.run(token, async () => {
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
    await liveTailRefreshGateRef.current.run(token, async () => {
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitBusy || btwSubmitting || composerLocked) return;
    if (!composerHasContent(text)) return;
    const value = text.trimEnd();
    const btwInput = parseBtwComposerInput(value);
    if (btwInput) {
      blurActiveElementForVimSubmit(effectiveVimEnabled, document.activeElement);
      openBtwDrawer();
      updateComposerText("");
      if (!btwInput.question) return;
      if (!await askBtwQuestion(btwInput.question)) updateComposerText(value);
      return;
    }
    const pendingMessage = createPendingUserMessage(id, value, session?.inputMode ?? "default");
    blurActiveElementForVimSubmit(effectiveVimEnabled, document.activeElement);
    updateComposerText("");
    setPendingUserMessage(pendingMessage);
    setSubmitBusy(true);
    isNearBottomRef.current = true;
    scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("send", true);
    try {
      const queued = shouldQueueComposerInput(session, queuedInputs);
      if (queued) {
        await api.enqueueInput(id, value, session?.inputMode ?? "default");
        await loadQueuedInputs(id, requestTokenRef.current);
        setPendingUserMessage((current) => (current?.id === pendingMessage.id ? null : current));
      } else {
        const response = await api.send(id, value, session?.inputMode ?? "default");
        if (response.queuedInput) {
          await loadQueuedInputs(id, requestTokenRef.current);
          setPendingUserMessage((current) => (current?.id === pendingMessage.id ? null : current));
        } else {
          setSession(response.session);
          syncSessionStoplight(response.session);
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

  function killSession() {
    if (actionBusy || !confirm("Kill this tmux pane?")) return;
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

  async function copyTmuxCommand() {
    if (!session) return;
    const command = tmuxAttachCommand(session);
    try {
      await copyText(command);
      setCopiedTmuxCommand(true);
      window.setTimeout(() => setCopiedTmuxCommand(false), 1600);
    } catch {
      setCopiedTmuxCommand(false);
    }
  }

  async function copyMessageFromMenu() {
    if (!messageMenu) return;
    const text = copyableMessageText(messageMenu.message);
    setMessageMenu(null);
    try {
      await copyText(text);
    } catch (error) {
      console.error(error);
    }
  }

  async function resolveApproval(decision: ApprovalDecision) {
    const targetId = id;
    const token = requestTokenRef.current;
    setApprovalBusy(decision);
    setApprovalError("");
    try {
      await api.resolveApproval(targetId, { decision });
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
    const targetId = id;
    const token = requestTokenRef.current;
    const answeredQuestion = question;
    setQuestionBusy(true);
    setQuestionError("");
    try {
      await api.answerQuestion(targetId, request);
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
      const response = await api.action(targetId, planActionRequest(action));
      if (!applyPlanActionResponse(response, targetId, token, isCurrentRequest, setSession, syncSessionStoplight)) return;
      setSuppressedPlanMessageId(pendingPlan.id);
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
    await api.updateQueuedInput(targetId, inputId, value, mode);
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
        onOpenSessionTransfer={accessMode === "local" ? openSessionTransfer : undefined}
      />
    );
  }
  const readySession = session;
  if (!readySession) {
    return (
      <SessionLoadingView
        session={loadingSession}
        error={sessionLoadError}
        retrying={sessionLoadRetrying}
        onRetry={() => setSessionLoadRetryNonce((current) => current + 1)}
        onBack={() => navigate("/")}
        onNewSession={() => openCreateSession()}
        onOpenSessionTransfer={accessMode === "local" ? openSessionTransfer : undefined}
      />
    );
  }
  const readyWorkspace = normalizeGitWorkspaceSummary(readySession.gitWorkspace);
  const completed = Boolean(readySession.agentOwnership?.completedAt);
  const statusPresentation = sessionStatusPresentation(readySession, shellSessions.some((candidate) => candidate.id === readySession.id) ? shellSessions : [readySession, ...shellSessions]);
  const statusSource = shellSessions.find((candidate) => candidate.id === statusPresentation.sourceSessionId);
  const statusDetail = statusPresentation.inherited && statusSource ? `from ${sessionDisplayName(statusSource, shellSessions)}` : null;

  return (
    <section className={composerFocused ? "session-view session-view-composer-focused" : "session-view"}>
      <div className="session-header">
        <button className="icon-button" onClick={() => navigate("/")} aria-label="Back">
          <ArrowLeft size={19} />
        </button>
        <div className="session-title">
          <SessionTitleHeading
            name={sessionDisplayName(readySession)}
            onFork={() => openForkSession(readySession)}
            forkDisabled={Boolean(actionBusy) || readySession.initializing === true || Boolean(readySession.startupError) || !readySession.codexSessionId}
          />
          <div className="session-title-meta">
            <SessionHeaderMeta session={readySession} />
            <TmuxCommandButton
              compact
              session={readySession}
              copied={copiedTmuxCommand}
              copyEnabled={!completed && accessMode === "local"}
              onCopy={() => void copyTmuxCommand()}
            />
          </div>
        </div>
        <div className="session-header-state">
          <HeavyCommandIndicator commands={heavyCommands} onOpen={() => setHeavyCommandsOpen(true)} />
          {readySession.initializing ? <LoadingStatusPill /> : <StatusPill status={statusPresentation.status} detail={statusDetail} />}
        </div>
      </div>

      {readySession.startupError ? (
        <p className="session-startup-error-banner" role="alert">{readySession.startupError}</p>
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
        sessionId={readySession.id}
        documents={documents}
        listLoading={documentsLoading}
        listError={documentsError}
        onClose={() => setDocumentsOpen(false)}
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
          {accessMode === "local" ? (
            <button type="button" onClick={openSessionTransfer} aria-label="Import or export sessions" title="Import or export sessions">
              <ArrowLeftRight size={16} />
              <span className="session-action-label">Transfer</span>
            </button>
          ) : null}
          <DocumentsButton documentCount={documents.length} open={documentsOpen} onOpen={() => setDocumentsOpen(true)} />
          <button
            type="button"
            className="btw-button"
            onClick={openBtwDrawer}
            disabled={readySession.initializing === true || !readySession.codexSessionId || Boolean(readySession.startupError)}
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
            disabled={completed || readySession.initializing === true || Boolean(actionBusy)}
            aria-busy={actionBusy === "interrupt"}
            aria-label={actionBusy === "interrupt" ? "Interrupting session" : "Interrupt session"}
            data-busy={actionBusy === "interrupt" || undefined}
            onClick={() => runAction({ type: "interrupt" })}
            title="Interrupt"
          >
            <Pause size={16} />
            <span className="session-action-label">{actionBusy === "interrupt" ? "Interrupting" : "Interrupt"}</span>
          </button>
          <button
            className="danger"
            disabled={completed || readySession.initializing === true || Boolean(actionBusy)}
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
          label={`Actions for ${label(messageMenu.message)} message`}
        >
          <ContextMenuItem icon={<Copy size={16} />} onClick={() => void copyMessageFromMenu()}>
            Copy
          </ContextMenuItem>
        </ContextMenu>
      ) : null}

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
          data-jump-controls={jumpVisibility.top || jumpVisibility.bottom || undefined}
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
          {pendingUserChatMessage ? <MessageBubble message={pendingUserChatMessage} pending onOpenMenu={openMessageMenu} /> : null}
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

      {approval ? (
        <ApprovalBanner
          approval={approval}
          busy={approvalBusy}
          disabled={readySession.initializing === true}
          error={approvalError}
          onDecision={resolveApproval}
        />
      ) : (
        <div className="composer-stack">
          {queuedInputs.length ? (
            <QueuedInputList
              inputs={queuedInputs}
              skills={codexSkills}
              vimEnabled={effectiveVimEnabled}
              onSkillSearch={() => void refreshCodexSkills()}
              onUpdate={updateQueuedInput}
              onDelete={deleteQueuedInput}
            />
          ) : null}
          <div className="composer-settings" role="group" aria-label="Composer settings">
            <ModeToggle
              mode={readySession.inputMode}
              busy={completed || readySession.initializing === true || actionBusy === "setInputMode" || Boolean(readySession.startupError)}
              onChange={setInputMode}
            />
            <FastModeToggle
              enabled={readySession.fastMode === true}
              available={readySession.fastModeAvailable ?? null}
              busy={completed || readySession.initializing === true || actionBusy === "setFastMode"}
              status={readySession.status}
              onChange={setFastMode}
            />
            {vimAvailable ? <VimModeToggle enabled={vimEnabled} onChange={updateVimMode} /> : null}
          </div>
          {inputModeError ? <p className="mode-toggle-error" role="alert">{inputModeError}</p> : null}
          {fastModeError ? <p className="mode-toggle-error" role="alert">{fastModeError}</p> : null}
          <form className="composer" ref={composerFormRef} onSubmit={submit}>
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
            />
            <button
              className="send-button"
              type="submit"
              aria-busy={submitBusy}
              aria-label={submitBusy ? "Sending" : shouldQueueComposerInput(readySession, queuedInputs) ? "Queue" : "Send"}
              data-busy={submitBusy || undefined}
              disabled={submitBusy || btwSubmitting || composerLocked || !composerHasContent(text)}
            >
              {submitBusy ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}
            </button>
          </form>
        </div>
      )}
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
  onNewSession,
  onOpenSessionTransfer
}: {
  session: ManagedSession | null;
  error?: string;
  retrying?: boolean;
  onRetry?: () => void;
  onBack: () => void;
  onNewSession: () => void;
  onOpenSessionTransfer?: () => void;
}) {
  const workspace = session ? normalizeGitWorkspaceSummary(session.gitWorkspace) : null;
  return (
    <SessionLoadingSkeleton
      header={
        <div className="session-header">
          <button className="icon-button" onClick={onBack} aria-label="Back">
            <ArrowLeft size={19} />
          </button>
          <div className="session-title">
            <h1>{session ? sessionDisplayName(session) : "Loading session"}</h1>
            {session ? (
              <div className="session-title-meta">
                <SessionHeaderMeta session={session} />
                <TmuxCommandButton compact session={session} copied={false} copyEnabled={false} onCopy={() => undefined} />
              </div>
            ) : <p className="session-header-meta">Starting session</p>}
          </div>
          <LoadingStatusPill />
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
            {onOpenSessionTransfer ? (
              <button type="button" onClick={onOpenSessionTransfer} aria-label="Import or export sessions" title="Import or export sessions">
                <ArrowLeftRight size={16} />
                <span className="session-action-label">Transfer</span>
              </button>
            ) : null}
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
  textarea.style.height = "auto";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
  const height = `${nextHeight}px`;
  const overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  textarea.style.height = height;
  textarea.style.overflowY = overflowY;
  if (!mirror) return;
  mirror.style.height = height;
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
  onCaretChange
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
  }, [disabled, placeholderCompartment, skillHighlightCompartment, vimEnabled]);

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
  rows,
  focusRequestKey,
  focusCommand = "focus",
  disabled
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
  rows?: number;
  focusRequestKey?: string | null;
  focusCommand?: PrimaryInputFocusCommand;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    if (!textareaRef.current) return;
    resizeComposerTextarea(textareaRef.current, mirrorRef.current);
  }, [placeholder, value]);

  useEffect(() => {
    setSelectedIndex(0);
    setDismissedTokenStart(null);
  }, [token?.start, token?.query]);

  useEffect(() => {
    if (focused && token) onSkillSearch?.();
  }, [focused, onSkillSearch, token?.start, token?.query]);

  useEffect(() => {
    if (vimEnabled || !focusRequestKey || disabled) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    if (focusCommand === "insertStart") {
      textarea.setSelectionRange(0, 0);
      setCaret(0);
      return;
    }
    if (focusCommand === "appendEnd") {
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      setCaret(end);
      return;
    }
    syncCaret(textarea);
  }, [disabled, focusCommand, focusRequestKey, vimEnabled]);

  function syncCaret(element: HTMLTextAreaElement) {
    setCaret(element.selectionStart ?? 0);
  }

  function acceptSkill(skill: CodexSkill) {
    if (!token) return;
    const next = replaceSkillToken(value, token, skill.name);
    onChange(next.text);
    if (vimEnabled) {
      vimSelectionNonceRef.current += 1;
      setVimSelectionRequest({ caret: next.caret, nonce: vimSelectionNonceRef.current });
      setCaret(next.caret);
      return;
    }
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (shouldSubmitComposer(event)) {
      event.preventDefault();
      onSubmitShortcut?.();
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      handleSuggestionCommand("next");
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      handleSuggestionCommand("previous");
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      handleSuggestionCommand("accept");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleSuggestionCommand("dismiss");
    }
  }

  function syncMirrorScroll(element: HTMLTextAreaElement) {
    if (!mirrorRef.current) return;
    mirrorRef.current.scrollTop = element.scrollTop;
    mirrorRef.current.scrollLeft = element.scrollLeft;
  }

  return (
    <div className={`skill-textarea${vimEnabled ? " skill-textarea-vim" : ""}`}>
      {vimEnabled ? (
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
          vimEnabled
          selectionRequest={vimSelectionRequest}
          focusRequestKey={focusRequestKey}
          focusCommand={focusCommand}
          onCaretChange={setCaret}
        />
      ) : (
        <>
          <div className="skill-textarea-mirror" ref={mirrorRef} aria-hidden="true">
            {renderComposerHighlights(value, skillNames)}
          </div>
          <textarea
            {...freeformComposerField}
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              syncCaret(event.target);
              syncMirrorScroll(event.target);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => syncCaret(event.currentTarget)}
            onClick={(event) => syncCaret(event.currentTarget)}
            onSelect={(event) => syncCaret(event.currentTarget)}
            onFocus={() => {
              setFocused(true);
              onFocus?.();
            }}
            onBlur={() => {
              setFocused(false);
              onBlur?.();
            }}
            onScroll={(event) => syncMirrorScroll(event.currentTarget)}
            placeholder={placeholder}
            rows={rows}
            disabled={disabled}
          />
        </>
      )}
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

export function SessionHeaderMeta({ session }: { session: Pick<ManagedSession, "repo" | "gitWorkspace" | "forkedFrom" | "agentOwnership" | "contextUsage"> }) {
  const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
  const dirty = workspace?.state === "worktree" || session.repo.dirty;
  const title = `${session.repo.name}${dirty ? " · dirty" : ""}`;

  return (
    <p className="session-header-meta" title={title}>
      <span className="session-header-repo">{session.repo.name}</span>
      {dirty ? (
        <>
          <span className="session-header-meta-separator" aria-hidden="true">
            ·
          </span>
          <span className="session-header-dirty dirty">dirty</span>
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
      {session.contextUsage ? (
        <>
          <span className="session-header-meta-separator" aria-hidden="true">·</span>
          <span title={`${session.contextUsage.activeTokens.toLocaleString()} of ${session.contextUsage.contextWindowTokens.toLocaleString()} active context tokens`}>
            {Math.round(session.contextUsage.contextPercent)}% context
          </span>
        </>
      ) : null}
    </p>
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

export function TmuxCommandButton({
  session,
  copied,
  compact = false,
  copyEnabled = true,
  onCopy
}: {
  session: ManagedSession;
  copied: boolean;
  compact?: boolean;
  copyEnabled?: boolean;
  onCopy: () => void;
}) {
  const command = tmuxAttachCommand(session);
  const model = sessionModelDisplay(session);
  const content = (
    <>
      {copyEnabled ? copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" /> : null}
      <span className="tmux-command-label">
        <span className="tmux-command-model">{model.model}</span>
        <span className="tmux-command-effort">{model.reasoningEffort}</span>
      </span>
      {copyEnabled && copied ? <span className="tmux-command-copied">Copied</span> : null}
    </>
  );
  const className = `tmux-command-button${compact ? " tmux-command-metadata" : ""}`;
  if (!copyEnabled) {
    return (
      <div className={`${className} tmux-command-display`} title={`${model.model} / ${model.reasoningEffort}`} aria-label={`${model.model} ${model.reasoningEffort}`}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onCopy}
      title={`${model.model} / ${model.reasoningEffort}\n${command}`}
      aria-label={`Copy tmux attach command for ${model.model} ${model.reasoningEffort}`}
    >
      {content}
    </button>
  );
}

export function sessionModelDisplay(session: Pick<ManagedSession, "inputMode" | "models">): { model: string; reasoningEffort: string } {
  const settings = session.models[session.inputMode];
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

export function tmuxAttachCommand(session: Pick<ManagedSession, "tmux">): string {
  const sessionTarget = shellQuote(session.tmux.sessionName);
  const windowTarget = shellQuote(`${session.tmux.sessionName}:${session.tmux.windowIndex}`);
  return `tmux select-window -t ${windowTarget} && tmux attach-session -t ${sessionTarget}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function ApprovalBanner({
  approval,
  busy,
  disabled = false,
  error,
  onDecision
}: {
  approval: ApprovalRequest;
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
  inputs,
  skills,
  vimEnabled,
  onSkillSearch,
  onUpdate,
  onDelete
}: {
  inputs: QueuedInput[];
  skills: CodexSkill[];
  vimEnabled: boolean;
  onSkillSearch: () => void;
  onUpdate: (inputId: string, text: string, mode: CollaborationMode) => Promise<void>;
  onDelete: (inputId: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  function startEdit(input: QueuedInput) {
    if (!queuedInputEditable(input)) return;
    setEditingId(input.id);
    setDraft(input.text);
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
                    <PlainText text={input.text} />
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

export function planActionRequest(action: PlanAction): SessionAction {
  return { type: "choosePlanAction", action };
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

export function pendingProposedPlanMessage(messages: ChatMessage[], suppressedMessageId: string | null): ChatMessage | null {
  const visibleMessages = displayMessages(messages);
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages[index];
    if (!message) continue;
    if (message.role === "user") return null;
    if (isRegularAssistantMessage(message) && hasCompleteProposedPlan(displayText(message) ?? "")) {
      return message.id === suppressedMessageId ? null : message;
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
  return status === "working" || status === "generating" || status === "executing" || status === "planning";
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
  const label = status === "planning" ? "Codex is planning..." : "Codex is working";
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
  questionAction = null,
  onOpenMenu
}: {
  message: ChatMessage;
  itemId?: string;
  pending?: boolean;
  planAction?: ReactNode;
  questionAction?: ReactNode;
  onOpenMenu?: (message: ChatMessage, x: number, y: number) => void;
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
      <MessageContent message={message} planAction={planAction} />
      {questionAction}
    </article>
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

function MessageContent({ message, planAction = null }: { message: ChatMessage; planAction?: ReactNode }) {
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
      <div className="rendered assistant-content">
        {segments.map((segment, index) => {
          if (segment.type === "plan") {
            return <ProposedPlanBlock key={index} text={segment.text} action={index === lastPlanSegmentIndex ? planAction : null} />;
          }
          return <MarkdownBlock key={index} text={segment.text} />;
        })}
      </div>
    );
  }

  if (message.role === "user") return <UserText text={message.text} />;

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

const markdownComponents: Components = {
  a(props) {
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

export function MarkdownBlock({ text, components = markdownComponents }: { text: string; components?: Components }) {
  if (!text) return null;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ProposedPlanBlock({ text, action = null }: { text: string; action?: ReactNode }) {
  return (
    <section className="proposed-plan">
      <div className="proposed-plan-head">Proposed plan</div>
      <div className="markdown proposed-plan-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {text}
        </ReactMarkdown>
      </div>
      {action}
    </section>
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
  return <PlainText text={body} skillNames={skills} />;
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
  return message.type === "question_request";
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
    || isTurnAbortedStatus(message)
    || isInstructionsLoadedStatus(message);
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
