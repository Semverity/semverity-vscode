// Read-only workspace file access as the FileSource port. Unsaved editor
// contents win over disk. Nothing read here is sent anywhere: the core turns
// it into package coordinates locally.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { FileSource } from "../core/ports";

const MAX_BYTES = 5 * 1024 * 1024;

export class WorkspaceFiles implements FileSource {
  private readonly decoder = new TextDecoder("utf-8");

  roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString().replace(/\/+$/, ""));
  }

  async readText(uri: string): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (open) return open.getText();
    try {
      const u = vscode.Uri.parse(uri, true);
      const stat = await vscode.workspace.fs.stat(u);
      if (stat.type & vscode.FileType.Directory || stat.size > MAX_BYTES) return undefined;
      return this.decoder.decode(await vscode.workspace.fs.readFile(u));
    } catch {
      return undefined;
    }
  }

  async findFiles(include: string, exclude?: string, maxResults?: number): Promise<string[]> {
    try {
      const found = await vscode.workspace.findFiles(include, exclude, maxResults);
      return found.map((u) => u.toString());
    } catch {
      return [];
    }
  }

  async exists(uri: string): Promise<boolean> {
    if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri)) return true;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.parse(uri, true));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A user-level registry file: ~/.npmrc (or $NPM_CONFIG_USERCONFIG),
   * ~/.yarnrc, ~/.yarnrc.yml, and Bun's $XDG_CONFIG_HOME/.bunfig.toml or
   * ~/.bunfig.toml. The core reads only registry URLs from them.
   */
  async readUserConfig(name: ".npmrc" | ".yarnrc" | ".yarnrc.yml" | "bunfig.toml"): Promise<string | undefined> {
    const env = process.env;
    let home: string;
    try {
      home = homedir();
    } catch {
      return undefined;
    }
    const paths: string[] = [];
    if (name === ".npmrc") paths.push(env["NPM_CONFIG_USERCONFIG"] || env["npm_config_userconfig"] || join(home, ".npmrc"));
    else if (name === "bunfig.toml") {
      if (env["XDG_CONFIG_HOME"]) paths.push(join(env["XDG_CONFIG_HOME"], ".bunfig.toml"));
      paths.push(join(home, ".bunfig.toml"));
    } else paths.push(join(home, name));
    // The first file that exists is the one the tool reads.
    for (const path of paths) {
      try {
        const st = await stat(path);
        if (st.isFile() && st.size <= MAX_BYTES) return await readFile(path, "utf8");
      } catch {
        // Absent; try the next location.
      }
    }
    return undefined;
  }
}
