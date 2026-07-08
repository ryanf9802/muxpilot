import { ChevronDown, ChevronRight, EllipsisVertical, FileText, GitBranch, Pencil, Plus, Search, Skull, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { useLocation, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import type {
  CodexUsageLimit,
  CodexUsageSummaryResponse,
  ManagedSession,
  OpenAIUsageDailyPoint,
  OpenAIUsageSummaryResponse,
  SessionEvent,
  SessionStatus
} from "@muxpilot/core";
import { SESSION_NAME_MAX_LENGTH, isValidSessionName, normalizeSessionName, normalizeSessionNameInput } from "@muxpilot/core";
import { api, eventSocket } from "../api/client.js";
import type { AppShellOutletContext } from "./AppShell.js";
import { StatusPill } from "../components/StatusPill.js";
import { sessionBaseName, sessionDisplayName } from "../utils/sessionLabels.js";
import {
  SESSION_STATUS_EVENT_DEBOUNCE_MS,
  SESSION_STATUS_RECONCILE_INTERVAL_MS,
  isSessionStatusSeverity,
  sessionStatusSeverity,
  shouldRefreshSessionsForEvent,
  type SessionStatusSeverity
} from "../utils/sessionStatus.js";

const ACTION_MENU_WIDTH = 220;
const ACTION_MENU_HEIGHT = 128;
const ACTION_MENU_EDGE = 8;
const DASHBOARD_COLLAPSED_REPOS_STORAGE_KEY = "muxpilot.dashboard.collapsed-repos.v1";
export const DASHBOARD_SESSION_RECONCILE_INTERVAL_MS = SESSION_STATUS_RECONCILE_INTERVAL_MS;
export const DASHBOARD_USAGE_RECONCILE_INTERVAL_MS = 60_000;
export const DASHBOARD_EVENT_DEBOUNCE_MS = SESSION_STATUS_EVENT_DEBOUNCE_MS;
export const DASHBOARD_STATUSES = ["", "working", "planning", "waiting", "question", "plan_ready", "approval", "unknown", "missing"];
export const DASHBOARD_STATUS_FILTER_OPTIONS = [
  { value: "", label: "all" },
  { value: "severity:red", label: "needs attention" },
  { value: "severity:yellow", label: "working / pending" },
  { value: "severity:green", label: "ready" }
];
export const SESSION_NAME_VALIDATION_MESSAGE = "Name must be 2-32 lowercase letters, numbers, or hyphens.";

export type DashboardStatusFilter =
  | { kind: "all"; selectValue: "" }
  | { kind: "status"; status: string; selectValue: string }
  | { kind: "severity"; severity: SessionStatusSeverity; selectValue: `severity:${SessionStatusSeverity}` };

export function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { connectionEpoch, openCreateSession } = useOutletContext<AppShellOutletContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [usageSummary, setUsageSummary] = useState<OpenAIUsageSummaryResponse | null>(null);
  const [codexUsageSummary, setCodexUsageSummary] = useState<CodexUsageSummaryResponse | null>(null);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ session: ManagedSession; x: number; y: number } | null>(null);
  const [renameSession, setRenameSession] = useState<ManagedSession | null>(null);
  const [renameName, setRenameName] = useState("");
  const [busyAction, setBusyAction] = useState<{ sessionId?: string; type: "rename" | "kill" } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activitySummaryToggleBusy, setActivitySummaryToggleBusy] = useState(false);
  const [activitySummaryToggleError, setActivitySummaryToggleError] = useState<string | null>(null);
  const [collapsedRepoKeys, setCollapsedRepoKeys] = useState<Set<string>>(() => new Set(loadStoredCollapsedRepoKeys()));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const sessionRequestIdRef = useRef(0);
  const usageRequestIdRef = useRef(0);
  const codexUsageRequestIdRef = useRef(0);
  const optimisticallyRemovedSessionIdsRef = useRef(new Set<string>());
  const statusFilter = useMemo(() => dashboardStatusFilterFromSearchParams(searchParams), [searchParams]);

  const loadSessions = useCallback(async () => {
    const requestId = ++sessionRequestIdRef.current;
    const sessionResponse = await api.sessions(q, statusFilter.kind === "status" ? statusFilter.status : "");
    if (requestId === sessionRequestIdRef.current) {
      const visibleSessions = filterSessionsByDashboardStatus(sessionResponse.sessions, statusFilter);
      setSessions(removeSessionsFromDashboard(visibleSessions, optimisticallyRemovedSessionIdsRef.current));
    }
  }, [q, statusFilter]);

  const loadUsageSummary = useCallback(async () => {
    const requestId = ++usageRequestIdRef.current;
    const summary = await api.openaiUsageSummary(30);
    if (requestId === usageRequestIdRef.current) setUsageSummary(summary);
  }, []);

  const loadCodexUsageSummary = useCallback(async () => {
    const requestId = ++codexUsageRequestIdRef.current;
    const summary = await api.codexUsageSummary();
    if (requestId === codexUsageRequestIdRef.current) setCodexUsageSummary(summary);
  }, []);

  useEffect(() => {
    const optimisticallyRemovedSessionId = dashboardLocationState(location.state).optimisticallyRemovedSessionId;
    if (!optimisticallyRemovedSessionId) return;
    optimisticallyRemovedSessionIdsRef.current.add(optimisticallyRemovedSessionId);
    setSessions((currentSessions) => removeSessionFromDashboard(currentSessions, optimisticallyRemovedSessionId));
  }, [location.state]);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadSessions().catch(() => undefined);
      }, DASHBOARD_EVENT_DEBOUNCE_MS);
    };

    void loadSessions().catch(() => undefined);
    const interval = setInterval(() => void loadSessions().catch(() => undefined), DASHBOARD_SESSION_RECONCILE_INTERVAL_MS);
    const socket = eventSocket();
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionEvent | { type: string };
      if (shouldRefreshDashboardForEvent(event)) scheduleLoad();
    };
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(interval);
      socket.close();
    };
  }, [connectionEpoch, loadSessions]);

  useEffect(() => {
    void loadUsageSummary().catch(() => undefined);
    void loadCodexUsageSummary().catch(() => undefined);
    const interval = setInterval(() => {
      void loadUsageSummary().catch(() => undefined);
      void loadCodexUsageSummary().catch(() => undefined);
    }, DASHBOARD_USAGE_RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadCodexUsageSummary, loadUsageSummary]);

  useEffect(() => {
    if (!menu) return undefined;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  useEffect(() => {
    if (!renameSession) return undefined;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyAction) return;
      setRenameSession(null);
      setActionError(null);
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [renameSession, busyAction]);

  const sessionGroups = useMemo(() => groupSessionsByRepo(sessions), [sessions]);
  const renameNameError = renameSession ? sessionNameValidationMessage(renameName) : null;

  function openMenu(session: ManagedSession, x: number, y: number) {
    setActionError(null);
    setMenu({ session, ...clampMenuPosition(x, y) });
  }

  function openMenuFromButton(session: ManagedSession, event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(session, rect.right - ACTION_MENU_WIDTH, rect.bottom + 6);
  }

  function openRename(session: ManagedSession) {
    setMenu(null);
    setActionError(null);
    setRenameSession(session);
    setRenameName(normalizeSessionNameInput(sessionBaseName(session)));
  }

  function closeRename() {
    if (busyAction) return;
    setRenameSession(null);
    setActionError(null);
  }

  function updateRenameName(value: string) {
    setRenameName(normalizeSessionNameInput(value));
    setActionError(null);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameSession || busyAction) return;

    const name = normalizeSessionName(renameName);
    if (!isValidSessionName(name)) {
      setActionError(SESSION_NAME_VALIDATION_MESSAGE);
      return;
    }

    setBusyAction({ sessionId: renameSession.id, type: "rename" });
    setActionError(null);
    try {
      await api.action(renameSession.id, { type: "rename", name });
      setRenameSession(null);
      await loadSessions();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not rename session.");
    } finally {
      setBusyAction(null);
    }
  }

  async function killPane(session: ManagedSession) {
    setMenu(null);
    setActionError(null);

    optimisticallyRemovedSessionIdsRef.current.add(session.id);
    setSessions((currentSessions) => removeSessionFromDashboard(currentSessions, session.id));
    setBusyAction({ sessionId: session.id, type: "kill" });
    try {
      await api.action(session.id, { type: "kill" });
      await loadSessions();
    } catch (error) {
      optimisticallyRemovedSessionIdsRef.current.delete(session.id);
      await loadSessions();
      setActionError(error instanceof Error ? error.message : "Could not kill pane.");
    } finally {
      setBusyAction(null);
    }
  }

  async function setActivitySummariesEnabled(enabled: boolean) {
    if (activitySummaryToggleBusy) return;
    setActivitySummaryToggleBusy(true);
    setActivitySummaryToggleError(null);
    const previousSummary = usageSummary;
    setUsageSummary((summary) => (summary ? { ...summary, activitySummariesEnabled: enabled } : summary));
    try {
      await api.updateActivitySummarySettings({ enabled });
      await Promise.all([loadUsageSummary(), loadSessions()]);
    } catch (error) {
      setUsageSummary(previousSummary);
      setActivitySummaryToggleError(error instanceof Error ? error.message : "Could not update activity summary setting.");
    } finally {
      setActivitySummaryToggleBusy(false);
    }
  }

  function toggleRepoCollapsed(repoKey: string) {
    setCollapsedRepoKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys);
      if (nextKeys.has(repoKey)) {
        nextKeys.delete(repoKey);
      } else {
        nextKeys.add(repoKey);
      }
      saveStoredCollapsedRepoKeys([...nextKeys]);
      return nextKeys;
    });
  }

  function updateStatusFilter(value: string) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("status");
    nextParams.delete("statusSeverity");
    if (value.startsWith("severity:")) {
      nextParams.set("statusSeverity", value.slice("severity:".length));
    } else if (value) {
      nextParams.set("status", value);
    }
    setSearchParams(nextParams);
  }

  return (
    <section className="dashboard">
      <div className="filters">
        <label className="search-box">
          <Search size={18} />
          <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search sessions" />
        </label>
        <select value={statusFilter.selectValue} onChange={(event) => updateStatusFilter(event.target.value)} aria-label="Status filter">
          {DASHBOARD_STATUS_FILTER_OPTIONS.map((option) => (
            <option key={option.value || "all"} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button className="dashboard-new-session-button" type="button" onClick={() => openCreateSession()}>
          <Plus size={16} />
          New session
        </button>
      </div>

      {actionError && !renameSession ? (
        <p className="dashboard-action-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="repo-session-groups">
        {sessionGroups.map((group) => {
          const isCollapsed = collapsedRepoKeys.has(group.key);
          const sessionGridId = repoSessionGridId(group.key);

          return (
            <section className="repo-session-group" key={group.key}>
              <RepoSessionGroupHeader
                group={group}
                isCollapsed={isCollapsed}
                sessionGridId={sessionGridId}
                onToggleCollapsed={toggleRepoCollapsed}
              />

              {isCollapsed ? null : (
                <div className="session-grid" id={sessionGridId}>
                  {group.sessions.map((session) => {
                    const previewLines = dashboardPreviewLines(session, usageSummary?.activitySummariesEnabled ?? true);

                    return (
                      <SessionCard
                        key={session.id}
                        session={session}
                        displayName={sessionDisplayName(session, sessions)}
                        previewLines={previewLines}
                        onOpen={() => navigate(`/sessions/${session.id}`)}
                        onOpenMenu={openMenu}
                        onOpenMenuFromButton={openMenuFromButton}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {menu ? (
        <div
          className="session-action-menu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={`Actions for ${sessionDisplayName(menu.session, sessions)}`}
        >
          <button type="button" role="menuitem" onClick={() => openRename(menu.session)} disabled={Boolean(busyAction)}>
            <Pencil size={16} />
            Rename
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => void killPane(menu.session)}
            disabled={Boolean(busyAction)}
            aria-busy={busyAction?.sessionId === menu.session.id && busyAction.type === "kill"}
            data-busy={busyAction?.sessionId === menu.session.id && busyAction.type === "kill" ? true : undefined}
          >
            <Skull size={16} />
            {busyAction?.sessionId === menu.session.id && busyAction.type === "kill" ? "Killing" : "Kill pane"}
          </button>
        </div>
      ) : null}

      {renameSession ? (
        <div className="dialog-backdrop" role="presentation" onPointerDown={(event) => event.currentTarget === event.target && closeRename()}>
          <form className="session-name-dialog" onSubmit={submitRename} role="dialog" aria-modal="true" aria-labelledby="rename-session-title">
            <div className="dialog-head">
              <h2 id="rename-session-title">Rename session</h2>
              <button type="button" className="icon-button" onClick={closeRename} aria-label="Close" disabled={Boolean(busyAction)}>
                <X size={18} />
              </button>
            </div>
            <label className="rename-field">
              <span>Name</span>
              <input
                autoFocus
                value={renameName}
                onChange={(event) => updateRenameName(event.target.value)}
                maxLength={SESSION_NAME_MAX_LENGTH}
                aria-invalid={Boolean(renameNameError)}
                disabled={Boolean(busyAction)}
              />
            </label>
            {renameNameError ? (
              <p className="dialog-error" role="alert">
                {renameNameError}
              </p>
            ) : null}
            {actionError ? (
              <p className="dialog-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" onClick={closeRename} disabled={Boolean(busyAction)}>
                Cancel
              </button>
              <button
                className="primary"
                type="submit"
                disabled={Boolean(busyAction) || Boolean(renameNameError)}
                aria-busy={busyAction?.sessionId === renameSession.id && busyAction.type === "rename"}
                data-busy={busyAction?.sessionId === renameSession.id && busyAction.type === "rename" ? true : undefined}
              >
                {busyAction?.sessionId === renameSession.id && busyAction.type === "rename" ? "Renaming" : "Rename"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div className="dashboard-usage-separator" aria-hidden="true" />
      <CodexUsagePanel summary={codexUsageSummary} />
      <OpenAIUsagePanel
        summary={usageSummary}
        toggleBusy={activitySummaryToggleBusy}
        toggleError={activitySummaryToggleError}
        onToggleActivitySummaries={setActivitySummariesEnabled}
      />
    </section>
  );
}

export function dashboardPreviewLines(
  session: Pick<ManagedSession, "activitySummary" | "recentUserPrompts">,
  activitySummariesEnabled = true
): string[] {
  return activitySummariesEnabled && session.activitySummary ? [session.activitySummary] : session.recentUserPrompts.slice(0, 2);
}

export function dashboardStatusFilterFromSearchParams(params: Pick<URLSearchParams, "get">): DashboardStatusFilter {
  const severity = params.get("statusSeverity");
  if (isSessionStatusSeverity(severity)) return { kind: "severity", severity, selectValue: `severity:${severity}` };

  const status = params.get("status");
  if (isDashboardStatus(status)) return { kind: "status", status, selectValue: status };

  return { kind: "all", selectValue: "" };
}

export function filterSessionsByDashboardStatus(sessions: ManagedSession[], filter: DashboardStatusFilter): ManagedSession[] {
  if (filter.kind !== "severity") return sessions;
  return sessions.filter((session) => sessionStatusSeverity(session.status) === filter.severity);
}

export function shouldRefreshDashboardForEvent(event: Pick<SessionEvent, "type"> | { type: string }): boolean {
  return shouldRefreshSessionsForEvent(event);
}

export function removeSessionFromDashboard(sessions: ManagedSession[], sessionId: string): ManagedSession[] {
  return sessions.filter((session) => session.id !== sessionId);
}

export function removeSessionsFromDashboard(sessions: ManagedSession[], sessionIds: ReadonlySet<string>): ManagedSession[] {
  return sessions.filter((session) => !sessionIds.has(session.id));
}

export function sessionNameValidationMessage(value: string): string | null {
  return isValidSessionName(normalizeSessionName(value)) ? null : SESSION_NAME_VALIDATION_MESSAGE;
}

export function parseStoredCollapsedRepoKeys(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

export function dashboardLocationState(state: unknown): { optimisticallyRemovedSessionId: string | null } {
  if (!state || typeof state !== "object" || !("optimisticallyRemovedSessionId" in state)) return { optimisticallyRemovedSessionId: null };
  const value = (state as { optimisticallyRemovedSessionId?: unknown }).optimisticallyRemovedSessionId;
  return { optimisticallyRemovedSessionId: typeof value === "string" ? value : null };
}

function isDashboardStatus(value: string | null): value is SessionStatus {
  return typeof value === "string" && DASHBOARD_STATUSES.includes(value);
}

export function SessionCard({
  session,
  displayName,
  previewLines,
  onOpen,
  onOpenMenu,
  onOpenMenuFromButton
}: {
  session: ManagedSession;
  displayName: string;
  previewLines: string[];
  onOpen: () => void;
  onOpenMenu: (session: ManagedSession, x: number, y: number) => void;
  onOpenMenuFromButton: (session: ManagedSession, event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const reserveSecondPromptSlot = !session.activitySummary && previewLines.length > 1;

  function clearLongPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pointerStartRef.current = null;
  }

  useEffect(() => clearLongPress, []);

  function openLongPressMenu(x: number, y: number) {
    suppressClickRef.current = true;
    clearLongPress();
    onOpenMenu(session, x, y);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" || event.button !== 0) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = setTimeout(() => openLongPressMenu(event.clientX, event.clientY), 600);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!pointerStartRef.current) return;
    const deltaX = Math.abs(event.clientX - pointerStartRef.current.x);
    const deltaY = Math.abs(event.clientY - pointerStartRef.current.y);
    if (deltaX > 10 || deltaY > 10) clearLongPress();
  }

  function handleContextMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    clearLongPress();
    onOpenMenu(session, event.clientX, event.clientY);
  }

  function handleClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpen();
  }

  return (
    <div className="session-card-shell">
      <button
        className="session-card"
        type="button"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerLeave={clearLongPress}
      >
        <div className="card-head">
          <div>
            <h2>{displayName}</h2>
          </div>
          <StatusPill status={session.status} />
        </div>
        <div className={`preview${reserveSecondPromptSlot ? " preview-two-lines" : ""}`}>
          {previewLines.length > 0 ? (
            previewLines.map((line, index) => (
              <p className={`preview-line${session.activitySummary ? " preview-summary" : ""}`} key={`${session.id}-preview-${index}`}>
                {line}
              </p>
            ))
          ) : (
            <p className="preview-line preview-empty">No user prompts yet.</p>
          )}
        </div>
        <div className="card-foot">
          <span>{session.lastActivityAt ? new Date(session.lastActivityAt).toLocaleString() : "no activity"}</span>
          <span className="session-size" title="Transcript size">
            <FileText size={13} /> {formatTranscriptSize(session.transcriptSize)}
          </span>
        </div>
      </button>
      <button
        className="session-card-menu-button"
        type="button"
        onClick={(event) => onOpenMenuFromButton(session, event)}
        aria-label={`Session actions for ${displayName}`}
      >
        <EllipsisVertical size={18} />
      </button>
    </div>
  );
}

export function RepoSessionGroupHeader({
  group,
  isCollapsed,
  sessionGridId,
  onToggleCollapsed
}: {
  group: RepoSessionGroup;
  isCollapsed?: boolean;
  sessionGridId?: string;
  onToggleCollapsed?: (repoKey: string) => void;
}) {
  function toggleCollapsed() {
    onToggleCollapsed?.(group.key);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleCollapsed();
  }

  return (
    <div
      className="repo-session-group-head"
      role="button"
      tabIndex={0}
      aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.repoName}`}
      aria-expanded={!isCollapsed}
      aria-controls={sessionGridId}
      title={isCollapsed ? "Expand repo" : "Collapse repo"}
      onClick={toggleCollapsed}
      onKeyDown={handleKeyDown}
    >
      <div className="repo-session-group-title-row">
        <span
          className="repo-collapse-button"
          aria-hidden="true"
        >
          {isCollapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
        </span>
        <div>
          <h2>
            <span>{group.repoName}</span>
          </h2>
          <p className="repo-session-group-meta">
            <GitBranch size={14} />
            <span>{group.branch ?? "no branch"}</span>
            {group.dirty ? <span className="dirty">dirty</span> : null}
          </p>
        </div>
      </div>
      <div className="repo-session-group-actions">
        <span>{formatSessionCount(group.sessions.length)}</span>
      </div>
    </div>
  );
}

export interface RepoSessionGroup {
  key: string;
  repoName: string;
  repoRoot: string | null;
  branch: string | null;
  dirty: boolean;
  sessions: ManagedSession[];
}

function groupSessionsByRepo(sessions: ManagedSession[]): RepoSessionGroup[] {
  const groups: RepoSessionGroup[] = [];
  const groupByKey = new Map<string, RepoSessionGroup>();

  for (const session of sessions) {
    const key = session.repo.root ?? `name:${session.repo.name}`;
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        key,
        repoName: session.repo.name,
        repoRoot: session.repo.root,
        branch: session.repo.branch,
        dirty: session.repo.dirty,
        sessions: []
      };
      groupByKey.set(key, group);
      groups.push(group);
    }

    group.dirty = group.dirty || session.repo.dirty;
    group.sessions.push(session);
  }

  return groups;
}

function loadStoredCollapsedRepoKeys(): string[] {
  if (typeof window === "undefined") return [];
  return parseStoredCollapsedRepoKeys(window.localStorage.getItem(DASHBOARD_COLLAPSED_REPOS_STORAGE_KEY));
}

function saveStoredCollapsedRepoKeys(repoKeys: readonly string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DASHBOARD_COLLAPSED_REPOS_STORAGE_KEY, JSON.stringify(repoKeys));
}

function repoSessionGridId(repoKey: string): string {
  return `repo-session-grid-${repoKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function formatSessionCount(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

function formatTranscriptSize(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(ACTION_MENU_EDGE, Math.min(x, window.innerWidth - ACTION_MENU_WIDTH - ACTION_MENU_EDGE)),
    y: Math.max(ACTION_MENU_EDGE, Math.min(y, window.innerHeight - ACTION_MENU_HEIGHT - ACTION_MENU_EDGE))
  };
}

export function OpenAIUsagePanel({
  summary,
  toggleBusy = false,
  toggleError = null,
  onToggleActivitySummaries
}: {
  summary: OpenAIUsageSummaryResponse | null;
  toggleBusy?: boolean;
  toggleError?: string | null;
  onToggleActivitySummaries?: (enabled: boolean) => void;
}) {
  if (summary && !summary.configured) return null;

  const points = summary?.points ?? [];
  const totals = summary?.totals;
  const hasCost = totals?.estimatedCostUsd !== null;
  const enabled = summary?.activitySummariesEnabled ?? true;

  return (
    <section className="usage-panel">
      <div className="usage-panel-head">
        <div>
          <h2>OpenAI cost, past 30 days</h2>
          <p>{enabled ? "Activity summary API calls" : "Activity summaries paused"}</p>
        </div>
        <div className="usage-panel-controls">
          <label className="summary-toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!summary || toggleBusy}
              onChange={(event) => onToggleActivitySummaries?.(event.currentTarget.checked)}
            />
            <span>Summaries</span>
          </label>
          <div className="usage-total">
            <strong>{summary ? formatUsd(totals?.estimatedCostUsd ?? null) : "..."}</strong>
            <span>{summary ? `${formatNumber(totals?.totalTokens ?? 0)} tokens` : "loading"}</span>
          </div>
        </div>
      </div>

      <UsageChart points={points} />

      <div className="usage-stats">
        <span>{formatNumber(totals?.requestCount ?? 0)} requests</span>
        <span>{formatNumber(totals?.inputTokens ?? 0)} input</span>
        <span>{formatNumber(totals?.cachedInputTokens ?? 0)} cached</span>
        <span>{formatNumber(totals?.outputTokens ?? 0)} output</span>
      </div>
      {summary && !hasCost && summary.unpricedModels.length > 0 ? (
        <p className="usage-note">Pricing missing for {summary.unpricedModels.join(", ")}.</p>
      ) : null}
      {toggleError ? (
        <p className="usage-note usage-error" role="alert">
          {toggleError}
        </p>
      ) : null}
    </section>
  );
}

export function CodexUsagePanel({ summary }: { summary: CodexUsageSummaryResponse | null }) {
  const accountLabel = summary ? formatCodexAccount(summary) : "loading";
  const planLabel = summary?.account?.planType ? summary.account.planType : null;

  return (
    <section className="usage-panel codex-usage-panel">
      <div className="usage-panel-head">
        <div>
          <h2>Codex usage</h2>
          <p>{summary?.available ? "Account limits" : summary?.error ?? "Account limits"}</p>
        </div>
        <div className="usage-total">
          <strong>{accountLabel}</strong>
          <span>{planLabel ?? (summary ? formatCodexRefresh(summary.refreshedAt) : "loading")}</span>
        </div>
      </div>

      <div className="codex-limit-list">
        <CodexLimitRow label="5h limit" limit={summary?.limits.fiveHour ?? null} loading={!summary} />
        <CodexLimitRow label="Weekly limit" limit={summary?.limits.weekly ?? null} loading={!summary} />
      </div>

      {summary ? (
        <div className="usage-stats">
          <span>{formatCodexRefresh(summary.refreshedAt)}</span>
          {summary.available ? null : <span>Unavailable</span>}
        </div>
      ) : null}
    </section>
  );
}

function CodexLimitRow({ label, limit, loading }: { label: string; limit: CodexUsageLimit | null; loading: boolean }) {
  const remainingPercent = limit?.remainingPercent ?? 0;
  return (
    <div className="codex-limit-row">
      <div className="codex-limit-meta">
        <span>{label}</span>
        <span>
          {loading ? "loading" : limit?.remainingPercent === null || !limit ? "unavailable" : `${Math.round(limit.remainingPercent)}% remaining`}
        </span>
      </div>
      <div className="codex-limit-track" aria-label={`${label} usage`}>
        <div className="codex-limit-fill" style={{ width: `${Math.max(0, Math.min(100, remainingPercent))}%` }} />
      </div>
      <div className="codex-limit-foot">
        <span>{limit?.remainingPercent === null || !limit ? "" : `${Math.round(limit.remainingPercent)}% remaining`}</span>
        <span>{limit?.resetsAt ? `Resets ${formatCodexReset(limit.resetsAt)}` : ""}</span>
      </div>
    </div>
  );
}

function UsageChart({ points }: { points: OpenAIUsageDailyPoint[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 600;
  const height = 150;
  const padding = { top: 14, right: 8, bottom: 24, left: 8 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxCost = Math.max(0, ...points.map((point) => point.estimatedCostUsd ?? 0));
  const barGap = 3;
  const barWidth = points.length > 0 ? Math.max(3, chartWidth / points.length - barGap) : 0;
  const activePoint = activeIndex === null ? null : points[activeIndex] ?? null;
  const activePosition =
    activeIndex === null
      ? null
      : usageChartBarPosition(activeIndex, points[activeIndex] ?? null, {
          width,
          height,
          padding,
          chartWidth,
          chartHeight,
          maxCost,
          barGap,
          barWidth,
          pointCount: points.length
        });

  return (
    <div className="usage-chart" aria-label="OpenAI cost over the past 30 days">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={height - padding.bottom}
          y2={height - padding.bottom}
          className="usage-axis"
        />
        {points.map((point, index) => {
          const position = usageChartBarPosition(index, point, {
            width,
            height,
            padding,
            chartWidth,
            chartHeight,
            maxCost,
            barGap,
            barWidth,
            pointCount: points.length
          });
          return (
            <rect
              key={point.date}
              className={point.estimatedCostUsd === null ? "usage-bar usage-bar-unpriced" : "usage-bar"}
              x={position.x}
              y={position.y}
              width={barWidth}
              height={position.barHeight}
              rx={2}
              tabIndex={0}
              aria-label={`${formatLongDate(point.date)} cost ${formatUsd(point.estimatedCostUsd)}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex((currentIndex) => (currentIndex === index ? null : currentIndex))}
              onFocus={() => setActiveIndex(index)}
              onClick={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex((currentIndex) => (currentIndex === index ? null : currentIndex))}
            />
          );
        })}
        {points.length > 0 ? (
          <>
            <text x={padding.left} y={height - 6} className="usage-chart-label">
              {formatShortDate(points[0]?.date)}
            </text>
            <text x={width - padding.right} y={height - 6} textAnchor="end" className="usage-chart-label">
              {formatShortDate(points.at(-1)?.date)}
            </text>
          </>
        ) : null}
      </svg>
      {activePoint && activePosition ? (
        <div
          className={`usage-tooltip usage-tooltip-${activePosition.tooltipAlign}`}
          style={{
            left: `${(activePosition.centerX / width) * 100}%`,
            top: `${(activePosition.tooltipY / height) * 100}%`
          }}
          role="status"
        >
          <span>{formatLongDate(activePoint.date)}</span>
          <strong>{formatUsd(activePoint.estimatedCostUsd)}</strong>
          <span>
            {formatNumber(activePoint.totalTokens)} tokens · {formatNumber(activePoint.requestCount)} requests
          </span>
        </div>
      ) : null}
    </div>
  );
}

type UsageChartPositionOptions = {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  chartWidth: number;
  chartHeight: number;
  maxCost: number;
  barGap: number;
  barWidth: number;
  pointCount: number;
};

function usageChartBarPosition(index: number, point: OpenAIUsageDailyPoint | null, options: UsageChartPositionOptions) {
  const cost = point?.estimatedCostUsd ?? 0;
  const barHeight = options.maxCost > 0 ? Math.max(2, (cost / options.maxCost) * options.chartHeight) : 0;
  const x = options.padding.left + index * (options.chartWidth / Math.max(1, options.pointCount)) + options.barGap / 2;
  const y = options.height - options.padding.bottom - barHeight;
  const centerX = x + options.barWidth / 2;
  const tooltipY = Math.max(options.padding.top + 2, y - 8);
  const tooltipAlign = centerX < options.width * 0.25 ? "left" : centerX > options.width * 0.75 ? "right" : "center";
  return { x, y, barHeight, centerX, tooltipY, tooltipAlign };
}

function formatUsd(value: number | null): string {
  if (value === null) return "unpriced";
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatCodexAccount(summary: CodexUsageSummaryResponse): string {
  if (!summary.account) return "Not signed in";
  if (summary.account.kind === "chatgpt") return summary.account.email ?? "ChatGPT";
  if (summary.account.kind === "apiKey") return "API key";
  if (summary.account.kind === "amazonBedrock") return "Amazon Bedrock";
  return "Unknown account";
}

function formatCodexRefresh(value: string): string {
  return `Updated ${new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatCodexReset(value: number): string {
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(millis).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatShortDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatLongDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
