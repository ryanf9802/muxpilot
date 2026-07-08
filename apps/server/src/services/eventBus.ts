import type { SessionEvent } from "@muxpilot/core";

type Listener = (event: SessionEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

