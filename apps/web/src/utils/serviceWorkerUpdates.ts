type UpdateListener = (available: boolean) => void;

interface ServiceWorkerLike extends EventTarget {
  state: ServiceWorkerState;
  postMessage(message: unknown): void;
}

interface ServiceWorkerRegistrationLike extends EventTarget {
  installing: ServiceWorkerLike | null;
  waiting: ServiceWorkerLike | null;
  update(): Promise<ServiceWorkerRegistration> | Promise<ServiceWorkerRegistrationLike>;
}

interface ServiceWorkerContainerLike extends EventTarget {
  controller: ServiceWorker | ServiceWorkerLike | null;
  register(scriptURL: string | URL, options?: RegistrationOptions): Promise<ServiceWorkerRegistration> | Promise<ServiceWorkerRegistrationLike>;
}

interface ServiceWorkerUpdateEnvironment {
  container: ServiceWorkerContainerLike;
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  reload: () => void;
}

export class ServiceWorkerUpdateCoordinator {
  private registration: ServiceWorkerRegistrationLike | null = null;
  private waiting: ServiceWorkerLike | null = null;
  private readonly observedInstallers = new WeakSet<ServiceWorkerLike>();
  private readonly listeners = new Set<UpdateListener>();
  private activationRequested = false;
  private reloaded = false;
  private started = false;

  constructor(private readonly environment: ServiceWorkerUpdateEnvironment) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.environment.container.addEventListener("controllerchange", this.handleControllerChange);
    this.environment.document.addEventListener("visibilitychange", this.handleVisibilityChange);

    try {
      const registration = await this.environment.container.register("/sw.js", { updateViaCache: "none" });
      this.registration = registration;
      registration.addEventListener("updatefound", this.handleUpdateFound);
      this.captureWaitingWorker();
      this.observeInstallingWorker();
      void registration.update().catch(() => undefined);
    } catch {
      // The app remains fully usable when service workers are unavailable.
    }
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.waiting !== null);
    return () => this.listeners.delete(listener);
  }

  activateUpdate(): boolean {
    if (!this.waiting) return false;
    this.activationRequested = true;
    this.waiting.postMessage({ type: "SKIP_WAITING" });
    return true;
  }

  dispose(): void {
    this.environment.container.removeEventListener("controllerchange", this.handleControllerChange);
    this.environment.document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.registration?.removeEventListener("updatefound", this.handleUpdateFound);
    this.listeners.clear();
  }

  private readonly handleUpdateFound = () => this.observeInstallingWorker();

  private observeInstallingWorker(): void {
    const installing = this.registration?.installing;
    if (!installing || this.observedInstallers.has(installing)) return;
    this.observedInstallers.add(installing);
    const handleStateChange = () => {
      if (installing.state !== "installed") return;
      installing.removeEventListener("statechange", handleStateChange);
      this.captureWaitingWorker();
    };
    installing.addEventListener("statechange", handleStateChange);
    handleStateChange();
  }

  private readonly handleVisibilityChange = () => {
    if (this.environment.document.visibilityState !== "visible") return;
    void this.registration?.update().catch(() => undefined);
  };

  private readonly handleControllerChange = () => {
    if (!this.activationRequested || this.reloaded) return;
    this.reloaded = true;
    this.environment.reload();
  };

  private captureWaitingWorker(): void {
    if (!this.environment.container.controller || !this.registration?.waiting) return;
    this.waiting = this.registration.waiting;
    for (const listener of this.listeners) listener(true);
  }
}

export function browserServiceWorkerUpdateCoordinator(): ServiceWorkerUpdateCoordinator | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return new ServiceWorkerUpdateCoordinator({
    container: navigator.serviceWorker,
    document,
    reload: () => window.location.reload()
  });
}
