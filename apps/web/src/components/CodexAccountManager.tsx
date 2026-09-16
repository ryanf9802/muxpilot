import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexAuthLogin, CodexAuthState } from "@muxpilot/core";
import { api } from "../api/client.js";

export function CodexAccountManager() {
  const [state, setState] = useState<CodexAuthState | null>(null);
  const [login, setLogin] = useState<CodexAuthLogin | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loginRef = useRef<CodexAuthLogin | null>(null);
  loginRef.current = login;
  const load = useCallback(async () => {
    try { setState(await api.codexAuth()); } catch (cause) { setError(message(cause)); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!login || login.status !== "pending") return;
    const timer = window.setInterval(() => void api.codexAuthLogin(login.id).then((next) => {
      setLogin(next);
      if (next.status === "completed") void load();
    }).catch((cause) => setError(message(cause))), 2_000);
    return () => window.clearInterval(timer);
  }, [load, login]);

  useEffect(() => () => {
    const active = loginRef.current;
    if (active?.status === "pending") void api.cancelCodexAuthLogin(active.id);
  }, []);

  async function mutate(operation: () => Promise<CodexAuthState>) {
    setBusy(true); setError("");
    try { setState(await operation()); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  async function startLogin(replaceProfileId?: string) {
    const requestedLabel = replaceProfileId ? state?.profiles.find((profile) => profile.id === replaceProfileId)?.label : label.trim();
    if (!requestedLabel) return;
    setBusy(true); setError("");
    try { setLogin(await api.startCodexAuthLogin({ label: requestedLabel, replaceProfileId })); setLabel(""); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  if (!state) return <div className="codex-account-manager"><p>Checking Codex accounts…</p></div>;
  return (
    <div className="codex-account-manager">
      <div className="usage-panel-head">
        <div>
          <p><strong>Active account:</strong> {state.account?.email ?? state.account?.type ?? "None"} · {state.status.replaceAll("_", " ")}</p>
        </div>
        <div className="usage-panel-controls">
          <button className="secondary-button" disabled={busy} onClick={() => void mutate(api.refreshCodexAuth)}>Refresh</button>
        </div>
      </div>
      {state.error ? <p className="dialog-error" role="alert">{state.error}</p> : null}
      {state.pendingSessionIds.length ? <p>Waiting for {state.pendingSessionIds.length} active session{state.pendingSessionIds.length === 1 ? "" : "s"} to reach a safe boundary.</p> : null}
      {state.credentialStorage === "unsupported" ? <p>Saved accounts are unavailable with the configured Codex credential store.</p> : (
        <>
          <div className="codex-account-add">
            <input value={label} maxLength={80} placeholder="Account label" aria-label="New Codex account label" onChange={(event) => setLabel(event.currentTarget.value)} />
            <button className="secondary-button" disabled={busy || !label.trim()} onClick={() => void startLogin()}>Add account</button>
          </div>
          <ul className="codex-account-list">
            {state.profiles.map((profile) => <li key={profile.id}>
              <span><strong>{profile.label}</strong><small>{profile.account.email ?? profile.account.type}{profile.id === state.activeProfileId ? " · active" : ""}</small></span>
              <span>
                <button disabled={busy || profile.id === state.activeProfileId || profile.requiresReauthentication} onClick={() => void mutate(() => api.activateCodexAuthProfile(profile.id))}>Use</button>
                <button disabled={busy} onClick={() => void startLogin(profile.id)}>Reauthenticate</button>
                <button disabled={busy} onClick={() => { const next = window.prompt("Account label", profile.label); if (next?.trim()) void mutate(() => api.renameCodexAuthProfile(profile.id, next.trim())); }}>Rename</button>
                <button disabled={busy} onClick={() => void mutate(() => api.forgetCodexAuthProfile(profile.id))}>Forget</button>
              </span>
            </li>)}
          </ul>
        </>
      )}
      {login ? <div className="codex-device-login" role="status">
        {login.status === "pending" ? <><p>Open <a href={login.verificationUrl ?? undefined} target="_blank" rel="noreferrer">the Codex sign-in page</a> and enter:</p><code>{login.userCode ?? "Waiting for code…"}</code></> : <p>{login.status === "completed" ? "Account saved." : login.error ?? `Login ${login.status}.`}</p>}
        <button onClick={() => { if (login.status === "pending") void api.cancelCodexAuthLogin(login.id); setLogin(null); }}>{login.status === "pending" ? "Cancel" : "Close"}</button>
      </div> : null}
      {error ? <p className="dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
