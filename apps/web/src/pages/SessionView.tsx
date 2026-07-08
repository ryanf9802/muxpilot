import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpToLine,
  Check,
  Copy,
  HelpCircle,
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
  X
} from "lucide-react";
import { cursorLineDown, insertNewlineAndIndent } from "@codemirror/commands";
import { minimalSetup } from "codemirror";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { EditorState, Prec, type Extension } from "@codemirror/state";
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
import { FormEvent, KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import type { AppShellOutletContext } from "./AppShell.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  CodexSkill,
  CollaborationMode,
  ManagedSession,
  PlanActionChoice,
  QuestionAnswerRequest,
  QuestionRequest,
  QueuedInput,
  SessionModelSettings,
  SessionAction,
  SessionEvent,
  TranscriptPageResponse,
  TranscriptItem as CoreTranscriptItem
} from "@muxpilot/core";
import { hasCompleteProposedPlan, itemFirstSequence, itemLastSequence, transcriptMessages } from "@muxpilot/core";
import { appendSkillNamesToText, normalizeSubagentNotificationText, normalizeUserContextText } from "@muxpilot/core";
import { api, eventSocket } from "../api/client.js";
import { StatusPill } from "../components/StatusPill.js";
import { codeMirrorComposerFieldAttributes, freeformComposerField, noAutofillTextField } from "../utils/formFields.js";
import { sessionDisplayName } from "../utils/sessionLabels.js";

const MESSAGE_PAGE_SIZE = 80;
const MESSAGE_TOP_LOAD_THRESHOLD_PX = 80;
const MESSAGE_BOTTOM_LOAD_THRESHOLD_PX = 120;
const SESSION_RECONCILE_INTERVAL_MS = 2000;
const SKILL_REFRESH_INTERVAL_MS = 60_000;
const SKILL_REFRESH_STALE_MS = 10_000;
export type ScrollBehavior = "bottom" | "top" | "preserve" | "none";
export type ScrollUpdateReason = "initial" | "explicit_bottom" | "send" | "live" | "older_page" | "manual_newer";
export type PlanAction = PlanActionChoice;
export type ScrollAnchorSnapshot = { itemId: string | null; offsetTop: number; scrollTop: number; scrollHeight: number };
export type MessageListAutoPageAction = "older" | "newer" | null;
export interface PendingUserMessage {
  id: string;
  sessionId: string;
  text: string;
  mode: CollaborationMode;
  timestamp: string;
}

const COMPOSER_DRAFT_STORAGE_PREFIX = "muxpilot.session-draft.v1:";
export const VIM_MODE_STORAGE_KEY = "muxpilot.vim-mode.v1";
export const DESKTOP_VIM_MEDIA_QUERY = "(min-width: 560px) and (hover: hover) and (pointer: fine)";

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

export function shouldAutofocusComposer(desktopInputAvailable: boolean): boolean {
  return desktopInputAvailable;
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

export function shouldReconcileSessionForEvent(event: Pick<SessionEvent, "type"> | { type: string }): boolean {
  return event.type === "session.updated" || event.type === "status.changed";
}

export function inputModeAction(mode: CollaborationMode): SessionAction {
  return { type: "setInputMode", mode };
}

export function sessionWithPendingInputMode(session: ManagedSession, pendingMode: CollaborationMode | null): ManagedSession {
  return pendingMode ? { ...session, inputMode: pendingMode } : session;
}

export function shouldQueueComposerInput(
  session: Pick<ManagedSession, "status"> | null,
  queuedInputs: Pick<QueuedInput, "status">[]
): boolean {
  if (queuedInputs.length > 0) return true;
  return !session || (session.status !== "waiting" && session.status !== "idle");
}

export function isNearMessageListBottom(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  thresholdPx = MESSAGE_BOTTOM_LOAD_THRESHOLD_PX
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

export function scrollBehaviorForTranscriptUpdate(reason: ScrollUpdateReason, isNearBottom: boolean): ScrollBehavior {
  if (reason === "older_page") return "preserve";
  if (reason === "manual_newer") return "none";
  if (reason === "live") return isNearBottom ? "bottom" : "none";
  return "bottom";
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
  const pendingTime = Date.parse(pending.timestamp);
  return Number.isFinite(messageTime) && Number.isFinite(pendingTime) && messageTime >= pendingTime;
}

export function shouldShowSessionLoading(
  session: Pick<ManagedSession, "id"> | null,
  routeSessionId: string,
  initialTranscriptSessionId: string | null
): boolean {
  return !session || session.id !== routeSessionId || initialTranscriptSessionId !== routeSessionId;
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
  const navigate = useNavigate();
  const {
    refreshSessionStoplight,
    syncSessionStoplight,
    openCreateSession,
    registerPromptHistoryPrefill,
    connectionEpoch,
    accessMode
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
  const [inputModeError, setInputModeError] = useState("");
  const [copiedTmuxCommand, setCopiedTmuxCommand] = useState(false);
  const [codexSkills, setCodexSkills] = useState<CodexSkill[]>([]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [vimEnabled, setVimEnabled] = useState(loadVimModePreference);
  const vimAvailable = useDesktopVimAvailable();
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [hasMoreAfter, setHasMoreAfter] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [jumpBusy, setJumpBusy] = useState<"top" | "bottom" | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set());
  const [expandedRangeItems, setExpandedRangeItems] = useState<Record<string, CoreTranscriptItem[]>>({});
  const [loadingRanges, setLoadingRanges] = useState<Set<string>>(() => new Set());
  const messageListRef = useRef<HTMLDivElement>(null);
  const requestTokenRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const liveTailRefreshRunningRef = useRef(false);
  const liveTailRefreshQueuedRef = useRef(false);
  const pendingInputModeRef = useRef<CollaborationMode | null>(null);
  const transcriptSourceKeyRef = useRef<string | null>(null);
  const initialTranscriptSessionIdRef = useRef<string | null>(null);
  const hasMoreAfterRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const lastSequenceRef = useRef(0);
  const lastMessageListScrollTopRef = useRef(0);
  const preserveScrollRef = useRef<ScrollAnchorSnapshot | null>(null);
  const scrollBehaviorRef = useRef<ScrollBehavior>("bottom");
  const skillsRefreshRunningRef = useRef(false);
  const skillsLastRefreshRef = useRef(0);
  const activeIdRef = useRef(id);
  const previousEffectIdRef = useRef(id);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const promptHistoryPrefillTextRef = useRef(text);
  activeIdRef.current = id;
  promptHistoryPrefillTextRef.current = text;

  const loadedMessages = useMemo(() => transcriptMessages(transcriptItems), [transcriptItems]);
  const lastSequence = useMemo(() => transcriptItems.at(-1)?.lastSequence ?? 0, [transcriptItems]);
  const firstSequence = useMemo(() => transcriptItems[0]?.firstSequence ?? 0, [transcriptItems]);
  lastSequenceRef.current = lastSequence;
  const pendingPlan = useMemo(() => pendingProposedPlanMessage(loadedMessages, suppressedPlanMessageId), [loadedMessages, suppressedPlanMessageId]);
  const showWorkingIndicator = shouldShowWorkingIndicator(session?.status, hasMoreAfter);
  const pendingUserChatMessage = useMemo(() => (pendingUserMessage ? pendingUserMessageToChatMessage(pendingUserMessage) : null), [pendingUserMessage]);
  const lastUserPromptAt = useMemo(
    () => latestUserPromptTimestamp(pendingUserChatMessage ? [...loadedMessages, pendingUserChatMessage] : loadedMessages),
    [loadedMessages, pendingUserChatMessage]
  );
  const composerLock = composerLockReason(Boolean(question), Boolean(pendingPlan));
  const composerLocked = Boolean(composerLock);
  const effectiveVimEnabled = vimAvailable && vimEnabled;
  const questionRenderedInline = Boolean(
    question &&
      (transcriptItems.some((item) => transcriptItemContainsMessageId(item, question.messageId)) ||
        Object.values(expandedRangeItems).some((items) => items.some((item) => transcriptItemContainsMessageId(item, question.messageId))))
  );

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
          planAction={
            pendingPlan?.id === item.message.id ? (
              <PlanActionBanner busy={planActionBusy} error={planActionError} onAction={submitPlanAction} />
            ) : null
          }
          questionAction={
            question?.messageId === item.message.id ? (
              <QuestionBanner question={question} busy={questionBusy} error={questionError} onAnswer={answerQuestion} />
            ) : null
          }
        />
      );
    }
    if (item.type === "user_action") return <UserAction key={item.message.id} itemId={item.id} message={item.message} />;
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
      setInputModeError("");
      setCopiedTmuxCommand(false);
      setComposerFocused(false);
      setPagination(false, false);
      setLoadingOlder(false);
      setLoadingNewer(false);
      setJumpBusy(null);
      setPendingUserMessage(null);
      setExpandedRangeItems({});
      setLoadingRanges(new Set());
      transcriptSourceKeyRef.current = null;
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
      liveTailRefreshRunningRef.current = false;
      liveTailRefreshQueuedRef.current = false;
      isNearBottomRef.current = true;
      lastMessageListScrollTopRef.current = 0;
      preserveScrollRef.current = null;
      scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("initial", true);
      setExpandedStacks(new Set());
    }
    void loadAll(id, token);
    const interval = setInterval(() => void reconcileLiveSession(id, token), SESSION_RECONCILE_INTERVAL_MS);
    const socket = eventSocket();
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionEvent | { type: string };
      if ("sessionId" in event && event.sessionId === id) {
        if (event.type === "message.appended") {
          const nextMessage = event.payload as ChatMessage;
          if (!hasMoreAfterRef.current) void refreshLiveTailMessages(id, token);
          if (nextMessage.type === "approval_request") void loadApproval(id, token);
          if (nextMessage.type === "question_request") void loadQuestion(id, token);
          void loadQueuedInputs(id, token);
        }
        if (event.type === "queue.updated") void loadQueuedInputs(id, token);
        if (shouldReconcileSessionForEvent(event)) {
          scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("live", isNearBottomRef.current);
          void Promise.all([loadSession(id, token), loadApproval(id, token), loadQuestion(id, token), loadQueuedInputs(id, token)]);
        }
      }
    };
    return () => {
      clearInterval(interval);
      socket.close();
    };
  }, [connectionEpoch, id]);

  function updateComposerText(value: string) {
    setText(value);
    saveComposerDraft(id, value);
  }

  function updateVimMode(enabled: boolean) {
    setVimEnabled(enabled);
    saveVimModePreference(enabled);
  }

  useLayoutEffect(() => {
    const container = messageListRef.current;
    if (!container) return;
    const behavior = scrollBehaviorRef.current;
    scrollBehaviorRef.current = "none";
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
    if (behavior === "none") return;
    scrollMessageListToBottom(container);
    updateMessageListScrollState(container);
    const animationFrame = window.requestAnimationFrame(() => {
      scrollMessageListToBottom(container);
      updateMessageListScrollState(container);
      if (initialTranscriptSessionId === id && !initialScrollReady) setInitialScrollReady(true);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [id, initialScrollReady, initialTranscriptSessionId, transcriptItems, showWorkingIndicator]);

  async function trackRefreshRequest<T>(request: () => Promise<T>): Promise<T> {
    return request();
  }

  async function loadAll(targetId = id, token = requestTokenRef.current) {
    await Promise.all([
      loadSession(targetId, token),
      loadRecentMessages(targetId, token),
      loadApproval(targetId, token),
      loadQuestion(targetId, token),
      loadQueuedInputs(targetId, token)
    ]);
  }

  async function loadSession(targetId = id, token = requestTokenRef.current) {
    const response = await trackRefreshRequest(() => api.session(targetId));
    if (!isCurrentRequest(targetId, token)) return;
    const nextSession = sessionWithPendingInputMode(response.session, pendingInputModeRef.current);
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

  async function reconcileLiveSession(targetId = id, token = requestTokenRef.current) {
    scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("live", isNearBottomRef.current);
    await Promise.all([
      loadSession(targetId, token),
      loadApproval(targetId, token),
      loadQuestion(targetId, token),
      loadQueuedInputs(targetId, token),
      refreshLiveTailMessages(targetId, token)
    ]);
  }

  async function refreshLiveTailMessages(targetId = id, token = requestTokenRef.current) {
    if (hasMoreAfterRef.current) return;
    if (liveTailRefreshRunningRef.current) {
      liveTailRefreshQueuedRef.current = true;
      return;
    }

    liveTailRefreshRunningRef.current = true;
    try {
      do {
        liveTailRefreshQueuedRef.current = false;
        scrollBehaviorRef.current = scrollBehaviorForTranscriptUpdate("live", isNearBottomRef.current);
        const response = await trackRefreshRequest(() => api.messages(targetId, { limit: MESSAGE_PAGE_SIZE }));
        if (!isCurrentTranscriptResponse(targetId, token, response)) return;
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
      } while (liveTailRefreshQueuedRef.current && !hasMoreAfterRef.current);
    } finally {
      if (isCurrentRequest(targetId, token)) {
        liveTailRefreshRunningRef.current = false;
      }
    }
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

  async function loadApproval(targetId = id, token = requestTokenRef.current) {
    const response = await trackRefreshRequest(() => api.approval(targetId));
    if (!isCurrentRequest(targetId, token)) return;
    setApproval(response.approval);
    if (!response.approval) setApprovalError("");
  }

  async function loadQuestion(targetId = id, token = requestTokenRef.current) {
    const response = await trackRefreshRequest(() => api.question(targetId));
    if (!isCurrentRequest(targetId, token)) return;
    setQuestion(response.question);
    if (!response.question) setQuestionError("");
  }

  async function loadQueuedInputs(targetId = id, token = requestTokenRef.current) {
    const response = await trackRefreshRequest(() => api.queuedInputs(targetId));
    if (!isCurrentRequest(targetId, token)) return;
    setQueuedInputs(response.queuedInputs);
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

  function updateMessageListScrollState(container: HTMLElement) {
    updateNearBottomState(container);
    lastMessageListScrollTopRef.current = container.scrollTop;
  }

  function reconcilePendingUserMessage(items: CoreTranscriptItem[]) {
    setPendingUserMessage((pending) => (pending && transcriptItemsContainPendingUserMessage(items, pending) ? null : pending));
  }

  function handleMessageListScroll() {
    const container = messageListRef.current;
    if (!container) return;
    const previousScrollTop = lastMessageListScrollTopRef.current;
    updateNearBottomState(container);
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
    if (submitBusy || composerLocked) return;
    const value = text.trimEnd();
    if (!value) return;
    const pendingMessage = createPendingUserMessage(id, value, session?.inputMode ?? "default");
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
        await api.send(id, value, session?.inputMode ?? "default");
        void refreshSessionStoplight().catch(() => undefined);
      }
    } catch (error) {
      updateComposerText(value);
      setPendingUserMessage((current) => (current?.id === pendingMessage.id ? null : current));
      throw error;
    } finally {
      setSubmitBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitComposer(event)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function runAction(action: SessionAction) {
    if (actionBusy) return;
    const targetId = id;
    const token = requestTokenRef.current;
    setActionBusy(action.type);
    try {
      await api.action(targetId, action);
      void refreshSessionStoplight().catch(() => undefined);
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
    setQuestionBusy(true);
    setQuestionError("");
    try {
      await api.answerQuestion(targetId, request);
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
      await api.action(targetId, planActionRequest(action));
      if (!isCurrentRequest(targetId, token)) return;
      setSuppressedPlanMessageId(pendingPlan.id);
      void refreshSessionStoplight().catch(() => undefined);
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

  if (shouldShowSessionLoading(session, id, initialTranscriptSessionId)) return <div className="center-screen">Loading</div>;
  const readySession = session;
  if (!readySession) return <div className="center-screen">Loading</div>;

  return (
    <section className={composerFocused ? "session-view session-view-composer-focused" : "session-view"}>
      <div className="session-header">
        <button className="icon-button" onClick={() => navigate("/")} aria-label="Back">
          <ArrowLeft size={19} />
        </button>
        <div className="session-title">
          <h1>{sessionDisplayName(readySession)}</h1>
          <SessionHeaderMeta session={readySession} />
        </div>
        <StatusPill status={readySession.status} />
        <TmuxCommandButton session={readySession} copied={copiedTmuxCommand} copyEnabled={accessMode === "local"} onCopy={() => void copyTmuxCommand()} />
        <ModeToggle mode={readySession.inputMode} busy={actionBusy === "setInputMode"} onChange={setInputMode} />
        {inputModeError ? <p className="mode-toggle-error">{inputModeError}</p> : null}
      </div>

      <div className="actions">
        <div className="actions-main">
          <button
            className="session-new-session-button"
            type="button"
            onClick={() => openCreateSession(readySession.repo.root ?? readySession.tmux.cwd)}
            aria-label="New session"
            title="New session"
          >
            <Plus size={18} />
            <span className="session-new-session-button-label">New session</span>
          </button>
          <button
            disabled={Boolean(actionBusy)}
            aria-busy={actionBusy === "interrupt"}
            data-busy={actionBusy === "interrupt" || undefined}
            onClick={() => runAction({ type: "interrupt" })}
            title="Interrupt"
          >
            <Pause size={16} /> {actionBusy === "interrupt" ? "Interrupting" : "Interrupt"}
          </button>
          <button
            className="danger"
            disabled={Boolean(actionBusy)}
            aria-busy={actionBusy === "kill"}
            data-busy={actionBusy === "kill" || undefined}
            onClick={killSession}
          >
            <Skull size={16} /> {actionBusy === "kill" ? "Killing" : "Kill"}
          </button>
        </div>
        <div className="actions-jump">
          <button
            disabled={Boolean(jumpBusy)}
            aria-busy={jumpBusy === "top"}
            data-busy={jumpBusy === "top" || undefined}
            onClick={jumpToTop}
            title="Jump to top"
          >
            <ArrowUpToLine size={16} /> {jumpBusy === "top" ? "Loading" : "Top"}
          </button>
          <button
            disabled={Boolean(jumpBusy)}
            aria-busy={jumpBusy === "bottom"}
            data-busy={jumpBusy === "bottom" || undefined}
            onClick={jumpToBottom}
            title="Jump to bottom"
          >
            <ArrowDownToLine size={16} /> {jumpBusy === "bottom" ? "Loading" : "Bottom"}
          </button>
        </div>
      </div>

      <div
        className={
          shouldHideInitialMessageList(initialTranscriptSessionId, id, initialScrollReady)
            ? "message-list message-list-initializing"
            : "message-list"
        }
        ref={messageListRef}
        onScroll={handleMessageListScroll}
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
        {pendingUserChatMessage ? <MessageBubble message={pendingUserChatMessage} pending /> : null}
        {showWorkingIndicator ? <WorkingIndicator status={readySession.status} lastUserPromptAt={lastUserPromptAt} /> : null}
        {question && !questionRenderedInline ? (
          <QuestionBanner question={question} busy={questionBusy} error={questionError} onAnswer={answerQuestion} />
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

      {approval ? (
        <ApprovalBanner
          approval={approval}
          busy={approvalBusy}
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
          <form className={`composer${vimAvailable ? " composer-vim-available" : ""}`} ref={composerFormRef} onSubmit={submit}>
            {vimAvailable ? <VimModeToggle enabled={vimEnabled} onChange={updateVimMode} /> : null}
            <SkillTextArea
              value={text}
              onChange={updateComposerText}
              onKeyDown={handleComposerKeyDown}
              vimEnabled={effectiveVimEnabled}
              onSubmitShortcut={() => {
                if (submitBusy || composerLocked) return;
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
              rows={3}
              focusRequestKey={shouldAutofocusComposer(vimAvailable) ? readySession.id : null}
              disabled={submitBusy || composerLocked}
            />
            <button
              className="send-button"
              type="submit"
              aria-busy={submitBusy}
              aria-label={submitBusy ? "Sending" : shouldQueueComposerInput(readySession, queuedInputs) ? "Queue" : "Send"}
              data-busy={submitBusy || undefined}
              disabled={submitBusy || composerLocked || !text.trimEnd()}
            >
              {submitBusy ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

export function shouldSubmitComposer(event: Pick<KeyboardEvent<HTMLTextAreaElement>, "ctrlKey" | "key">): boolean {
  return event.ctrlKey && event.key === "Enter";
}

export function composerLockReason(hasPendingQuestion: boolean, hasPendingPlan: boolean): string | null {
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
  selectionRequest,
  focusRequestKey,
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
  selectionRequest: { caret: number; nonce: number } | null;
  focusRequestKey?: string | null;
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
  }, [disabled, focusRequestKey]);

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
            run: () => onSuggestionCommandRef.current?.("dismiss") ?? false
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
      vim({ status: true }),
      vimRelativeLineNumbers(),
      minimalSetup,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(codeMirrorComposerFieldAttributes),
      codeMirrorSkillHighlightExtension(skillNames),
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
          else onBlurRef.current?.();
        }
      })
    ];

    if (placeholder) extensions.push(codeMirrorPlaceholder(placeholder));

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
  }, [disabled, focusRequestKey, placeholder, skillNamesKey]);

  return <div className="vim-editor" ref={rootRef} />;
}

export function SkillTextArea({
  value,
  onChange,
  onKeyDown,
  vimEnabled,
  onSubmitShortcut,
  onFocus,
  onBlur,
  skills,
  onSkillSearch,
  placeholder,
  rows,
  focusRequestKey,
  disabled
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  vimEnabled?: boolean;
  onSubmitShortcut?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  skills: CodexSkill[];
  onSkillSearch?: () => void;
  placeholder?: string;
  rows?: number;
  focusRequestKey?: string | null;
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
    textareaRef.current?.focus();
  }, [disabled, focusRequestKey, vimEnabled]);

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
    if (shouldSubmitComposer(event)) {
      if (!vimEnabled && onSubmitShortcut) {
        event.preventDefault();
        onSubmitShortcut();
        return;
      }
      onKeyDown?.(event);
      return;
    }
    if (open && suggestions.length > 0) {
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
        return;
      }
    }
    onKeyDown?.(event);
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
          selectionRequest={vimSelectionRequest}
          focusRequestKey={focusRequestKey}
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

export function SessionHeaderMeta({ session }: { session: Pick<ManagedSession, "repo"> }) {
  const branch = session.repo.branch ?? "no branch";
  const title = `${session.repo.name} · ${branch}`;

  return (
    <p className="session-header-meta" title={title}>
      <span className="session-header-repo">{session.repo.name}</span>
      <span className="session-header-branch-separator" aria-hidden="true">
        ·
      </span>
      <span className="session-header-branch">{branch}</span>
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
  copyEnabled = true,
  onCopy
}: {
  session: ManagedSession;
  copied: boolean;
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
  if (!copyEnabled) {
    return (
      <div className="tmux-command-button tmux-command-display" title={`${model.model} / ${model.reasoningEffort}`} aria-label={`${model.model} ${model.reasoningEffort}`}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="tmux-command-button"
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

async function copyText(value: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(value);
  } catch {
    fallbackCopy(value);
  }
}

function fallbackCopy(value: string): void {
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function ApprovalBanner({
  approval,
  busy,
  error,
  onDecision
}: {
  approval: ApprovalRequest;
  busy: ApprovalDecision | null;
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
        <button
          disabled={Boolean(busy)}
          aria-busy={busy === "approve_once"}
          data-busy={busy === "approve_once" || undefined}
          onClick={() => onDecision("approve_once")}
        >
          <Check size={16} /> {busy === "approve_once" ? "Approving" : "Approve once"}
        </button>
        {approval.prefixRule?.length ? (
          <button
            disabled={Boolean(busy)}
            aria-busy={busy === "approve_for_prefix"}
            data-busy={busy === "approve_for_prefix" || undefined}
            onClick={() => onDecision("approve_for_prefix")}
          >
            <ShieldCheck size={16} /> {busy === "approve_for_prefix" ? "Approving" : "Always allow prefix"}
          </button>
        ) : null}
        <button
          className="danger"
          disabled={Boolean(busy)}
          aria-busy={busy === "deny"}
          data-busy={busy === "deny" || undefined}
          onClick={() => onDecision("deny")}
        >
          <X size={16} /> {busy === "deny" ? "Denying" : "Deny"}
        </button>
      </div>
    </section>
  );
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
    const value = draft.trimEnd();
    if (!value || busyId) return;
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
    if (!queuedInputEditable(input) || busyId) return;
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
                    rows={3}
                    disabled={busy}
                  />
                  {input.error ? <p className="queued-input-error">{input.error}</p> : null}
                  <div className="queued-input-actions">
                    <button
                      type="button"
                      disabled={busy || !draft.trimEnd()}
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
                    <p>{input.text}</p>
                    <div className="queued-input-actions">
                      <button type="button" disabled={!editable || busy} onClick={() => startEdit(input)}>
                        <Pencil size={16} /> Edit
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={!editable || busy}
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

function queuedInputEditable(input: QueuedInput): boolean {
  return input.status === "queued" || input.status === "failed";
}

function QuestionBanner({
  question,
  busy,
  error,
  onAnswer
}: {
  question: QuestionRequest;
  busy: boolean;
  error: string;
  onAnswer: (request: QuestionAnswerRequest) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerDraft>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const remainingSeconds = questionRemainingSeconds(question, nowMs);
  const complete = question.questions.every((prompt) => questionAnswerDraftComplete(answers[prompt.id]));

  useEffect(() => {
    setAnswers({});
  }, [question.id]);

  useEffect(() => {
    if (!question.countdownExpiresAt) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [question.countdownExpiresAt]);

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !complete) return;
    onAnswer(buildQuestionAnswerRequest(question, answers));
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
                      setAnswers((current) => {
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
                setAnswers((current) => ({
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
          disabled={busy || !complete}
          aria-busy={busy}
          data-busy={busy || undefined}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} {busy ? "Sending" : "Send answer"}
        </button>
      </div>
    </form>
  );
}

interface QuestionAnswerDraft {
  selectedOption: string | null;
  other: string;
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
  error,
  onAction
}: {
  busy: PlanAction | null;
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
            disabled={Boolean(busy)}
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

export function MessageBubble({
  message,
  itemId,
  pending = false,
  planAction = null,
  questionAction = null
}: {
  message: ChatMessage;
  itemId?: string;
  pending?: boolean;
  planAction?: ReactNode;
  questionAction?: ReactNode;
}) {
  return (
    <article
      className={`message message-${message.role} message-type-${message.type}${pending ? " message-pending" : ""}`}
      data-transcript-item-id={itemId}
      aria-busy={pending || undefined}
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

function UserAction({ message, itemId }: { message: ChatMessage; itemId?: string }) {
  return (
    <div className="user-action" data-transcript-item-id={itemId}>
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
  if (isSubagentMessage(message)) return "Subagent";
  if (isAssistantUpdate(message)) return "Progress";
  if (message.type === "tool_call") return "Tool";
  if (message.type === "command_output") return "Command";
  if (message.type === "parser_notice") return "Parser";
  return message.role;
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

const markdownComponents: Components = {
  a(props) {
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  }
};

export function MarkdownBlock({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
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
          return <pre key={index}>{part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</pre>;
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
  const visibleIndex = latestVisibleAssistantIndex(messages);
  if (visibleIndex < 0) return groupEventStackItems(messages);

  const items: TranscriptItem[] = [];
  const beforeVisible = messages.slice(0, visibleIndex);
  const visibleMessage = messages[visibleIndex];
  const afterVisible = messages.slice(visibleIndex + 1);

  pushActivity(items, beforeVisible);
  if (visibleMessage) items.push({ type: "message", message: visibleMessage });
  items.push(...groupEventStackItems(afterVisible));
  return items;
}

function appendTurnActivity(items: TranscriptItem[], messages: ChatMessage[]): void {
  if (messages.length === 0) return;

  const visibleIndex = latestVisibleAssistantIndex(messages);
  if (visibleIndex < 0) {
    pushActivity(items, messages);
    return;
  }

  const beforeVisible = messages.slice(0, visibleIndex);
  const visibleMessage = messages[visibleIndex];
  const afterVisible = messages.slice(visibleIndex + 1);

  pushActivity(items, beforeVisible);
  if (visibleMessage) items.push({ type: "message", message: visibleMessage });
  items.push(...groupEventStackItems(afterVisible));
}

function latestVisibleAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRegularAssistantMessage(message)) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isAssistantUpdate(message)) return index;
  }
  return -1;
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
  if (message.role === "tool" || message.role === "system") return true;
  if (isAssistantUpdate(message)) return true;
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
  const assistantMessages = messages.filter(isRegularAssistantMessage).length;
  const events = messages.length - assistantMessages;
  if (assistantMessages > 0 && events > 0) {
    return `${messages.length} intermediate ${pluralize(messages.length, "item")}: ${assistantMessages} ${pluralize(
      assistantMessages,
      "message"
    )}, ${events} ${pluralize(events, "event")}`;
  }
  if (assistantMessages > 0) return `${assistantMessages} intermediate ${pluralize(assistantMessages, "message")}`;
  return `${events} intermediate ${pluralize(events, "event")}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function isRegularAssistantMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && !isAssistantUpdate(message);
}

function isUserActionMessage(message: ChatMessage): boolean {
  return isTurnAbortedStatus(message) || isInstructionsLoadedStatus(message);
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
