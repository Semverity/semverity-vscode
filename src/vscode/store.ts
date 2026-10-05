// ExtensionContext.globalState as the KeyValueStore port. The cache key is not
// registered with setKeysForSync, so cached scores never leave the machine
// through Settings Sync.

import type * as vscode from "vscode";
import type { KeyValueStore } from "../core/ports";

export class MementoStore implements KeyValueStore {
  constructor(private readonly memento: vscode.Memento) {}

  get<T>(key: string): T | undefined {
    return this.memento.get<T>(key);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    return this.memento.update(key, value);
  }
}
