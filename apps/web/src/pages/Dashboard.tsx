import { ArrowLeftRight, Bell, ChevronDown, ChevronRight, EllipsisVertical, FileText, GitBranch, GitFork, Pencil, Pin, PinOff, Plus, Search, Skull, Zap } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { useLocation, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import type {
  CodexUsageLimit,
  CodexUsageSummaryResponse,
  ManagedSession,
  NotificationRuleType,
  NotificationTriggeredPayload,
  OpenAIUsageDailyPoint,
  OpenAIUsageSummaryResponse,
  SessionEvent,
  SessionDisplayStatus
} from "@muxpilot/core";
import { SESSION_NAME_MAX_LENGTH, SESSION_NAME_MIN_LENGTH, isOperatorActionableAgentStatus, isValidSessionName, normalizeGitWorkspaceSummary, normalizeSessionName, normalizeSessionNameInput } from "@muxpilot/core";
import { api, notificationDeviceId } from "../api/client.js";
import type { AppShellOutletContext } from "./AppShell.js";
import { LoadingStatusPill, StatusPill } from "../components/StatusPill.js";
import { ContextMenu, ContextMenuItem, clampContextMenuPosition, submenuPosition, useContextMenuTrigger, useDismissableContextMenu } from "../components/ContextMenu.js";
import { NotificationRuleMenu } from "../components/NotificationRuleMenu.js";
import { DashboardSessionsSkeleton, UsagePanelSkeleton } from "../components/LoadingSkeleton.js";
import { Modal } from "../components/Modal.js";
import { noAutofillTextField, searchField } from "../utils/formFields.js";
import { sessionBaseName, sessionDisplayName } from "../utils/sessionLabels.js";
import { notificationRulesLabel, sessionNotificationRules } from "../utils/notifications.js";
import {
  sessionStatusPresentation,
  sessionStatusSeverity,
  type SessionStatusSeverity
} from "../utils/sessionStatus.js";

const ACTION_MENU_WIDTH = 220;
const ACTION_MENU_HEIGHT = 312;
const NOTIFICATION_MENU_WIDTH = 220;
const NOTIFICATION_RING_MS = 2800;
const ACTION_MENU_EDGE = 8;
const DASHBOARD_COLLAPSED_REPOS_STORAGE_KEY = "muxpilot.dashboard.collapsed-repos.v1";
export const DASHBOARD_USAGE_RECONCILE_INTERVAL_MS = 60_000;
export const DASHBOARD_STATUSES = ["", "working", "running", "planning", "queued", "waiting", "question", "plan_ready", "approval", "blocked", "input_failed", "startup_failed", "unknown", "missing", "completed"];
export const SESSION_NAME_VALIDATION_MESSAGE = "Name must be a 2-32 character Git-style name.";

export type DashboardStatusFilter =
  | { kind: "all"; selectValue: "" }
  | { kind: "status"; status: SessionDisplayStatus; selectValue: string }
  | { kind: "severity"; severity: SessionStatusSeverity; selectValue: `severity:${SessionStatusSeverity}` };

export function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessions: shellSessions, sessionsLoaded, subscribeSessionEvents, refreshSessionStoplight, syncSessionStoplight, openCreateSession, openSessionTransfer, openForkSession, notificationSettings, setNotificationSettings, registerPrimaryInputFocus, sessionStoplightSeverity, accessMode } =
    useOutletContext<AppShellOutletContext>();
  const [searchParams] = useSearchParams();
  const [usageSummary, setUsageSummary] = useState<OpenAIUsageSummaryResponse | null>(null);
  const [codexUsageSummary, setCodexUsageSummary] = useState<CodexUsageSummaryResponse | null>(null);
  const [usageSummaryInitialLoading, setUsageSummaryInitialLoading] = useState(true);
  const [codexUsageSummaryInitialLoading, setCodexUsageSummaryInitialLoading] = useState(true);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ session: ManagedSession; x: number; y: number } | null>(null);
  const [notifySubmenuOpen, setNotifySubmenuOpen] = useState(false);
  const [notificationToggleBusy, setNotificationToggleBusy] = useState(false);
  const [notificationRings, setNotificationRings] = useState<Record<string, NotificationTriggeredPayload["severity"]>>({});
  const [renameSession, setRenameSession] = useState<ManagedSession | null>(null);
  const [renameName, setRenameName] = useState("");
  const [agentParentSession, setAgentParentSession] = useState<ManagedSession | null>(null);
  const [agentParentId, setAgentParentId] = useState("");
  const [busyAction, setBusyAction] = useState<{ sessionId?: string; type: "rename" | "pin" | "kill" | "agentParent" } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activitySummaryToggleBusy, setActivitySummaryToggleBusy] = useState(false);
  const [activitySummaryToggleError, setActivitySummaryToggleError] = useState<string | null>(null);
  const [collapsedRepoKeys, setCollapsedRepoKeys] = useState<Set<string>>(() => new Set(loadStoredCollapsedRepoKeys()));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const usageRequestIdRef = useRef(0);
  const codexUsageRequestIdRef = useRef(0);
  const [optimisticallyRemovedSessionIds, setOptimisticallyRemovedSessionIds] = useState<Set<string>>(() => new Set());
  const queryStatusFilter = useMemo(() => dashboardStatusFilterFromSearchParams(searchParams), [searchParams]);
  const statusFilter = useMemo<DashboardStatusFilter>(
    () =>
      sessionStoplightSeverity
        ? { kind: "severity", severity: sessionStoplightSeverity, selectValue: `severity:${sessionStoplightSeverity}` }
        : queryStatusFilter,
    [queryStatusFilter, sessionStoplightSeverity]
  );

  const sessions = useMemo(
    () => includeAgentAncestors(
      removeSessionsFromDashboard(filterSessionsByDashboardQuery(filterSessionsByDashboardStatus(shellSessions, statusFilter), q), optimisticallyRemovedSessionIds),
      shellSessions
    ),
    [optimisticallyRemovedSessionIds, q, shellSessions, statusFilter]
  );

  const loadUsageSummary = useCallback(async () => {
    const requestId = ++usageRequestIdRef.current;
    try {
      const summary = await api.openaiUsageSummary(30);
      if (requestId === usageRequestIdRef.current) setUsageSummary(summary);
    } finally {
      if (requestId === usageRequestIdRef.current) setUsageSummaryInitialLoading(false);
    }
  }, []);

  const loadCodexUsageSummary = useCallback(async () => {
    const requestId = ++codexUsageRequestIdRef.current;
    try {
      const summary = await api.codexUsageSummary();
      if (requestId === codexUsageRequestIdRef.current) setCodexUsageSummary(summary);
    } finally {
      if (requestId === codexUsageRequestIdRef.current) setCodexUsageSummaryInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    const optimisticallyRemovedSessionId = dashboardLocationState(location.state).optimisticallyRemovedSessionId;
    if (!optimisticallyRemovedSessionId) return;
    setOptimisticallyRemovedSessionIds((current) => new Set(current).add(optimisticallyRemovedSessionId));
  }, [location.state]);

  useEffect(() => {
    const timers = new Set<number>();
    const unsubscribe = subscribeSessionEvents((event) => {
      if (!isNotificationTriggeredEvent(event)) return;
      setNotificationRings((current) => ({ ...current, [event.sessionId]: event.payload.severity }));
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setNotificationRings((current) => {
          const next = { ...current };
          delete next[event.sessionId];
          return next;
        });
      }, NOTIFICATION_RING_MS);
      timers.add(timer);
    });
    return () => {
      unsubscribe();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [subscribeSessionEvents]);

  useEffect(() => {
    void loadUsageSummary().catch(() => undefined);
    void loadCodexUsageSummary().catch(() => undefined);
    const interval = setInterval(() => {
      void loadUsageSummary().catch(() => undefined);
      void loadCodexUsageSummary().catch(() => undefined);
    }, DASHBOARD_USAGE_RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadCodexUsageSummary, loadUsageSummary]);

  useDismissableContextMenu(Boolean(menu), menuRef, () => setMenu(null));

  useEffect(
    () =>
      registerPrimaryInputFocus((command) => {
        if (command !== "focus") return false;
        if (!searchInputRef.current) return false;
        searchInputRef.current.focus();
        searchInputRef.current.select();
        return true;
      }),
    [registerPrimaryInputFocus]
  );

  const sessionGroups = useMemo(() => groupSessionsByRepo(sessions), [sessions]);
  const renameNameWarning = renameSession ? sessionNameValidationMessage(renameName) : null;
  const renameNameInvalid = Boolean(renameSession) && !isValidSessionName(normalizeSessionName(renameName));

  function openMenu(session: ManagedSession, x: number, y: number) {
    setActionError(null);
    setNotifySubmenuOpen(false);
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

  function openAgentParent(session: ManagedSession) {
    setMenu(null);
    setActionError(null);
    setAgentParentSession(session);
    setAgentParentId(session.agentOwnership?.parentSessionId ?? "");
  }

  function closeAgentParent() {
    if (busyAction) return;
    setAgentParentSession(null);
    setActionError(null);
  }

  async function submitAgentParent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentParentSession || busyAction) return;
    setBusyAction({ sessionId: agentParentSession.id, type: "agentParent" });
    setActionError(null);
    try {
      const response = await api.action(agentParentSession.id, {
        type: "setAgentParent",
        parentSessionId: agentParentId || null
      });
      if (response.session) syncSessionStoplight(response.session);
      setAgentParentSession(null);
      await refreshSessionStoplight();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update the agent-session parent.");
    } finally {
      setBusyAction(null);
    }
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
      return;
    }

    setBusyAction({ sessionId: renameSession.id, type: "rename" });
    setActionError(null);
    try {
      await api.action(renameSession.id, { type: "rename", name });
      setRenameSession(null);
      await refreshSessionStoplight();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not rename session.");
    } finally {
      setBusyAction(null);
    }
  }

  async function killPane(session: ManagedSession) {
    setMenu(null);
    setActionError(null);

    setOptimisticallyRemovedSessionIds((current) => new Set(current).add(session.id));
    setBusyAction({ sessionId: session.id, type: "kill" });
    try {
      await api.action(session.id, { type: "kill" });
      await refreshSessionStoplight();
    } catch (error) {
      setOptimisticallyRemovedSessionIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      await refreshSessionStoplight();
      setActionError(error instanceof Error ? error.message : "Could not kill pane.");
    } finally {
      setBusyAction(null);
    }
  }

  async function setSessionPinned(session: ManagedSession, pinned: boolean) {
    setMenu(null);
    setActionError(null);
    setBusyAction({ sessionId: session.id, type: "pin" });
    syncSessionStoplight({ ...session, pinned });
    try {
      await api.action(session.id, { type: pinned ? "pin" : "unpin" });
      await refreshSessionStoplight();
    } catch (error) {
      await refreshSessionStoplight();
      setActionError(error instanceof Error ? error.message : pinned ? "Could not pin session." : "Could not unpin session.");
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
      await Promise.all([loadUsageSummary(), refreshSessionStoplight()]);
    } catch (error) {
      setUsageSummary(previousSummary);
      setActivitySummaryToggleError(error instanceof Error ? error.message : "Could not update activity summary setting.");
    } finally {
      setActivitySummaryToggleBusy(false);
    }
  }

  async function toggleSessionNotification(sessionId: string, type: NotificationRuleType, enabled: boolean) {
    if (notificationToggleBusy) return;
    setNotificationToggleBusy(true);
    try {
      const settings = await api.updateNotificationSetting({ deviceId: notificationDeviceId(), setting: "rule", scope: "session", sessionId, type, enabled });
      setNotificationSettings(settings);
    } finally {
      setNotificationToggleBusy(false);
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

  return (
    <section className="dashboard">
      <div className="filters">
        <label className="search-box">
          <Search size={18} />
          <input
            {...searchField}
            ref={searchInputRef}
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search sessions"
          />
        </label>
        <DashboardPrimaryActions
          showTransfer={accessMode === "local"}
          onOpenSessionTransfer={openSessionTransfer}
          onNewSession={() => openCreateSession()}
        />
      </div>

      {actionError && !renameSession && !agentParentSession ? (
        <p className="dashboard-action-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="repo-session-groups">
        {!sessionsLoaded ? <DashboardSessionsSkeleton /> : sessionGroups.map((group) => {
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
                        notificationRules={sessionNotificationRules(notificationSettings, session.id)}
                        notificationRing={notificationRings[session.id] ?? null}
                        children={agentSessionDescendants(session.id, sessions)}
                        onOpen={() => navigate(`/sessions/${session.id}`)}
                        onOpenChild={(childId) => navigate(`/sessions/${childId}`)}
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
        <ContextMenu
          className="session-action-menu"
          ref={menuRef}
          position={menu}
          label={`Actions for ${sessionDisplayName(menu.session, sessions)}`}
        >
          <ContextMenuItem
            icon={menu.session.pinned ? <PinOff size={16} /> : <Pin size={16} />}
            onClick={() => void setSessionPinned(menu.session, !menu.session.pinned)}
            disabled={Boolean(busyAction) || menu.session.initializing === true}
            aria-busy={busyAction?.sessionId === menu.session.id && busyAction.type === "pin"}
            data-busy={busyAction?.sessionId === menu.session.id && busyAction.type === "pin" ? true : undefined}
          >
            {menu.session.pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuItem icon={<Pencil size={16} />} onClick={() => openRename(menu.session)} disabled={Boolean(busyAction) || menu.session.initializing === true || Boolean(menu.session.runtimeUnavailableReason)}>
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            icon={<GitFork size={16} />}
            onClick={() => {
              setMenu(null);
              openForkSession(menu.session);
            }}
            disabled={Boolean(busyAction) || menu.session.initializing === true || !menu.session.codexSessionId}
          >
            Fork session
          </ContextMenuItem>
          <ContextMenuItem
            icon={<GitFork size={16} />}
            onClick={() => openAgentParent(menu.session)}
            disabled={Boolean(busyAction) || menu.session.initializing === true}
          >
            Manage agent parent
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Bell size={16} />}
            aria-haspopup="menu"
            aria-expanded={notifySubmenuOpen}
            onMouseEnter={() => setNotifySubmenuOpen(true)}
            onFocus={() => setNotifySubmenuOpen(true)}
            onClick={() => setNotifySubmenuOpen(true)}
            disabled={Boolean(busyAction) || menu.session.initializing === true}
          >
            Notify
            <ChevronRight className="menu-chevron" size={16} />
          </ContextMenuItem>
          <ContextMenuItem
            className="danger"
            icon={<Skull size={16} />}
            onClick={() => void killPane(menu.session)}
            disabled={Boolean(busyAction) || menu.session.initializing === true || menu.session.capabilities?.kill === false}
            aria-busy={busyAction?.sessionId === menu.session.id && busyAction.type === "kill"}
            data-busy={busyAction?.sessionId === menu.session.id && busyAction.type === "kill" ? true : undefined}
          >
            {busyAction?.sessionId === menu.session.id && busyAction.type === "kill" ? "Killing" : "Kill runtime"}
          </ContextMenuItem>
          {notifySubmenuOpen ? (
            <ContextMenu
              className="session-action-menu notification-rule-menu session-notify-submenu"
              position={notificationSubmenuPosition(menu.x, menu.y)}
              label={`Notification settings for ${sessionDisplayName(menu.session, sessions)}`}
            >
              <NotificationRuleMenu
                enabledRules={sessionNotificationRules(notificationSettings, menu.session.id)}
                onToggle={(type, enabled) => void toggleSessionNotification(menu.session.id, type, enabled)}
                disabled={notificationToggleBusy || menu.session.initializing === true}
              />
            </ContextMenu>
          ) : null}
        </ContextMenu>
      ) : null}

      {renameSession ? (
        <Modal
          open
          onClose={closeRename}
          title="Rename session"
          panelClassName="session-name-dialog"
          as="form"
          onSubmit={submitRename}
          dismissible={!busyAction}
        >
            <label className="rename-field">
              <span>Name</span>
              <input
                {...noAutofillTextField}
                autoFocus
                value={renameName}
                onChange={(event) => updateRenameName(event.target.value)}
                maxLength={SESSION_NAME_MAX_LENGTH}
                aria-invalid={renameNameInvalid}
                disabled={Boolean(busyAction)}
              />
            </label>
            {renameNameWarning ? (
              <p className="dialog-error" role="alert">
                {renameNameWarning}
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
                disabled={Boolean(busyAction) || renameNameInvalid}
                aria-busy={busyAction?.sessionId === renameSession.id && busyAction.type === "rename"}
                data-busy={busyAction?.sessionId === renameSession.id && busyAction.type === "rename" ? true : undefined}
              >
                {busyAction?.sessionId === renameSession.id && busyAction.type === "rename" ? "Renaming" : "Rename"}
              </button>
            </div>
        </Modal>
      ) : null}

      {agentParentSession ? (
        <Modal
          open
          onClose={closeAgentParent}
          title="Manage agent parent"
          panelClassName="session-name-dialog"
          as="form"
          onSubmit={submitAgentParent}
          dismissible={!busyAction}
        >
          <label className="rename-field">
            <span>Parent session</span>
            <select
              autoFocus
              value={agentParentId}
              onChange={(event) => {
                setAgentParentId(event.currentTarget.value);
                setActionError(null);
              }}
              disabled={Boolean(busyAction)}
            >
              <option value="">Top level (no agent parent)</option>
              {agentParentCandidates(agentParentSession, shellSessions).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{sessionDisplayName(candidate, shellSessions)}</option>
              ))}
            </select>
          </label>
          <p className="dialog-help">Agent-managed sessions remain fully visible under their selected parent.</p>
          {actionError ? <p className="dialog-error" role="alert">{actionError}</p> : null}
          <div className="dialog-actions">
            <button type="button" onClick={closeAgentParent} disabled={Boolean(busyAction)}>Cancel</button>
            <button
              className="primary"
              type="submit"
              disabled={Boolean(busyAction)}
              aria-busy={busyAction?.sessionId === agentParentSession.id && busyAction.type === "agentParent"}
            >
              {busyAction?.sessionId === agentParentSession.id && busyAction.type === "agentParent" ? "Saving" : "Save"}
            </button>
          </div>
        </Modal>
      ) : null}

      <div className="dashboard-usage-separator" aria-hidden="true" />
      {codexUsageSummaryInitialLoading && !codexUsageSummary ? (
        <UsagePanelSkeleton />
      ) : codexUsageSummary ? (
        <CodexUsagePanel summary={codexUsageSummary} />
      ) : (
        <UsageUnavailablePanel title="Codex usage" />
      )}
      {usageSummaryInitialLoading && !usageSummary ? (
        <UsagePanelSkeleton chart />
      ) : usageSummary ? (
        <OpenAIUsagePanel
          summary={usageSummary}
          toggleBusy={activitySummaryToggleBusy}
          toggleError={activitySummaryToggleError}
          onToggleActivitySummaries={setActivitySummariesEnabled}
        />
      ) : (
        <UsageUnavailablePanel title="OpenAI cost, past 30 days" />
      )}
    </section>
  );
}

export function DashboardPrimaryActions({
  showTransfer,
  onOpenSessionTransfer,
  onNewSession
}: {
  showTransfer: boolean;
  onOpenSessionTransfer: () => void;
  onNewSession: () => void;
}) {
  return (
    <div className="dashboard-primary-actions">
      {showTransfer ? (
        <button className="dashboard-transfer-button" type="button" onClick={onOpenSessionTransfer} aria-label="Import or export sessions" title="Import or export sessions">
          <ArrowLeftRight size={17} />
          <span className="dashboard-transfer-button-label">Transfer</span>
        </button>
      ) : null}
      <button className="dashboard-new-session-button" type="button" onClick={onNewSession} aria-label="New session" title="New session">
        <Plus size={16} />
        <span className="dashboard-new-session-button-label">New session</span>
      </button>
    </div>
  );
}

function UsageUnavailablePanel({ title }: { title: string }) {
  return (
    <section className="usage-panel">
      <div className="usage-panel-head">
        <div>
          <h2>{title}</h2>
          <p>Usage data is unavailable. Muxpilot will retry automatically.</p>
        </div>
      </div>
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
  const status = params.get("status");
  if (isDashboardStatus(status)) return { kind: "status", status, selectValue: status };

  return { kind: "all", selectValue: "" };
}

export function filterSessionsByDashboardStatus(sessions: ManagedSession[], filter: DashboardStatusFilter): ManagedSession[] {
  if (filter.kind === "status") return sessions.filter((session) => sessionStatusPresentation(session, sessions).status === filter.status);
  if (filter.kind !== "severity") return sessions;
  return sessions.filter((session) => !session.initializing && sessionStatusSeverity(sessionStatusPresentation(session, sessions).status) === filter.severity);
}

export function filterSessionsByDashboardQuery(sessions: ManagedSession[], query: string): ManagedSession[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) => [
    session.repo.name,
    session.repo.branch,
    session.tmux.cwd,
    session.tmux.sessionName,
    session.tmux.windowId,
    String(session.tmux.windowIndex),
    session.tmux.windowName,
    session.tmux.paneId,
    String(session.tmux.paneIndex),
    session.preview,
    session.activitySummary,
    ...session.recentUserPrompts
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
}

export function removeSessionFromDashboard(sessions: ManagedSession[], sessionId: string): ManagedSession[] {
  return sessions.filter((session) => session.id !== sessionId);
}

export function removeSessionsFromDashboard(sessions: ManagedSession[], sessionIds: ReadonlySet<string>): ManagedSession[] {
  return sessions.filter((session) => !sessionIds.has(session.id));
}

export function sessionNameValidationMessage(value: string): string | null {
  const name = normalizeSessionName(value);
  if (isValidSessionName(name) || name.length < SESSION_NAME_MIN_LENGTH) return null;
  return SESSION_NAME_VALIDATION_MESSAGE;
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

function isDashboardStatus(value: string | null): value is SessionDisplayStatus {
  return typeof value === "string" && DASHBOARD_STATUSES.includes(value);
}

export function SessionCard({
  session,
  displayName,
  previewLines,
  notificationRules,
  notificationRing,
  children = [],
  onOpen,
  onOpenChild = () => undefined,
  onOpenMenu,
  onOpenMenuFromButton
}: {
  session: ManagedSession;
  displayName: string;
  previewLines: string[];
  notificationRules: NotificationRuleType[];
  notificationRing: NotificationTriggeredPayload["severity"] | null;
  children?: ManagedSession[];
  onOpen: () => void;
  onOpenChild?: (sessionId: string) => void;
  onOpenMenu: (session: ManagedSession, x: number, y: number) => void;
  onOpenMenuFromButton: (session: ManagedSession, event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const menuTrigger = useContextMenuTrigger(session, onOpenMenu);
  const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
  const statusPresentation = sessionStatusPresentation(session, [session, ...children]);
  const statusSource = children.find((candidate) => candidate.id === statusPresentation.sourceSessionId);
  const statusDetail = statusSource ? `from ${sessionDisplayName(statusSource, [session, ...children])}` : null;
  const allChildrenCompleted = children.length > 0 && children.every((child) => Boolean(child.agentOwnership?.completedAt));
  const cardClassName = `session-card${session.pinned ? " session-card-pinned" : ""}${notificationRing ? ` session-card-notification-ring session-card-notification-ring-${notificationRing}` : ""}`;

  function handleClick() {
    if (menuTrigger.consumeSuppressedClick()) return;
    onOpen();
  }

  return (
    <div className="session-card-shell">
      <button
        className={cardClassName}
        type="button"
        onClick={handleClick}
        {...menuTrigger.triggerProps}
      >
        <div className="card-head">
          <div>
            <h2>{displayName}</h2>
            {workspace ? (
              <p className="session-card-branch" title={workspace.targetBranch}>
                {workspace.targetBranch}
              </p>
            ) : null}
            {session.forkedFrom ? (
              <p className="session-card-origin" title={`Forked from ${session.forkedFrom.sessionName}`}>
                Forked from {session.forkedFrom.sessionName}
              </p>
            ) : null}
          </div>
          <span className="session-card-head-actions">
            {session.fastMode === true ? (
              <span className="session-fast-mode-indicator" title="Fast mode enabled" aria-label="Fast mode enabled">
                <Zap size={14} />
              </span>
            ) : null}
            {session.pinned ? (
              <span className="session-pin-indicator" title="Pinned" aria-label="Pinned session">
                <Pin size={14} />
              </span>
            ) : null}
            <SessionResourceIndicator usage={session.resourceUsage} />
            {session.initializing ? <LoadingStatusPill /> : <StatusPill status={statusPresentation.status} detail={statusDetail} />}
          </span>
        </div>
        <div className="preview">
          {session.runtimeUnavailableReason ? (
            <p className="preview-line session-startup-error" role="alert">{session.runtimeUnavailableReason}</p>
          ) : session.startupError ? (
            <p className="preview-line session-startup-error" role="alert">{session.startupError}</p>
          ) : previewLines.length > 0 ? (
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
          <span className="card-foot-events">
            <span className="session-size" title="Transcript size">
              <FileText size={13} /> {formatTranscriptSize(session.transcriptSize)}
            </span>
            {notificationRules.length > 0 ? (
              <span className="session-notification-indicator" title={`Notify: ${notificationRulesLabel(notificationRules)}`} aria-label={`Notify: ${notificationRulesLabel(notificationRules)}`}>
                <Bell size={13} />
              </span>
            ) : null}
            {workspace ? (
              <span
                className="git-workspace-status-indicator"
                data-state={workspace.state}
                title={`Git workspace: ${workspace.targetBranch} · ${workspace.state === "worktree" ? "isolated" : workspace.state}`}
                aria-label={`Git workspace: ${workspace.targetBranch} · ${workspace.state === "worktree" ? "isolated" : workspace.state}`}
              >
                <GitBranch size={14} />
              </span>
            ) : null}
          </span>
        </div>
      </button>
      {children.length > 0 ? (
        <details className="agent-session-tree" data-completed={allChildrenCompleted || undefined}>
          <summary>
            <span>{formatSessionCount(children.length, allChildrenCompleted ? "completed agent" : "agent")}</span>
            {allChildrenCompleted ? null : <span>{agentTreeStatusLabel(children)}</span>}
          </summary>
          <div className="agent-session-children">
            <AgentSessionRows parentSessionId={session.id} allSessions={children} depth={0} onOpen={onOpenChild} revealCompleted={allChildrenCompleted} />
          </div>
        </details>
      ) : null}
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

function SessionResourceIndicator({ usage }: { usage: ManagedSession["resourceUsage"] }) {
  if (
    !usage ||
    !Number.isFinite(usage.memoryCurrentBytes) ||
    !Number.isFinite(usage.memoryMaxBytes) ||
    usage.memoryCurrentBytes < 0 ||
    usage.memoryMaxBytes <= 0
  ) {
    return null;
  }
  const memoryPercent = Math.max(0, usage.memoryCurrentBytes / usage.memoryMaxBytes * 100);
  const fillPercent = Math.min(100, memoryPercent);
  const level = memoryPercent >= 85 ? "high" : memoryPercent >= 60 ? "medium" : "normal";
  const cpu = usage.cpuPercent === null
    ? "collecting sample"
    : `${formatResourcePercent(usage.cpuPercent)} of one core`;
  const memory = [
    `Memory: ${formatResourceBytes(usage.memoryCurrentBytes)} of ${formatResourceBytes(usage.memoryMaxBytes)} (${formatResourcePercent(memoryPercent)})`,
    Number.isFinite(usage.memoryHighBytes) && usage.memoryHighBytes > 0
      ? `soft limit ${formatResourceBytes(usage.memoryHighBytes)}`
      : null
  ].filter(Boolean).join(" · ");
  const label = [
    memory,
    `CPU: ${cpu} · limit ${formatResourcePercent(usage.cpuLimitPercent)}`
  ].join("\n");
  return (
    <span
      className="session-resource-indicator"
      data-level={level}
      role="meter"
      title={label}
      aria-label={label.replace("\n", ". ")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fillPercent * 10) / 10}
      style={{ "--session-memory-fill": `${fillPercent * 3.6}deg` } as CSSProperties}
    />
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
            <span title={group.branch ?? "no branch"}>
              {group.branch ?? "no branch"}
            </span>
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

export function groupSessionsByRepo(sessions: ManagedSession[]): RepoSessionGroup[] {
  const groups: RepoSessionGroup[] = [];
  const groupByKey = new Map<string, RepoSessionGroup>();

  for (const session of sessions) {
    if (session.agentOwnership && sessions.some((candidate) => candidate.id === session.agentOwnership?.parentSessionId)) continue;
    const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
    const repoRoot = workspace?.repoRoot || session.repo.root;
    const key = repoRoot ?? `name:${session.repo.name}`;
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        key,
        repoName: workspace?.repoRoot ? dashboardPathBaseName(workspace.repoRoot) : session.repo.name,
        repoRoot,
        branch: workspace?.targetBranch ?? session.repo.branch,
        dirty: workspace?.state === "worktree" || session.repo.dirty,
        sessions: []
      };
      groupByKey.set(key, group);
      groups.push(group);
    }

    group.dirty = group.dirty || workspace?.state === "worktree" || session.repo.dirty;
    group.sessions.push(session);
  }

  for (const group of groups) {
    group.sessions = orderSessionsWithinRepo(group.sessions);
  }

  return groups;
}

export function orderSessionsWithinRepo(sessions: ManagedSession[]): ManagedSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((first, second) => Number(second.session.pinned) - Number(first.session.pinned) || first.index - second.index)
    .map(({ session }) => session);
}

function dashboardPathBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
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

function formatSessionCount(count: number, label = "session"): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function agentSessionChildren(parentSessionId: string, sessions: ManagedSession[]): ManagedSession[] {
  return sessions.filter((session) => session.agentOwnership?.parentSessionId === parentSessionId);
}

function agentSessionDescendants(parentSessionId: string, sessions: ManagedSession[]): ManagedSession[] {
  const descendants: ManagedSession[] = [];
  const pending = [parentSessionId];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const child of agentSessionChildren(parent, sessions)) {
      if (descendants.some((candidate) => candidate.id === child.id)) continue;
      descendants.push(child);
      pending.push(child.id);
    }
  }
  return descendants;
}

function agentParentCandidates(session: ManagedSession, sessions: ManagedSession[]): ManagedSession[] {
  const excluded = new Set([session.id, ...agentSessionDescendants(session.id, sessions).map((candidate) => candidate.id)]);
  return sessions.filter((candidate) => !excluded.has(candidate.id) && !candidate.archived && candidate.status !== "missing");
}

function includeAgentAncestors(filtered: ManagedSession[], all: ManagedSession[]): ManagedSession[] {
  const included = new Map(filtered.map((session) => [session.id, session]));
  for (const session of filtered) {
    let current = session;
    const seen = new Set<string>();
    while (current.agentOwnership && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = all.find((candidate) => candidate.id === current.agentOwnership?.parentSessionId);
      if (!parent) break;
      included.set(parent.id, parent);
      current = parent;
    }
  }
  return all.filter((session) => included.has(session.id));
}

function AgentSessionRows({
  parentSessionId,
  allSessions,
  depth,
  onOpen,
  revealCompleted = false
}: {
  parentSessionId: string;
  allSessions: ManagedSession[];
  depth: number;
  onOpen: (sessionId: string) => void;
  revealCompleted?: boolean;
}) {
  const children = agentSessionChildren(parentSessionId, allSessions);
  const completedRoots: ManagedSession[] = [];
  const visibleChildren: ManagedSession[] = [];
  for (const child of children) {
    if (!revealCompleted && isCompletedAgentBranch(child, allSessions)) completedRoots.push(child);
    else visibleChildren.push(child);
  }
  const completedCount = completedRoots.reduce((count, child) => count + 1 + agentSessionDescendants(child.id, allSessions).length, 0);
  return (
    <>
      {visibleChildren.map((child) => (
        <AgentSessionRow key={child.id} session={child} allSessions={allSessions} depth={depth} onOpen={onOpen} revealCompleted={revealCompleted} />
      ))}
      {completedRoots.length > 0 ? (
        <details className="agent-session-completed">
          <summary>{formatSessionCount(completedCount, "completed agent")}</summary>
          <div className="agent-session-completed-children">
            {completedRoots.map((child) => (
              <AgentSessionRow key={child.id} session={child} allSessions={allSessions} depth={depth} onOpen={onOpen} revealCompleted />
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

function AgentSessionRow({ session, allSessions, depth, onOpen, revealCompleted }: { session: ManagedSession; allSessions: ManagedSession[]; depth: number; onOpen: (sessionId: string) => void; revealCompleted: boolean }) {
  const statusPresentation = sessionStatusPresentation(session, allSessions);
  const context = session.contextUsage ? `${Math.round(session.contextUsage.contextPercent)}% context` : "context pending";
  const ownership = session.agentOwnership;
  const workUsed = ownership && session.contextUsage ? Math.max(0, session.contextUsage.lifetimeWorkTokens - ownership.workTokenBaseline) : null;
  const budget = ownership && workUsed !== null ? `${Math.max(0, Math.round((ownership.workTokenBudget - workUsed) / 1000))}k budget` : "";
  return (
    <div className="agent-session-branch" style={{ "--agent-depth": depth } as CSSProperties}>
      <button className="agent-session-row" type="button" data-completed={statusPresentation.status === "completed" || undefined} onClick={() => onOpen(session.id)}>
        <span className="agent-session-row-name">{sessionDisplayName(session)}</span>
        <span className="agent-session-row-meta">{context}{budget ? ` · ${budget}` : ""}</span>
        {session.initializing ? <LoadingStatusPill /> : <StatusPill status={statusPresentation.status} />}
      </button>
      <AgentSessionRows parentSessionId={session.id} allSessions={allSessions} depth={depth + 1} onOpen={onOpen} revealCompleted={revealCompleted} />
    </div>
  );
}

function isCompletedAgentBranch(session: ManagedSession, allSessions: ManagedSession[]): boolean {
  return Boolean(session.agentOwnership?.completedAt) && !agentSessionDescendants(session.id, allSessions).some((descendant) => !descendant.agentOwnership?.completedAt);
}

function agentTreeStatusLabel(children: ManagedSession[]): string {
  const liveChildren = children.filter((session) => !session.agentOwnership?.completedAt);
  const urgent = liveChildren.filter((session) => isOperatorActionableAgentStatus(session.status)).length;
  if (urgent > 0) return `${urgent} need attention`;
  const working = liveChildren.filter((session) => ["working", "running", "planning", "executing", "generating"].includes(session.status)).length;
  if (working > 0) return `${working} working`;
  return liveChildren.length === 0 ? "all complete" : "quiet";
}

function formatTranscriptSize(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}

function formatResourceBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round(bytes / 1024 ** 3 * 10) / 10} GiB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MiB`;
}

function formatResourcePercent(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`;
}

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  return clampContextMenuPosition(x, y, { width: ACTION_MENU_WIDTH, height: ACTION_MENU_HEIGHT, edge: ACTION_MENU_EDGE });
}

function notificationSubmenuPosition(x: number, y: number): { x: number; y: number } {
  return submenuPosition({ x, y }, { parentWidth: ACTION_MENU_WIDTH, width: NOTIFICATION_MENU_WIDTH, height: 144, itemOffsetY: 96, edge: ACTION_MENU_EDGE });
}

function isNotificationTriggeredEvent(event: SessionEvent | { type: string }): event is SessionEvent & { payload: NotificationTriggeredPayload } {
  return event.type === "notification.triggered" && Boolean((event as { payload?: unknown }).payload);
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
