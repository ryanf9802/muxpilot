import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeftRight, Bell, Check, ChevronRight, Copy, Download, Eye, EyeOff, History, Info, LoaderCircle, LogOut, Play, RotateCcw, Search, Settings, Smartphone, Trash2, Upload } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { ToastContainer, toast } from "react-toastify";
import { AUTH_EXPIRED_EVENT, ApiError, api, eventSocket, isUnauthorizedError, notificationDeviceId } from "../api/client.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type {
  AccessMode,
  CreateSessionRequest,
  GitRepositoryProbe,
  ManagedSession,
  MeResponse,
  MuxpilotGitSkillStatus,
  NotificationRuleType,
  NotificationSettings,
  NotificationTriggeredPayload,
  PromptHistoryResult,
  RemoteAccessResponse,
  SessionDirectorySuggestion,
  SessionEvent,
  SessionHistoryResult,
  SessionTransferImportResponse,
  SessionTransferInspectResponse
} from "@muxpilot/core";
import { SESSION_NAME_MAX_LENGTH, SESSION_NAME_MIN_LENGTH, isValidSessionName, normalizeSessionName, normalizeSessionNameInput, sessionHistoryIdentity } from "@muxpilot/core";
import { installCtrlWGuard } from "../utils/ctrlW.js";
import { credentialSuppressedField, noAutofillTextField, searchField } from "../utils/formFields.js";
import { directorySuggestionLabel } from "../utils/sessionDirectories.js";
import {
  SESSION_STATUS_EVENT_DEBOUNCE_MS,
  SESSION_STATUS_RECONCILE_INTERVAL_MS,
  countSessionStatuses,
  shouldRefreshSessionsForEvent,
  type SessionStoplightCounts,
  type SessionStatusSeverity
} from "../utils/sessionStatus.js";
import { NotificationRuleMenu } from "../components/NotificationRuleMenu.js";
import { AppBrand } from "../components/AppBrand.js";
import { AppLoadingSkeleton, loadingSkeletonVariantForPath } from "../components/LoadingSkeleton.js";
import { Modal } from "../components/Modal.js";
import {
  attemptConnectionAutoReload,
  clearConnectionAutoReload,
  installForegroundRecoveryListeners,
  requestWithTimeout
} from "../utils/connectionRecovery.js";
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuItem, ContextMenuSeparator, dropdownMenuPosition, submenuPosition, useDismissableContextMenu } from "../components/ContextMenu.js";
import {
  disablePushSubscription,
  ensurePushSubscription,
  globalNotificationRules,
  isPushNotificationAvailable,
  notificationPushEnabled,
  notificationSoundEnabled,
  notificationToastMessage,
  playNotificationBell
} from "../utils/notifications.js";

export type ShellConnectionState = "checking" | "connected" | "disconnected" | "unauthorized";
export const SHELL_RECONNECT_INTERVAL_MS = 2000;
export const SHELL_CONNECTION_PROBE_TIMEOUT_MS = 5000;
export const SESSION_NAME_VALIDATION_MESSAGE = "Name must be a 2-32 character Git-style name.";
const GLOBAL_NOTIFICATION_MENU_WIDTH = 220;
const GLOBAL_NOTIFICATION_MENU_HEIGHT = 230;
const GLOBAL_NOTIFICATION_SETTINGS_MENU_HEIGHT = 96;
const GLOBAL_NOTIFICATION_SETTINGS_MENU_OFFSET_Y = 145;
const MENU_EDGE = 8;
export type PrimaryInputFocusCommand = "focus" | "insert" | "insertStart" | "append" | "appendEnd";
type PrimaryInputFocusHandler = (command: PrimaryInputFocusCommand) => boolean | void;

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [connectionState, setConnectionState] = useState<ShellConnectionState>("checking");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [sessionTransferOpen, setSessionTransferOpen] = useState(false);
  const [showConnectButton, setShowConnectButton] = useState(false);
  const [showLogoutButton, setShowLogoutButton] = useState(true);
  const [accessMode, setAccessMode] = useState<AccessMode | null>(null);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [createSessionCwd, setCreateSessionCwd] = useState("");
  const [createSessionName, setCreateSessionName] = useState("");
  const [createSessionGitProbe, setCreateSessionGitProbe] = useState<GitRepositoryProbe | null>(null);
  const [createSessionGitProbeBusy, setCreateSessionGitProbeBusy] = useState(false);
  const [createSessionTargetBranch, setCreateSessionTargetBranch] = useState("");
  const [gitSkillStatus, setGitSkillStatus] = useState<MuxpilotGitSkillStatus["status"] | "checking" | "error" | null>(null);
  const [createSessionBusy, setCreateSessionBusy] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);
  const [createSessionTab, setCreateSessionTab] = useState<"create" | "history">("create");
  const [createSessionDirectoryFocused, setCreateSessionDirectoryFocused] = useState(false);
  const [createSessionDirectorySelectedIndex, setCreateSessionDirectorySelectedIndex] = useState(0);
  const [createSessionNameAutofocus, setCreateSessionNameAutofocus] = useState(false);
  const [sessionHistoryQuery, setSessionHistoryQuery] = useState("");
  const [sessionHistoryResults, setSessionHistoryResults] = useState<SessionHistoryResult[]>([]);
  const [sessionHistorySelectedIndex, setSessionHistorySelectedIndex] = useState(0);
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  const [sessionHistoryError, setSessionHistoryError] = useState("");
  const [sessionHistoryRestoreId, setSessionHistoryRestoreId] = useState<string | null>(null);
  const [serverDirectorySuggestions, setServerDirectorySuggestions] = useState<SessionDirectorySuggestion[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [sessionStoplightSeverity, setSessionStoplightSeverity] = useState<SessionStatusSeverity | null>(null);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null);
  const [notificationMenu, setNotificationMenu] = useState<{ x: number; y: number } | null>(null);
  const [notificationSettingsSubmenuOpen, setNotificationSettingsSubmenuOpen] = useState(false);
  const [notificationToggleBusy, setNotificationToggleBusy] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [shellSocketEpoch, setShellSocketEpoch] = useState(0);
  const [promptHistoryOpen, setPromptHistoryOpen] = useState(false);
  const [promptHistoryInitialQuery, setPromptHistoryInitialQuery] = useState("");
  const [promptHistoryRequestKey, setPromptHistoryRequestKey] = useState(0);
  const sessionRequestIdRef = useRef(0);
  const connectionStateRef = useRef<ShellConnectionState>("checking");
  const locationPathRef = useRef(location.pathname);
  const notificationSettingsRef = useRef<NotificationSettings | null>(null);
  const notificationMenuRef = useRef<HTMLDivElement | null>(null);
  const directorySuggestionRefs = useRef(new Map<string, HTMLButtonElement>());
  const promptHistoryPrefillRef = useRef<() => string>(() => "");
  const createSessionCwdPrefillRef = useRef<() => string>(() => "");
  const primaryInputFocusRef = useRef<PrimaryInputFocusHandler>(() => false);
  const sessionHistoryRequestIdRef = useRef(0);
  const connectionProbeRef = useRef<{
    controller: AbortController;
    promise: Promise<boolean>;
  } | null>(null);
  const connectionProbeFailureCountRef = useRef(0);

  useEffect(() => installCtrlWGuard(), []);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    locationPathRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings;
  }, [notificationSettings]);

  const markUnauthorized = useCallback(() => {
    setConnectionState("unauthorized");
    navigate("/access", { replace: true });
  }, [navigate]);

  const markDisconnected = useCallback((error?: unknown) => {
    if (isUnauthorizedError(error)) {
      markUnauthorized();
      return;
    }
    setConnectionState("disconnected");
  }, [markUnauthorized]);

  const applyMe = useCallback((me: MeResponse) => {
    connectionProbeFailureCountRef.current = 0;
    clearConnectionAutoReload(() => window.sessionStorage);
    if (!me.accessGranted) {
      markUnauthorized();
      return;
    }
    const wasDisconnected = connectionStateRef.current === "disconnected";
    setConnectionState("connected");
    setAccessMode(me.accessMode);
    setShowConnectButton(shouldShowConnectDeviceButton(me));
    setShowLogoutButton(shouldShowLogoutButton(me));
    if (wasDisconnected) setConnectionEpoch((epoch) => epoch + 1);
  }, [markUnauthorized]);

  const probeShellConnection = useCallback((supersede = false): Promise<boolean> => {
    const activeProbe = connectionProbeRef.current;
    if (activeProbe && !supersede) return activeProbe.promise;
    if (activeProbe) {
      connectionProbeRef.current = null;
      activeProbe.controller.abort();
    }

    const controller = new AbortController();
    const probe: { controller: AbortController; promise: Promise<boolean> } = {
      controller,
      promise: Promise.resolve(false)
    };
    probe.promise = requestWithTimeout((signal) => api.me(signal), SHELL_CONNECTION_PROBE_TIMEOUT_MS, controller)
      .then((me) => {
        if (connectionProbeRef.current !== probe) return false;
        applyMe(me);
        return me.accessGranted;
      })
      .catch((error) => {
        if (connectionProbeRef.current !== probe) return false;
        markDisconnected(error);
        connectionProbeFailureCountRef.current += 1;
        attemptConnectionAutoReload(connectionProbeFailureCountRef.current, {
          visibilityState: document.visibilityState,
          online: navigator.onLine,
          storage: () => window.sessionStorage,
          reload: () => window.location.reload()
        });
        return false;
      })
      .finally(() => {
        if (connectionProbeRef.current === probe) connectionProbeRef.current = null;
      });
    connectionProbeRef.current = probe;
    return probe.promise;
  }, [applyMe, markDisconnected]);

  const handleConnectedRequestFailure = useCallback((error: unknown) => {
    if (isUnauthorizedError(error)) {
      markUnauthorized();
      return;
    }
    if (!shouldProbeShellConnection(error)) return;
    void probeShellConnection();
  }, [markUnauthorized, probeShellConnection]);

  useEffect(() => {
    const handleAuthExpired = () => markUnauthorized();
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [markUnauthorized]);

  const loadSessions = useCallback(async () => {
    const requestId = ++sessionRequestIdRef.current;
    const sessionResponse = await api.sessions();
    if (requestId === sessionRequestIdRef.current) setSessions(sessionResponse.sessions);
  }, []);

  const loadNotificationSettings = useCallback(async () => {
    setNotificationSettings(await api.notificationSettings());
  }, []);

  const syncSessionStoplight = useCallback((session: ManagedSession) => {
    setSessions((currentSessions) => syncSessionIntoStoplightSessions(currentSessions, session));
  }, []);

  useEffect(() => {
    void probeShellConnection(true);
    return () => {
      const activeProbe = connectionProbeRef.current;
      connectionProbeRef.current = null;
      activeProbe?.controller.abort();
    };
  }, [probeShellConnection]);

  useEffect(() => installForegroundRecoveryListeners(() => {
    if (connectionStateRef.current === "connected") {
      setConnectionEpoch((epoch) => epoch + 1);
      setShellSocketEpoch((epoch) => epoch + 1);
    }
    void probeShellConnection(true);
  }), [probeShellConnection]);

  useEffect(() => {
    if (connectionState !== "connected") return undefined;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadSessions().catch(handleConnectedRequestFailure);
      }, SESSION_STATUS_EVENT_DEBOUNCE_MS);
    };

    void loadSessions().catch(handleConnectedRequestFailure);
    void loadNotificationSettings().catch(() => undefined);
    const interval = setInterval(() => void loadSessions().catch(handleConnectedRequestFailure), SESSION_STATUS_RECONCILE_INTERVAL_MS);
    const socket = eventSocket();
    let closing = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const reconnectSockets = () => {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closing) return;
        setConnectionEpoch((epoch) => epoch + 1);
        setShellSocketEpoch((epoch) => epoch + 1);
      }, SHELL_RECONNECT_INTERVAL_MS);
    };
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionEvent | { type: string };
      if (isNotificationTriggeredEvent(event)) {
        if (notificationSoundEnabled(notificationSettingsRef.current)) playNotificationBell();
        const message = notificationToastMessage(event.payload);
        toast(message, {
          position: locationPathRef.current.startsWith("/sessions/") ? "top-right" : "top-left",
          type: toastTypeForNotification(event.payload),
          className: "session-notification-toast",
          ariaLabel: `${message}. Open chat session`,
          onClick: () => navigate(event.payload.url)
        });
      }
      if (shouldRefreshSessionsForEvent(event)) scheduleLoad();
    };
    socket.onclose = () => {
      if (closing) return;
      reconnectSockets();
      void probeShellConnection();
    };
    return () => {
      closing = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(interval);
      socket.close();
    };
  }, [connectionState, handleConnectedRequestFailure, loadNotificationSettings, loadSessions, navigate, probeShellConnection, shellSocketEpoch]);

  useEffect(() => {
    if (connectionState !== "disconnected") return undefined;

    const poll = () => void probeShellConnection();
    poll();
    const interval = setInterval(poll, SHELL_RECONNECT_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [connectionState, probeShellConnection]);

  useEffect(() => {
    if (!createSessionOpen) return;
    let cancelled = false;
    setServerDirectorySuggestions([]);
    api
      .sessionDirectories()
      .then((response) => {
        if (!cancelled) setServerDirectorySuggestions(response.directories);
      })
      .catch(() => {
        if (!cancelled) setServerDirectorySuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [createSessionOpen]);

  useEffect(() => {
    if (!createSessionOpen || createSessionTab !== "create" || !createSessionCwd.trim()) {
      setCreateSessionGitProbe(null);
      setCreateSessionGitProbeBusy(false);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCreateSessionGitProbeBusy(true);
      void api.gitRepositoryProbe(createSessionCwd.trim()).then((probe) => {
        if (cancelled) return;
        setCreateSessionGitProbe(probe);
        const target = probe.currentBranch && probe.localBranches.includes(probe.currentBranch)
          ? probe.currentBranch
          : probe.localBranches[0] ?? "";
        setCreateSessionTargetBranch(target);
      }).catch(() => {
        if (!cancelled) setCreateSessionGitProbe(null);
      }).finally(() => {
        if (!cancelled) setCreateSessionGitProbeBusy(false);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [createSessionCwd, createSessionOpen, createSessionTab]);

  useEffect(() => {
    if (!createSessionOpen || !createSessionGitProbe?.isGit) {
      setGitSkillStatus(null);
      return undefined;
    }
    let cancelled = false;
    setGitSkillStatus("checking");
    void api.gitWorkflowSkillStatus().then((status) => {
      if (!cancelled) setGitSkillStatus(status.status);
    }).catch(() => {
      if (!cancelled) setGitSkillStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [createSessionGitProbe?.isGit, createSessionGitProbe?.repoRoot, createSessionOpen]);

  useEffect(() => {
    if (!createSessionOpen || createSessionTab !== "history") return undefined;
    const requestId = ++sessionHistoryRequestIdRef.current;
    setSessionHistoryLoading(true);
    setSessionHistoryError("");
    const timer = window.setTimeout(() => {
      api
        .sessionHistory(sessionHistoryQuery)
        .then((response) => {
          if (requestId !== sessionHistoryRequestIdRef.current) return;
          setSessionHistoryResults(response.results);
          setSessionHistorySelectedIndex(0);
        })
        .catch(() => {
          if (requestId !== sessionHistoryRequestIdRef.current) return;
          setSessionHistoryResults([]);
          setSessionHistoryError("Could not load session history.");
        })
        .finally(() => {
          if (requestId === sessionHistoryRequestIdRef.current) setSessionHistoryLoading(false);
        });
    }, 80);
    return () => {
      window.clearTimeout(timer);
    };
  }, [createSessionOpen, createSessionTab, sessionHistoryQuery]);

  useDismissableContextMenu(Boolean(notificationMenu), notificationMenuRef, () => {
    setNotificationMenu(null);
    setNotificationSettingsSubmenuOpen(false);
  });

  const stoplightCounts = useMemo(() => countSessionStatuses(sessions), [sessions]);
  const directorySuggestions = serverDirectorySuggestions;
  const createSessionNameWarning = createSessionOpen ? sessionNameValidationMessage(createSessionName) : null;
  const createSessionNameInvalid = createSessionOpen && !isValidSessionName(normalizeSessionName(createSessionName));
  const gitWorkspaceFieldsAvailable = gitSkillStatus === "current";
  const visibleDirectorySuggestions = useMemo(
    () => filterSessionDirectorySuggestions(directorySuggestions, createSessionCwd),
    [createSessionCwd, directorySuggestions]
  );
  const showDirectorySuggestions = createSessionOpen && createSessionDirectoryFocused && visibleDirectorySuggestions.length > 0;
  const activeDirectorySuggestionId = showDirectorySuggestions ? sessionDirectorySuggestionOptionId(visibleDirectorySuggestions[createSessionDirectorySelectedIndex]?.path) : undefined;
  const contentClassName = location.pathname.startsWith("/sessions/") ? "content content-session" : "content";
  const activeStoplightSeverity = location.pathname === "/" ? sessionStoplightSeverity : null;

  useEffect(() => {
    if (location.pathname !== "/") setSessionStoplightSeverity(null);
  }, [location.pathname]);

  useEffect(() => {
    if (!showDirectorySuggestions) {
      setCreateSessionDirectorySelectedIndex(0);
      return;
    }
    setCreateSessionDirectorySelectedIndex((index) => Math.min(index, visibleDirectorySuggestions.length - 1));
  }, [showDirectorySuggestions, visibleDirectorySuggestions.length]);

  useEffect(() => {
    if (!showDirectorySuggestions) return;
    const path = visibleDirectorySuggestions[createSessionDirectorySelectedIndex]?.path;
    if (!path) return;
    directorySuggestionRefs.current.get(path)?.scrollIntoView({ block: "nearest" });
  }, [createSessionDirectorySelectedIndex, showDirectorySuggestions, visibleDirectorySuggestions]);

  const openCreateSession = useCallback((cwd = "") => {
    const hasPrefilledCwd = cwd.trim().length > 0;
    setCreateSessionOpen(true);
    setCreateSessionTab("create");
    setCreateSessionCwd(cwd);
    setCreateSessionName("");
    setCreateSessionGitProbe(null);
    setCreateSessionTargetBranch("");
    setGitSkillStatus(null);
    setCreateSessionError(null);
    setCreateSessionDirectoryFocused(!hasPrefilledCwd);
    setCreateSessionDirectorySelectedIndex(0);
    setCreateSessionNameAutofocus(hasPrefilledCwd);
  }, []);

  useEffect(() => {
    if (connectionState !== "connected") return undefined;
    const handleNewSessionShortcut = (event: globalThis.KeyboardEvent) => {
      if (!isNewSessionShortcut(event)) return;
      event.preventDefault();
      if (createSessionOpen || connectOpen || promptHistoryOpen) return;
      let cwd = "";
      try {
        cwd = createSessionCwdPrefillRef.current();
      } catch {
        cwd = "";
      }
      openCreateSession(cwd);
    };
    document.addEventListener("keydown", handleNewSessionShortcut);
    return () => document.removeEventListener("keydown", handleNewSessionShortcut);
  }, [connectionState, connectOpen, createSessionOpen, openCreateSession, promptHistoryOpen]);

  const registerCreateSessionCwdPrefill = useCallback((provider: () => string) => {
    createSessionCwdPrefillRef.current = provider;
    return () => {
      if (createSessionCwdPrefillRef.current === provider) createSessionCwdPrefillRef.current = () => "";
    };
  }, []);

  const registerPromptHistoryPrefill = useCallback((provider: () => string) => {
    promptHistoryPrefillRef.current = provider;
    return () => {
      if (promptHistoryPrefillRef.current === provider) promptHistoryPrefillRef.current = () => "";
    };
  }, []);

  const registerPrimaryInputFocus = useCallback((provider: PrimaryInputFocusHandler) => {
    primaryInputFocusRef.current = provider;
    return () => {
      if (primaryInputFocusRef.current === provider) primaryInputFocusRef.current = () => false;
    };
  }, []);

  useEffect(() => {
    if (connectionState !== "connected") return undefined;
    const handlePrimaryInputFocusShortcut = (event: globalThis.KeyboardEvent) => {
      const command = primaryInputFocusCommandForShortcut(event);
      if (!command || !shouldHandlePrimaryInputFocusShortcut(event, document)) return;
      const handled = primaryInputFocusRef.current(command);
      if (handled === false) return;
      event.preventDefault();
    };
    document.addEventListener("keydown", handlePrimaryInputFocusShortcut);
    return () => document.removeEventListener("keydown", handlePrimaryInputFocusShortcut);
  }, [connectionState]);

  const openPromptHistory = useCallback(() => {
    let initialQuery = "";
    try {
      initialQuery = promptHistoryPrefillRef.current();
    } catch {
      initialQuery = "";
    }
    setPromptHistoryInitialQuery(initialQuery);
    setPromptHistoryRequestKey((key) => key + 1);
    setPromptHistoryOpen(true);
  }, []);

  useEffect(() => {
    if (connectionState !== "connected") return undefined;
    const handlePromptHistoryShortcut = (event: globalThis.KeyboardEvent) => {
      if (!isPromptHistoryShortcut(event)) return;
      event.preventDefault();
      if (createSessionOpen || connectOpen) return;
      openPromptHistory();
    };
    document.addEventListener("keydown", handlePromptHistoryShortcut);
    return () => document.removeEventListener("keydown", handlePromptHistoryShortcut);
  }, [connectionState, connectOpen, createSessionOpen, openPromptHistory]);

  if (connectionState === "checking") {
    return <AppLoadingSkeleton variant={loadingSkeletonVariantForPath(location.pathname)} />;
  }
  if (connectionState === "unauthorized") return null;
  if (connectionState === "disconnected") {
    return (
      <div className="app">
        <header className="topbar">
          <AppBrand />
          <div />
          <div className="topbar-actions" />
        </header>
        <main className="content recovery-content">
          <AppRecoveryPage
            role="status"
            title="Cannot reach muxpilot"
            message="The app is open, but the backend is not responding. Keep this page open while muxpilot reconnects."
            detail="This can happen after the server restarts or when an installed PWA wakes with a stale network connection. Muxpilot will retry automatically."
            actionLabel="Reload app"
            onAction={() => window.location.reload()}
          />
        </main>
      </div>
    );
  }

  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await api.logout();
      navigate("/access", { replace: true });
    } finally {
      setLogoutBusy(false);
    }
  }

  function closeCreateSession() {
    if (createSessionBusy || sessionHistoryRestoreId) return;
    setCreateSessionOpen(false);
    setCreateSessionError(null);
    setSessionHistoryError("");
    setCreateSessionDirectoryFocused(false);
    setCreateSessionDirectorySelectedIndex(0);
    setCreateSessionNameAutofocus(false);
  }

  function updateCreateSessionCwd(value: string) {
    setCreateSessionCwd(value);
    setCreateSessionError(null);
    setCreateSessionDirectorySelectedIndex(0);
  }

  function chooseCreateSessionDirectory(path: string) {
    setCreateSessionCwd(path);
    setCreateSessionDirectoryFocused(false);
    setCreateSessionError(null);
    setCreateSessionDirectorySelectedIndex(0);
  }

  async function dismissCreateSessionDirectory(path: string) {
    const removedSuggestion = serverDirectorySuggestions.find((suggestion) => suggestion.path === path);
    setServerDirectorySuggestions((suggestions) => suggestions.filter((suggestion) => suggestion.path !== path));
    try {
      await api.dismissSessionDirectory(path);
    } catch {
      if (removedSuggestion) {
        setServerDirectorySuggestions((suggestions) => mergeSessionDirectorySuggestions(suggestions, [removedSuggestion]));
      }
      toast.error("Could not remove directory recommendation.");
    }
  }

  function handleCreateSessionDirectoryKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!showDirectorySuggestions) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCreateSessionDirectorySelectedIndex((index) =>
        nextSessionDirectorySuggestionIndex(index, visibleDirectorySuggestions.length, event.key === "ArrowDown" ? 1 : -1)
      );
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setCreateSessionDirectorySelectedIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setCreateSessionDirectorySelectedIndex(visibleDirectorySuggestions.length - 1);
      return;
    }
    if (event.key === "Enter") {
      const selectedSuggestion = visibleDirectorySuggestions[createSessionDirectorySelectedIndex] ?? visibleDirectorySuggestions[0];
      if (!selectedSuggestion) return;
      event.preventDefault();
      chooseCreateSessionDirectory(selectedSuggestion.path);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setCreateSessionDirectoryFocused(false);
    }
  }

  function updateCreateSessionName(value: string) {
    setCreateSessionName(normalizeSessionNameInput(value));
    setCreateSessionError(null);
  }

  function handleSessionHistoryKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCreateSession();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSessionHistorySelectedIndex((index) => Math.min(sessionHistoryResults.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSessionHistorySelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter") {
      const selected = sessionHistoryResults[sessionHistorySelectedIndex];
      if (!selected) return;
      event.preventDefault();
      void restoreHistorySession(selected);
    }
  }

  async function restoreHistorySession(result: SessionHistoryResult) {
    if (sessionHistoryRestoreId) return;
    setSessionHistoryRestoreId(result.sessionId);
    setSessionHistoryError("");
    try {
      const response = await api.restoreSession(result.sessionId);
      syncSessionStoplight(response.session);
      setCreateSessionOpen(false);
      navigate(`/sessions/${response.session.id}`, { state: { restoringSessionId: response.session.id } });
      void loadSessions().catch(handleConnectedRequestFailure);
    } catch (error) {
      handleConnectedRequestFailure(error);
      setSessionHistoryError(error instanceof Error ? error.message : "Could not restore session.");
    } finally {
      setSessionHistoryRestoreId(null);
    }
  }

  async function submitCreateSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createSessionBusy) return;

    const cwd = createSessionCwd.trim();
    const name = normalizeSessionName(createSessionName);
    if (!cwd) {
      setCreateSessionError("Directory is required.");
      return;
    }
    if (!isValidSessionName(name)) {
      return;
    }
    if (createSessionGitProbe?.isGit && !gitWorkspaceFieldsAvailable) {
      setCreateSessionError("Run pnpm app start prod to install or update the muxpilot Git workflow skill first.");
      return;
    }
    if (createSessionGitProbe?.isGit && !createSessionTargetBranch.trim()) {
      setCreateSessionError("Target branch is required for Git sessions.");
      return;
    }
    if (createSessionGitProbe?.isGit && !createSessionGitProbe.localBranches.includes(createSessionTargetBranch)) {
      setCreateSessionError("Select an existing local target branch.");
      return;
    }

    setCreateSessionBusy(true);
    setCreateSessionError(null);
    try {
      const request: CreateSessionRequest = createSessionGitProbe?.isGit
        ? { cwd, name, workspace: {
            mode: "git" as const,
            targetBranch: createSessionTargetBranch.trim()
          } }
        : { cwd, name, workspace: { mode: "directory" } };
      const response = await api.createSession(request);
      setCreateSessionOpen(false);
      await loadSessions();
      navigate(`/sessions/${response.session.id}`);
    } catch (error) {
      setCreateSessionError(error instanceof Error ? error.message : "Could not create session.");
    } finally {
      setCreateSessionBusy(false);
    }
  }

  function updateCreateSessionTargetBranch(value: string) {
    if (createSessionGitProbe?.localBranches.includes(value)) setCreateSessionTargetBranch(value);
  }

  function selectSessionStoplightSeverity(severity: SessionStatusSeverity) {
    setSessionStoplightSeverity((currentSeverity) => nextSessionStoplightSeverity(currentSeverity, severity));
    navigate({ pathname: "/", search: sessionStoplightSearch(location.search) });
  }

  function openGlobalNotificationMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setNotificationSettingsSubmenuOpen(false);
    setNotificationMenu(dropdownMenuPosition(rect, { width: GLOBAL_NOTIFICATION_MENU_WIDTH, height: GLOBAL_NOTIFICATION_MENU_HEIGHT, edge: MENU_EDGE }));
  }

  if (sessionHistoryRestoreId) {
    return <AppLoadingSkeleton variant="session" label="Restoring session" />;
  }

  async function toggleGlobalNotification(type: NotificationRuleType, enabled: boolean) {
    if (notificationToggleBusy) return;
    setNotificationToggleBusy(true);
    try {
      const settings = await api.updateNotificationSetting({ deviceId: notificationDeviceId(), setting: "rule", scope: "global", type, enabled });
      setNotificationSettings(settings);
    } finally {
      setNotificationToggleBusy(false);
    }
  }

  async function toggleNotificationDelivery(channel: "push" | "sound", enabled: boolean) {
    if (notificationToggleBusy) return;
    setNotificationToggleBusy(true);
    try {
      if (channel === "push") {
        if (enabled) {
          const subscribed = await ensurePushSubscription();
          if (!subscribed) return;
        } else {
          await disablePushSubscription();
        }
      }
      const settings = await api.updateNotificationSetting({ deviceId: notificationDeviceId(), setting: "delivery", channel, enabled });
      setNotificationSettings(settings);
    } finally {
      setNotificationToggleBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <AppBrand />
        <SessionStoplight counts={stoplightCounts} activeSeverity={activeStoplightSeverity} onSelect={selectSessionStoplightSeverity} />
        <div className="topbar-actions">
          {accessMode === "local" ? (
            <button className="icon-button" onClick={() => setSessionTransferOpen(true)} aria-label="Import or export sessions">
              <ArrowLeftRight size={18} />
            </button>
          ) : null}
          <button className="icon-button" onClick={openGlobalNotificationMenu} aria-label="Global notifications">
            <Bell size={18} />
          </button>
          {showConnectButton ? (
            <button className="icon-button" onClick={() => setConnectOpen(true)} aria-label="Connect device">
              <Smartphone size={18} />
            </button>
          ) : null}
          {showLogoutButton ? (
            <button
              className="icon-button"
              onClick={logout}
              disabled={logoutBusy}
              aria-busy={logoutBusy}
              aria-label={logoutBusy ? "Clearing access" : "Clear access"}
              data-busy={logoutBusy || undefined}
            >
              <LogOut size={18} />
            </button>
          ) : null}
        </div>
      </header>
      {sessionTransferOpen ? <SessionTransferDialog onClose={() => setSessionTransferOpen(false)} /> : null}
      {notificationMenu ? (
        <ContextMenu
          className="notification-rule-menu"
          ref={notificationMenuRef}
          position={notificationMenu}
          label="Global notification settings"
        >
          <NotificationRuleMenu
            enabledRules={globalNotificationRules(notificationSettings)}
            onToggle={(type, enabled) => void toggleGlobalNotification(type, enabled)}
            disabled={notificationToggleBusy}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Settings size={16} />}
            trailing={<ChevronRight className="menu-chevron" size={16} />}
            aria-haspopup="menu"
            aria-expanded={notificationSettingsSubmenuOpen}
            onMouseEnter={() => setNotificationSettingsSubmenuOpen(true)}
            onFocus={() => setNotificationSettingsSubmenuOpen(true)}
            onClick={() => setNotificationSettingsSubmenuOpen(true)}
            disabled={notificationToggleBusy}
          >
            Settings
          </ContextMenuItem>
          {notificationSettingsSubmenuOpen ? (
            <ContextMenu
              className="notification-rule-menu session-notify-submenu"
              position={notificationSettingsSubmenuPosition(notificationMenu)}
              label="Notification delivery settings"
            >
              <ContextMenuCheckboxItem
                checked={notificationPushEnabled(notificationSettings)}
                disabled={notificationToggleBusy || (!isPushNotificationAvailable() && !notificationPushEnabled(notificationSettings))}
                onClick={() => void toggleNotificationDelivery("push", !notificationPushEnabled(notificationSettings))}
              >
                Push
              </ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem
                checked={notificationSoundEnabled(notificationSettings)}
                disabled={notificationToggleBusy}
                onClick={() => void toggleNotificationDelivery("sound", !notificationSoundEnabled(notificationSettings))}
              >
                Sound
              </ContextMenuCheckboxItem>
            </ContextMenu>
          ) : null}
        </ContextMenu>
      ) : null}
      <main className={contentClassName}>
        <Outlet
          context={
            {
              refreshSessionStoplight: loadSessions,
              syncSessionStoplight,
              sessionStoplightSeverity,
              openCreateSession,
              registerCreateSessionCwdPrefill,
              registerPromptHistoryPrefill,
              registerPrimaryInputFocus,
              connectionEpoch,
              accessMode,
              notificationSettings,
              setNotificationSettings
            } satisfies AppShellOutletContext
          }
        />
      </main>
      <ToastContainer theme="dark" newestOnTop closeButton closeOnClick pauseOnFocusLoss={false} />
      <Modal
        open={createSessionOpen}
        onClose={closeCreateSession}
        title="New session"
        panelClassName="session-name-dialog"
        as="form"
        onSubmit={submitCreateSession}
        dismissible={!createSessionBusy && !sessionHistoryRestoreId}
      >
            <div className="dialog-tabs" role="tablist" aria-label="New session options">
              <button type="button" role="tab" aria-selected={createSessionTab === "create"} data-active={createSessionTab === "create" || undefined} onClick={() => setCreateSessionTab("create")}>
                <Play size={15} />
                Create
              </button>
              <button type="button" role="tab" aria-selected={createSessionTab === "history"} data-active={createSessionTab === "history" || undefined} onClick={() => setCreateSessionTab("history")}>
                <History size={15} />
                History
              </button>
            </div>
            {createSessionTab === "create" ? (
              <>
                <label className="rename-field">
                  <span>Directory</span>
                  <div className="session-directory-combobox">
                    <input
                      {...noAutofillTextField}
                      autoFocus={!createSessionNameAutofocus}
                      value={createSessionCwd}
                      onChange={(event) => updateCreateSessionCwd(event.target.value)}
                      onFocus={() => setCreateSessionDirectoryFocused(true)}
                      onBlur={() => window.setTimeout(() => setCreateSessionDirectoryFocused(false), 120)}
                      onKeyDown={handleCreateSessionDirectoryKeyDown}
                      maxLength={4096}
                      disabled={createSessionBusy}
                      role="combobox"
                      aria-expanded={showDirectorySuggestions}
                      aria-controls="session-directory-suggestions"
                      aria-activedescendant={activeDirectorySuggestionId}
                      aria-autocomplete="list"
                    />
                    {showDirectorySuggestions ? (
                      <div className="session-directory-suggestions" id="session-directory-suggestions" role="listbox" aria-label="Session directories">
                        {visibleDirectorySuggestions.map((suggestion, index) => (
                          <div className="session-directory-suggestion-row" role="presentation" key={suggestion.path}>
                            <button
                              id={sessionDirectorySuggestionOptionId(suggestion.path)}
                              ref={(element) => updateDirectorySuggestionRef(directorySuggestionRefs.current, suggestion.path, element)}
                              type="button"
                              role="option"
                              aria-selected={index === createSessionDirectorySelectedIndex}
                              className={`session-directory-suggestion-option${index === createSessionDirectorySelectedIndex ? " session-directory-suggestion-selected" : ""}`}
                              onMouseDown={(event) => event.preventDefault()}
                              onMouseEnter={() => setCreateSessionDirectorySelectedIndex(index)}
                              onClick={() => chooseCreateSessionDirectory(suggestion.path)}
                            >
                              <span className="session-directory-suggestion-name">{directorySuggestionLabel(suggestion)}</span>
                              <span className="session-directory-suggestion-path">{suggestion.path}</span>
                            </button>
                            <button
                              type="button"
                              className="session-directory-suggestion-remove"
                              aria-label={`Remove ${suggestion.path} from recommendations`}
                              title="Remove from recommendations"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void dismissCreateSessionDirectory(suggestion.path)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </label>
                {createSessionGitProbeBusy ? <p className="session-git-probe-note">Inspecting repository…</p> : null}
                {createSessionGitProbe?.isGit ? (
                  <>
                    {gitWorkspaceFieldsAvailable ? (
                      <label className="rename-field" htmlFor="create-session-target-branch">
                        <span>Target branch</span>
                        <select
                          id="create-session-target-branch"
                          value={createSessionTargetBranch}
                          onChange={(event) => updateCreateSessionTargetBranch(event.target.value)}
                          disabled={createSessionBusy || createSessionGitProbe.localBranches.length === 0}
                        >
                          {targetBranchSuggestions(createSessionGitProbe).map((suggestion) => (
                            <option key={suggestion.value} value={suggestion.value}>{suggestion.label}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <GitWorkflowSkillStatusCallout status={gitSkillStatus} onRetry={() => {
                      setGitSkillStatus("checking");
                      void api.gitWorkflowSkillStatus().then((status) => setGitSkillStatus(status.status)).catch(() => setGitSkillStatus("error"));
                    }} />
                    {gitWorkspaceFieldsAvailable && createSessionGitProbe.localBranches.length === 0
                      ? <p className="session-git-probe-note">This repository has no local branches.</p>
                      : null}
                  </>
                ) : null}
                <label className="rename-field">
                  <span>Name</span>
                  <input
                    {...noAutofillTextField}
                    autoFocus={createSessionNameAutofocus}
                    value={createSessionName}
                    onChange={(event) => updateCreateSessionName(event.target.value)}
                    maxLength={SESSION_NAME_MAX_LENGTH}
                    aria-invalid={createSessionNameInvalid}
                    disabled={createSessionBusy}
                  />
                </label>
                {createSessionNameWarning ? (
                  <p className="dialog-error" role="alert">
                    {createSessionNameWarning}
                  </p>
                ) : null}
                {createSessionError ? (
                  <p className="dialog-error" role="alert">
                    {createSessionError}
                  </p>
                ) : null}
                <div className="dialog-actions">
                  <button type="button" onClick={closeCreateSession} disabled={createSessionBusy}>
                    Cancel
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    disabled={createSessionBusy || createSessionNameInvalid || Boolean(createSessionGitProbe?.isGit && (!gitWorkspaceFieldsAvailable || !createSessionGitProbe.localBranches.includes(createSessionTargetBranch)))}
                    aria-busy={createSessionBusy}
                    data-busy={createSessionBusy || undefined}
                  >
                    {createSessionBusy ? "Creating" : "Create"}
                  </button>
                </div>
              </>
            ) : (
              <div className="session-history-panel">
                <label className="prompt-history-search">
                  <Search size={17} aria-hidden="true" />
                  <input
                    {...searchField}
                    autoFocus
                    value={sessionHistoryQuery}
                    onChange={(event) => setSessionHistoryQuery(event.target.value)}
                    onKeyDown={handleSessionHistoryKeyDown}
                    placeholder="Search user prompts"
                    aria-controls="session-history-results"
                  />
                </label>
                {sessionHistoryError ? <p className="dialog-error">{sessionHistoryError}</p> : null}
                <div className="session-history-results" id="session-history-results" role="listbox" aria-label="Restorable sessions">
                  {sessionHistoryLoading ? <p className="prompt-history-muted">Searching sessions</p> : null}
                  {!sessionHistoryLoading && !sessionHistoryError && sessionHistoryResults.length === 0 ? <p className="prompt-history-muted">No restorable sessions</p> : null}
                  {!sessionHistoryLoading
                    ? sessionHistoryResults.map((result, index) => (
                        <button
                          key={sessionHistoryResultKey(result)}
                          type="button"
                          role="option"
                          aria-selected={index === sessionHistorySelectedIndex}
                          className={index === sessionHistorySelectedIndex ? "session-history-result session-history-result-selected" : "session-history-result"}
                          disabled={Boolean(sessionHistoryRestoreId)}
                          onMouseEnter={() => setSessionHistorySelectedIndex(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void restoreHistorySession(result)}
                        >
                          <span className="session-history-result-main">
                            <strong>{result.sessionName}</strong>
                            <span>{sessionHistoryResultMeta(result)}</span>
                          </span>
                          <span className="session-history-result-prompt">{sessionHistoryPromptPreview(result)}</span>
                          <span className="session-history-result-action" aria-hidden="true">
                            {sessionHistoryRestoreId === result.sessionId ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
                          </span>
                        </button>
                      ))
                    : null}
                </div>
              </div>
            )}
      </Modal>
      {promptHistoryOpen ? (
        <PromptHistoryDialog
          initialQuery={promptHistoryInitialQuery}
          requestKey={promptHistoryRequestKey}
          onClose={() => setPromptHistoryOpen(false)}
        />
      ) : null}
      {connectOpen ? <ConnectDeviceDialog onClose={() => setConnectOpen(false)} /> : null}
    </div>
  );
}

export { AppBrand };

export interface AppShellOutletContext {
  refreshSessionStoplight: () => Promise<void>;
  syncSessionStoplight: (session: ManagedSession) => void;
  sessionStoplightSeverity: SessionStatusSeverity | null;
  openCreateSession: (cwd?: string) => void;
  registerCreateSessionCwdPrefill: (provider: () => string) => () => void;
  registerPromptHistoryPrefill: (provider: () => string) => () => void;
  registerPrimaryInputFocus: (provider: PrimaryInputFocusHandler) => () => void;
  connectionEpoch: number;
  accessMode: AccessMode | null;
  notificationSettings: NotificationSettings | null;
  setNotificationSettings: (settings: NotificationSettings) => void;
}

export function shouldProbeShellConnection(error: unknown): boolean {
  return !(error instanceof ApiError);
}

function isNotificationTriggeredEvent(event: SessionEvent | { type: string }): event is SessionEvent & { payload: NotificationTriggeredPayload } {
  return event.type === "notification.triggered" && Boolean((event as { payload?: unknown }).payload);
}

function toastTypeForNotification(payload: NotificationTriggeredPayload): "success" | "warning" | "error" {
  if (payload.severity === "red") return "error";
  if (payload.severity === "green") return "success";
  return "warning";
}

function notificationSettingsSubmenuPosition(position: { x: number; y: number }): { x: number; y: number } {
  return submenuPosition(position, {
    parentWidth: GLOBAL_NOTIFICATION_MENU_WIDTH,
    width: GLOBAL_NOTIFICATION_MENU_WIDTH,
    height: GLOBAL_NOTIFICATION_SETTINGS_MENU_HEIGHT,
    itemOffsetY: GLOBAL_NOTIFICATION_SETTINGS_MENU_OFFSET_Y,
    edge: MENU_EDGE
  });
}

export function DisconnectedNotice() {
  return (
    <div className="disconnected-notice" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={17} />
      <span>Disconnected from muxpilot. Reconnecting...</span>
    </div>
  );
}

export function AppRecoveryPage({
  role = "alert",
  title,
  message,
  detail,
  actionLabel,
  busy = false,
  onAction
}: {
  role?: "alert" | "status";
  title: string;
  message: string;
  detail?: string;
  actionLabel?: string;
  busy?: boolean;
  onAction?: () => void;
}) {
  return (
    <section className="recovery-page" role={role} aria-live={role === "status" ? "polite" : "assertive"}>
      <div className="recovery-mark" aria-hidden="true">
        {busy ? <LoaderCircle className="spin" size={28} /> : <AlertTriangle size={28} />}
      </div>
      <div className="recovery-copy">
        <h1>{title}</h1>
        <p>{message}</p>
        {detail ? <p className="recovery-detail">{detail}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <button className="primary-button recovery-action" type="button" onClick={onAction} disabled={busy} aria-busy={busy} data-busy={busy || undefined}>
          {busy ? <LoaderCircle className="spin" size={18} /> : null}
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}

export function sessionNameValidationMessage(value: string): string | null {
  const name = normalizeSessionName(value);
  if (isValidSessionName(name) || name.length < SESSION_NAME_MIN_LENGTH) return null;
  return SESSION_NAME_VALIDATION_MESSAGE;
}

export function GitWorkflowSkillStatusCallout({
  status,
  onRetry
}: {
  status: MuxpilotGitSkillStatus["status"] | "checking" | "error" | null;
  onRetry: () => void;
}) {
  if (status === "checking") return <p className="session-git-probe-note">Checking Codex skill…</p>;
  if (status === "missing" || status === "outdated") {
    return (
      <div className="session-git-skill-callout">
        <p>Run <code>pnpm app start prod</code> to {status === "missing" ? "install" : "update"} the muxpilot Git workflow skill.</p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="session-git-skill-callout">
        <p>Could not check the muxpilot Git workflow skill.</p>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return null;
}

export function filterSessionDirectorySuggestions(
  suggestions: SessionDirectorySuggestion[],
  query: string,
  limit = 8
): SessionDirectorySuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  const sortedSuggestions = [...suggestions].sort(compareSessionDirectorySuggestionsByRecency);
  const matches = normalizedQuery
    ? sortedSuggestions.filter((suggestion) =>
        [suggestion.path, suggestion.label, suggestion.branch, suggestion.repoRoot]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedQuery))
      )
    : sortedSuggestions;
  return matches.slice(0, limit);
}

export function nextSessionDirectorySuggestionIndex(currentIndex: number, suggestionCount: number, direction: 1 | -1): number {
  if (suggestionCount <= 0) return 0;
  return (currentIndex + direction + suggestionCount) % suggestionCount;
}

export function sessionDirectorySuggestionsFromSessions(sessions: ManagedSession[]): SessionDirectorySuggestion[] {
  return mergeSessionDirectorySuggestions(
    sessions
      .filter((session) => !session.archived && session.status !== "missing")
      .map((session) => {
        const path = session.gitWorkspace?.entryPath ?? session.repo.root ?? session.tmux.cwd;
        return {
          path,
          label: session.gitWorkspace ? directoryBaseName(session.gitWorkspace.repoRoot) : session.repo.name || directoryBaseName(path),
          repoRoot: session.gitWorkspace?.repoRoot ?? session.repo.root,
          branch: session.gitWorkspace?.targetBranch ?? session.repo.branch,
          source: "active" as const,
          lastActivityAt: session.lastActivityAt
        };
      })
      .filter((suggestion) => suggestion.path.trim().length > 0)
  );
}

export function mergeSessionDirectorySuggestions(...suggestionGroups: SessionDirectorySuggestion[][]): SessionDirectorySuggestion[] {
  const suggestionsByPath = new Map<string, SessionDirectorySuggestion>();
  for (const suggestion of suggestionGroups.flat()) {
    const existing = suggestionsByPath.get(suggestion.path);
    if (!existing) {
      suggestionsByPath.set(suggestion.path, suggestion);
      continue;
    }

    suggestionsByPath.set(suggestion.path, mergeSessionDirectorySuggestion(existing, suggestion));
  }
  return [...suggestionsByPath.values()].sort(compareSessionDirectorySuggestionsByRecency);
}

function mergeSessionDirectorySuggestion(first: SessionDirectorySuggestion, second: SessionDirectorySuggestion): SessionDirectorySuggestion {
  const latest = compareSessionDirectorySuggestionsByRecency(first, second) <= 0 ? first : second;
  const sourceComparison = compareSessionDirectorySuggestionsBySource(first, second);
  const preferred = sourceComparison === 0 ? latest : sourceComparison < 0 ? first : second;
  return {
    ...preferred,
    label: preferred.label || latest.label,
    repoRoot: preferred.repoRoot ?? latest.repoRoot,
    branch: preferred.branch ?? latest.branch,
    lastActivityAt: latest.lastActivityAt
  };
}

function compareSessionDirectorySuggestionsBySource(first: SessionDirectorySuggestion, second: SessionDirectorySuggestion): number {
  if (first.source === second.source) return 0;
  return first.source === "active" ? -1 : 1;
}

function compareSessionDirectorySuggestionsByRecency(first: SessionDirectorySuggestion, second: SessionDirectorySuggestion): number {
  const firstTime = first.lastActivityAt ? Date.parse(first.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const secondTime = second.lastActivityAt ? Date.parse(second.lastActivityAt) : Number.NEGATIVE_INFINITY;
  if (firstTime !== secondTime) return secondTime - firstTime;
  return first.label.localeCompare(second.label) || first.path.localeCompare(second.path);
}

function directoryBaseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").filter(Boolean).pop() ?? path;
}

export interface GitRefSuggestion {
  value: string;
  label: string;
  detail: string;
}

export function targetBranchSuggestions(probe: GitRepositoryProbe): GitRefSuggestion[] {
  const suggestions = new Map<string, GitRefSuggestion>();
  for (const branch of probe.localBranches) {
    if (isMuxpilotManagedSessionBranch(branch)) continue;
    suggestions.set(branch, { value: branch, label: branch, detail: "Local branch" });
  }
  return [...suggestions.values()].sort(compareGitRefSuggestions);
}

function compareGitRefSuggestions(left: GitRefSuggestion, right: GitRefSuggestion): number {
  return left.label.localeCompare(right.label) || left.value.localeCompare(right.value);
}

function sessionDirectorySuggestionOptionId(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return `session-directory-suggestion-${encodeURIComponent(path).replaceAll("%", "_")}`;
}

function updateDirectorySuggestionRef(refs: Map<string, HTMLButtonElement>, path: string, element: HTMLButtonElement | null): void {
  if (element) refs.set(path, element);
  else refs.delete(path);
}

export function syncSessionIntoStoplightSessions(currentSessions: ManagedSession[], session: ManagedSession): ManagedSession[] {
  if (session.archived || session.status === "missing") return currentSessions.filter((item) => item.id !== session.id);
  const index = currentSessions.findIndex((item) => item.id === session.id);
  if (index === -1) return [...currentSessions, session];
  const nextSessions = [...currentSessions];
  nextSessions[index] = session;
  return nextSessions;
}

export function sessionStoplightSearch(currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("status");
  params.delete("statusSeverity");
  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : "";
}

export function nextSessionStoplightSeverity(
  currentSeverity: SessionStatusSeverity | null,
  selectedSeverity: SessionStatusSeverity
): SessionStatusSeverity | null {
  return currentSeverity === selectedSeverity ? null : selectedSeverity;
}

export function SessionStoplight({
  counts,
  activeSeverity,
  onSelect
}: {
  counts: SessionStoplightCounts;
  activeSeverity?: SessionStatusSeverity | null;
  onSelect?: (severity: SessionStatusSeverity) => void;
}) {
  return (
    <div
      className="session-stoplight"
      data-has-active={activeSeverity ? true : undefined}
      aria-label={sessionStoplightSummary(counts)}
      title={sessionStoplightSummary(counts)}
    >
      <SessionStoplightDot
        severity="red"
        count={counts.red}
        label={sessionStoplightDotLabel("red", counts.red)}
        active={activeSeverity === "red"}
        onSelect={onSelect}
      />
      <SessionStoplightDot
        severity="yellow"
        count={counts.yellow}
        label={sessionStoplightDotLabel("yellow", counts.yellow)}
        active={activeSeverity === "yellow"}
        onSelect={onSelect}
      />
      <SessionStoplightDot
        severity="green"
        count={counts.green}
        label={sessionStoplightDotLabel("green", counts.green)}
        active={activeSeverity === "green"}
        onSelect={onSelect}
      />
    </div>
  );
}

function SessionStoplightDot({
  severity,
  count,
  label,
  active,
  onSelect
}: {
  severity: SessionStatusSeverity;
  count: number;
  label: string;
  active?: boolean;
  onSelect?: (severity: SessionStatusSeverity) => void;
}) {
  if (count === 0 && !active) return null;

  return (
    <button
      type="button"
      className={`session-stoplight-dot session-stoplight-dot-${severity}`}
      aria-pressed={active ? "true" : "false"}
      data-active={active || undefined}
      aria-label={label}
      title={label}
      onClick={() => onSelect?.(severity)}
    >
      {count}
    </button>
  );
}

function sessionStoplightSummary(counts: SessionStoplightCounts): string {
  return `${sessionStoplightDotLabel("red", counts.red)}, ${sessionStoplightDotLabel("yellow", counts.yellow)}, ${sessionStoplightDotLabel("green", counts.green)}`;
}

function sessionStoplightDotLabel(severity: SessionStatusSeverity, count: number): string {
  if (severity === "red") return `${count} ${sessionCountNoun(count)} need attention`;
  if (severity === "yellow") return `${count} ${sessionCountNoun(count)} working`;
  return `${count} ${sessionCountNoun(count)} ready`;
}

function sessionCountNoun(count: number): string {
  return count === 1 ? "session" : "sessions";
}

export function shouldShowConnectDeviceButton(me: Pick<MeResponse, "accessGranted" | "accessKeyRequired" | "accessMode">): boolean {
  return me.accessGranted && me.accessMode === "local" && !me.accessKeyRequired;
}

export function shouldShowLogoutButton(me: Pick<MeResponse, "accessMode">): boolean {
  return me.accessMode !== "unrestricted";
}

export function isPromptHistoryShortcut(event: Pick<globalThis.KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key">): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "r";
}

export function isNewSessionShortcut(event: Pick<globalThis.KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key">): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n";
}

export function isSessionTransferFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".mpsession");
}

interface SessionTransferMappingProbe {
  path: string;
  probe: GitRepositoryProbe | null;
  busy: boolean;
  error: string | null;
}

export function importTargetBranchValue(probe: GitRepositoryProbe, preferred: string): string {
  const suggestions = targetBranchSuggestions(probe);
  return suggestions.some((suggestion) => suggestion.value === preferred) ? preferred : suggestions[0]?.value ?? "";
}

function SessionTransferDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"export" | "import">("export");
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [preview, setPreview] = useState<SessionTransferInspectResponse | null>(null);
  const [mappings, setMappings] = useState<Record<string, { destinationCwd: string; targetBranch: string }>>({});
  const [result, setResult] = useState<SessionTransferImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const [importDragging, setImportDragging] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [mappingProbes, setMappingProbes] = useState<Record<string, SessionTransferMappingProbe>>({});

  useEffect(() => {
    void Promise.all([api.transferableSessions(), api.sessionTransferStatus()])
      .then(([sessionResponse, status]) => {
        setSessions(sessionResponse.sessions);
        setEncryptionEnabled(status.encryptionEnabled);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const mappingProbeKey = preview?.mappings
    .filter((requirement) => requirement.workspaceMode === "git")
    .map((requirement) => `${requirement.sourceCwd}\u0000${mappings[requirement.sourceCwd]?.destinationCwd.trim() ?? ""}`)
    .join("\u0001") ?? "";

  useEffect(() => {
    if (!preview) {
      setMappingProbes({});
      return undefined;
    }
    const targets = preview.mappings
      .filter((requirement) => requirement.workspaceMode === "git")
      .map((requirement) => ({
        sourceCwd: requirement.sourceCwd,
        path: mappings[requirement.sourceCwd]?.destinationCwd.trim() ?? ""
      }));
    let cancelled = false;
    const timer = window.setTimeout(() => {
      for (const target of targets) {
        if (!target.path) {
          setMappingProbes((current) => ({ ...current, [target.sourceCwd]: { path: "", probe: null, busy: false, error: null } }));
          continue;
        }
        setMappingProbes((current) => ({ ...current, [target.sourceCwd]: { path: target.path, probe: null, busy: true, error: null } }));
        void api.gitRepositoryProbe(target.path).then((probe) => {
          if (cancelled) return;
          setMappingProbes((current) => ({ ...current, [target.sourceCwd]: { path: target.path, probe, busy: false, error: null } }));
          setMappings((current) => {
            const mapping = current[target.sourceCwd];
            if (!mapping || mapping.destinationCwd.trim() !== target.path) return current;
            return { ...current, [target.sourceCwd]: { ...mapping, targetBranch: importTargetBranchValue(probe, mapping.targetBranch) } };
          });
        }).catch(() => {
          if (!cancelled) setMappingProbes((current) => ({ ...current, [target.sourceCwd]: { path: target.path, probe: null, busy: false, error: "Could not inspect this repository." } }));
        });
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mappingProbeKey, preview]);

  async function close() {
    if (busy || closing) return;
    setClosing(true);
    if (preview && !result) await api.cancelSessionTransfer(preview.token).catch(() => undefined);
    onClose();
  }

  async function exportSelected() {
    setBusy(true);
    setError("");
    try {
      const download = await api.exportSessionTransfer([...selected]);
      const url = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = download.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function inspectFile(file: File | undefined) {
    if (!file) return;
    if (!isSessionTransferFileName(file.name)) {
      setImportFileName(file.name);
      setError("Choose a .mpsession file.");
      return;
    }
    setImportFileName(file.name);
    setBusy(true);
    setError("");
    setResult(null);
    if (preview) await api.cancelSessionTransfer(preview.token).catch(() => undefined);
    try {
      const next = await api.inspectSessionTransfer(file);
      setPreview(next);
      setMappings(Object.fromEntries(next.mappings.map((mapping) => [mapping.sourceCwd, {
        destinationCwd: mapping.sourceCwd,
        targetBranch: mapping.targetBranch ?? ""
      }])));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function importSessions() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const imported = await api.importSessionTransfer({
        token: preview.token,
        mappings: preview.mappings.map((requirement) => ({
          sourceCwd: requirement.sourceCwd,
          destinationCwd: mappings[requirement.sourceCwd]?.destinationCwd.trim() ?? "",
          ...(requirement.workspaceMode === "git" ? { targetBranch: mappings[requirement.sourceCwd]?.targetBranch.trim() } : {})
        }))
      });
      setResult(imported);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  function updateImportDestination(sourceCwd: string, workspaceMode: "directory" | "git", destinationCwd: string) {
    setMappings((current) => ({ ...current, [sourceCwd]: { ...current[sourceCwd]!, destinationCwd } }));
    if (workspaceMode === "git") {
      setMappingProbes((current) => ({
        ...current,
        [sourceCwd]: { path: destinationCwd.trim(), probe: null, busy: Boolean(destinationCwd.trim()), error: null }
      }));
    }
  }

  const portableSessions = sessions.filter((session) => Boolean(session.codexSessionId && session.codexJsonlPath));
  const mappingComplete = preview?.mappings.every((requirement) => {
    const value = mappings[requirement.sourceCwd];
    if (!value?.destinationCwd.trim()) return false;
    if (requirement.workspaceMode !== "git") return true;
    const mappingProbe = mappingProbes[requirement.sourceCwd];
    return Boolean(mappingProbe?.path === value.destinationCwd.trim() && mappingProbe.probe?.isGit && targetBranchSuggestions(mappingProbe.probe).some((suggestion) => suggestion.value === value.targetBranch));
  }) ?? false;

  return (
    <Modal
      open
      onClose={close}
      title="Session transfer"
      panelClassName="session-name-dialog"
      dismissible={!busy && !closing}
    >
        <div className="dialog-tabs" role="tablist" aria-label="Session transfer options">
          <button type="button" role="tab" aria-selected={tab === "export"} data-active={tab === "export" || undefined} onClick={() => setTab("export")}><Download size={16} /> Export</button>
          <button type="button" role="tab" aria-selected={tab === "import"} data-active={tab === "import" || undefined} onClick={() => setTab("import")}><Upload size={16} /> Import</button>
        </div>
        {tab === "export" ? (
          <div className="session-transfer-panel">
            <p className="session-git-probe-note">{encryptionEnabled ? "Exports are encrypted with MUXPILOT_SESSION_FILE_KEY." : "Exports are not encrypted. Configure MUXPILOT_SESSION_FILE_KEY to protect them."}</p>
            <div className="session-history-results session-transfer-list">
              {portableSessions.map((session) => (
                <label className="session-transfer-option" key={session.id}>
                  <input type="checkbox" checked={selected.has(session.id)} onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(session.id); else next.delete(session.id);
                    return next;
                  })} />
                  <span><strong>{session.tmux.windowName || session.repo.name}</strong><small>{session.repo.name} · {session.status}{session.archived ? " · archived" : ""}</small></span>
                </label>
              ))}
              {!portableSessions.length ? <p className="prompt-history-muted">No portable sessions found.</p> : null}
            </div>
            <div className="dialog-actions"><button type="button" onClick={() => void close()} disabled={busy}>Cancel</button><button type="button" className="primary" disabled={busy || selected.size === 0} aria-busy={busy} data-busy={busy || undefined} onClick={() => void exportSelected()}>{busy ? "Exporting" : `Export ${selected.size || ""} session${selected.size === 1 ? "" : "s"}`}</button></div>
          </div>
        ) : (
          <div className="session-transfer-panel">
            {!preview ? <>
              <label
                className="session-transfer-dropzone"
                data-dragging={importDragging || undefined}
                data-busy={busy || undefined}
                aria-busy={busy}
                onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (!busy) setImportDragging(true); }}
                onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; if (!busy) setImportDragging(true); }}
                onDragLeave={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                  setImportDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setImportDragging(false);
                  if (!busy) void inspectFile(event.dataTransfer.files[0]);
                }}
              >
                <input
                  type="file"
                  accept=".mpsession,application/vnd.muxpilot.session"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void inspectFile(file);
                  }}
                />
                <span className="session-transfer-dropzone-icon" aria-hidden="true">
                  {busy ? <LoaderCircle className="spin" size={22} /> : <Upload size={22} />}
                </span>
                <strong>{busy ? "Inspecting archive" : importDragging ? "Drop file to import" : "Drop a .mpsession file here"}</strong>
                <span>{busy ? importFileName : "or click to browse"}</span>
                {!busy && importFileName ? <small>Selected: {importFileName}</small> : null}
              </label>
              <div className="dialog-actions"><button type="button" onClick={() => void close()} disabled={busy}>Cancel</button></div>
            </> : null}
            {preview && !result ? <>
              <p className="session-git-probe-note">{preview.sessions.length} session{preview.sessions.length === 1 ? "" : "s"} found · {preview.encrypted ? "encrypted" : "plaintext"}. Map each source location before all sessions are resumed.</p>
              <div className="session-transfer-mappings">
                {preview.mappings.map((requirement) => <div key={requirement.sourceCwd} className="session-transfer-mapping">
                  <div className="session-transfer-mapping-head"><strong>{requirement.repoName}</strong><span>{requirement.sourceCwd}</span></div>
                  <label className="rename-field"><span>Destination directory</span><input {...noAutofillTextField} value={mappings[requirement.sourceCwd]?.destinationCwd ?? ""} onChange={(event) => updateImportDestination(requirement.sourceCwd, requirement.workspaceMode, event.target.value)} /></label>
                  {requirement.workspaceMode === "git" ? <>
                    <label className="rename-field">
                      <span>Local target branch</span>
                      <select
                        value={mappings[requirement.sourceCwd]?.targetBranch ?? ""}
                        disabled={busy || mappingProbes[requirement.sourceCwd]?.busy || !mappingProbes[requirement.sourceCwd]?.probe?.isGit || targetBranchSuggestions(mappingProbes[requirement.sourceCwd]!.probe!).length === 0}
                        onChange={(event) => setMappings((current) => ({ ...current, [requirement.sourceCwd]: { ...current[requirement.sourceCwd]!, targetBranch: event.target.value } }))}
                      >
                        {mappingProbes[requirement.sourceCwd]?.busy ? <option value="">Inspecting repository…</option> : null}
                        {!mappingProbes[requirement.sourceCwd]?.busy && !mappingProbes[requirement.sourceCwd]?.probe?.isGit ? <option value="">Choose a valid Git directory</option> : null}
                        {mappingProbes[requirement.sourceCwd]?.probe?.isGit && targetBranchSuggestions(mappingProbes[requirement.sourceCwd]!.probe!).length === 0 ? <option value="">No local branches</option> : null}
                        {mappingProbes[requirement.sourceCwd]?.probe?.isGit ? targetBranchSuggestions(mappingProbes[requirement.sourceCwd]!.probe!).map((suggestion) => <option key={suggestion.value} value={suggestion.value}>{suggestion.label}</option>) : null}
                      </select>
                    </label>
                    {mappingProbes[requirement.sourceCwd]?.error ? <p className="session-git-probe-note dialog-error">{mappingProbes[requirement.sourceCwd]!.error}</p> : null}
                    {mappingProbes[requirement.sourceCwd]?.probe && !mappingProbes[requirement.sourceCwd]!.probe!.isGit ? <p className="session-git-probe-note dialog-error">Destination is not a Git repository.</p> : null}
                  </> : null}
                </div>)}
              </div>
              <div className="dialog-actions"><button type="button" onClick={() => { void api.cancelSessionTransfer(preview.token); setPreview(null); }} disabled={busy}>Choose another</button><button type="button" className="primary" disabled={busy || !mappingComplete} aria-busy={busy} data-busy={busy || undefined} onClick={() => void importSessions()}>{busy ? "Importing" : "Import and resume all"}</button></div>
            </> : null}
            {result ? <><div className="session-transfer-results">{result.results.map((item) => <div className="session-transfer-result" key={item.codexSessionId} data-status={item.status}><strong>{item.sessionName}</strong><span>{item.status.replaceAll("_", " ")}{item.error ? `: ${item.error}` : ""}</span></div>)}</div><div className="dialog-actions"><button type="button" className="primary" onClick={onClose}>Done</button></div></> : null}
          </div>
        )}
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
    </Modal>
  );
}

export function primaryInputFocusCommandForShortcut(
  event: Pick<globalThis.KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key">
): PrimaryInputFocusCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.shiftKey && event.key !== "I" && event.key !== "A") return null;
  if (!event.shiftKey && event.key === "i") return "insert";
  if (event.key === "I") return "insertStart";
  if (!event.shiftKey && event.key === "a") return "append";
  if (event.key === "A") return "appendEnd";
  return null;
}

export function isPrimaryInputFocusShortcut(event: Pick<globalThis.KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key">): boolean {
  return primaryInputFocusCommandForShortcut(event) !== null;
}

export function shouldHandlePrimaryInputFocusShortcut(
  event: Pick<globalThis.KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key" | "target">,
  ownerDocument: Pick<Document, "querySelector"> | null = typeof document === "undefined" ? null : document
): boolean {
  return primaryInputFocusCommandForShortcut(event) !== null && !isEditableShortcutTarget(event.target) && !hasShortcutBlockingOverlay(ownerDocument);
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  return Boolean(element?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-content"));
}

export function hasShortcutBlockingOverlay(ownerDocument: Pick<Document, "querySelector"> | null): boolean {
  return Boolean(ownerDocument?.querySelector("[role='dialog'], [role='menu']"));
}

function eventTargetElement(target: EventTarget | null): Pick<Element, "closest"> | null {
  const candidate = target as { closest?: unknown } | null;
  if (typeof candidate?.closest !== "function") return null;
  return candidate as Pick<Element, "closest">;
}

function PromptHistoryDialog({
  initialQuery,
  requestKey,
  onClose
}: {
  initialQuery: string;
  requestKey: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<PromptHistoryResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    setQuery(initialQuery);
    setSelectedIndex(0);
  }, [initialQuery, requestKey]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      api
        .promptHistory(query)
        .then((response) => {
          if (requestId !== requestIdRef.current) return;
          setResults(response.results);
          setSelectedIndex(0);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setResults([]);
          setError("Could not load prompt history.");
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    }, 60);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  async function copyResult(result: PromptHistoryResult) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(result.text);
    } catch {
      try {
        fallbackCopy(result.text);
      } catch {
        toast.error("Could not copy prompt.");
        return;
      }
    }
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(results.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter") {
      const selected = results[selectedIndex];
      if (selected) {
        event.preventDefault();
        void copyResult(selected);
      }
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Prompt history"
      panelClassName="prompt-history-dialog"
      backdropClassName="prompt-history-backdrop"
      initialFocusRef={inputRef}
      loading={loading}
    >
        <label className="prompt-history-search">
          <Search size={17} aria-hidden="true" />
          <input
            {...searchField}
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search submitted prompts"
            aria-controls="prompt-history-results"
          />
        </label>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="prompt-history-results" id="prompt-history-results" role="listbox" aria-label="Submitted prompts">
          {loading ? <p className="prompt-history-muted">Searching prompts</p> : null}
          {!loading && !error && results.length === 0 ? <p className="prompt-history-muted">No matching prompts</p> : null}
          {!loading
            ? results.map((result, index) => (
                <button
                  key={`${result.id}-${result.sequence}`}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  className={index === selectedIndex ? "prompt-history-result prompt-history-result-selected" : "prompt-history-result"}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void copyResult(result)}
                >
                  <span className="prompt-history-result-text">{result.text}</span>
                  <span className="prompt-history-result-meta">{promptHistoryResultMeta(result)}</span>
                  <span className="prompt-history-result-copy" aria-hidden="true">
                    <Copy size={16} />
                  </span>
                </button>
              ))
            : null}
        </div>
    </Modal>
  );
}

export function promptHistoryResultMeta(result: Pick<PromptHistoryResult, "repoName" | "repoBranch" | "sessionName" | "timestamp">): string {
  const repo = result.repoBranch ? `${result.repoName} · ${result.repoBranch}` : result.repoName;
  return `${repo} · ${result.sessionName} · ${formatPromptHistoryTimestamp(result.timestamp)}`;
}

export function sessionHistoryResultMeta(result: Pick<SessionHistoryResult, "repoName" | "repoBranch" | "cwd" | "lastActivityAt" | "status" | "archived" | "gitWorkspace">): string {
  const branch = result.gitWorkspace?.sessionBranch ?? result.repoBranch;
  const repo = branch ? `${result.repoName} · ${branch}` : result.repoName;
  const time = result.lastActivityAt ? formatPromptHistoryTimestamp(result.lastActivityAt) : "No activity";
  const state = result.archived ? "archived" : result.status;
  return `${repo || result.cwd} · ${state} · ${time}`;
}

export function sessionHistoryResultKey(result: Pick<SessionHistoryResult, "sessionId" | "codexSessionId" | "gitWorkspace">): string {
  return sessionHistoryIdentity(result);
}

export function isMuxpilotManagedSessionBranch(branch: string): boolean {
  return /^muxpilot\/[A-Za-z0-9_-]{16}(?:\/g[1-9]\d*)?$/.test(branch);
}

function sessionHistoryPromptPreview(result: Pick<SessionHistoryResult, "matchedPrompts" | "cwd">): string {
  return result.matchedPrompts[0]?.text || result.cwd;
}

function formatPromptHistoryTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function ConnectDeviceDialog({ onClose }: { onClose: () => void }) {
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessResponse | null>(null);
  const [error, setError] = useState("");
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);

  useEffect(() => {
    api
      .remoteAccess()
      .then((response) => setRemoteAccess(response))
      .catch(() => setError("Could not load remote access information."));
  }, []);

  async function copy(value: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
    } catch {
      fallbackCopy(value);
    }
    setCopiedUrl(value);
    window.setTimeout(() => setCopiedUrl((current) => (current === value ? null : current)), 1600);
  }

  async function revokeRemoteAccess() {
    if (revokeBusy) return;
    setRevokeBusy(true);
    setError("");
    try {
      const response = await api.revokeRemoteAccess();
      setRemoteAccess(response);
      setCopiedUrl(null);
    } catch {
      setError("Could not revoke remote access.");
    } finally {
      setRevokeBusy(false);
    }
  }

  async function updateUnrestrictedRemoteAccess(enabled: boolean) {
    if (settingsBusy) return;
    setSettingsBusy(true);
    setError("");
    try {
      const response = await api.updateRemoteAccessSettings({ unrestrictedRemoteAccess: enabled });
      setRemoteAccess(response);
      setCopiedUrl(null);
    } catch {
      setError("Could not update remote access settings.");
    } finally {
      setSettingsBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Connect device"
      panelClassName="connect-dialog"
      dismissible={!revokeBusy && !settingsBusy}
    >
        {error ? <p className="dialog-error">{error}</p> : null}
        {!remoteAccess && !error ? <p className="connect-muted">Loading remote access details</p> : null}

        {remoteAccess ? (
          <ConnectDeviceContent
            remoteAccess={remoteAccess}
            copiedValue={copiedUrl}
            revokeBusy={revokeBusy}
            settingsBusy={settingsBusy}
            onCopy={copy}
            onRevoke={revokeRemoteAccess}
            onUpdateUnrestrictedRemoteAccess={updateUnrestrictedRemoteAccess}
          />
        ) : null}
    </Modal>
  );
}

export function ConnectDeviceContent({
  remoteAccess,
  copiedValue,
  revokeBusy,
  settingsBusy,
  onCopy,
  onRevoke,
  onUpdateUnrestrictedRemoteAccess
}: {
  remoteAccess: RemoteAccessResponse;
  copiedValue: string | null;
  revokeBusy: boolean;
  settingsBusy: boolean;
  onCopy: (value: string) => void | Promise<void>;
  onRevoke: () => void | Promise<void>;
  onUpdateUnrestrictedRemoteAccess: (enabled: boolean) => void | Promise<void>;
}) {
  const [keyVisible, setKeyVisible] = useState(false);
  const [qrVisible, setQrVisible] = useState(false);
  const [trustQrVisible, setTrustQrVisible] = useState(false);
  const qrUrl = remoteAccessQrValue(remoteAccess);
  const trustUrl = remoteAccess.pwaTrust.primaryUrl;

  return (
    <div className="connect-content">
      {trustUrl ? (
        <div className="connect-trust">
          <span>Install phone certificate</span>
          <div className="connect-link-row">
            <strong>{trustUrl}</strong>
            <button type="button" className="copy-button" onClick={() => void onCopy(trustUrl)}>
              {copiedValue === trustUrl ? <Check size={16} /> : <Copy size={16} />}
              {copiedValue === trustUrl ? "Copied" : "Copy link"}
            </button>
          </div>
          <div className="connect-qr-section">
            <button type="button" className="copy-button" onClick={() => setTrustQrVisible((visible) => !visible)}>
              {trustQrVisible ? "Hide certificate QR" : "Show certificate QR"}
            </button>
            {trustQrVisible ? (
              <div className="connect-qr" aria-label={`QR code for ${trustUrl}`}>
                <QRCodeCanvas value={trustUrl} size={184} marginSize={2} level="M" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {remoteAccess.primaryUrl ? (
        <div className="connect-primary">
          <span>Open this URL on your phone</span>
          <div className="connect-link-row">
            <strong>{remoteAccess.primaryUrl}</strong>
            <button type="button" className="copy-button" onClick={() => void onCopy(remoteAccess.primaryUrl!)}>
              {copiedValue === remoteAccess.primaryUrl ? <Check size={16} /> : <Copy size={16} />}
              {copiedValue === remoteAccess.primaryUrl ? "Copied" : "Copy link"}
            </button>
          </div>

          {remoteAccess.accessKeyRequired ? (
            <label className="connect-access-key">
              <span>Access key</span>
              <div>
                <input {...credentialSuppressedField} readOnly type={keyVisible ? "text" : "password"} value={remoteAccess.accessKey} />
                <button type="button" className="icon-button" onClick={() => setKeyVisible((visible) => !visible)} aria-label={keyVisible ? "Hide access key" : "Show access key"}>
                  {keyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
                <button type="button" className="copy-button" onClick={() => void onCopy(remoteAccess.accessKey)}>
                  {copiedValue === remoteAccess.accessKey ? <Check size={16} /> : <Copy size={16} />}
                  {copiedValue === remoteAccess.accessKey ? "Copied" : "Copy key"}
                </button>
              </div>
            </label>
          ) : null}

          {qrUrl ? (
            <div className="connect-qr-section">
              <button type="button" className="copy-button" onClick={() => setQrVisible((visible) => !visible)}>
                {qrVisible ? "Hide QR code" : "Show QR code"}
              </button>
              {qrVisible ? (
                <div className="connect-qr" aria-label={`QR code for ${qrUrl}`}>
                  <QRCodeCanvas value={qrUrl} size={184} marginSize={2} level="M" />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="connect-revoke">
            <button type="button" className="copy-button danger" disabled={revokeBusy} aria-busy={revokeBusy} data-busy={revokeBusy || undefined} onClick={() => void onRevoke()}>
              <RotateCcw size={16} />
              {revokeBusy ? "Revoking" : "Revoke remote access"}
            </button>
          </div>
        </div>
      ) : (
        <p className="connect-warning">Phone access is not available with the current bind settings.</p>
      )}

      {remoteAccess.urls.length > 1 ? (
        <div className="connect-url-list">
          <span>Other detected URLs</span>
          {remoteAccess.urls.slice(1).map((url) => (
            <button key={url} type="button" onClick={() => void onCopy(url)}>
              {url}
            </button>
          ))}
        </div>
      ) : null}

      {remoteAccess.pwaTrust.urls.length > 1 ? (
        <div className="connect-url-list">
          <span>Other certificate URLs</span>
          {remoteAccess.pwaTrust.urls.slice(1).map((url) => (
            <button key={url} type="button" onClick={() => void onCopy(url)}>
              {url}
            </button>
          ))}
        </div>
      ) : null}

      <dl className="connect-details">
        <div>
          <dt>Bind host</dt>
          <dd>{remoteAccess.bindHost}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>{remoteAccess.unrestrictedRemoteAccess ? "Unrestricted remote" : remoteAccess.accessKeyRequired ? "Access key required" : "Trusted local"}</dd>
        </div>
      </dl>

      {remoteAccess.warnings.length > 0 ? (
        <ul className="connect-warnings">
          {remoteAccess.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {remoteAccess.pwaTrust.warnings.length > 0 ? (
        <ul className="connect-warnings">
          {remoteAccess.pwaTrust.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <label className="connect-unrestricted">
        <input
          type="checkbox"
          checked={remoteAccess.unrestrictedRemoteAccess}
          disabled={settingsBusy}
          onChange={(event) => void onUpdateUnrestrictedRemoteAccess(event.currentTarget.checked)}
        />
        <span>
          <strong>Allow unrestricted remote access</strong>
          <small>Remote devices will be able to connect without the access key.</small>
        </span>
      </label>
    </div>
  );
}

export function remoteAccessQrValue(remoteAccess: Pick<RemoteAccessResponse, "primaryAccessUrl" | "primaryUrl">): string | null {
  return remoteAccess.primaryAccessUrl ?? remoteAccess.primaryUrl;
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
