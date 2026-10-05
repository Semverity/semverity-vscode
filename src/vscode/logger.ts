// The "Semverity" log output channel as the Logger port. Callers pass only
// coordinates, API paths, status codes and error codes; never headers, the API
// key, file contents or paths.

import * as vscode from "vscode";
import type { Logger } from "../core/ports";

export class ChannelLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel("Semverity", { log: true });
  }

  debug(message: string): void {
    this.channel.debug(message);
  }

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string): void {
    this.channel.error(message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
