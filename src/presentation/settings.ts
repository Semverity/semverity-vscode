// The settings the pure presentation functions read. Built from the extension
// settings by toPresentationSettings() in src/settings.ts.

import type { ScoreBasis } from "./grades";

export interface PresentationSettings {
  decorations: boolean;
  showUnscored: boolean;
  hovers: boolean;
  diagnostics: boolean;
  scoreBasis: ScoreBasis;
  /** 0 turns the warning off. */
  warningBelow: number;
  /** 0 turns the error off. */
  errorBelow: number;
  /** Gate ids that raise a warning (malware and KEV always raise an error). */
  gates: readonly string[];
  /** Base URL of the web site, for package page links. */
  siteBaseUrl: string;
}

export const DEFAULT_WARNING_GATES: readonly string[] = [
  "high_vuln_with_fix",
  "unfixed_high_vuln",
  "yanked",
  "typosquat",
  "install_script_untrusted",
  "dependency_confusion",
  "denied_package",
  "license_denied",
];

export const DEFAULT_PRESENTATION_SETTINGS: PresentationSettings = {
  decorations: true,
  showUnscored: true,
  hovers: true,
  diagnostics: true,
  scoreBasis: "headline",
  warningBelow: 65,
  errorBelow: 0,
  gates: DEFAULT_WARNING_GATES,
  siteBaseUrl: "https://semverity.dev",
};
