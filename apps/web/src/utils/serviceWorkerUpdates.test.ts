// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceWorkerUpdateCoordinator } from "./serviceWorkerUpdates.js";

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  postMessage = vi.fn();
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(async () => this);
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  register = vi.fn(async () => this.registration);

  constructor(readonly registration: FakeRegistration) {
    super();
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

afterEach(() => vi.restoreAllMocks());

describe("ServiceWorkerUpdateCoordinator", () => {
  it("does not announce a first-time installation", async () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();
    const container = new FakeContainer(registration);
    const coordinator = coordinatorFor(container);
    const availability = vi.fn();
    coordinator.subscribe(availability);

    await coordinator.start();

    expect(container.register).toHaveBeenCalledWith("/sw.js", { updateViaCache: "none" });
    expect(availability).toHaveBeenLastCalledWith(false);
  });

  it("announces an already-waiting update for a controlled page", async () => {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();
    const container = new FakeContainer(registration);
    container.controller = new FakeWorker();
    const coordinator = coordinatorFor(container);
    const availability = vi.fn();
    coordinator.subscribe(availability);

    await coordinator.start();

    expect(availability).toHaveBeenLastCalledWith(true);
  });

  it("announces an update after a new worker finishes installing", async () => {
    const registration = new FakeRegistration();
    const installing = new FakeWorker();
    registration.installing = installing;
    const container = new FakeContainer(registration);
    container.controller = new FakeWorker();
    const coordinator = coordinatorFor(container);
    const availability = vi.fn();
    coordinator.subscribe(availability);
    await coordinator.start();

    registration.dispatchEvent(new Event("updatefound"));
    registration.waiting = installing;
    installing.state = "installed";
    installing.dispatchEvent(new Event("statechange"));

    expect(availability).toHaveBeenLastCalledWith(true);
  });

  it("observes an installer that already exists when registration resolves", async () => {
    const registration = new FakeRegistration();
    const installing = new FakeWorker();
    registration.installing = installing;
    const container = new FakeContainer(registration);
    container.controller = new FakeWorker();
    const coordinator = coordinatorFor(container);
    const availability = vi.fn();
    coordinator.subscribe(availability);
    await coordinator.start();

    registration.waiting = installing;
    installing.state = "installed";
    installing.dispatchEvent(new Event("statechange"));

    expect(availability).toHaveBeenLastCalledWith(true);
  });

  it("activates the waiting worker and reloads exactly once after control changes", async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker();
    registration.waiting = waiting;
    const container = new FakeContainer(registration);
    container.controller = new FakeWorker();
    const reload = vi.fn();
    const coordinator = coordinatorFor(container, reload);
    await coordinator.start();

    expect(coordinator.activateUpdate()).toBe(true);
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange"));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("checks again when the app returns to the foreground", async () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer(registration);
    const document = new FakeDocument();
    const coordinator = new ServiceWorkerUpdateCoordinator({ container, document, reload: vi.fn() });
    await coordinator.start();
    expect(registration.update).toHaveBeenCalledTimes(1);

    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("leaves the app usable when registration fails", async () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer(registration);
    container.register.mockRejectedValueOnce(new Error("unsupported"));
    const coordinator = coordinatorFor(container);

    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(coordinator.activateUpdate()).toBe(false);
  });
});

function coordinatorFor(container: FakeContainer, reload = vi.fn()) {
  return new ServiceWorkerUpdateCoordinator({ container, document: new FakeDocument(), reload });
}
