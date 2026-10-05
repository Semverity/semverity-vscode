// An in-memory KeyValueStore standing in for ExtensionContext.globalState.

import type { KeyValueStore } from "../../src/core/ports";

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  writes = 0;

  get<T>(key: string): T | undefined {
    const v = this.data.get(key);
    // Mementos hand back copies of JSON values; do the same so tests catch shared mutation.
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }

  update(key: string, value: unknown): Promise<void> {
    this.writes++;
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, JSON.parse(JSON.stringify(value)));
    return Promise.resolve();
  }
}
