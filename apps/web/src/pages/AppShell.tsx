import { Outlet, useNavigate } from "react-router-dom";
import { Check, Copy, Eye, EyeOff, LoaderCircle, LogOut, RotateCcw, Smartphone, X } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { AUTH_EXPIRED_EVENT, api, eventSocket, isUnauthorizedError } from "../api/client.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManagedSession, MeResponse, RemoteAccessResponse, SessionEvent } from "@muxpilot/core";
import { installCtrlWGuard } from "../utils/ctrlW.js";
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

export function AppShell() {
  const navigate = useNavigate();
  const [connectionState, setConnectionState] = useState<ShellConnectionState>("checking");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [showConnectButton, setShowConnectButton] = useState(false);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
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
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionEvent | { type: string };
      if (shouldRefreshSessionsForEvent(event)) scheduleLoad();
    };
    socket.onclose = () => {
      if (closing) return;
      markDisconnected();
    };
    return () => {
      closing = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(interval);
      socket.close();
    };
  }, [connectionState, loadSessions, markDisconnected]);

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

  const stoplightCounts = useMemo(() => countSessionStatuses(sessions), [sessions]);

  if (connectionState === "checking") return <div className="center-screen">Loading</div>;
  if (connectionState === "unauthorized") return null;

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>muxpilot</strong>
          <span>tmux managed</span>
        </div>
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
        {connectionState === "disconnected" ? <DisconnectedNotice /> : null}
        <Outlet context={{ refreshSessionStoplight: loadSessions, syncSessionStoplight, connectionEpoch } satisfies AppShellOutletContext} />
      </main>
      {connectOpen ? <ConnectDeviceDialog onClose={() => setConnectOpen(false)} /> : null}
    </div>
  );
}

export interface AppShellOutletContext {
  refreshSessionStoplight: () => Promise<void>;
  syncSessionStoplight: (session: ManagedSession) => void;
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

export function shouldShowConnectDeviceButton(me: Pick<MeResponse, "accessMode">): boolean {
  return me.accessMode === "local";
}

function ConnectDeviceDialog({ onClose }: { onClose: () => void }) {
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessResponse | null>(null);
  const [error, setError] = useState("");
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

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
            onCopy={copy}
            onRevoke={revokeRemoteAccess}
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
  onCopy,
  onRevoke
}: {
  remoteAccess: RemoteAccessResponse;
  copiedValue: string | null;
  revokeBusy: boolean;
  onCopy: (value: string) => void | Promise<void>;
  onRevoke: () => void | Promise<void>;
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
          <dd>{remoteAccess.accessKeyRequired ? "Access key required" : "Trusted local"}</dd>
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
