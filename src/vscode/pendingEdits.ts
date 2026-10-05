// The healthy-version edits a hover offers as "Use x" links. The link carries
// only an opaque id; the edit itself stays here, computed by the extension, so
// Markdown in a hover can never ask the apply command to edit anything else.

import type { DeclaredIn } from "../core/types";

export interface PendingEdit {
  declaredIn: DeclaredIn;
  version: string;
}

const MAX_PENDING = 200;

export class PendingEdits {
  private readonly edits = new Map<string, PendingEdit>();
  private next = 0;
  private readonly salt = Math.random().toString(36).slice(2, 10);

  /** Stores an edit and returns the id for the command link. */
  register(edit: PendingEdit): string {
    const id = `${this.salt}-${++this.next}`;
    this.edits.set(id, edit);
    while (this.edits.size > MAX_PENDING) {
      const oldest = this.edits.keys().next().value;
      if (oldest === undefined) break;
      this.edits.delete(oldest);
    }
    return id;
  }

  get(id: unknown): PendingEdit | undefined {
    return typeof id === "string" ? this.edits.get(id) : undefined;
  }
}
