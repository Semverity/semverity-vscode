// A minimal event emitter with the vscode Event shape, so the core can expose
// events without importing vscode.

import type { Disposable, Event, Listener } from "./types";

export class Emitter<T> implements Disposable {
  private listeners = new Set<Listener<T>>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
