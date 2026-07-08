import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppRecoveryPage, AppShell } from "./pages/AppShell.js";
import { Dashboard } from "./pages/Dashboard.js";
import { AccessPage } from "./pages/Login.js";
import { SessionView } from "./pages/SessionView.js";
import "./styles/app.css";

if (import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("muxpilot render error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <AppRecoveryPage
          title="Muxpilot hit an app error"
          message="The interface could not finish rendering. Reload the app to start a clean UI session."
          detail={this.state.error.message}
          actionLabel="Reload app"
          onAction={() => window.location.reload()}
        />
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route path="/access" element={<AccessPage />} />
        <Route path="/" element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="sessions/:id" element={<SessionViewRoute />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </AppErrorBoundary>
);

function SessionViewRoute() {
  const { id = "" } = useParams();
  return <SessionView key={id} />;
}
