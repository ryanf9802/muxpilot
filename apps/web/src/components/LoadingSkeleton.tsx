import { AppBrand } from "./AppBrand.js";

export type LoadingSkeletonVariant = "dashboard" | "session" | "access";

export function loadingSkeletonVariantForPath(pathname: string): Exclude<LoadingSkeletonVariant, "access"> {
  return pathname.startsWith("/sessions/") ? "session" : "dashboard";
}

export function AppLoadingSkeleton({
  variant,
  label
}: {
  variant: LoadingSkeletonVariant;
  label?: string;
}) {
  if (variant === "access") return <AccessLoadingSkeleton label={label} />;

  const statusLabel = label ?? (variant === "session" ? "Loading session" : "Loading dashboard");
  return (
    <div className="app loading-app-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{statusLabel}</span>
      <header className="topbar" aria-hidden="true">
        <AppBrand />
        <div className="loading-topbar-status">
          <SkeletonBlock className="skeleton-dot" />
          <SkeletonBlock className="skeleton-dot" />
          <SkeletonBlock className="skeleton-dot" />
        </div>
        <div className="topbar-actions">
          <SkeletonBlock className="skeleton-icon" />
          <SkeletonBlock className="skeleton-icon" />
        </div>
      </header>
      <main className={variant === "session" ? "content content-session" : "content"} aria-hidden="true">
        {variant === "session" ? <SessionLoadingSkeleton announce={false} /> : <DashboardLoadingSkeleton announce={false} />}
      </main>
    </div>
  );
}

export function DashboardLoadingSkeleton({ announce = true }: { announce?: boolean }) {
  return (
    <section
      className="dashboard loading-dashboard-skeleton"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-busy={announce ? "true" : undefined}
    >
      {announce ? <span className="sr-only">Loading dashboard</span> : null}
      <div className="filters" aria-hidden="true">
        <div className="search-box loading-search-box">
          <SkeletonBlock className="skeleton-search-icon" />
          <SkeletonBlock className="skeleton-line skeleton-line-search" />
        </div>
        <SkeletonBlock className="skeleton-new-session" />
      </div>
      <DashboardSessionsSkeleton announce={false} />
      <div className="dashboard-usage-separator" aria-hidden="true" />
      <UsagePanelSkeleton announce={false} />
      <UsagePanelSkeleton announce={false} chart />
    </section>
  );
}

export function DashboardSessionsSkeleton({ announce = true }: { announce?: boolean }) {
  return (
    <div
      className="repo-session-groups loading-session-groups"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-busy={announce ? "true" : undefined}
    >
      {announce ? <span className="sr-only">Loading sessions</span> : null}
      {[0, 1].map((group) => (
        <section className="repo-session-group" key={group} aria-hidden="true">
          <div className="repo-session-group-head loading-repo-head">
            <SkeletonBlock className="skeleton-icon skeleton-repo-toggle" />
            <div className="loading-repo-copy">
              <SkeletonBlock className="skeleton-line skeleton-line-repo" />
              <SkeletonBlock className="skeleton-line skeleton-line-meta" />
            </div>
            <SkeletonBlock className="skeleton-line skeleton-line-count" />
          </div>
          <div className="session-grid">
            <SessionCardSkeleton />
            <SessionCardSkeleton />
          </div>
        </section>
      ))}
    </div>
  );
}

export function UsagePanelSkeleton({ announce = true, chart = false }: { announce?: boolean; chart?: boolean }) {
  return (
    <section
      className="usage-panel loading-usage-panel"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-busy={announce ? "true" : undefined}
    >
      {announce ? <span className="sr-only">Loading usage</span> : null}
      <div className="usage-panel-head" aria-hidden="true">
        <div className="loading-usage-copy">
          <SkeletonBlock className="skeleton-line skeleton-line-title" />
          <SkeletonBlock className="skeleton-line skeleton-line-meta" />
        </div>
        <div className="loading-usage-total">
          <SkeletonBlock className="skeleton-line skeleton-line-total" />
          <SkeletonBlock className="skeleton-line skeleton-line-meta" />
        </div>
      </div>
      {chart ? (
        <SkeletonBlock className="skeleton-usage-chart" />
      ) : (
        <div className="loading-limit-list" aria-hidden="true">
          <SkeletonBlock className="skeleton-line skeleton-line-wide" />
          <SkeletonBlock className="skeleton-limit-track" />
          <SkeletonBlock className="skeleton-line skeleton-line-wide" />
          <SkeletonBlock className="skeleton-limit-track" />
        </div>
      )}
      <div className="loading-usage-stats" aria-hidden="true">
        <SkeletonBlock className="skeleton-line skeleton-line-stat" />
        <SkeletonBlock className="skeleton-line skeleton-line-stat" />
        <SkeletonBlock className="skeleton-line skeleton-line-stat" />
      </div>
    </section>
  );
}

export function SessionLoadingSkeleton({ announce = true, label = "Loading session" }: { announce?: boolean; label?: string }) {
  return (
    <section
      className="session-view loading-session-skeleton"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-busy={announce ? "true" : undefined}
    >
      {announce ? <span className="sr-only">{label}</span> : null}
      <div className="session-header" aria-hidden="true">
        <SkeletonBlock className="skeleton-icon skeleton-back" />
        <div className="session-title loading-session-title">
          <SkeletonBlock className="skeleton-line skeleton-line-session-title" />
          <SkeletonBlock className="skeleton-line skeleton-line-session-meta" />
        </div>
        <SkeletonBlock className="skeleton-pill" />
        <SkeletonBlock className="skeleton-session-command" />
        <SkeletonBlock className="skeleton-mode-toggle" />
      </div>
      <div className="actions" aria-hidden="true">
        <div className="actions-main">
          <SkeletonBlock className="skeleton-action skeleton-action-square" />
          <SkeletonBlock className="skeleton-action" />
          <SkeletonBlock className="skeleton-action skeleton-action-short" />
        </div>
        <div className="actions-jump">
          <SkeletonBlock className="skeleton-action skeleton-action-short" />
          <SkeletonBlock className="skeleton-action skeleton-action-short" />
        </div>
      </div>
      <div className="transcript-pane" aria-hidden="true">
        <div className="message-list loading-message-list">
          <MessageSkeleton className="loading-message-assistant" lines={3} />
          <MessageSkeleton className="loading-message-user" lines={2} />
          <MessageSkeleton className="loading-message-assistant loading-message-narrow" lines={2} />
        </div>
      </div>
      <div className="composer-stack" aria-hidden="true">
        <div className="composer loading-composer">
          <SkeletonBlock className="skeleton-composer-input" />
          <SkeletonBlock className="skeleton-composer-send" />
        </div>
      </div>
    </section>
  );
}

export function AccessLoadingSkeleton({ label = "Checking access" }: { label?: string }) {
  return (
    <div className="login-page loading-access-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="login-card loading-access-card" aria-hidden="true">
        <SkeletonBlock className="skeleton-access-mark" />
        <SkeletonBlock className="skeleton-line skeleton-line-access-title" />
        <div className="loading-access-field">
          <SkeletonBlock className="skeleton-line skeleton-line-label" />
          <SkeletonBlock className="skeleton-access-input" />
        </div>
        <SkeletonBlock className="skeleton-access-button" />
      </div>
    </div>
  );
}

function SessionCardSkeleton() {
  return (
    <div className="session-card loading-session-card" aria-hidden="true">
      <div className="card-head">
        <SkeletonBlock className="skeleton-line skeleton-line-card-title" />
        <SkeletonBlock className="skeleton-pill" />
      </div>
      <div className="preview loading-card-preview">
        <SkeletonBlock className="skeleton-line skeleton-line-wide" />
        <SkeletonBlock className="skeleton-line skeleton-line-preview" />
      </div>
      <div className="card-foot">
        <SkeletonBlock className="skeleton-line skeleton-line-card-foot" />
        <SkeletonBlock className="skeleton-line skeleton-line-card-events" />
      </div>
    </div>
  );
}

function MessageSkeleton({ className, lines }: { className: string; lines: number }) {
  return (
    <div className={`message loading-message ${className}`}>
      <SkeletonBlock className="skeleton-line skeleton-line-message-meta" />
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonBlock
          className={index === lines - 1 ? "skeleton-line skeleton-line-message-last" : "skeleton-line skeleton-line-wide"}
          key={index}
        />
      ))}
    </div>
  );
}

function SkeletonBlock({ className }: { className: string }) {
  return <span className={`skeleton-block ${className}`} aria-hidden="true" />;
}
