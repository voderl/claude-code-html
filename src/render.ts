import { AnsiUp } from "ansi_up";
import { cleanAnsi, segmentAnsi, Segment } from "./segment";

export interface Snapshot {
  width: number; // pixel bucket
  cols: number; // tmux column count used at capture
  ansi: string; // already-trimmed ANSI from tmux capture-pane -e
}

/**
 * Render one ANSI chunk to inline-HTML via ansi_up, then route it through
 * CJK wrapping, style classification (so repeated colours collapse to short
 * class names), and adjacent-span merging. Each call is independent — we
 * never let ansi_up state leak across segments.
 */
function ansiChunkToHtml(ansi: string, classifier: StyleClassifier): string {
  if (!ansi) return "";
  const up = new AnsiUp();
  up.use_classes = false;
  let html = up.ansi_to_html(ansi);
  // Terminal "bold" reads as weight 500-600 visually; browser `bold` (700)
  // looks heavier than what the user sees in their terminal.
  html = html.replace(/font-weight:bold\b/g, "font-weight:500");
  html = wrapCJK(html);
  html = classifier.classify(html);
  html = mergeAdjacentSpans(html);
  return html;
}

/**
 * Pull the tool name out of a tool segment so we can title group summaries.
 * Tool calls render as `⏺ <Name>(...)` with the name in bold; bashTool is
 * the user's `!` shortcut and we label it as "Bash" by convention.
 */
function toolName(seg: { kind: string; cmdAnsi: string }): string {
  if (seg.kind === "bashTool") return "Bash";
  const text = seg.cmdAnsi.replace(/\x1b\[[\d;]*[a-zA-Z]/g, "");
  const m = text.match(/⏺\s+([A-Za-z][\w]*)/);
  return m ? m[1] : "Tool";
}

function buildGroupSummary(tools: Array<{ kind: string; cmdAnsi: string }>): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const n = toolName(t);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const breakdown = Array.from(counts.entries())
    .map(([n, c]) => `${escapeHtml(n)}×${c}`)
    .join(", ");
  return `▸ ${tools.length} tools hidden (${breakdown}), click or ctrl+o to expand`;
}

/**
 * Render a full snapshot's ANSI as the body of a `<pre class="terminal">`:
 * clean → segment at the ANSI level → emit each segment through ansi_up
 * separately. Tool blocks become inline `<details>`; user prompts and bash
 * runs become `<span class="user-prompt">`; gaps preserve the visual
 * whitespace between blocks. Runs of ≥2 consecutive tool/bashTool segments
 * (with optional gaps between) fold into a single `<details class="tool-group">`
 * — collapsed by default in View mode and expanded en-masse in Detail mode.
 */
export function renderAnsi(ansi: string, classifier: StyleClassifier): string {
  const segs = segmentAnsi(cleanAnsi(ansi));
  const parts: string[] = [];
  let promptIdx = 0;

  const renderOne = (seg: Segment): string => {
    if (seg.kind === "plain") return ansiChunkToHtml(seg.ansi, classifier);
    if (seg.kind === "prompt") {
      return `<span class="user-prompt" data-prompt-idx="${promptIdx++}">${ansiChunkToHtml(seg.ansi, classifier)}</span>`;
    }
    if (seg.kind === "agent") {
      return `<span class="agent-prompt">${ansiChunkToHtml(seg.ansi, classifier)}</span>`;
    }
    if (seg.kind === "tool") {
      // Output sits inside .tool-out, but the *hiding* is delegated to the
      // browser's user-agent rule on ::details-content — closed <details>
      // hides its content via the native mechanism, which Chrome's find-in-
      // page knows how to auto-expand. No explicit "\n" before the body:
      // the block-level ::details-content wrapper already breaks the line
      // between <summary> and the output.
      return `<details class="tool"><summary>${ansiChunkToHtml(seg.cmdAnsi, classifier)}</summary><span class="tool-out">${ansiChunkToHtml(seg.outAnsi, classifier)}</span></details>`;
    }
    if (seg.kind === "bashTool") {
      // .user-prompt sits on the <summary> (not the <details>) so its
      // textContent is just the `! cmd` line — the menu can use it as the
      // title without scanning past the ⎿ output that follows inside.
      return `<details class="tool"><summary class="user-prompt" data-prompt-idx="${promptIdx++}">${ansiChunkToHtml(seg.cmdAnsi, classifier)}</summary><span class="tool-out">${ansiChunkToHtml(seg.outAnsi, classifier)}</span></details>`;
    }
    // gap.count N → N visible blank lines. Each parts[] entry is joined
    // with one "\n", so N-1 explicit "\n" plus the two joining ones
    // produces N+1 newlines between neighbours = N blanks.
    return "\n".repeat(Math.max(0, seg.count - 1));
  };

  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    if (seg.kind === "tool" || seg.kind === "bashTool") {
      // Walk forward collecting consecutive tool/bashTool segments. Gaps
      // between two tools are absorbed into the group (so they hide with
      // the body); a trailing gap before a non-tool segment is *not* —
      // it stays outside so the spacing before the next block survives.
      const tools: Array<{ kind: string; cmdAnsi: string }> = [seg];
      let j = i + 1;
      let groupEnd = j;
      while (j < segs.length) {
        const s = segs[j];
        if (s.kind === "tool" || s.kind === "bashTool") {
          tools.push(s);
          j++;
          groupEnd = j;
        } else if (s.kind === "gap") {
          j++;
        } else {
          break;
        }
      }
      if (tools.length >= 2) {
        const inner: string[] = [];
        for (let k = i; k < groupEnd; k++) inner.push(renderOne(segs[k]));
        parts.push(
          `<details class="tool-group"><summary class="tool-group-summary">${buildGroupSummary(tools)}</summary><span class="tool-group-body">${inner.join("\n")}</span></details>`,
        );
        i = groupEnd;
        continue;
      }
    }
    parts.push(renderOne(seg));
    i++;
  }
  return `<pre class="terminal">${parts.join("\n")}</pre>`;
}

// CJK Unified Ideographs + extensions, Hiragana, Katakana, CJK Symbols and
// Punctuation, Halfwidth and Fullwidth Forms. Each glyph occupies 2 terminal
// cells, so in HTML we need to clamp its rendered width to 2ch to keep the
// table borders (│ ─ etc.) aligned with the ASCII grid.
const CJK_RUN_RE = /[⺀-⻿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]+/g;

/**
 * Walk the ansi_up output, splitting it into HTML tags vs raw text, and wrap
 * each *run* of consecutive CJK code points in a single
 * <span class="cjk" style="width:Nch">…</span>, where N = 2 × char count.
 * CSS justifies the run's content with text-align: justify +
 * text-justify: inter-character (plus 2px horizontal padding to keep short
 * runs from glueing to the box edges), so every wide glyph still lands inside
 * its 2-cell slot without paying the per-character span overhead.
 */
export function wrapCJK(html: string): string {
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_m, tag: string, text: string) => {
    if (tag) return tag;
    return text.replace(
      CJK_RUN_RE,
      (run) => `<span class="cjk" style="width:${run.length * 2}ch">${run}</span>`,
    );
  });
}

/**
 * Dedupe every `style="…"` attribute we encounter into a short CSS class, so
 * thousands of repeated `<span style="color:rgb(…)">` shrink to `<span class="a">`.
 * Names use a base-52/62 alphabet (single char for the first 52 unique styles,
 * two chars for the next 3,224, etc.) to keep the per-span cost minimal.
 */
class StyleClassifier {
  private map = new Map<string, string>();
  private n = 0;

  classify(html: string): string {
    return html.replace(/<([a-zA-Z][\w-]*)([^>]*)>/g, (full, tag: string, attrs: string) => {
      const styleMatch = attrs.match(/\sstyle="([^"]*)"/);
      if (!styleMatch) return full;
      const style = styleMatch[1];
      let cls = this.map.get(style);
      if (cls === undefined) {
        cls = shortName(this.n++);
        this.map.set(style, cls);
      }
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

  cssRules(): string {
    let css = "";
    for (const [style, cls] of this.map) css += `.${cls}{${style}}`;
    return css;
  }
}

/**
 * ansi_up emits one <span> per uncolored "token" even when consecutive tokens
 * share the same SGR state, because the TUI usually wraps each word in its own
 * \x1b[...m...\x1b[0m. After classify(), that shows up as `<span class="X">A</span>
 * <span class="X">B</span>` pairs that round-trip to the same color. Merge any
 * such adjacent pair into `<span class="X">A B</span>`. Iterate until fixed
 * point so chains of N same-class spans collapse into one. Safe: we only merge
 * across separators that contain no tags, so we never absorb nested markup.
 *
 * .cjk spans are exempt: their width class encodes the exact CJK char count of
 * the wrapped run, so merging two `class="cjk l"` (width:2ch) spans across an
 * intervening `17` would leave the merged span 2ch wide but 4 visual cells of
 * content — the cjk box-drawing borders on later lines would then drift.
 */
function mergeAdjacentSpans(html: string): string {
  const re = /<span class="([^"]+)">([^<]*)<\/span>([^<]*)<span class="\1">([^<]*)<\/span>/g;
  let prev = "";
  while (prev !== html) {
    prev = html;
    html = html.replace(re, (m, cls: string, a: string, sep: string, b: string) =>
      /\bcjk\b/.test(cls) ? m : `<span class="${cls}">${a}${sep}${b}</span>`,
    );
  }
  return html;
}

// Class identifiers must start with a letter (52 options) and may continue
// with letters or digits (62 options).
const LEAD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const REST = LEAD + "0123456789";

function shortName(n: number): string {
  let len = 1;
  let offset = 0;
  let cap = LEAD.length;
  while (n - offset >= cap) {
    offset += cap;
    len++;
    cap = LEAD.length * Math.pow(REST.length, len - 1);
  }
  let m = n - offset;
  let s = "";
  for (let i = 0; i < len - 1; i++) {
    s = REST[m % REST.length] + s;
    m = Math.floor(m / REST.length);
  }
  return LEAD[m] + s;
}

export interface BuildHtmlOpts {
  sessionId: string;
  snapshots: Snapshot[];
  fontPx?: number; // base monospace font size
  title?: string; // <title> (defaults to "Claude Code Session <sessionId>")
  // Initial fold state. "preview" closes every <details> (matches the
  // tool-group's "N tools hidden …" summary); "detail" expands everything.
  // Defaults to "preview".
  mode?: "preview" | "detail";
}

/**
 * Build a single HTML document where:
 *   - Inline styles from ansi_up are deduped into short CSS classes.
 *   - Each width bucket lives inside its own <template data-w="N" data-cols="C">.
 *     Templates are inert until cloned, so the browser does no layout work for
 *     the buckets it isn't currently showing.
 *   - JS picks the largest template whose data-w ≤ window.innerWidth and clones
 *     its content into <div id="snap">. On resize it re-clones.
 *   - Ctrl+O toggles the global view mode (preview ↔ detail); Ctrl+E toggles
 *     whether each individual tool call is expanded. State survives the
 *     resize-driven re-clone.
 */
export function buildHtml(opts: BuildHtmlOpts): string {
  const { sessionId, snapshots } = opts;
  const fontPx = opts.fontPx ?? 14;
  // 'preview' = all <details> closed (only tool-group summaries visible);
  // 'detail' = all <details> open. Falls back to 'preview' on any other value.
  const buildMode: "preview" | "detail" = opts.mode === "detail" ? "detail" : "preview";
  let title = (opts.title ?? "").trim().replace(/^✳\s*/, "").trim();
  if (!title) title = `Claude Code Session ${sessionId}`;

  const widths = uniqSorted(snapshots.map((s) => s.width));

  const classifier = new StyleClassifier();
  let templates = "";
  for (const w of widths) {
    const snap = snapshots.find((s) => s.width === w);
    if (!snap) continue;
    // Expose the capture's column count as a CSS variable so .tool's
    // ellipsis cap (max-width: var(--cols)) matches the exported pane
    // width — e.g. a 50-col snapshot caps tool summaries at 50ch.
    const inner = `<div class="snapshot" style="--cols:${snap.cols}ch">${renderAnsi(snap.ansi, classifier)}</div>`;
    templates += `<template data-w="${w}" data-cols="${snap.cols}">${inner}</template>\n`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${faviconDataUrl()}">
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
.terminal { white-space: pre; margin: 0; tab-size: 4; }
/* CJK runs render inside an inline-block whose width is class-driven
   (.cjk picks up width:Nch from the deduped style classes). text-justify:
   inter-character distributes the run across the slot. The 2px horizontal
   padding (eaten out of the outer width by the global box-sizing: border-box,
   so the cell-aligned outer width is preserved) reserves a small edge gutter
   so short runs — especially N=2 where justify would otherwise dump all slack
   into the single inter-char gap — don't glue their glyphs to the box edges. */
.cjk {
  display: inline-block;
  text-align: justify;
  text-align-last: justify;
  text-justify: inter-character;
  padding: 0 2px;
  vertical-align: baseline;
}
/* Tool-call blocks sit inside the terminal pre. details.tool is an
   inline-block so it flows with surrounding text. max-width: 100% caps the
   element to the pre's content width — that gives the closed summary a
   real width to ellipsis against. line-height tightens vertical rhythm so
   stacked tool blocks don't drift apart. */
details.tool {
  display: inline-block;
  max-width: var(--cols, 100ch);
  vertical-align: top;
  line-height: 1.15;
  /* Pull the box back in by exactly the summary's padding so the visual
     footprint matches the text content while the summary keeps the
     padding for its hover target / background. */
  margin: -4px -4px -4px 0px;
}
details.tool > summary {
  /* Fixed-width inline-block sized to the capture's column count; both
     states share the box so the open ↔ closed transition doesn't reflow
     anything around it. Closed adds the ellipsis clamp on top. */
  display: inline-block;
  width: var(--cols, 100ch);
  line-height: 1.3;
  cursor: pointer; list-style: none; outline: none;
  border-radius: 4px; padding: 4px 4px 4px 0px;
}
details.tool > summary::-webkit-details-marker { display: none; }
details.tool > summary::marker { content: ""; }
details.tool:not([open]) > summary {
  /* Single-line ellipsis when closed. nowrap collapses any embedded
     newline continuations of long cmds into spaces — that's the price of
     native text-overflow ellipsis. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
details.tool[open] > summary { background: rgba(255,255,255,0.03); }
details.tool > summary:hover { background: rgba(255,255,255,0.06); }
/* Hiding of .tool-out is delegated to the user-agent ::details-content rule:
   when <details> is closed, Chrome (and Firefox 131+/Safari 18.4+) hides the
   content via the native mechanism. We deliberately do NOT override
   ::details-content here — the native hiding is what makes Chrome's
   find-in-page auto-expand work, even across nested <details>. */
/* Tool-group: wraps a run of ≥2 adjacent tool calls so the whole run can
   collapse behind a single summary in View mode. Same story as details.tool —
   we let the user-agent ::details-content rule hide .tool-group-body when
   closed, so Ctrl+F can search and auto-expand through both layers. */
details.tool-group {
  display: inline-block;
  vertical-align: top;
  max-width: var(--cols, 100ch);
}
details.tool-group > summary.tool-group-summary {
  /* Sized to its content but capped at the capture's column count so the
     dashed-box never spills past the pane edge — short breakdowns stay
     tight, long ones ellipsis at --cols. */
  display: inline-block;
  max-width: var(--cols, 100ch);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer; list-style: none; outline: none;
  color: #8a8a8a;
  font-style: italic;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  border: 1px dashed rgba(255,255,255,0.12);
  user-select: none;
}
details.tool-group > summary.tool-group-summary::-webkit-details-marker { display: none; }
details.tool-group > summary.tool-group-summary::marker { content: ""; }
details.tool-group > summary.tool-group-summary:hover {
  background: rgba(255,255,255,0.08);
  color: #d0d0d0;
}
details.tool-group[open] > summary.tool-group-summary { display: none; }
.hint {
  position: fixed; bottom: 10px; right: 12px;
  font: 11px/1.4 ui-monospace, monospace;
  color: #b0b0b0; background: rgba(0,0,0,0.55);
  border: 1px solid #333; padding: 4px 8px; border-radius: 4px;
  user-select: none; pointer-events: none;
}
.hint b { color: #fff; }
/* Prompt-jump menu — top-right hamburger that opens a list of the user's
   prompts. Each item is the prompt's textContent, ellipsized, and clicking
   one scrolls to that prompt's <span class="user-prompt">. */
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
.ccs-menu-empty {
  padding: 8px 10px; color: #888; font-style: italic;
}
${classifier.cssRules()}
</style>
</head>
<body>
${templates}<div id="snap"></div>
<div class="ccs-menu" id="ccs-menu"><button class="ccs-menu-btn" id="ccs-menu-btn" type="button" aria-label="提问列表">☰</button><div class="ccs-menu-list" id="ccs-menu-list"></div></div>
<div class="hint" id="ccs-hint"><b id="ccs-idx">${buildMode === "detail" ? "Detail" : "Preview"}</b> · <kbd>Ctrl</kbd>+<kbd>O</kbd> toggle<span id="ccs-tools-hint"${buildMode === "detail" ? "" : " hidden"}> · <kbd>Ctrl</kbd>+<kbd>E</kbd> to <span id="ccs-tools">expand</span> tool</span></div>
<script>
(function () {
  var widths = ${JSON.stringify(widths)};
  var snap = document.getElementById('snap');
  var idxEl = document.getElementById('ccs-idx');
  var toolsEl = document.getElementById('ccs-tools');
  var toolsHint = document.getElementById('ccs-tools-hint');
  var hint = document.getElementById('ccs-hint');
  var menu = document.getElementById('ccs-menu');
  var menuBtn = document.getElementById('ccs-menu-btn');
  var menuList = document.getElementById('ccs-menu-list');
  // 'preview' = every <details> closed (matches the "N tools hidden …"
  // summary on tool-groups). 'detail' = every <details> open. Priority:
  // URL ?mode=preview|detail > build-time --mode > built-in 'preview'.
  // Case-insensitive on the URL value so ?mode=Detail also works.
  // Persisted here so it survives snapshot/width re-clones (re-apply after
  // every render()).
  var buildMode = ${JSON.stringify(buildMode)};
  function readInitialMode() {
    try {
      var v = (new URLSearchParams(location.search).get('mode') || '').toLowerCase();
      if (v === 'preview') return 'preview';
      if (v === 'detail') return 'detail';
    } catch (e) {}
    return buildMode;
  }
  var mode = readInitialMode();
  // Detail-only fine-grain: do individual tool calls show their <details>
  // body? Independent of mode; defaults to false (folded) so Detail mode
  // first shows just the cmd lines and the user reaches Ctrl+E for the
  // verbose output. Stays unset while in Preview (the parent tool-group
  // hides everything anyway).
  var toolsOpen = false;
  var curW = -1;
  function pickW() {
    var iw = window.innerWidth;
    for (var i = widths.length - 1; i >= 0; i--) if (iw >= widths[i]) return widths[i];
    return widths[0];
  }
  function render() {
    var w = pickW();
    if (w === curW) return;
    curW = w;
    var tpl = document.querySelector('template[data-w="' + w + '"]');
    snap.textContent = '';
    snap.appendChild(tpl.content.cloneNode(true));
    applyMode();
  }
  function applyMode() {
    // Two independent layers:
    //   mode       → details.tool-group open/closed
    //   toolsOpen  → each details.tool open/closed
    // In Preview the inner tool state is moot (the group hides it), but
    // we still set it so toggling out to Detail mode honours the user's
    // most recent Ctrl+E choice.
    var groups = snap.querySelectorAll('details.tool-group');
    for (var i = 0; i < groups.length; i++) {
      if (mode === 'preview') groups[i].removeAttribute('open');
      else groups[i].setAttribute('open', '');
    }
    var tools = snap.querySelectorAll('details.tool');
    for (var j = 0; j < tools.length; j++) {
      if (toolsOpen) tools[j].setAttribute('open', '');
      else tools[j].removeAttribute('open');
    }
    if (idxEl) idxEl.textContent = mode === 'detail' ? 'Detail' : 'Preview';
    // Verb describes what Ctrl+E will do next: when tools are open, the
    // hint says "to fold"; when collapsed, "to expand".
    if (toolsEl) toolsEl.textContent = toolsOpen ? 'fold' : 'expand';
    if (toolsHint) toolsHint.hidden = mode !== 'detail';
  }
  function cycleMode() {
    mode = mode === 'preview' ? 'detail' : 'preview';
    applyMode();
  }
  function cycleTools() {
    toolsOpen = !toolsOpen;
    applyMode();
  }
  function buildMenu() {
    var prompts = snap.querySelectorAll('.user-prompt');
    menuList.textContent = '';
    if (!prompts.length) {
      var empty = document.createElement('div');
      empty.className = 'ccs-menu-empty';
      empty.textContent = '（暂无提问）';
      menuList.appendChild(empty);
      return;
    }
    for (var i = 0; i < prompts.length; i++) {
      var raw = (prompts[i].textContent || '').trim();
      // .user-prompt wraps only the user's question (prompt span) or the
      // bashTool summary — no slash-command output bleeds in, so the label
      // needs no ⎿ slicing. Just strip the leading marker.
      var label = raw.replace(/^[❯!]\\s*/, '').replace(/\\s+/g, ' ').trim();
      // Bypass-permissions banner renders as a ❯ block sandwiched between
      // box-drawing rules. Skip entries whose content is purely decorative.
      if (!label || /^─/.test(label)) continue;
      var item = document.createElement('a');
      item.className = 'ccs-menu-item';
      item.href = '#';
      item.textContent = label;
      item.title = label;
      (function (target) {
        item.addEventListener('click', function (e) {
          e.preventDefault();
          // Open any ancestor <details> (tool / tool-group) so the target
          // has layout — otherwise scrollIntoView is a no-op on a hidden
          // node inside a collapsed View-mode group.
          var p = target.parentElement;
          while (p) {
            if (p.tagName === 'DETAILS' && !p.hasAttribute('open')) p.setAttribute('open', '');
            p = p.parentElement;
          }
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
  render();
  window.addEventListener('resize', render);
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey && !e.metaKey && !e.altKey)) return;
    if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      cycleMode();
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      cycleTools();
    }
  });
})();
</script>
</body>
</html>
`;
}

function uniqSorted(xs: number[]): number[] {
  return Array.from(new Set(xs)).sort((a, b) => a - b);
}

function faviconDataUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="32" dy=".35em" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="52" fill="#cc785c">✳</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
