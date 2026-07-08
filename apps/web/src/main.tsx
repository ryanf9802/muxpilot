import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./pages/AppShell.js";
import { Dashboard } from "./pages/Dashboard.js";
import { AccessPage } from "./pages/Login.js";
import { SessionView } from "./pages/SessionView.js";
import "./styles/app.css";

if (import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

createRoot(document.getElementById("root")!).render(
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
);

function SessionViewRoute() {
  const { id = "" } = useParams();
  return <SessionView key={id} />;
}
