import { ArrowLeftRight, Bell, ChevronDown, ChevronRight, EllipsisVertical, FileText, GitBranch, GitFork, Pencil, Pin, PinOff, Plus, Search, Settings2, ShieldCheck, Skull, Zap } from "lucide-react";
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
  CodexUsageSummaryResponse,
  CodexModelCatalogResponse,
  ApprovalReviewerSettings,
  CollaborationMode,
  ManagedSession,
  NotificationRuleType,
  NotificationTriggeredPayload,
  SessionEvent,
  SessionDisplayStatus,
  SessionModelSelections
} from "@muxpilot/core";
import { SESSION_NAME_MAX_LENGTH, SESSION_NAME_MIN_LENGTH, isOperatorActionableAgentStatus, isValidSessionName, normalizeGitWorkspaceSummary, normalizeSessionName, normalizeSessionNameInput } from "@muxpilot/core";
import { api, notificationDeviceId } from "../api/client.js";
import type { AppShellOutletContext } from "./AppShell.js";
import { LoadingStatusPill, StatusPill } from "../components/StatusPill.js";
import { ContextMenu, ContextMenuItem, clampContextMenuPosition, submenuPosition, useContextMenuTrigger, useDismissableContextMenu } from "../components/ContextMenu.js";
import { NotificationRuleMenu } from "../components/NotificationRuleMenu.js";
import { DashboardSessionsSkeleton, UsagePanelSkeleton } from "../components/LoadingSkeleton.js";
import { Modal } from "../components/Modal.js";
import { ModelSettingsDrawer } from "../components/ModelSettingsDrawer.js";
import { Button, DialogActions } from "../components/Button.js";
import { CodexUsagePanel } from "../components/CodexUsagePanel.js";
import { noAutofillTextField, searchField } from "../utils/formFields.js";
import { sessionBaseName, sessionDisplayName } from "../utils/sessionLabels.js";
import { notificationRulesLabel, sessionNotificationRules } from "../utils/notifications.js";
import {
  sessionStatusPresentation,
  sessionStatusSeverity,
  type SessionStatusSeverity
} from "../utils/sessionStatus.js";

export { CodexUsagePanel };

const ACTION_MENU_WIDTH = 220;
const ACTION_MENU_HEIGHT = 312;
const NOTIFICATION_MENU_WIDTH = 220;
const NOTIFICATION_RING_MS = 2800;
const ACTION_MENU_EDGE = 8;
const DASHBOARD_COLLAPSED_REPOS_STORAGE_KEY = "muxpilot.dashboard.collapsed-repos.v1";
export const DASHBOARD_USAGE_RECONCILE_INTERVAL_MS = 60_000;
export const DASHBOARD_SEARCH_DEBOUNCE_MS = 150;
export const DASHBOARD_STATUSES = ["", "working", "running", "planning", "queued", "waiting", "question", "plan_ready", "approval", "blocked", "input_failed", "startup_failed", "unknown", "missing", "completed"];
export const SESSION_NAME_VALIDATION_MESSAGE = "Name must be a 2-32 character Git-style name.";

export type DashboardStatusFilter =
  | { kind: "all"; selectValue: "" }
  | { kind: "status"; status: SessionDisplayStatus; selectValue: string }
  | { kind: "severity"; severity: SessionStatusSeverity; selectValue: `severity:${SessionStatusSeverity}` };

export function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessions: shellSessions, sessionsLoaded, sessionsLoadError, retrySessions, subscribeSessionEvents, refreshSessionStoplight, syncSessionStoplight, openCreateSession, openSessionTransfer, openForkSession, notificationSettings, setNotificationSettings, registerPrimaryInputFocus, sessionStoplightSeverity, accessMode } =
    useOutletContext<AppShellOutletContext>();
  const [searchParams] = useSearchParams();
  const [codexUsageSummary, setCodexUsageSummary] = useState<CodexUsageSummaryResponse | null>(null);
  const [codexUsageSummaryInitialLoading, setCodexUsageSummaryInitialLoading] = useState(true);
  const [q, setQ] = useState("");
  const [serverSearch, setServerSearch] = useState<{ query: string; sessions: ManagedSession[] } | null>(null);
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
  const [reviewerSettingsOpen, setReviewerSettingsOpen] = useState(false);
  const [reviewerSettings, setReviewerSettings] = useState<ApprovalReviewerSettings | null>(null);
  const [reviewerSettingsBusy, setReviewerSettingsBusy] = useState(false);
  const [reviewerSettingsError, setReviewerSettingsError] = useState("");
  const [modelDefaultsOpen, setModelDefaultsOpen] = useState(false);
  const [modelDefaultsCatalog, setModelDefaultsCatalog] = useState<CodexModelCatalogResponse | null>(null);
  const [modelDefaults, setModelDefaults] = useState<SessionModelSelections | null>(null);
  const [modelDefaultsLoading, setModelDefaultsLoading] = useState(false);
  const [modelDefaultsApplying, setModelDefaultsApplying] = useState<CollaborationMode | null>(null);
  const [modelDefaultsError, setModelDefaultsError] = useState("");
  const [collapsedRepoKeys, setCollapsedRepoKeys] = useState<Set<string>>(() => new Set(loadStoredCollapsedRepoKeys()));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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

  const normalizedQuery = q.trim();
  const searchBase = useMemo(() => {
    if (!normalizedQuery || serverSearch?.query !== normalizedQuery) return shellSessions;
    const latestById = new Map(shellSessions.map((session) => [session.id, session]));
    return serverSearch.sessions.map((session) => latestById.get(session.id) ?? session);
  }, [normalizedQuery, serverSearch, shellSessions]);
  const sessions = useMemo(() => {
    const matched = normalizedQuery && serverSearch?.query !== normalizedQuery
      ? filterSessionsByDashboardQuery(searchBase, normalizedQuery)
      : searchBase;
    return includeAgentAncestors(
      removeSessionsFromDashboard(filterSessionsByDashboardStatus(matched, statusFilter), optimisticallyRemovedSessionIds),
      shellSessions
    );
  }, [normalizedQuery, optimisticallyRemovedSessionIds, searchBase, serverSearch?.query, shellSessions, statusFilter]);

  useEffect(() => {
    if (!normalizedQuery) {
      setServerSearch(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.sessionSummaries(normalizedQuery).then((response) => {
        if (!cancelled) setServerSearch({ query: normalizedQuery, sessions: response.sessions });
      }).catch(() => undefined);
    }, DASHBOARD_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [normalizedQuery]);

  const loadCodexUsageSummary = useCallback(async (refresh = false) => {
    const requestId = ++codexUsageRequestIdRef.current;
    try {
      const summary = await api.codexUsageSummary(refresh);
      if (requestId === codexUsageRequestIdRef.current) setCodexUsageSummary(summary);
    } finally {
      if (requestId === codexUsageRequestIdRef.current) setCodexUsageSummaryInitialLoading(false);
    }
  }, []);

  const acceptCodexUsageSummary = useCallback((summary: CodexUsageSummaryResponse) => {
    codexUsageRequestIdRef.current += 1;
    setCodexUsageSummary(summary);
    setCodexUsageSummaryInitialLoading(false);
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
    void loadCodexUsageSummary().catch(() => undefined);
    const interval = setInterval(() => {
      void loadCodexUsageSummary().catch(() => undefined);
    }, DASHBOARD_USAGE_RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadCodexUsageSummary]);

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

  async function killSession(session: ManagedSession) {
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
      setActionError(error instanceof Error ? error.message : "Could not end session.");
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

  async function loadModelDefaults() {
    setModelDefaultsLoading(true);
    setModelDefaultsError("");
    try {
      const [catalog, response] = await Promise.all([api.codexModels(), api.globalModelSettings()]);
      setModelDefaultsCatalog(catalog);
      setModelDefaults(response.settings);
    } catch (error) {
      setModelDefaultsError(error instanceof Error ? error.message : "Could not load model defaults.");
    } finally {
      setModelDefaultsLoading(false);
    }
  }

  function openModelDefaults() {
    setModelDefaultsOpen(true);
    void loadModelDefaults();
  }

  async function openReviewerSettings() {
    setReviewerSettingsOpen(true);
    setReviewerSettingsBusy(true);
    setReviewerSettingsError("");
    try {
      const [catalog, response] = await Promise.all([api.codexModels(), api.approvalReviewerSettings()]);
      setModelDefaultsCatalog(catalog);
      setReviewerSettings(response.settings);
    } catch (error) {
      setReviewerSettingsError(error instanceof Error ? error.message : "Could not load approval reviewer settings.");
    } finally {
      setReviewerSettingsBusy(false);
    }
  }

  async function saveReviewerSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewerSettings) return;
    setReviewerSettingsBusy(true);
    setReviewerSettingsError("");
    try {
      const response = await api.updateApprovalReviewerSettings(reviewerSettings);
      setReviewerSettings(response.settings);
      setReviewerSettingsOpen(false);
    } catch (error) {
      setReviewerSettingsError(error instanceof Error ? error.message : "Could not update approval reviewer settings.");
    } finally {
      setReviewerSettingsBusy(false);
    }
  }

  async function applyModelDefault(mode: CollaborationMode, model: string, reasoningEffort: string | null): Promise<void> {
    setModelDefaultsApplying(mode);
    setModelDefaultsError("");
    try {
      const response = await api.updateGlobalModelSettings({ mode, model, reasoningEffort });
      setModelDefaults(response.settings);
    } catch (error) {
      setModelDefaultsError(error instanceof Error ? error.message : "Could not update model defaults.");
    } finally {
      setModelDefaultsApplying(null);
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
          onOpenModelDefaults={openModelDefaults}
          onOpenReviewerSettings={() => void openReviewerSettings()}
          onOpenSessionTransfer={openSessionTransfer}
          onNewSession={() => openCreateSession()}
        />
      </div>

      <ModelSettingsDrawer
        open={modelDefaultsOpen}
        title="Default model settings"
        description="Choose the model and reasoning effort inherited by new sessions, then apply it to the Normal or Plan default."
        selections={modelDefaults ?? modelDefaultsCatalog?.defaults ?? emptyModelSelections}
        activeMode={null}
        catalog={modelDefaultsCatalog}
        loading={modelDefaultsLoading}
        error={modelDefaultsError}
        applying={modelDefaultsApplying}
        onClose={() => setModelDefaultsOpen(false)}
        onRetry={() => void loadModelDefaults()}
        onApply={applyModelDefault}
      />

      <Modal
        open={reviewerSettingsOpen}
        onClose={() => setReviewerSettingsOpen(false)}
        title="Auto approval reviewer"
        panelClassName="session-name-dialog"
        as="form"
        onSubmit={saveReviewerSettings}
        dismissible={!reviewerSettingsBusy}
      >
        <p className="dialog-help">Choose the Codex model used to review requests from sessions in Auto approval mode.</p>
        <label className="rename-field">
          <span>Reviewer model</span>
          <select
            autoFocus
            value={reviewerSettings?.model ?? ""}
            disabled={reviewerSettingsBusy}
            onChange={(event) => {
              const model = modelDefaultsCatalog?.models.find((candidate) => candidate.model === event.currentTarget.value);
              setReviewerSettings({ model: event.currentTarget.value, reasoningEffort: model?.defaultReasoningEffort ?? null });
            }}
          >
            {(modelDefaultsCatalog?.models ?? []).map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
          </select>
        </label>
        <label className="rename-field">
          <span>Reasoning effort</span>
          <select
            value={reviewerSettings?.reasoningEffort ?? ""}
            disabled={reviewerSettingsBusy}
            onChange={(event) => setReviewerSettings((current) => current ? { ...current, reasoningEffort: event.currentTarget.value || null } : current)}
          >
            {(modelDefaultsCatalog?.models.find((model) => model.model === reviewerSettings?.model)?.supportedReasoningEfforts ?? [])
              .map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
          </select>
        </label>
        {reviewerSettingsError ? <p className="dialog-error" role="alert">{reviewerSettingsError}</p> : null}
        <DialogActions>
          <Button variant="ghost" onClick={() => setReviewerSettingsOpen(false)} disabled={reviewerSettingsBusy}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!reviewerSettings || reviewerSettingsBusy} busy={reviewerSettingsBusy}>Save</Button>
        </DialogActions>
      </Modal>

      {actionError && !renameSession && !agentParentSession ? (
        <p className="dashboard-action-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="repo-session-groups">
        {sessionsLoadError ? (
          <div className="dashboard-session-load-error" role="alert">
            <span>{sessionsLoadError}</span>
            <Button size="small" onClick={() => void retrySessions()}>Retry</Button>
          </div>
        ) : null}
        {!sessionsLoaded && !sessionsLoadError ? <DashboardSessionsSkeleton /> : sessionGroups.map((group) => {
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
                    const previewLines = dashboardPreviewLines(session);

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
            onClick={() => void killSession(menu.session)}
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
            <DialogActions>
              <Button variant="ghost" onClick={closeRename} disabled={Boolean(busyAction)}>Cancel</Button>
              <Button
                variant="primary"
                type="submit"
                disabled={Boolean(busyAction) || renameNameInvalid}
                busy={busyAction?.sessionId === renameSession.id && busyAction.type === "rename"}
                busyLabel="Renaming"
              >
                Rename
              </Button>
            </DialogActions>
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
          <DialogActions>
            <Button variant="ghost" onClick={closeAgentParent} disabled={Boolean(busyAction)}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={Boolean(busyAction)}
              busy={busyAction?.sessionId === agentParentSession.id && busyAction.type === "agentParent"}
              busyLabel="Saving"
            >
              Save
            </Button>
          </DialogActions>
        </Modal>
      ) : null}

      <div className="dashboard-usage-separator" aria-hidden="true" />
      {codexUsageSummaryInitialLoading && !codexUsageSummary ? (
        <UsagePanelSkeleton />
      ) : codexUsageSummary ? (
        <CodexUsagePanel
          summary={codexUsageSummary}
          onSummaryChange={acceptCodexUsageSummary}
          onRefreshSummary={() => loadCodexUsageSummary(true)}
        />
      ) : (
        <UsageUnavailablePanel title="Codex usage" />
      )}
    </section>
  );
}

export function DashboardPrimaryActions({
  showTransfer,
  onOpenModelDefaults,
  onOpenReviewerSettings,
  onOpenSessionTransfer,
  onNewSession
}: {
  showTransfer: boolean;
  onOpenModelDefaults: () => void;
  onOpenReviewerSettings: () => void;
  onOpenSessionTransfer: () => void;
  onNewSession: () => void;
}) {
  return (
    <div className="dashboard-primary-actions">
      <button className="dashboard-model-defaults-button" type="button" onClick={onOpenModelDefaults} aria-label="Default model settings" title="Default model settings">
        <Settings2 size={17} />
        <span className="dashboard-model-defaults-button-label">Model defaults</span>
      </button>
      <button className="dashboard-model-defaults-button" type="button" onClick={onOpenReviewerSettings} aria-label="Auto approval reviewer settings" title="Auto approval reviewer settings">
        <ShieldCheck size={17} />
        <span className="dashboard-model-defaults-button-label">Approval reviewer</span>
      </button>
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

const emptyModelSelections: SessionModelSelections = {
  default: { model: null, reasoningEffort: null },
  plan: { model: null, reasoningEffort: null }
};

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
  session: Pick<ManagedSession, "recentUserPrompts">
): string[] {
  return session.recentUserPrompts.slice(0, 2);
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
    sessionBaseName(session),
    session.repo.name,
    session.repo.branch,
    session.preview,
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
              <p className="preview-line" key={`${session.id}-preview-${index}`}>
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
