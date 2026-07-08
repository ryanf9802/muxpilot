import { Outlet, useNavigate } from "react-router-dom";
import { AlertTriangle, Check, Copy, Eye, EyeOff, LoaderCircle, LogOut, RotateCcw, Smartphone, X } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { AUTH_EXPIRED_EVENT, api, eventSocket, isUnauthorizedError } from "../api/client.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ManagedSession, MeResponse, RemoteAccessResponse, SessionDirectorySuggestion, SessionEvent } from "@muxpilot/core";
import { SESSION_NAME_MAX_LENGTH, isValidSessionName, normalizeSessionName, normalizeSessionNameInput } from "@muxpilot/core";
import { installCtrlWGuard } from "../utils/ctrlW.js";
import { directorySuggestionLabel } from "../utils/sessionDirectories.js";
import {
  SESSION_STATUS_EVENT_DEBOUNCE_MS,
  SESSION_STATUS_RECONCILE_INTERVAL_MS,
  countSessionStatuses,
  shouldRefreshSessionsForEvent,
  type SessionStoplightCounts,
  type SessionStatusSeverity
} from "../utils/sessionStatus.js";

export type ShellConnectionState = "checking" | "connected" | "disconnected" | "unauthorized";
export const SHELL_RECONNECT_INTERVAL_MS = 2000;
export const SESSION_NAME_VALIDATION_MESSAGE = "Name must be 2-32 lowercase letters, numbers, or hyphens.";

export function AppShell() {
  const navigate = useNavigate();
  const [connectionState, setConnectionState] = useState<ShellConnectionState>("checking");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [showConnectButton, setShowConnectButton] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [createSessionCwd, setCreateSessionCwd] = useState("");
  const [createSessionName, setCreateSessionName] = useState("");
  const [createSessionBusy, setCreateSessionBusy] = useState(false);
  const [createSessionError, setCreateSessionError] = useState<string | null>(null);
  const [directorySuggestions, setDirectorySuggestions] = useState<SessionDirectorySuggestion[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [shellSocketEpoch, setShellSocketEpoch] = useState(0);
  const sessionRequestIdRef = useRef(0);
  const connectionStateRef = useRef<ShellConnectionState>("checking");

  useEffect(() => installCtrlWGuard(), []);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

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
    if (!me.accessGranted) {
      markUnauthorized();
      return;
    }
    const wasDisconnected = connectionStateRef.current === "disconnected";
    setConnectionState("connected");
    setShowConnectButton(shouldShowConnectDeviceButton(me));
    if (wasDisconnected) setConnectionEpoch((epoch) => epoch + 1);
  }, [markUnauthorized]);

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

  const syncSessionStoplight = useCallback((session: ManagedSession) => {
    setSessions((currentSessions) => syncSessionIntoStoplightSessions(currentSessions, session));
  }, []);

  useEffect(() => {
    api
      .me()
      .then(applyMe)
      .catch(markDisconnected);
  }, [applyMe, markDisconnected]);

  useEffect(() => {
    if (connectionState !== "connected") return undefined;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadSessions().catch(markDisconnected);
      }, SESSION_STATUS_EVENT_DEBOUNCE_MS);
    };

    void loadSessions().catch(markDisconnected);
    const interval = setInterval(() => void loadSessions().catch(markDisconnected), SESSION_STATUS_RECONCILE_INTERVAL_MS);
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
      if (shouldRefreshSessionsForEvent(event)) scheduleLoad();
    };
    socket.onclose = () => {
      if (closing) return;
      void api
        .me()
        .then((me) => {
          if (closing) return;
          if (!me.accessGranted) {
            markUnauthorized();
            return;
          }
          applyMe(me);
          reconnectSockets();
        })
        .catch((error) => {
          if (!closing) markDisconnected(error);
        });
    };
    return () => {
      closing = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(interval);
      socket.close();
    };
  }, [applyMe, connectionState, loadSessions, markDisconnected, markUnauthorized, shellSocketEpoch]);

  useEffect(() => {
    if (connectionState !== "disconnected") return undefined;

    let cancelled = false;
    const poll = () => {
      void api
        .me()
        .then((me) => {
          if (!cancelled) applyMe(me);
        })
        .catch((error) => {
          if (!cancelled) markDisconnected(error);
        });
    };
    const interval = setInterval(poll, SHELL_RECONNECT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [applyMe, connectionState, markDisconnected]);

  useEffect(() => {
    if (!createSessionOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || createSessionBusy) return;
      closeCreateSession();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [createSessionBusy, createSessionOpen]);

  useEffect(() => {
    if (!createSessionOpen) return;
    let cancelled = false;
    api
      .sessionDirectories()
      .then((response) => {
        if (!cancelled) setDirectorySuggestions(response.directories);
      })
      .catch(() => {
        if (!cancelled) setDirectorySuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [createSessionOpen]);

  const stoplightCounts = useMemo(() => countSessionStatuses(sessions), [sessions]);
  const createSessionNameError = createSessionOpen ? sessionNameValidationMessage(createSessionName) : null;

  const openCreateSession = useCallback((cwd = "") => {
    setCreateSessionOpen(true);
    setCreateSessionCwd(cwd);
    setCreateSessionName("");
    setCreateSessionError(null);
  }, []);

  const retryConnection = useCallback(async () => {
    if (retryBusy) return;
    setRetryBusy(true);
    try {
      const me = await api.me();
      applyMe(me);
    } catch (error) {
      markDisconnected(error);
    } finally {
      setRetryBusy(false);
    }
  }, [applyMe, markDisconnected, retryBusy]);

  if (connectionState === "checking") {
    return (
      <AppRecoveryPage
        role="status"
        busy
        title="Opening muxpilot"
        message="Checking the local backend connection."
      />
    );
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
            detail="This can happen after the server restarts or when an installed PWA wakes before the backend is ready."
            actionLabel={retryBusy ? "Retrying" : "Retry now"}
            busy={retryBusy}
            onAction={() => void retryConnection()}
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
    if (createSessionBusy) return;
    setCreateSessionOpen(false);
    setCreateSessionError(null);
  }

  function updateCreateSessionName(value: string) {
    setCreateSessionName(normalizeSessionNameInput(value));
    setCreateSessionError(null);
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
      setCreateSessionError(SESSION_NAME_VALIDATION_MESSAGE);
      return;
    }

    setCreateSessionBusy(true);
    setCreateSessionError(null);
    try {
      const response = await api.createSession({ cwd, name });
      setCreateSessionOpen(false);
      await loadSessions();
      navigate(`/sessions/${response.session.id}`);
    } catch (error) {
      setCreateSessionError(error instanceof Error ? error.message : "Could not create session.");
    } finally {
      setCreateSessionBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <AppBrand />
        <SessionStoplight counts={stoplightCounts} onSelect={(severity) => navigate(`/?statusSeverity=${severity}`)} />
        <div className="topbar-actions">
          {showConnectButton ? (
            <button className="icon-button" onClick={() => setConnectOpen(true)} aria-label="Connect device">
              <Smartphone size={18} />
            </button>
          ) : null}
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
        </div>
      </header>
      <main className="content">
        <Outlet
          context={
            { refreshSessionStoplight: loadSessions, syncSessionStoplight, openCreateSession, connectionEpoch } satisfies AppShellOutletContext
          }
        />
      </main>
      {createSessionOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => event.currentTarget === event.target && closeCreateSession()}
        >
          <form className="session-name-dialog" onSubmit={submitCreateSession} role="dialog" aria-modal="true" aria-labelledby="create-session-title">
            <div className="dialog-head">
              <h2 id="create-session-title">New session</h2>
              <button type="button" className="icon-button" onClick={closeCreateSession} aria-label="Close" disabled={createSessionBusy}>
                <X size={18} />
              </button>
            </div>
            <label className="rename-field">
              <span>Directory</span>
              <input
                autoFocus
                value={createSessionCwd}
                onChange={(event) => setCreateSessionCwd(event.target.value)}
                maxLength={4096}
                disabled={createSessionBusy}
                list="session-directory-suggestions"
              />
            </label>
            <datalist id="session-directory-suggestions">
              {directorySuggestions.map((suggestion) => (
                <option key={suggestion.path} value={suggestion.path} label={directorySuggestionLabel(suggestion)} />
              ))}
            </datalist>
            <label className="rename-field">
              <span>Name</span>
              <input
                value={createSessionName}
                onChange={(event) => updateCreateSessionName(event.target.value)}
                maxLength={SESSION_NAME_MAX_LENGTH}
                aria-invalid={Boolean(createSessionNameError)}
                disabled={createSessionBusy}
              />
            </label>
            {createSessionNameError ? (
              <p className="dialog-error" role="alert">
                {createSessionNameError}
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
                disabled={createSessionBusy || Boolean(createSessionNameError)}
                aria-busy={createSessionBusy}
                data-busy={createSessionBusy || undefined}
              >
                {createSessionBusy ? "Creating" : "Create"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {connectOpen ? <ConnectDeviceDialog onClose={() => setConnectOpen(false)} /> : null}
    </div>
  );
}

export function AppBrand() {
  return (
    <div className="brand">
      <img className="brand-logo" src="/favicon.svg" alt="" aria-hidden="true" />
      <strong>muxpilot</strong>
    </div>
  );
}

export interface AppShellOutletContext {
  refreshSessionStoplight: () => Promise<void>;
  syncSessionStoplight: (session: ManagedSession) => void;
  openCreateSession: (cwd?: string) => void;
  connectionEpoch: number;
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
  return isValidSessionName(normalizeSessionName(value)) ? null : SESSION_NAME_VALIDATION_MESSAGE;
}

export function syncSessionIntoStoplightSessions(currentSessions: ManagedSession[], session: ManagedSession): ManagedSession[] {
  if (session.archived || session.status === "missing") return currentSessions.filter((item) => item.id !== session.id);
  const index = currentSessions.findIndex((item) => item.id === session.id);
  if (index === -1) return [...currentSessions, session];
  const nextSessions = [...currentSessions];
  nextSessions[index] = session;
  return nextSessions;
}

export function SessionStoplight({ counts, onSelect }: { counts: SessionStoplightCounts; onSelect?: (severity: SessionStatusSeverity) => void }) {
  return (
    <div className="session-stoplight" aria-label={sessionStoplightSummary(counts)} title={sessionStoplightSummary(counts)}>
      <SessionStoplightDot severity="red" count={counts.red} label={sessionStoplightDotLabel("red", counts.red)} onSelect={onSelect} />
      <SessionStoplightDot severity="yellow" count={counts.yellow} label={sessionStoplightDotLabel("yellow", counts.yellow)} onSelect={onSelect} />
      <SessionStoplightDot severity="green" count={counts.green} label={sessionStoplightDotLabel("green", counts.green)} onSelect={onSelect} />
    </div>
  );
}

function SessionStoplightDot({
  severity,
  count,
  label,
  onSelect
}: {
  severity: SessionStatusSeverity;
  count: number;
  label: string;
  onSelect?: (severity: SessionStatusSeverity) => void;
}) {
  if (count === 0) return null;

  return (
    <button
      type="button"
      className={`session-stoplight-dot session-stoplight-dot-${severity}`}
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
    <div className="dialog-backdrop" role="presentation" onPointerDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="connect-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-device-title">
        <div className="dialog-head">
          <h2 id="connect-device-title">Connect device</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

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
      </section>
    </div>
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
                <input readOnly type={keyVisible ? "text" : "password"} value={remoteAccess.accessKey} />
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
