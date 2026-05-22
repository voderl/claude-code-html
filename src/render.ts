import { AnsiUp } from "ansi_up";
import { cleanAnsi, segmentAnsi } from "./segment";

export interface Snapshot {
  width: number; // pixel bucket
  cols: number; // tmux column count used at capture
  index: number; // 0 = initial (post-ESC), 1 = post-Ctrl+O, ...
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
 * Render a full snapshot's ANSI as the body of a `<pre class="terminal">`:
 * clean → segment at the ANSI level → emit each segment through ansi_up
 * separately. Tool blocks become inline `<details>`; user prompts and bash
 * runs become `<span class="user-prompt">`; gaps preserve the visual
 * whitespace between blocks.
 */
export function renderAnsi(ansi: string, classifier: StyleClassifier): string {
  const segs = segmentAnsi(cleanAnsi(ansi));
  const parts: string[] = [];
  let promptIdx = 0;
  for (const seg of segs) {
    if (seg.kind === "plain") {
      parts.push(ansiChunkToHtml(seg.ansi, classifier));
    } else if (seg.kind === "prompt") {
      parts.push(
        `<span class="user-prompt" data-prompt-idx="${promptIdx++}">${ansiChunkToHtml(seg.ansi, classifier)}</span>`,
      );
    } else if (seg.kind === "tool") {
      // Output sits inside an explicit .tool-out span so CSS can hide it
      // when <details> is closed (display:inline details + native hiding
      // of non-summary children is unreliable in browsers).
      parts.push(
        `<details class="tool"><summary>${ansiChunkToHtml(seg.cmdAnsi, classifier)}</summary><span class="tool-out">\n${ansiChunkToHtml(seg.outAnsi, classifier)}</span></details>`,
      );
    } else if (seg.kind === "bashTool") {
      // .user-prompt sits on the <summary> (not the <details>) so its
      // textContent is just the `! cmd` line — the menu can use it as the
      // title without scanning past the ⎿ output that follows inside.
      parts.push(
        `<details class="tool"><summary class="user-prompt" data-prompt-idx="${promptIdx++}">${ansiChunkToHtml(seg.cmdAnsi, classifier)}</summary><span class="tool-out">\n${ansiChunkToHtml(seg.outAnsi, classifier)}</span></details>`,
      );
    } else {
      // gap.count N → N visible blank lines. Each parts[] entry is joined
      // with one "\n", so N-1 explicit "\n" plus the two joining ones
      // produces N+1 newlines between neighbours = N blanks.
      parts.push("\n".repeat(Math.max(0, seg.count - 1)));
    }
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
}

/**
 * Build a single HTML document where:
 *   - Inline styles from ansi_up are deduped into short CSS classes.
 *   - Each width bucket lives inside its own <template data-w="N" data-cols="C">.
 *     Templates are inert until cloned, so the browser does no layout work for
 *     the buckets it isn't currently showing.
 *   - JS picks the largest template whose data-w ≤ window.innerWidth and clones
 *     its content into <div id="snap">. On resize it re-clones.
 *   - Ctrl+O cycles the active .snapshot div within the cloned content. The
 *     cycle index is preserved across resize-driven re-clones.
 */
export function buildHtml(opts: BuildHtmlOpts): string {
  const { sessionId, snapshots } = opts;
  const fontPx = opts.fontPx ?? 14;
  const title = (opts.title && opts.title.trim()) || `Claude Code Session ${sessionId}`;

  const widths = uniqSorted(snapshots.map((s) => s.width));
  const snapIdx = uniqSorted(snapshots.map((s) => s.index));

  const classifier = new StyleClassifier();
  let templates = "";
  for (const w of widths) {
    const cols = snapshots.find((s) => s.width === w)?.cols ?? 0;
    let inner = "";
    for (const idx of snapIdx) {
      const snap = snapshots.find((s) => s.index === idx && s.width === w);
      if (!snap) continue;
      const cls = idx === snapIdx[0] ? "snapshot active" : "snapshot";
      const body = renderAnsi(snap.ansi, classifier);
      inner += `<div class="${cls}" data-snapshot="${idx}">${body}</div>`;
    }
    templates += `<template data-w="${w}" data-cols="${cols}">${inner}</template>\n`;
  }

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
.terminal { white-space: pre; margin: 0; tab-size: 4; }
.snapshot { display: none; }
.snapshot.active { display: block; }
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
   inline-block so it flows with surrounding text, and the .tool-out body
   is inline-table so its block of multi-line output keeps its own layout
   when expanded without breaking the pre's character grid. */
details.tool { display: inline-block; }
details.tool > summary {
  display: inline; cursor: pointer; list-style: none; outline: none;
  border-radius: 4px; padding: 4px 4px 4px 0;
}
details.tool > summary::-webkit-details-marker { display: none; }
details.tool > summary::marker { content: ""; }
/* Skip the ::details-content {display:contents} hack — overriding the
   pseudo-element's box also disables Chrome's built-in "hide non-summary
   children when not [open]" mechanism, which leaves the body always
   visible. The explicit .tool-out rules below handle layout + visibility. */
details.tool > .tool-out { display: inline; }
details.tool:not([open]) > .tool-out { display: none; }
details.tool > summary:hover { background: rgba(255,255,255,0.06); }
details.tool[open] > summary { background: rgba(255,255,255,0.03); }
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
   one scrolls to that prompt's <span class="user-prompt"> in the active
   snapshot. */
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
<div class="hint" id="ccs-hint"><b id="ccs-idx">View</b> · <kbd>Ctrl</kbd>+<kbd>O</kbd> 切换</div>
<script>
(function () {
  var widths = ${JSON.stringify(widths)};
  var snap = document.getElementById('snap');
  var idxEl = document.getElementById('ccs-idx');
  var hint = document.getElementById('ccs-hint');
  var menu = document.getElementById('ccs-menu');
  var menuBtn = document.getElementById('ccs-menu-btn');
  var menuList = document.getElementById('ccs-menu-list');
  var activeIdx = 0;
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
    apply();
  }
  function apply() {
    var snaps = snap.querySelectorAll('.snapshot');
    if (snaps.length <= 1 && hint) hint.style.display = 'none';
    for (var i = 0; i < snaps.length; i++) {
      if (i === activeIdx) snaps[i].classList.add('active');
      else snaps[i].classList.remove('active');
    }
    if (idxEl && snaps[activeIdx]) idxEl.textContent = activeIdx === 0 ? 'View' : 'Detail';
  }
  function cycle() {
    var snaps = snap.querySelectorAll('.snapshot');
    if (snaps.length <= 1) return;
    activeIdx = (activeIdx + 1) % snaps.length;
    apply();
  }
  function buildMenu() {
    var activeSnap = snap.querySelector('.snapshot.active') || snap;
    var prompts = activeSnap.querySelectorAll('.user-prompt');
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
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      cycle();
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
