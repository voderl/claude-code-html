import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as diff from "diff";
import hljs from "highlight.js/lib/core";
import bashLang from "highlight.js/lib/languages/bash";
import cLang from "highlight.js/lib/languages/c";
import cppLang from "highlight.js/lib/languages/cpp";
import cssLang from "highlight.js/lib/languages/css";
import goLang from "highlight.js/lib/languages/go";
import javaLang from "highlight.js/lib/languages/java";
import javascriptLang from "highlight.js/lib/languages/javascript";
import jsonLang from "highlight.js/lib/languages/json";
import markdownLang from "highlight.js/lib/languages/markdown";
import pythonLang from "highlight.js/lib/languages/python";
import rustLang from "highlight.js/lib/languages/rust";
import scssLang from "highlight.js/lib/languages/scss";
import sqlLang from "highlight.js/lib/languages/sql";
import typescriptLang from "highlight.js/lib/languages/typescript";
import xmlLang from "highlight.js/lib/languages/xml";
import yamlLang from "highlight.js/lib/languages/yaml";

// Only the languages we expect to see in JSONL transcripts. Skipping the
// full hljs bundle keeps the runtime bundle ~10x smaller.
hljs.registerLanguage("bash", bashLang);
hljs.registerLanguage("c", cLang);
hljs.registerLanguage("cpp", cppLang);
hljs.registerLanguage("css", cssLang);
hljs.registerLanguage("go", goLang);
hljs.registerLanguage("java", javaLang);
hljs.registerLanguage("javascript", javascriptLang);
hljs.registerLanguage("json", jsonLang);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("python", pythonLang);
hljs.registerLanguage("rust", rustLang);
hljs.registerLanguage("scss", scssLang);
hljs.registerLanguage("sql", sqlLang);
hljs.registerLanguage("typescript", typescriptLang);
hljs.registerLanguage("xml", xmlLang);
hljs.registerLanguage("yaml", yamlLang);

/**
 * Renderer for Claude Code session JSONL transcripts.
 *
 * Reads `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` and turns each
 * entry into the same on-page widgets the tmux capture produces: top banner,
 * `❯` user prompts, `⏺` assistant text, collapsible tool calls with `⎿`
 * output, `✻ Worked for Ns` duration markers, `※ recap:` away summaries, and
 * the bottom permission bar.
 *
 * Subagents live as their own JSONL files under `<sessionId>/subagents/` and
 * are rendered into separate `<template data-subagent-id="…">` blocks. The
 * page script swaps to the subagent body when the URL has `?sub_agent=ID`.
 */

// ──────────────────────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────────────────────

/** Generic JSONL entry. Only fields we actually use are typed; rest is `any`. */
export interface JsonlEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  permissionMode?: string;
  durationMs?: number;
  content?: any;
  message?: any;
  toolUseResult?: any;
  sourceToolAssistantUUID?: string;
  promptId?: string;
  attachment?: any;
  [k: string]: any;
}

export interface SubagentBundle {
  agentId: string;
  description: string;
  agentType: string;
  entries: JsonlEntry[];
}

export interface RenderJsonlOpts {
  jsonlPath: string;
  /** Override the <title>. Defaults to the session's aiTitle or "Claude Code Session <id>". */
  title?: string;
  /** Base monospace size in px. Default 14. */
  fontPx?: number;
}

// ──────────────────────────────────────────────────────────────────────────
//  Style palette — picked to match the existing tmux-rendered samples.
// ──────────────────────────────────────────────────────────────────────────

const C = {
  // foregrounds
  gray:        "rgb(148,148,148)",
  white:       "rgb(255,255,255)",
  dimWhite:    "rgb(220,220,220)",
  green:       "rgb(135,215,135)",
  red:         "rgb(215,135,135)",
  errorRed:    "rgb(255,0,95)",
  blueLink:    "rgb(175,215,255)",
  cyan:        "rgb(95,215,255)",
  yellow:      "rgb(215,215,135)",
  orange:      "rgb(255,135,0)",
  pink:        "rgb(255,135,175)",
  dim:         "rgb(108,108,108)",
  promptArrow: "rgb(78,78,78)",
  // diff highlight backgrounds (Claude Code-ish green/red tints)
  diffAddBg:   "rgb(0,75,0)",
  diffAddFg:   "rgb(175,255,175)",
  diffDelBg:   "rgb(95,0,0)",
  diffDelFg:   "rgb(255,175,175)",
  // backgrounds
  bgPrompt:    "rgb(58,58,58)",
  bgIconBlack: "rgb(0,0,0)",
} as const;

// CJK Unified Ideographs + extensions, Hiragana, Katakana, CJK Symbols and
// Punctuation, Halfwidth and Fullwidth Forms. Each glyph occupies 2 terminal
// cells; we wrap runs in <span class="cjk" style="width:Nch"> to keep glyph
// spacing close to the terminal rendering even with prose mixed with ASCII.
const CJK_RUN_RE = /[⺀-⻿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]+/g;

// ──────────────────────────────────────────────────────────────────────────
//  Small HTML helpers
// ──────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default:  return "&#39;";
    }
  });
}

/**
 * Escape text + wrap any consecutive CJK run in a fixed-width inline-block so
 * 2-cell glyphs occupy 2ch on the page. This is what keeps Chinese prose
 * looking aligned with surrounding ASCII without a per-character span.
 */
function escapeAndWrapCJK(s: string): string {
  const escaped = escapeHtml(s);
  return escaped.replace(
    CJK_RUN_RE,
    (run) => `<span class="cjk" style="width:${run.length * 2}ch">${run}</span>`,
  );
}

interface SpanOpts {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  /** Skip CJK wrapping — useful for known-ASCII content. */
  rawText?: boolean;
}

function span(text: string, opts: SpanOpts = {}): string {
  const inner = opts.rawText ? escapeHtml(text) : escapeAndWrapCJK(text);
  return wrapSpan(inner, opts);
}

/**
 * Same as `span()` but the inner content is already-rendered HTML — used when
 * we need to wrap a tokenized run (e.g. bash highlight output) in a single
 * background span without re-escaping the inner markup.
 */
function spanHtml(innerHtml: string, opts: SpanOpts = {}): string {
  return wrapSpan(innerHtml, opts);
}

function wrapSpan(inner: string, opts: SpanOpts): string {
  const style: string[] = [];
  if (opts.bold) style.push("font-weight:500");
  if (opts.italic) style.push("font-style:italic");
  if (opts.fg) style.push(`color:${opts.fg}`);
  if (opts.bg) style.push(`background-color:${opts.bg}`);
  if (style.length === 0) return inner;
  return `<span style="${style.join(";")}">${inner}</span>`;
}

// ──────────────────────────────────────────────────────────────────────────
//  Style → class consolidator.
//
//  The renderers above emit raw `<span style="…">` markup because that's the
//  simplest local API. Before the page ships, we run StyleClassifier across
//  the whole document: every unique style string gets mapped to a CSS class
//  and the inline attribute is rewritten as `class="…"`.
//
//    - `width:Nch` → semantic name `w-N` (so `w-2`, `w-4`, … `w-100`).
//      These are extremely repetitive — one per CJK glyph run — so the
//      semantic names also make the markup easier to scan.
//    - everything else → short alpha-numeric name (a, b, c, …, aa, ab, …)
//      via the same shortName scheme the legacy tmux renderer used.
// ──────────────────────────────────────────────────────────────────────────

class StyleClassifier {
  private map = new Map<string, string>();
  private widthSeen = new Set<number>();
  private n = 0;

  /** Look up (or allocate) the class for a given inline-style string. */
  classify(style: string): string {
    const cached = this.map.get(style);
    if (cached !== undefined) return cached;
    // Semantic naming for CJK widths.
    const wMatch = style.match(/^width:(\d+)ch$/);
    if (wMatch) {
      const w = parseInt(wMatch[1], 10);
      const cls = `w-${w}`;
      this.map.set(style, cls);
      this.widthSeen.add(w);
      return cls;
    }
    const cls = shortName(this.n++);
    this.map.set(style, cls);
    return cls;
  }

  /** Emit CSS for every class registered so far. */
  cssRules(): string {
    let css = "";
    for (const [style, cls] of this.map) css += `.${cls}{${style}}`;
    return css;
  }
}

// Class identifiers must start with a letter (52 options) and may continue
// with letters or digits (62 options).
const SC_LEAD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SC_REST = SC_LEAD + "0123456789";

function shortName(n: number): string {
  let len = 1;
  let offset = 0;
  let cap = SC_LEAD.length;
  while (n - offset >= cap) {
    offset += cap;
    len++;
    cap = SC_LEAD.length * Math.pow(SC_REST.length, len - 1);
  }
  let m = n - offset;
  let s = "";
  for (let i = 0; i < len - 1; i++) {
    s = SC_REST[m % SC_REST.length] + s;
    m = Math.floor(m / SC_REST.length);
  }
  return SC_LEAD[m] + s;
}

/**
 * Walk every opening tag in `html`, peel off its `style="…"` attribute, and
 * rewrite it as `class="…"`. If the tag already has a class (e.g. the `cjk`
 * marker on CJK runs), the new class is appended to the existing list.
 */
function classifyHtml(html: string, sc: StyleClassifier): string {
  return html.replace(/<([a-zA-Z][\w-]*)([^>]*)>/g, (full, tag: string, attrs: string) => {
    const styleMatch = attrs.match(/\sstyle="([^"]*)"/);
    if (!styleMatch) return full;
    const style = styleMatch[1];
    const cls = sc.classify(style);
    let rest = attrs.replace(/\sstyle="[^"]*"/, "");
    const classMatch = rest.match(/\sclass="([^"]*)"/);
    if (classMatch) {
      rest = rest.replace(/\sclass="[^"]*"/, ` class="${classMatch[1]} ${cls}"`);
    } else {
      rest = ` class="${cls}"` + rest;
    }
    return `<${tag}${rest}>`;
  });
}

// ──────────────────────────────────────────────────────────────────────────
//  Bash syntax highlighter.
//
//  Claude Code uses highlight.js with the bash language + a terminal theme
//  to color bash commands. We mirror the result with a small regex-based
//  tokenizer — close enough for the on-page summary, and a lot cheaper than
//  bundling hljs.
//
//  Colors are picked to be close to the terminal theme: command names + paths
//  in light blue, flags in orange, quoted strings in green, operators in
//  gray, variables in yellow, comments dim gray.
// ──────────────────────────────────────────────────────────────────────────

const BASH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done",
  "case", "esac", "while", "until", "function", "select", "return",
]);
const BASH_BUILTINS = new Set([
  "cd", "echo", "printf", "export", "set", "unset", "source", "alias",
  "exit", "shift", "test", "trap", "eval", "exec", "read", "wait", "kill",
  "pwd", "umask", "readonly", "local", "declare", "let",
]);

type BashTok =
  | { kind: "ws"; value: string }
  | { kind: "string"; value: string }
  | { kind: "comment"; value: string }
  | { kind: "var"; value: string }
  | { kind: "subshell-open"; value: string }
  | { kind: "subshell-close"; value: string }
  | { kind: "operator"; value: string }
  | { kind: "flag"; value: string }
  | { kind: "word"; value: string };

/**
 * Tokenize a bash command. The grammar is intentionally light — we recognize
 * strings, comments, variables, sub-shells, and operators, and everything
 * else lands in `word`. A post-pass on the token list classifies which words
 * sit in command position.
 */
function tokenizeBash(cmd: string): BashTok[] {
  const tokens: BashTok[] = [];
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    const ch = cmd[i];
    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n") {
      let j = i;
      while (j < len && (cmd[j] === " " || cmd[j] === "\t" || cmd[j] === "\n")) j++;
      tokens.push({ kind: "ws", value: cmd.slice(i, j) });
      i = j;
      continue;
    }
    // Comments (# to end of line). Only treat as comment when at word boundary.
    if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) {
      let j = i;
      while (j < len && cmd[j] !== "\n") j++;
      tokens.push({ kind: "comment", value: cmd.slice(i, j) });
      i = j;
      continue;
    }
    // Double-quoted string
    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        if (cmd[j] === "\\" && j + 1 < len) { j += 2; continue; }
        if (cmd[j] === '"') { j++; break; }
        j++;
      }
      tokens.push({ kind: "string", value: cmd.slice(i, j) });
      i = j;
      continue;
    }
    // Single-quoted string (no escapes inside)
    if (ch === "'") {
      let j = i + 1;
      while (j < len && cmd[j] !== "'") j++;
      if (j < len) j++;
      tokens.push({ kind: "string", value: cmd.slice(i, j) });
      i = j;
      continue;
    }
    // Backtick subshell
    if (ch === "`") {
      let j = i + 1;
      while (j < len && cmd[j] !== "`") {
        if (cmd[j] === "\\" && j + 1 < len) { j += 2; continue; }
        j++;
      }
      if (j < len) j++;
      tokens.push({ kind: "string", value: cmd.slice(i, j) });
      i = j;
      continue;
    }
    // Variable: $WORD or ${...}
    if (ch === "$") {
      if (cmd[i + 1] === "(") {
        tokens.push({ kind: "subshell-open", value: "$(" });
        i += 2;
        continue;
      }
      if (cmd[i + 1] === "{") {
        let j = i + 2;
        while (j < len && cmd[j] !== "}") j++;
        if (j < len) j++;
        tokens.push({ kind: "var", value: cmd.slice(i, j) });
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < len && /[\w?$@*#!_-]/.test(cmd[j])) j++;
      if (j > i + 1) {
        tokens.push({ kind: "var", value: cmd.slice(i, j) });
        i = j;
        continue;
      }
      // Lonely $ → word
      tokens.push({ kind: "word", value: "$" });
      i++;
      continue;
    }
    // Close paren — for subshell context
    if (ch === ")") {
      tokens.push({ kind: "subshell-close", value: ")" });
      i++;
      continue;
    }
    // Operators (longest match first)
    const ops = ["&&", "||", ">>", "<<", "2>&1", "2>", ">&", "|", ">", "<", ";", "&"];
    let matched = false;
    for (const op of ops) {
      if (cmd.startsWith(op, i)) {
        tokens.push({ kind: "operator", value: op });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // Flag: -x or --x or --x=value (after whitespace only, to avoid matching `-` in args mid-word)
    if (ch === "-") {
      const prev = tokens[tokens.length - 1];
      const atArgPosition = !prev || prev.kind === "ws" || prev.kind === "operator" || prev.kind === "subshell-open";
      if (atArgPosition) {
        let j = i + 1;
        if (cmd[j] === "-") j++;
        while (j < len && /[\w?-]/.test(cmd[j])) j++;
        // Include =value if present
        if (cmd[j] === "=") {
          j++;
          // value runs until whitespace or operator
          while (j < len && !/[\s|;&<>()`'"]/.test(cmd[j])) j++;
        }
        if (j > i + 1) {
          tokens.push({ kind: "flag", value: cmd.slice(i, j) });
          i = j;
          continue;
        }
      }
    }
    // Everything else: a word. Run until next whitespace / operator / quote.
    {
      let j = i;
      while (j < len && !/[\s|;&<>()`'"$]/.test(cmd[j])) j++;
      if (j === i) { j = i + 1; } // safety
      tokens.push({ kind: "word", value: cmd.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

/**
 * Tokenize a bash command and emit colored HTML. Words appearing in command
 * position (start of input, or right after a pipe/`&&`/`||`/`;`) are colored
 * as commands; everything else as plain text or its specific token color.
 */
function highlightBash(cmd: string): string {
  if (!cmd) return "";
  const tokens = tokenizeBash(cmd);
  let atCmdPos = true;
  const parts: string[] = [];
  for (const t of tokens) {
    switch (t.kind) {
      case "ws":
        parts.push(escapeAndWrapCJK(t.value));
        break;
      case "comment":
        parts.push(span(t.value, { fg: C.dim, italic: true }));
        break;
      case "string":
        parts.push(span(t.value, { fg: C.green }));
        atCmdPos = false;
        break;
      case "var":
        parts.push(span(t.value, { fg: C.yellow }));
        atCmdPos = false;
        break;
      case "subshell-open":
        parts.push(span(t.value, { fg: C.gray, rawText: true }));
        atCmdPos = true;
        break;
      case "subshell-close":
        parts.push(span(t.value, { fg: C.gray, rawText: true }));
        atCmdPos = false;
        break;
      case "operator":
        parts.push(span(t.value, { fg: C.gray, rawText: true }));
        // After ;, &&, ||, |, & a new command starts.
        atCmdPos = /^(;|&&|\|\||\||&)$/.test(t.value);
        break;
      case "flag":
        parts.push(span(t.value, { fg: C.orange, rawText: true }));
        atCmdPos = false;
        break;
      case "word": {
        const w = t.value;
        if (atCmdPos) {
          if (BASH_KEYWORDS.has(w)) {
            parts.push(span(w, { fg: C.pink, bold: true, rawText: true }));
          } else if (BASH_BUILTINS.has(w)) {
            parts.push(span(w, { fg: C.blueLink, bold: true, rawText: true }));
          } else {
            parts.push(span(w, { fg: C.blueLink, rawText: true }));
          }
          atCmdPos = false;
        } else {
          // Argument: paths in blue-ish, plain words default.
          if (w.startsWith("/") || w.startsWith("~/") || w.startsWith("./") || w.startsWith("../")) {
            parts.push(span(w, { fg: C.dimWhite, rawText: true }));
          } else {
            parts.push(escapeAndWrapCJK(w));
          }
        }
        break;
      }
    }
  }
  return parts.join("");
}

// ──────────────────────────────────────────────────────────────────────────
//  Diff renderer for Edit / Write structuredPatch.
//
//  structuredPatch is an array of unified-diff hunks:
//    { oldStart, oldLines, newStart, newLines, lines: [" ctx", "+add", "-del"] }
//  We render each hunk with a `@@ -X,Y +X,Z @@` header line and color the
//  body lines green for additions, red for deletions.
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
//  Syntax highlighter for source code inside diffs.
//
//  highlight.js outputs HTML with `hljs-keyword` / `hljs-string` / … class
//  names. We map those to inline-style spans against our `C` palette; the
//  StyleClassifier post-pass then dedupes them like every other style. The
//  diff renderer applies this per source line — multi-line strings will
//  lose continuation but that's fine for change-summary view.
// ──────────────────────────────────────────────────────────────────────────

/** hljs scope → foreground color. Unmapped scopes pass through uncolored. */
const HLJS_COLORS: Record<string, string> = {
  "hljs-keyword":      C.pink,
  "hljs-built_in":     C.cyan,
  "hljs-type":         C.cyan,
  "hljs-class":        C.cyan,
  "hljs-tag":          C.cyan,
  "hljs-name":         C.cyan,
  "hljs-title":        C.blueLink,
  "hljs-title.function": C.blueLink,
  "hljs-title.class":  C.cyan,
  "hljs-function":     C.blueLink,
  "hljs-property":     C.blueLink,
  "hljs-attr":         C.orange,
  "hljs-attribute":    C.orange,
  "hljs-params":       C.dimWhite,
  "hljs-literal":      C.yellow,
  "hljs-number":       C.yellow,
  "hljs-symbol":       C.yellow,
  "hljs-variable":     C.yellow,
  "hljs-string":       C.green,
  "hljs-regexp":       C.green,
  "hljs-comment":      C.dim,
  "hljs-meta":         C.dim,
  "hljs-doctag":       C.dim,
  "hljs-operator":     C.gray,
  "hljs-punctuation":  C.gray,
  "hljs-deletion":     C.errorRed,
  "hljs-addition":     C.green,
  "hljs-strong":       C.white,
  "hljs-emphasis":     C.dimWhite,
  "hljs-link":         C.blueLink,
  "hljs-section":      C.cyan,
  "hljs-bullet":       C.orange,
  "hljs-quote":        C.dim,
  "hljs-code":         C.blueLink,
  "hljs-formula":      C.yellow,
  "hljs-selector-tag": C.cyan,
  "hljs-selector-class": C.orange,
  "hljs-selector-id":  C.blueLink,
};

/** Convert hljs HTML (`<span class="hljs-X">…</span>`) into inline-style HTML
 *  the StyleClassifier can dedupe. Unknown scopes get a bare `<span>` so the
 *  nesting structure stays balanced. */
function hljsToInline(html: string): string {
  return html.replace(/<span class="([^"]+)">/g, (m, classAttr: string) => {
    // hljs may emit multi-class spans like `hljs-title hljs-class`. Walk
    // them in order; the first known color wins.
    for (const cls of classAttr.split(/\s+/)) {
      const color = HLJS_COLORS[cls];
      if (color) return `<span style="color:${color}">`;
    }
    return "<span>";
  });
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  rs: "rust",
  go: "go",
  java: "java", kt: "java",
  c: "c", h: "c",
  cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp",
  json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml",
  sql: "sql",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  css: "css",
  scss: "scss", sass: "scss",
};

/** Pick a registered hljs language id for a path. Returns undefined when we
 *  haven't bundled a matching grammar — caller should fall back to plain. */
function langForFile(filePath: string | undefined | null): string | undefined {
  if (!filePath) return undefined;
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  const id = EXT_TO_LANG[ext];
  if (id && hljs.getLanguage(id)) return id;
  return undefined;
}

/** Highlight a single source line; returns inline-style HTML (or escaped
 *  plain text when no language matched / hljs errored). */
function highlightSource(code: string, lang: string | undefined): string {
  if (!code) return "";
  if (!lang) return escapeHtml(code);
  try {
    const r = hljs.highlight(code, { language: lang, ignoreIllegals: true });
    return hljsToInline(r.value);
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Run the `diff` package's formatPatch over a JSONL `structuredPatch` array.
 * Returns the canonical unified-diff body (everything past the 5-line
 * `Index:/===/---/+++` header that formatPatch always emits — those headers
 * have no meaning here since the file name is repeated in the tool summary).
 */
function generateDiff(structuredPatch: any): string {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return "";
  try {
    const patchText = (diff as any).formatPatch({
      oldFileName: "test.js",
      newFileName: "test.js",
      oldHeader: "Original",
      newHeader: "Modified",
      hunks: structuredPatch,
    });
    return patchText.slice(125);
  } catch {
    return "";
  }
}

/**
 * Colorize a raw unified-diff body (no `Index:` header) line-by-line.
 *
 *   `@@` hunk headers → cyan
 *   `+` lines        → green-tinted background, body syntax-highlighted
 *   `-` lines        → red-tinted background, body syntax-highlighted
 *   context lines    → dim, body syntax-highlighted
 *
 * The body of each line is passed through `highlightSource(content, lang)`
 * so language keywords/strings/comments etc. keep their colors on top of the
 * diff tint. The diff tint comes from the wrapper span's background-color;
 * its foreground sets the *default* color for unstyled tokens, which the
 * inner hljs spans override per-scope.
 */
function colorizeDiff(diffText: string, lang?: string): string {
  if (!diffText) return "";
  const lines = diffText.replace(/\n$/, "").split("\n");
  return lines
    .map((raw) => {
      if (raw.startsWith("@@")) {
        return span(raw, { fg: C.cyan, rawText: true });
      }
      if (raw.startsWith("+")) {
        const body = highlightSource(raw.slice(1), lang);
        return spanHtml("+" + body, { bg: C.diffAddBg, fg: C.diffAddFg });
      }
      if (raw.startsWith("-")) {
        const body = highlightSource(raw.slice(1), lang);
        return spanHtml("-" + body, { bg: C.diffDelBg, fg: C.diffDelFg });
      }
      // Context line carries a leading space in unified-diff format. Keep
      // the indent but dim it; the body still goes through the highlighter.
      const lead = raw.startsWith(" ") ? raw.slice(0, 1) : "";
      const body = highlightSource(raw.slice(lead.length), lang);
      return spanHtml(lead + body, { fg: C.dim });
    })
    .join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
//  Markdown renderer for assistant prose.
//
//  Claude Code's terminal renders a small markdown subset inline:
//    **bold** / *italic* / `inline code` / [text](url) / ```fences```
//  plus list markers (`-`, `*`, `1.`) and `#` headers shown as bold.
//
//  We mirror that subset here so the rendered HTML doesn't show raw `**` or
//  back-ticks the way the first renderer pass did.
// ──────────────────────────────────────────────────────────────────────────

type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "link"; text: string; url: string };

/**
 * Greedy inline-markdown tokenizer. Bold (`**…**`) is matched before italic
 * (`*…*`) so the `**` markers aren't consumed as two italic spans. Inline code
 * keeps its body literal — we never re-parse the inside of a back-tick run.
 */
function tokenizeInlineMd(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  // Order of alternations matters: longest/strongest match first.
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > i) tokens.push({ kind: "text", value: line.slice(i, m.index) });
    if (m[1] != null) tokens.push({ kind: "code", value: m[1] });
    else if (m[2] != null) tokens.push({ kind: "bold", value: m[2] });
    else if (m[3] != null) tokens.push({ kind: "italic", value: m[3] });
    else if (m[4] != null && m[5] != null) tokens.push({ kind: "link", text: m[4], url: m[5] });
    i = m.index + m[0].length;
  }
  if (i < line.length) tokens.push({ kind: "text", value: line.slice(i) });
  return tokens;
}

function renderInlineMd(line: string): string {
  return tokenizeInlineMd(line)
    .map((t) => {
      switch (t.kind) {
        case "text":   return escapeAndWrapCJK(t.value);
        case "code":   return span(t.value, { fg: C.blueLink });
        case "bold":   return span(t.value, { bold: true });
        case "italic": return span(t.value, { italic: true });
        case "link":   return `<a href="${escapeHtml(t.url)}" style="color:${C.blueLink}">${escapeAndWrapCJK(t.text)}</a>`;
      }
    })
    .join("");
}

/**
 * Render a single source line as markdown. Picks up headers and list markers
 * before delegating to inline tokenization.
 */
function renderMdLine(line: string): string {
  // Headers: `# Foo`, `## Foo` … → bold.
  const header = line.match(/^(\s*)(#{1,6})\s+(.+)$/);
  if (header) {
    const lead = header[1];
    const body = renderInlineMd(header[3]);
    // Wrap the rendered body in a bold span so any inline tokens keep their
    // styles but the whole header reads as a heading.
    return `${lead}<span style="font-weight:500">${body}</span>`;
  }
  return renderInlineMd(line);
}

/**
 * Render a multi-line markdown block. Handles fenced code blocks (```), then
 * applies inline markdown line-by-line to the rest.
 */
function renderMarkdownBlock(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let codeBuf: string[] = [];
  const flushCode = () => {
    if (codeBuf.length === 0) return;
    const body = codeBuf.join("\n");
    // Render code blocks with a dim background and the same monospace face the
    // surrounding terminal pre already uses. No re-parsing of the contents.
    out.push(
      `<span style="background-color:rgb(40,40,40);color:rgb(175,215,255)">${escapeHtml(body)}</span>`,
    );
    codeBuf = [];
  };
  for (const line of lines) {
    const fence = line.match(/^(\s*)```/);
    if (fence) {
      if (inFence) {
        flushCode();
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      codeBuf.push(line);
    } else {
      out.push(renderMdLine(line));
    }
  }
  // Unterminated fence — render what we collected so we don't drop content.
  if (inFence && codeBuf.length > 0) flushCode();
  return out.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
//  JSONL loading
// ──────────────────────────────────────────────────────────────────────────

export function parseJsonl(filePath: string): JsonlEntry[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const out: JsonlEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // Skip malformed lines rather than failing the whole render. Half-written
      // last lines happen when the user opens an active session's transcript.
    }
  }
  return out;
}

/**
 * Look for `<sessionDir>/<sessionId>/subagents/agent-*.jsonl`. The parent
 * session lives at `<sessionDir>/<sessionId>.jsonl` and Claude Code stores the
 * sidechain transcripts in a parallel directory named after the session.
 */
export function loadSubagents(jsonlPath: string): Map<string, SubagentBundle> {
  const dir = path.dirname(jsonlPath);
  const base = path.basename(jsonlPath, ".jsonl");
  const subagentDir = path.join(dir, base, "subagents");
  const out = new Map<string, SubagentBundle>();
  if (!fs.existsSync(subagentDir)) return out;

  for (const entry of fs.readdirSync(subagentDir)) {
    if (!entry.startsWith("agent-") || !entry.endsWith(".jsonl")) continue;
    const agentId = entry.slice("agent-".length, -".jsonl".length);
    const entries = parseJsonl(path.join(subagentDir, entry));
    const metaFile = path.join(subagentDir, `agent-${agentId}.meta.json`);
    let description = `subagent ${agentId.slice(0, 8)}`;
    let agentType = "general-purpose";
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
        if (meta.description) description = meta.description;
        if (meta.agentType) agentType = meta.agentType;
      } catch {
        /* ignore */
      }
    }
    out.set(agentId, { agentId, description, agentType, entries });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
//  Renderable items — flat list produced by walking the JSONL entries.
// ──────────────────────────────────────────────────────────────────────────

type Item =
  | { kind: "banner"; version: string; model: string; effort: string; planTier: string; cwd: string }
  | { kind: "blank" }
  | { kind: "promptUser"; text: string; promptIdx: number }
  | { kind: "promptSlash"; text: string; promptIdx: number; result?: string }
  | { kind: "bashInput"; command: string; promptIdx: number }
  | { kind: "bashOutput"; stdout: string; stderr: string }
  | { kind: "bashBlock"; command: string; stdout: string; stderr: string; promptIdx: number }
  | { kind: "taskNotification"; summary: string; status: string }
  | { kind: "assistantText"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; args: string; outputHtml: string; isError: boolean }
  | { kind: "agentTool"; description: string; agentId?: string; outputHtml: string; isError: boolean }
  | { kind: "recap"; text: string }
  | { kind: "duration"; durationMs: number; verb: string }
  | { kind: "bottomBar"; permissionMode: string; effort: string };

interface SessionMeta {
  sessionId: string;
  version: string;
  model: string;
  effort: string;
  planTier: string;
  cwd: string;
  permissionMode: string;
  aiTitle?: string;
}

function pickFirst<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (const x of arr) if (pred(x)) return x;
  return undefined;
}

function extractMeta(entries: JsonlEntry[]): SessionMeta {
  const first = entries[0];
  const sessionId = first?.sessionId || "";
  const version = entries.find((e) => e.version)?.version || "";
  const cwd = entries.find((e) => e.cwd)?.cwd || "";
  // The latest permission-mode entry wins — users can flip it mid-session.
  let permissionMode = "default";
  for (const e of entries) {
    if (e.type === "permission-mode" && e.permissionMode) permissionMode = e.permissionMode;
  }
  if (permissionMode === "default") {
    const fallback = entries.find((e) => e.permissionMode);
    if (fallback?.permissionMode) permissionMode = fallback.permissionMode;
  }
  // Pull model name from the latest *real* assistant message — model can
  // change mid-session if the user runs `/model`. Synthetic placeholders
  // (`<synthetic>`) are produced by internal framing messages; ignore them so
  // the banner doesn't end up showing that as the model name.
  let rawModel = "";
  for (const e of entries) {
    const m = e.message?.model;
    if (e.type === "assistant" && typeof m === "string" && m && !m.startsWith("<")) {
      rawModel = m;
    }
  }
  const model = formatModelName(rawModel);
  // Effort and plan tier aren't recorded in JSONL — read them from env vars
  // Claude Code sets (or accept user overrides via CLAUDE_CODE_*). Falls back
  // to the same defaults the existing rendered banner used.
  const effort =
    process.env.CLAUDE_CODE_EFFORT ||
    process.env.CCS_EFFORT ||
    "xhigh effort";
  const planTier =
    process.env.CLAUDE_CODE_PLAN_TIER ||
    process.env.CCS_PLAN_TIER ||
    "Claude Pro";
  // ai-title is rewritten as the conversation progresses; the last one is the
  // current title.
  let aiTitle: string | undefined;
  for (const e of entries) {
    if (e.type === "ai-title" && typeof e.aiTitle === "string") aiTitle = e.aiTitle;
  }
  return { sessionId, version, model, effort, planTier, cwd, permissionMode, aiTitle };
}

function formatModelName(raw: string): string {
  // "claude-opus-4-7" → "Opus 4.7"
  // "claude-sonnet-4-6" → "Sonnet 4.6"
  // "claude-haiku-4-5-20251001" → "Haiku 4.5"
  const m = raw.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (!m) return raw || "Claude";
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${name} ${m[2]}.${m[3]}`;
}

function homeShortCwd(cwd: string): string {
  const home = os.homedir();
  if (cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

// Verb rotation matches Claude Code's `Worked / Baked / Cooked / Brewed / …`
// pattern. We don't try to mirror its exact rotation; pick one verb based on
// the index so the page has a bit of variety.
const DURATION_VERBS = ["Worked", "Baked", "Cooked", "Brewed", "Sautéed", "Simmered"];

// ──────────────────────────────────────────────────────────────────────────
//  Tool-call formatting — turn each tool_use + tool_result into a renderable
//  command line + output snippet styled like Claude Code's terminal.
// ──────────────────────────────────────────────────────────────────────────

function formatToolArgs(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Bash": {
      return String(input.command || "");
    }
    case "Read": {
      let s = String(input.file_path || "");
      if (input.offset != null || input.limit != null) {
        const start = input.offset ?? 1;
        const end = (input.offset ?? 1) + (input.limit ?? 0) - 1;
        s += ` · lines ${start}-${end || ""}`;
      }
      return s;
    }
    case "Write":
    case "Edit": {
      return String(input.file_path || "");
    }
    case "Glob": {
      return String(input.pattern || "");
    }
    case "Grep": {
      const parts: string[] = [];
      if (input.pattern) parts.push(`"${input.pattern}"`);
      if (input.path) parts.push(`path:${input.path}`);
      if (input.glob) parts.push(`glob:${input.glob}`);
      return parts.join(" ");
    }
    case "WebFetch": {
      return String(input.url || "");
    }
    case "WebSearch": {
      return String(input.query || "");
    }
    case "Agent": {
      return String(input.description || "");
    }
    case "ToolSearch": {
      return String(input.query || "");
    }
    case "TaskCreate": {
      return String(input.subject || "");
    }
    case "TaskUpdate": {
      const bits = [`#${input.taskId || "?"}`];
      if (input.status) bits.push(input.status);
      return bits.join(" ");
    }
    default: {
      // Fall back to a compact JSON-ish summary of the first scalar field.
      const keys = Object.keys(input);
      for (const k of keys) {
        const v = (input as any)[k];
        if (typeof v === "string" && v.length > 0) return v;
      }
      return JSON.stringify(input);
    }
  }
}

function formatToolDisplayName(name: string): string {
  // Edit/Write get re-labeled to "Update"/"Write" to match Claude Code's UI.
  if (name === "Edit") return "Update";
  return name;
}

/**
 * Render the tool's result as the `⎿`-prefixed output block. The shape varies
 * by tool; for Bash we print the stdout verbatim, for Read/Edit/Write we
 * synthesise the short status line Claude Code shows ("Read N lines",
 * "Added N lines", "(No output)" …).
 */
function renderToolOutput(
  name: string,
  toolUse: any,
  toolResultEntry: JsonlEntry | undefined,
): { html: string; isError: boolean } {
  const arrow = span("  ⎿  ", { fg: C.gray });
  const isError = toolResultEntry?.message?.content?.[0]?.is_error === true;

  if (!toolResultEntry) {
    return { html: arrow + span("(no result captured)", { italic: true, fg: C.gray }), isError: false };
  }

  const result = toolResultEntry.toolUseResult;
  const contentArr = toolResultEntry.message?.content;
  const content0 = Array.isArray(contentArr) ? contentArr[0] : undefined;
  const rawContent: string =
    typeof content0?.content === "string"
      ? content0.content
      : Array.isArray(content0?.content)
        ? content0.content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join("\n")
        : "";

  const fmtBodyLines = (body: string, fg: string = C.gray): string => {
    const lines = body.split("\n");
    return lines
      .map((line, i) =>
        i === 0
          ? arrow + span(line, { fg })
          : span("     " + line, { fg }),
      )
      .join("\n");
  };

  switch (name) {
    case "Bash": {
      const stdout = (result?.stdout ?? rawContent ?? "").trimEnd();
      const stderr = (result?.stderr ?? "").trimEnd();
      let body = stdout;
      if (stderr) body = body ? `${body}\n${stderr}` : stderr;
      if (!body) body = "(No output)";
      // Bash bodies render in gray to mirror the terminal output color. Error
      // results get a red tint instead.
      return { html: fmtBodyLines(body, isError ? C.errorRed : C.gray), isError };
    }
    case "Read": {
      const lineCount = (typeof rawContent === "string" && rawContent.length > 0)
        ? rawContent.split("\n").length
        : 0;
      return {
        html: arrow + span("Read ", { fg: C.gray }) + span(String(lineCount), { fg: C.white, bold: true }) + span(" lines", { fg: C.gray }),
        isError,
      };
    }
    case "Edit": {
      // Use the structuredPatch from the tool result so we render exactly the
      // hunks Claude Code saw. Falls back to a one-line "Updated file" status
      // when the patch is missing (rare — usually means a no-op edit).
      const patch = result?.structuredPatch;
      const diffText = generateDiff(patch);
      if (!diffText) {
        return { html: arrow + span("Updated file", { fg: C.gray }), isError };
      }
      const filePath: string = result?.filePath ?? toolUse?.input?.file_path ?? "";
      const lang = langForFile(filePath);
      // First line of the diff sits next to the ⎿ marker; subsequent lines
      // get a fixed 5-space indent so the diff lines up under the arrow.
      const colorized = colorizeDiff(diffText, lang).split("\n");
      const indented = colorized
        .map((l, i) => (i === 0 ? arrow + l : "     " + l))
        .join("\n");
      return { html: indented, isError };
    }
    case "Write": {
      const patch = result?.structuredPatch;
      const filePath: string = result?.filePath ?? toolUse?.input?.file_path ?? "";
      const lang = langForFile(filePath);
      const diffText = generateDiff(patch);
      // New file: structuredPatch is empty, so fall back to the full content
      // as a single "+ added" block — keeps the visual consistent with edits.
      if (!diffText) {
        const content: string = result?.content ?? toolUse?.input?.content ?? "";
        const lines = content.replace(/\n$/, "").split("\n");
        const head = span(`@@ new file ${filePath} @@`, { fg: C.cyan, rawText: true });
        const body = lines
          .map((l) => spanHtml("+" + highlightSource(l, lang), { bg: C.diffAddBg, fg: C.diffAddFg }))
          .join("\n");
        const all = `${head}\n${body}`;
        const split = all.split("\n");
        return {
          html: split.map((l, i) => (i === 0 ? arrow + l : "     " + l)).join("\n"),
          isError,
        };
      }
      const colorized = colorizeDiff(diffText, lang).split("\n");
      const indented = colorized
        .map((l, i) => (i === 0 ? arrow + l : "     " + l))
        .join("\n");
      return { html: indented, isError };
    }
    case "WebFetch":
    case "WebSearch": {
      const body = (rawContent || JSON.stringify(result || {})).slice(0, 4000);
      return { html: fmtBodyLines(body), isError };
    }
    case "Agent": {
      // Body is set by the caller (it pulls the subagent's final response).
      return { html: fmtBodyLines(rawContent || "(no agent response)"), isError };
    }
    default: {
      const body = (rawContent || (typeof result === "string" ? result : "")).toString();
      return { html: fmtBodyLines(body || "(No output)"), isError };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Local-command tag parsing.
//
//  When the user runs `!cmd` or invokes a background task, Claude Code writes
//  a sequence of user messages wrapped in pseudo-XML tags:
//    <local-command-caveat>…</local-command-caveat>     (an isMeta DO-NOT-RESPOND notice)
//    <bash-input>cmd</bash-input>                        (the invocation)
//    <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>  (its output)
//    <task-notification>…<summary>…</summary>…</task-notification> (bg task done)
//
//  We render these as bash-style prompts (`❯ ! cmd`) followed by `⎿`-prefixed
//  output, matching how Claude Code's terminal shows them.
// ──────────────────────────────────────────────────────────────────────────

/**
 * If the text is one of the local-command pseudo-XML envelopes, return the
 * matching item(s). Returns `null` when the text is plain prose so the caller
 * can fall back to the normal prompt rendering.
 */
function parseLocalCommand(text: string, allocPromptIdx: () => number): Item[] | null {
  const hasTag = /<(?:local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)\b/.test(text);
  if (!hasTag) return null;

  // The caveat is a "DO NOT respond" notice meant for the model, not the
  // reader. Drop it entirely.
  if (/^<local-command-caveat>[\s\S]*<\/local-command-caveat>\s*$/.test(text.trim())) {
    return [];
  }

  const items: Item[] = [];

  const inputMatch = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (inputMatch) {
    items.push({ kind: "bashInput", command: inputMatch[1].trim(), promptIdx: allocPromptIdx() });
  }

  const stdoutMatch = text.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
  const stderrMatch = text.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
  if (stdoutMatch || stderrMatch) {
    const stdout = (stdoutMatch?.[1] || "").replace(/\n+$/, "");
    const stderr = (stderrMatch?.[1] || "").replace(/\n+$/, "");
    if (stdout || stderr) {
      items.push({ kind: "bashOutput", stdout, stderr });
    }
  }

  const taskMatch = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (taskMatch) {
    const body = taskMatch[1];
    const summary = body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || "(background task completed)";
    const status = body.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() || "completed";
    items.push({ kind: "taskNotification", summary, status });
  }

  // If we recognised tags but extracted nothing renderable, treat as a no-op
  // rather than falling back to the verbose XML text.
  return items;
}

// ──────────────────────────────────────────────────────────────────────────
//  Build the renderable item list from JSONL entries.
// ──────────────────────────────────────────────────────────────────────────

/** Index the entries by tool_use_id so we can pair tool_use ↔ tool_result. */
function indexToolResults(entries: JsonlEntry[]): Map<string, JsonlEntry> {
  const out = new Map<string, JsonlEntry>();
  for (const e of entries) {
    if (e.type !== "user") continue;
    const arr = e.message?.content;
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      if (c && c.type === "tool_result" && c.tool_use_id) {
        out.set(c.tool_use_id, e);
      }
    }
  }
  return out;
}

function plainTextFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .join("");
  }
  return "";
}

interface BuildSessionOpts {
  /** When rendering a subagent, the parent transcript's `agentId` is set here
   *  so we know to skip the initial user message wrapping (it's the prompt
   *  the parent passed in, surfaced in the parent's Agent tool call). */
  isSubagent?: boolean;
  /** Subagent map for the *main* session — lets us tag Agent tool calls with
   *  the right `agentId` so the page can open the subagent template. */
  subagents?: Map<string, SubagentBundle>;
}

function buildItems(entries: JsonlEntry[], opts: BuildSessionOpts = {}): { items: Item[]; meta: SessionMeta } {
  const meta = extractMeta(entries);
  const resultsById = indexToolResults(entries);
  const items: Item[] = [];

  if (!opts.isSubagent) {
    items.push({
      kind: "banner",
      version: meta.version,
      model: meta.model,
      effort: meta.effort,
      planTier: meta.planTier,
      cwd: homeShortCwd(meta.cwd),
    });
    items.push({ kind: "blank" });
  }

  // Pair Agent tool_use to a subagent by promptId so we can deep-link.
  // Promotion: each subagent session has its first user entry's promptId
  // matching the Agent tool_use's promptId in the parent.
  const subagentByPromptId = new Map<string, string>();
  if (opts.subagents) {
    for (const sa of opts.subagents.values()) {
      const firstUser = sa.entries.find((e) => e.type === "user");
      if (firstUser?.promptId) subagentByPromptId.set(firstUser.promptId, sa.agentId);
      // Also map by agentId directly so we can fall back.
    }
  }

  let promptIdx = 0;
  let durationVerbIdx = 0;
  // Track per-message duplicate tool_use rendering — Claude sometimes records
  // both a streaming "thinking" assistant message and the final tool_use with
  // the same message id; we still want both shown once.
  const seenToolUseIds = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // Sidechain entries belong to a subagent transcript; the main session
    // shouldn't render them inline.
    if (!opts.isSubagent && e.isSidechain) continue;

    switch (e.type) {
      case "user": {
        const content = e.message?.content;
        // tool_result entries get rendered as part of the matching tool call.
        if (Array.isArray(content) && content.some((c: any) => c?.type === "tool_result")) {
          break;
        }
        // Skip pure-string user messages that are auto-injected (caret-only,
        // empty, etc.).
        const text = plainTextFromContent(content).trim();
        if (!text) break;

        // Local-command envelopes come through as user messages too — render
        // them as the bash/task widgets they actually were, not as XML text.
        const localItems = parseLocalCommand(text, () => promptIdx++);
        if (localItems) {
          if (localItems.length === 0) break; // caveat-only: nothing to draw
          for (const it of localItems) items.push(it);
          items.push({ kind: "blank" });
          break;
        }

        if (text.startsWith("/")) {
          items.push({ kind: "promptSlash", text, promptIdx: promptIdx++ });
        } else if (text.startsWith("!")) {
          // Bang-bash from the input box.
          items.push({ kind: "promptSlash", text, promptIdx: promptIdx++ });
        } else {
          items.push({ kind: "promptUser", text, promptIdx: promptIdx++ });
        }
        items.push({ kind: "blank" });
        break;
      }
      case "assistant": {
        const arr = e.message?.content;
        if (!Array.isArray(arr)) break;
        for (const c of arr) {
          if (!c) continue;
          if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            items.push({ kind: "assistantText", text: c.text });
            items.push({ kind: "blank" });
          } else if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) {
            items.push({ kind: "thinking", text: c.thinking });
            items.push({ kind: "blank" });
          } else if (c.type === "tool_use" && c.id) {
            if (seenToolUseIds.has(c.id)) continue;
            seenToolUseIds.add(c.id);
            const resultEntry = resultsById.get(c.id);
            const name = String(c.name || "");
            if (name === "Agent") {
              const description = String(c.input?.description || "subagent");
              let agentId: string | undefined;
              // Match by promptId on the matching tool_result (it carries the
              // parent's promptId, and so does the subagent's first message).
              const tr = resultEntry;
              if (tr?.promptId && subagentByPromptId.has(tr.promptId)) {
                agentId = subagentByPromptId.get(tr.promptId);
              }
              // Fallback: if there's only one subagent and we can't match,
              // hand it to that one.
              if (!agentId && opts.subagents && opts.subagents.size === 1) {
                agentId = Array.from(opts.subagents.keys())[0];
              }
              const { html, isError } = renderToolOutput(name, c, resultEntry);
              items.push({ kind: "agentTool", description, agentId, outputHtml: html, isError });
              items.push({ kind: "blank" });
            } else {
              const args = formatToolArgs(name, c.input);
              const { html, isError } = renderToolOutput(name, c, resultEntry);
              items.push({ kind: "tool", name, args, outputHtml: html, isError });
              items.push({ kind: "blank" });
            }
          }
        }
        break;
      }
      case "system": {
        if (e.subtype === "turn_duration" && typeof e.durationMs === "number") {
          const verb = DURATION_VERBS[durationVerbIdx++ % DURATION_VERBS.length];
          items.push({ kind: "duration", durationMs: e.durationMs, verb });
        } else if (e.subtype === "away_summary" && typeof e.content === "string") {
          items.push({ kind: "recap", text: e.content });
          items.push({ kind: "blank" });
        }
        break;
      }
      default:
        // Skip housekeeping types: attachment, file-history-snapshot,
        // ai-title, permission-mode, last-prompt, hook_success, …
        break;
    }
  }

  if (!opts.isSubagent) {
    items.push({ kind: "blank" });
    items.push({ kind: "bottomBar", permissionMode: meta.permissionMode, effort: meta.effort });
  }

  return { items: mergeBashBlocks(items), meta };
}

/**
 * Fold (bashInput, [blank], bashOutput) sequences into a single bashBlock so
 * the rendered page shows them as one collapsible `❯ ! cmd` widget. Items
 * with no matching output stay as standalone bashInput (e.g. the user typed
 * `!` but Claude hasn't recorded output yet).
 */
function mergeBashBlocks(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "bashInput") {
      // Look ahead past blanks for the matching bashOutput.
      let j = i + 1;
      while (j < items.length && items[j].kind === "blank") j++;
      const next = items[j];
      if (next && next.kind === "bashOutput") {
        out.push({
          kind: "bashBlock",
          command: it.command,
          stdout: next.stdout,
          stderr: next.stderr,
          promptIdx: it.promptIdx,
        });
        // Swallow any blanks we skipped plus the bashOutput itself; keep the
        // single trailing blank after the block (matches the original
        // bashOutput → blank emission).
        i = j;
      } else {
        out.push(it);
      }
    } else {
      out.push(it);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
//  Render items → HTML
// ──────────────────────────────────────────────────────────────────────────

function renderBanner(item: Extract<Item, { kind: "banner" }>): string {
  // Mirror the four-line "Claude Code" banner from the terminal — the red
  // tank-icon block plus version/model/account/cwd lines on the right.
  const red = (s: string) => span(s, { fg: C.red, rawText: true });
  const redOnBlack = (s: string) => span(s, { fg: C.red, bg: C.bgIconBlack, rawText: true });
  const grayInfo = (s: string) => span(s, { fg: C.gray });
  return [
    `           ${span("Claude Code", { bold: true, rawText: true })} ${grayInfo(item.version ? `v${item.version}` : "")}`,
    `${red(" ▐")}${redOnBlack("▛███▜")}${red("▌")}   ${grayInfo(`${item.model} with ${item.effort}`)}`,
    `${red("▝▜")}${redOnBlack("█████")}${red("▛▘")}  ${grayInfo(item.planTier)}`,
    `${red("  ▘▘ ▝▝  ")}  ${grayInfo(item.cwd)}`,
  ].join("\n");
}

function renderPromptUser(item: Extract<Item, { kind: "promptUser" }>): string {
  // The terminal renders the prompt as white text on a dark-gray strip with a
  // `❯ ` prefix in a dimmer color. We replicate the strip with two spans per
  // line — the leading `❯ ` plus the body.
  const lines = item.text.split("\n");
  const arrow = span("❯ ", { fg: C.promptArrow, bg: C.bgPrompt, rawText: true });
  const body = lines
    .map((line, i) => {
      const lead = i === 0 ? arrow : span("  ", { bg: C.bgPrompt, rawText: true });
      return `${lead}${span(line, { fg: C.white, bg: C.bgPrompt })}`;
    })
    .join("\n");
  return `<span class="user-prompt" data-prompt-idx="${item.promptIdx}">${body}</span>`;
}

function renderPromptSlash(item: Extract<Item, { kind: "promptSlash" }>): string {
  // Slash and bang commands render the same way as user prompts visually but
  // we tag them too so the menu lists them.
  const arrow = span("❯ ", { fg: C.promptArrow, bg: C.bgPrompt, rawText: true });
  const body =
    arrow +
    span(item.text, { fg: C.white, bg: C.bgPrompt });
  return `<span class="user-prompt" data-prompt-idx="${item.promptIdx}">${body}</span>`;
}

function renderBashInput(item: Extract<Item, { kind: "bashInput" }>): string {
  // `❯ ! cmd` styled like a slash command but with a `!` marker. The whole
  // line is tagged as a user prompt so the menu picks it up.
  const arrow = span("❯ ", { fg: C.promptArrow, bg: C.bgPrompt, rawText: true });
  const bang = span("! ", { fg: C.pink, bg: C.bgPrompt, rawText: true });
  const body = arrow + bang + span(item.command, { fg: C.white, bg: C.bgPrompt });
  return `<span class="user-prompt" data-prompt-idx="${item.promptIdx}">${body}</span>`;
}

function renderBashBlock(item: Extract<Item, { kind: "bashBlock" }>): string {
  // Same shape as a Bash tool call: a `❯ ! cmd` summary that opens a body
  // containing the stdout/stderr. Tagged as a user-prompt so the side menu
  // lists it alongside `❯ /slash` entries, with a unique prompt index.
  const arrow = span("❯ ", { fg: C.promptArrow, bg: C.bgPrompt, rawText: true });
  const bang = span("! ", { fg: C.pink, bg: C.bgPrompt, rawText: true });
  const cmdInner = highlightBash(item.command);
  // The highlighter emits plain spans (no bg). To get the gray-strip look
  // around the command, wrap the highlighted markup in one bg-prompt span —
  // spanHtml leaves the inner HTML intact while still routing the style
  // attribute through the classifier.
  const summary = arrow + bang + spanHtml(cmdInner, { bg: C.bgPrompt });
  const outItem: Extract<Item, { kind: "bashOutput" }> = {
    kind: "bashOutput",
    stdout: item.stdout,
    stderr: item.stderr,
  };
  const outHtml = renderBashOutput(outItem);
  return `<details class="tool user-prompt" data-prompt-idx="${item.promptIdx}"><summary>${summary}</summary><span class="tool-out">\n${outHtml}</span></details>`;
}

function renderBashOutput(item: Extract<Item, { kind: "bashOutput" }>): string {
  // Indent each output line under a leading `⎿ ` like a tool output. stderr is
  // shown in red — its presence does *not* automatically mark stdout as a
  // failure, since stderr is often used for warnings/progress.
  const arrowGray = span("  ⎿  ", { fg: C.gray });
  const renderBody = (body: string, fg: string): string => {
    const lines = body.split("\n");
    return lines
      .map((line, i) => (i === 0 ? arrowGray + span(line, { fg }) : span("     " + line, { fg })))
      .join("\n");
  };
  const parts: string[] = [];
  if (item.stdout) parts.push(renderBody(item.stdout, C.gray));
  if (item.stderr) parts.push(renderBody(item.stderr, C.errorRed));
  if (parts.length === 0) parts.push(arrowGray + span("(no output)", { fg: C.gray, italic: true }));
  return parts.join("\n");
}

function renderTaskNotification(item: Extract<Item, { kind: "taskNotification" }>): string {
  // Background-task completion shows the summary verbatim. `status` colors the
  // arrow: green for completed, red for failure, gray otherwise.
  const arrowColor =
    item.status === "completed" || item.status === "success" ? C.green
      : item.status === "failed" || item.status === "error" ? C.errorRed
      : C.gray;
  const arrow = span("  ⎿  ", { fg: arrowColor });
  return arrow + span(item.summary, { fg: C.gray });
}

function renderAssistantText(item: Extract<Item, { kind: "assistantText" }>): string {
  // Match the terminal: a leading white `⏺` glyph and then the model's prose,
  // rendered with the inline markdown subset (bold, code, italic, links,
  // fenced blocks). The leading dot is on the first line; continuation lines
  // get a 2-space indent so the prose visually hangs under the `⏺`.
  const dot = span("⏺", { fg: C.white, rawText: true });
  const rendered = renderMarkdownBlock(item.text).split("\n");
  return rendered
    .map((line, i) => (i === 0 ? `${dot} ${line}` : `  ${line}`))
    .join("\n");
}

function renderThinking(item: Extract<Item, { kind: "thinking" }>): string {
  // Thinking text is dim/italic in the terminal. Keep it visible but muted.
  // We don't apply markdown — thinking is meant to be raw model output.
  const dot = span("✻", { fg: C.gray, rawText: true });
  const lines = item.text.split("\n");
  const body = lines
    .map((line, i) => {
      const inner = span(line, { fg: C.gray, italic: true });
      return i === 0 ? `${dot} ${inner}` : `  ${inner}`;
    })
    .join("\n");
  return body;
}

function renderToolItem(item: Extract<Item, { kind: "tool" }>): string {
  const dot = span("⏺", { fg: C.green, rawText: true });
  const displayName = formatToolDisplayName(item.name);
  // Bash gets full syntax highlighting on the command; other tools' args
  // (paths, queries) stay plain so escapes and CJK look right.
  const argHtml = item.name === "Bash"
    ? highlightBash(item.args || "")
    : escapeAndWrapCJK(item.args || "");
  const summary = `${dot} ${span(displayName, { bold: true, rawText: true })}(${argHtml})`;
  const outHtml = item.outputHtml;
  return `<details class="tool"${item.isError ? ' data-error="1"' : ""}><summary>${summary}</summary><span class="tool-out">\n${outHtml}</span></details>`;
}

function renderAgentTool(item: Extract<Item, { kind: "agentTool" }>): string {
  const dot = span("⏺", { fg: C.green, rawText: true });
  const summary = `${dot} ${span("Agent", { bold: true, rawText: true })}(${escapeAndWrapCJK(item.description)})`;
  const link = item.agentId
    ? `<a class="subagent-link" href="?sub_agent=${escapeHtml(item.agentId)}">${span("↗ open subagent", { fg: C.blueLink, rawText: true })}</a>\n`
    : "";
  return `<details class="tool"${item.isError ? ' data-error="1"' : ""}><summary>${summary}</summary><span class="tool-out">\n${link}${item.outputHtml}</span></details>`;
}

function renderRecap(item: Extract<Item, { kind: "recap" }>): string {
  // `※ recap: …` with bold "recap:" label and italic body.
  const mark = span("※", { fg: C.gray, rawText: true });
  const label = span("recap: ", { bold: true, fg: C.gray });
  const body = span(item.text, { italic: true, fg: C.gray });
  return `${mark} ${label}${body}`;
}

function renderDuration(item: Extract<Item, { kind: "duration" }>): string {
  const flower = span("✻", { fg: C.gray, rawText: true });
  const body = span(` ${item.verb} for ${formatDuration(item.durationMs)}`, { fg: C.gray });
  return `${flower}${body}`;
}

function renderBottomBar(item: Extract<Item, { kind: "bottomBar" }>): string {
  // Width-agnostic horizontal rules, then the prompt strip and the legend.
  const rule = span("─".repeat(120), { fg: C.dim, rawText: true });
  const arrow = span("❯ ", { fg: C.promptArrow, rawText: true });
  const modePill =
    item.permissionMode === "bypassPermissions"
      ? span("⏵⏵ bypass permissions on", { fg: C.pink, rawText: true })
      : item.permissionMode === "plan"
        ? span("⏸ plan mode", { fg: C.pink, rawText: true })
        : span("✓ default mode", { fg: C.green, rawText: true });
  const legend = span(" (shift+tab to cycle) · ← for agents", { fg: C.gray });
  const effortLine = span(`◉ ${item.effort.replace(/\s*effort$/i, "")} · /effort`, { fg: C.gray });
  return [
    rule,
    arrow,
    rule,
    `  ${modePill}${legend}`,
    `                                                                              ${effortLine}`,
  ].join("\n");
}

function renderItems(items: Item[]): string {
  const parts: string[] = [];
  for (const it of items) {
    switch (it.kind) {
      case "banner":         parts.push(renderBanner(it)); break;
      case "blank":          parts.push(""); break;
      case "promptUser":     parts.push(renderPromptUser(it)); break;
      case "promptSlash":    parts.push(renderPromptSlash(it)); break;
      case "bashInput":      parts.push(renderBashInput(it)); break;
      case "bashOutput":     parts.push(renderBashOutput(it)); break;
      case "bashBlock":      parts.push(renderBashBlock(it)); break;
      case "taskNotification": parts.push(renderTaskNotification(it)); break;
      case "assistantText":  parts.push(renderAssistantText(it)); break;
      case "thinking":       parts.push(renderThinking(it)); break;
      case "tool":           parts.push(renderToolItem(it)); break;
      case "agentTool":      parts.push(renderAgentTool(it)); break;
      case "recap":          parts.push(renderRecap(it)); break;
      case "duration":       parts.push(renderDuration(it)); break;
      case "bottomBar":      parts.push(renderBottomBar(it)); break;
    }
  }
  return `<pre class="terminal">${parts.join("\n")}</pre>`;
}

// ──────────────────────────────────────────────────────────────────────────
//  Public entry: renderJsonlToHtml
// ──────────────────────────────────────────────────────────────────────────

export function renderJsonlToHtml(opts: RenderJsonlOpts): string {
  const { jsonlPath } = opts;
  const fontPx = opts.fontPx ?? 14;
  const entries = parseJsonl(jsonlPath);
  const subagents = loadSubagents(jsonlPath);

  const { items: mainItems, meta } = buildItems(entries, { subagents });
  const rawMain = renderItems(mainItems);

  // Build a subagent body per agent — these go into <template> tags so they
  // stay inert until the page script swaps them in via ?sub_agent=…
  const rawTemplates: string[] = [];
  for (const sa of subagents.values()) {
    const { items: subItems } = buildItems(sa.entries, { isSubagent: true });
    const body = renderItems(subItems);
    rawTemplates.push(
      `<template data-subagent-id="${escapeHtml(sa.agentId)}" data-description="${escapeHtml(sa.description)}">${body}</template>`,
    );
  }

  // Collapse every `style="…"` attribute into a shared CSS class so the
  // rendered HTML stays compact even when thousands of spans share the same
  // visual style. Run the classifier across the main body *and* every
  // subagent template, so they share one class table.
  const sc = new StyleClassifier();
  const mainBody = classifyHtml(rawMain, sc);
  const subTemplates = rawTemplates.map((t) => classifyHtml(t, sc)).join("\n");

  // Claude Code renders the session title with a leading "✳ " glyph in the
  // terminal tab. Match that here so the browser tab and the rendered page
  // line up with what the user saw live.
  const baseTitle =
    (opts.title && opts.title.trim()) ||
    meta.aiTitle ||
    `Claude Code Session ${meta.sessionId}`;
  const title = /^✳/.test(baseTitle) ? baseTitle : `✳ ${baseTitle}`;

  return wrapPage({
    title,
    fontPx,
    mainBody,
    subTemplates,
    classifiedCss: sc.cssRules(),
  });
}

// ──────────────────────────────────────────────────────────────────────────
//  Page wrapper — CSS + JS shared with the existing renderer.
// ──────────────────────────────────────────────────────────────────────────

interface PageOpts {
  title: string;
  fontPx: number;
  mainBody: string;
  subTemplates: string;
  /** CSS rules emitted by StyleClassifier — one per unique deduped style. */
  classifiedCss: string;
}

function wrapPage(opts: PageOpts): string {
  const { title, fontPx, mainBody, subTemplates, classifiedCss } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #181818; }
body {
  color: #e5e5e5;
  font-family: Menlo, Monaco, "SF Mono", SFMono-Regular, ui-monospace,
               Consolas, "Liberation Mono", "Courier New",
               "PingFang SC", "PingFang TC", "Hiragino Sans GB",
               "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC",
               monospace;
  font-size: ${fontPx}px;
  line-height: 1.3;
  padding: 16px 12px 32px;
  font-variant-ligatures: none;
}
.terminal { white-space: pre-wrap; margin: 0; overflow-x: auto; tab-size: 4; word-break: break-word; }
.snapshot { display: block; }
/* CJK runs render inside a fixed-width inline-block so 2-cell glyphs occupy
   2ch on the page. Without the explicit width the prose drifts away from the
   ASCII grid the original terminal capture sits on. */
.cjk {
  display: inline-block;
  text-align: justify;
  text-align-last: justify;
  text-justify: inter-character;
  padding: 0 2px;
  vertical-align: baseline;
}
details.tool { display: inline-block; }
details.tool > summary {
  display: inline; cursor: pointer; list-style: none; outline: none;
  border-radius: 4px; padding: 4px 4px 4px 0;
}
details.tool > summary::-webkit-details-marker { display: none; }
details.tool > summary::marker { content: ""; }
details.tool > .tool-out { display: inline; }
details.tool:not([open]) > .tool-out { display: none; }
details.tool > summary:hover { background: rgba(255,255,255,0.06); }
details.tool[open] > summary { background: rgba(255,255,255,0.03); }
details.tool[data-error="1"] > summary { color: rgb(255,0,95); }
a.subagent-link { color: rgb(175,215,255); text-decoration: underline; }
.hint {
  position: fixed; bottom: 10px; right: 12px;
  font: 11px/1.4 ui-monospace, monospace;
  color: #b0b0b0; background: rgba(0,0,0,0.55);
  border: 1px solid #333; padding: 4px 8px; border-radius: 4px;
  user-select: none; pointer-events: none;
}
.hint b { color: #fff; }
.ccs-menu {
  position: fixed; top: 10px; right: 12px; z-index: 10;
  font: 12px/1.4 ui-monospace, monospace;
}
.ccs-menu-btn {
  background: rgba(0,0,0,0.55); color: #e5e5e5;
  border: 1px solid #333; border-radius: 4px;
  padding: 4px 8px; cursor: pointer; font: inherit;
}
.ccs-menu-btn:hover { background: rgba(0,0,0,0.75); }
.ccs-menu-list {
  display: none;
  position: absolute; top: calc(100% + 4px); right: 0;
  min-width: 240px; max-width: min(420px, 90vw);
  max-height: 60vh; overflow-y: auto;
  background: #1f1f1f; color: #e5e5e5;
  border: 1px solid #3a3a3a; border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.5);
}
.ccs-menu.open .ccs-menu-list { display: block; }
.ccs-menu-item {
  display: block; padding: 6px 10px; color: inherit;
  text-decoration: none; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-bottom: 1px solid #2a2a2a;
}
.ccs-menu-item:last-child { border-bottom: 0; }
.ccs-menu-item:hover { background: rgba(255,255,255,0.06); }
.ccs-menu-empty { padding: 8px 10px; color: #888; font-style: italic; }
.subagent-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; margin: 0 0 16px 0;
  background: #232323; border: 1px solid #333; border-radius: 4px;
}
.subagent-banner a { color: rgb(175,215,255); text-decoration: underline; cursor: pointer; }
.subagent-banner .sub-desc { color: #aaa; }
.is-hidden { display: none; }
${classifiedCss}
</style>
</head>
<body>
<div id="main-view">${mainBody}</div>
<div id="subagent-view" class="is-hidden"></div>
${subTemplates}
<div class="ccs-menu" id="ccs-menu"><button class="ccs-menu-btn" id="ccs-menu-btn" type="button" aria-label="提问列表">☰</button><div class="ccs-menu-list" id="ccs-menu-list"></div></div>
<script>
(function () {
  var mainView = document.getElementById('main-view');
  var subView = document.getElementById('subagent-view');
  var menu = document.getElementById('ccs-menu');
  var menuBtn = document.getElementById('ccs-menu-btn');
  var menuList = document.getElementById('ccs-menu-list');

  function paramSubAgent() {
    try { return new URLSearchParams(window.location.search).get('sub_agent'); }
    catch (e) { return null; }
  }
  function showSubagent(id) {
    var tpl = document.querySelector('template[data-subagent-id="' + cssEsc(id) + '"]');
    if (!tpl) { showMain(); return; }
    var desc = tpl.getAttribute('data-description') || '';
    mainView.classList.add('is-hidden');
    subView.classList.remove('is-hidden');
    subView.textContent = '';
    var banner = document.createElement('div');
    banner.className = 'subagent-banner';
    var back = document.createElement('a');
    back.href = window.location.pathname;
    back.textContent = '← back to main';
    banner.appendChild(back);
    var d = document.createElement('span');
    d.className = 'sub-desc';
    d.textContent = '· ' + desc;
    banner.appendChild(d);
    subView.appendChild(banner);
    subView.appendChild(tpl.content.cloneNode(true));
    buildMenu();
  }
  function showMain() {
    mainView.classList.remove('is-hidden');
    subView.classList.add('is-hidden');
    subView.textContent = '';
    buildMenu();
  }
  function cssEsc(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; }); }

  function activeRoot() {
    return subView.classList.contains('is-hidden') ? mainView : subView;
  }
  function buildMenu() {
    var root = activeRoot();
    var prompts = root.querySelectorAll('.user-prompt');
    menuList.textContent = '';
    if (!prompts.length) {
      var empty = document.createElement('div');
      empty.className = 'ccs-menu-empty';
      empty.textContent = '（暂无提问）';
      menuList.appendChild(empty);
      return;
    }
    for (var i = 0; i < prompts.length; i++) {
      var raw = (prompts[i].innerText || prompts[i].textContent || '').trim();
      var label = raw.replace(/^❯\\s*/, '').replace(/\\s+/g, ' ').trim();
      if (!label) continue;
      var item = document.createElement('a');
      item.className = 'ccs-menu-item';
      item.href = '#';
      item.textContent = label;
      item.title = label;
      (function (target) {
        item.addEventListener('click', function (e) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          menu.classList.remove('open');
        });
      })(prompts[i]);
      menuList.appendChild(item);
    }
    if (!menuList.children.length) {
      var empty2 = document.createElement('div');
      empty2.className = 'ccs-menu-empty';
      empty2.textContent = '（暂无提问）';
      menuList.appendChild(empty2);
    }
  }
  if (menuBtn) {
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.classList.contains('open');
      if (!open) buildMenu();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (menu.classList.contains('open') && !menu.contains(e.target)) {
        menu.classList.remove('open');
      }
    });
  }

  var initial = paramSubAgent();
  if (initial) showSubagent(initial);
  else showMain();
  window.addEventListener('popstate', function () {
    var id = paramSubAgent();
    if (id) showSubagent(id);
    else showMain();
  });
})();
</script>
</body>
</html>
`;
}
