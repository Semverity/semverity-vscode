// Inline decorations after import and manifest lines (docs/DESIGN.md 9.4): one
// decoration type per grade, with a shield icon in the grade colour and the
// text in the grade's theme colour.

import * as vscode from "vscode";
import type { Grade } from "../core/api/types";
import { decorationFor, groupByLine } from "../presentation/decoration";
import { colorIdFor, GRADE_HEX, GRADE_ORDER, shieldSvg } from "../presentation/grades";
import type { PresentationSettings } from "../presentation/settings";
import type { DocumentTracker } from "./documents";

type Key = Grade | "none";
const KEYS: readonly Key[] = [...GRADE_ORDER, "none"];
const MAX_PER_EDITOR = 500;

function isLightTheme(kind: vscode.ColorThemeKind): boolean {
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

function iconUri(hex: string): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(shieldSvg(hex)).toString("base64")}`);
}

export class DecorationController implements vscode.Disposable {
  private types = new Map<Key, vscode.TextEditorDecorationType>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly tracker: DocumentTracker,
    private readonly settings: () => PresentationSettings,
  ) {
    this.createTypes();
    this.subscriptions.push(
      tracker.onDidChange((uris) => this.refreshUris(uris)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.disposeTypes();
        this.createTypes();
        this.refreshAll();
      }),
    );
  }

  private createTypes(): void {
    const palette = isLightTheme(vscode.window.activeColorTheme.kind) ? GRADE_HEX.light : GRADE_HEX.dark;
    for (const key of KEYS) {
      const muted = key === "none";
      this.types.set(
        key,
        vscode.window.createTextEditorDecorationType({
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
          before: {
            contentIconPath: iconUri(palette[key]),
            margin: "0 0.3em 0 1.5em",
            width: "12px",
            height: "12px",
          },
          after: {
            color: new vscode.ThemeColor(colorIdFor(muted ? undefined : key)),
            fontStyle: muted ? "italic" : "normal",
          },
        }),
      );
    }
  }

  private disposeTypes(): void {
    for (const t of this.types.values()) t.dispose();
    this.types.clear();
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refreshEditor(editor);
  }

  private refreshUris(uris: string[]): void {
    const wanted = new Set(uris);
    for (const editor of vscode.window.visibleTextEditors) {
      if (wanted.has(editor.document.uri.toString())) this.refreshEditor(editor);
    }
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    const byKey = new Map<Key, vscode.DecorationOptions[]>();
    for (const key of KEYS) byKey.set(key, []);
    const s = this.settings();
    if (s.decorations) {
      const doc = editor.document;
      const lines = groupByLine(this.tracker.items(doc.uri.toString()));
      let count = 0;
      for (const [line, items] of lines) {
        if (count >= MAX_PER_EDITOR) break;
        if (line < 0 || line >= doc.lineCount) continue;
        const spec = decorationFor(items, s);
        if (!spec) continue;
        const end = doc.lineAt(line).range.end;
        byKey.get(spec.iconGrade)?.push({
          range: new vscode.Range(end, end),
          renderOptions: { after: { contentText: spec.text } },
        });
        count++;
      }
    }
    for (const [key, options] of byKey) {
      const type = this.types.get(key);
      if (type) editor.setDecorations(type, options);
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.disposeTypes();
  }
}
