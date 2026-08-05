import { useEffect, useState } from "react";
import type { ServiceWorkerUpdateCoordinator } from "../utils/serviceWorkerUpdates.js";

export function AppUpdatePrompt({ coordinator }: { coordinator: ServiceWorkerUpdateCoordinator | null }) {
  const [available, setAvailable] = useState(false);
  const [activating, setActivating] = useState(false);

  useEffect(() => coordinator?.subscribe(setAvailable), [coordinator]);

  if (!available) return null;
  return (
    <AppUpdateNotice
      activating={activating}
      onReload={() => {
        if (!coordinator?.activateUpdate()) return;
        setActivating(true);
      }}
    />
  );
}

export function AppUpdateNotice({ activating, onReload }: { activating: boolean; onReload: () => void }) {
  return (
    <aside className="app-update-prompt" role="status" aria-live="polite">
      <span>A muxpilot update is available.</span>
      <button type="button" disabled={activating} onClick={onReload}>
        {activating ? "Updating…" : "Reload"}
      </button>
    </aside>
  );
}
