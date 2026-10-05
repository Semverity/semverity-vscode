// The API key in VS Code SecretStorage. It is never written to settings, the
// cache or the log; the core reads it through the SecretSource port when it
// builds a request.

import type * as vscode from "vscode";
import type { SecretSource } from "../core/ports";
import type { Disposable, Event } from "../core/types";

export const API_KEY_SECRET = "semverity.apiKey";

/** The expected shape of a Semverity API key: "svk_" followed by 40 characters. */
export function looksLikeApiKey(value: string): boolean {
  return /^svk_\S{40}$/.test(value);
}

export class ApiKeyStore implements SecretSource, Disposable {
  private readonly listeners = new Set<() => void>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.subscription = secrets.onDidChange((e) => {
      if (e.key !== API_KEY_SECRET) return;
      for (const l of [...this.listeners]) l();
    });
  }

  readonly onDidChange: Event<void> = (listener) => {
    const l = () => listener(undefined);
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  };

  async getApiKey(): Promise<string | undefined> {
    const value = await this.secrets.get(API_KEY_SECRET);
    return value && value.trim() ? value.trim() : undefined;
  }

  async set(key: string): Promise<void> {
    await this.secrets.store(API_KEY_SECRET, key.trim());
  }

  async clear(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET);
  }

  dispose(): void {
    this.listeners.clear();
    this.subscription.dispose();
  }
}
