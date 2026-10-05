// Markdown helpers for hovers and tooltips. Text from the server or from the
// workspace is escaped so it cannot add links or commands to a trusted hover.
// Code spans in such text are re-emitted through code(), which chooses its own
// delimiters, so a run of backticks in the text can never open or close a span
// that the renderer would read differently.

// Escaping the brackets is what stops a link (and so a command link); angle
// brackets stop autolinks and HTML. Escaping every colon and at sign breaks the
// GFM extended autolinks (https://..., mailto:..., name@host), and escaping the
// dollar sign stops a theme icon ($(name)) in a hover that supports them.
// Parentheses, dashes and plus signs are left alone: the helpers never start a
// line with untrusted text. Dots are escaped only after "www", the one place a
// dot starts an autolink.
const SPECIAL = /[\\`*_{}[\]<>#|~:@$]/g;
const WWW_DOT = /\b(www)\./gi;

/** Escapes every Markdown special character. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(SPECIAL, (c) => `\\${c}`)
    .replace(WWW_DOT, "$1\\.");
}

/** The longest run of backticks in the text. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return longest;
}

/**
 * Escapes untrusted text. Single-backtick spans (`like this`, no backtick and no
 * line break inside) are rendered as code through code(); every other backtick
 * is escaped, so the result never holds a delimiter the text chose.
 */
export function inlineMarkdown(text: string): string {
  const clean = text.replace(/\r?\n/g, " ");
  const out: string[] = [];
  let last = 0;
  for (const m of clean.matchAll(/`([^`]+)`/g)) {
    const at = m.index;
    out.push(escapeMarkdown(clean.slice(last, at)));
    out.push(code(m[1] ?? ""));
    last = at + m[0].length;
  }
  out.push(escapeMarkdown(clean.slice(last)));
  return out.join("");
}

/**
 * A code span that survives backticks inside the text: the fence is one
 * backtick longer than the longest run inside, as CommonMark requires.
 */
export function code(text: string): string {
  const clean = text.replace(/\r?\n/g, " ");
  // An empty span cannot be written; two bare backticks could pair with a later fence.
  if (clean === "") return "";
  const fence = "`".repeat(longestBacktickRun(clean) + 1);
  const pad = clean.startsWith("`") || clean.endsWith("`") || (clean.startsWith(" ") && clean.endsWith(" ") && clean.trim() !== "") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/** A command link: `[title](command:id?<encoded args>)`. */
export function commandLink(title: string, command: string, args?: unknown): string {
  const query = args === undefined ? "" : `?${encodeURIComponent(JSON.stringify([args]))}`;
  return `[${escapeMarkdown(title)}](command:${command}${query})`;
}

/** A link to an https URL; the URL's parentheses and spaces are encoded. */
export function urlLink(title: string, url: string): string {
  const safe = url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[${escapeMarkdown(title)}](${safe})`;
}
