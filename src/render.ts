import { AnsiUp } from "ansi_up";

export interface Snapshot {
  width: number; // pixel bucket
  cols: number; // tmux column count used at capture
  index: number; // 0 = initial (post-ESC), 1 = post-Ctrl+O, ...
  html: string; // rendered <pre>-inner HTML
}

export function ansiToHtml(ansi: string): string {
  const up = new AnsiUp();
  // Inline styles — we class-ify them later in buildHtml.
  up.use_classes = false;
  // Strip leading/trailing blank lines that tmux pads to fill the visible pane,
  // but keep internal whitespace intact.
  const stripped = ansi.replace(/^[\s ]*\n/g, "").replace(/[\s ]*\n*$/g, "\n");
  // Strip OSC sequences (ESC ] ... ST). ansi_up only understands CSI/SGR, so
  // OSC 8 hyperlinks would otherwise leak their ]8;…\ body into the HTML as
  // garbage. Dropping the start/end markers preserves the anchor text between.
  const cleaned = stripped
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // Drop non-SGR CSI control sequences ansi_up doesn't recognize.
    .replace(/\x1b\[\??[0-9;]*[hlABCDsuJKf]/g, "");

  let html = up.ansi_to_html(cleaned);
  // Terminal "bold" reads as weight 500-600 visually; browser `bold` (700)
  // looks heavier than what the user sees in their terminal.
  html = html.replace(/font-weight:bold\b/g, "font-weight:500");
  return wrapCJK(html);
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
 * text-justify: inter-character, so every wide glyph still lands on a 2-cell
 * boundary without paying the per-character span overhead.
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
      const html = mergeAdjacentSpans(classifier.classify(snap.html));
      inner += `<div class="${cls}" data-snapshot="${idx}"><pre class="terminal">${html}</pre></div>`;
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
  line-height: 1.4;
  padding: 16px 0 48px;
  font-variant-ligatures: none;
}
.terminal { white-space: pre; margin: 0; overflow-x: auto; tab-size: 4; }
.snapshot { display: none; }
.snapshot.active { display: block; }
/* CJK runs render inside an inline-block whose width is class-driven
   (.cjk picks up width:Nch from the deduped style classes). text-justify:
   inter-character distributes the run across the 2N-cell slot so each glyph
   lands on a 2-cell boundary without per-character span overhead. */
.cjk {
  display: inline-block;
  text-align: justify;
  text-align-last: justify;
  text-justify: inter-character;
  vertical-align: baseline;
}
.hint {
  position: fixed; bottom: 10px; right: 12px;
  font: 11px/1.4 ui-monospace, monospace;
  color: #b0b0b0; background: rgba(0,0,0,0.55);
  border: 1px solid #333; padding: 4px 8px; border-radius: 4px;
  user-select: none; pointer-events: none;
}
.hint b { color: #fff; }
${classifier.cssRules()}
</style>
</head>
<body>
${templates}<div id="snap"></div>
<div class="hint" id="ccs-hint"><b id="ccs-idx">${snapIdx[0]}</b>/${snapIdx[snapIdx.length - 1]} · <kbd>Ctrl</kbd>+<kbd>O</kbd> 切换</div>
<script>
(function () {
  var widths = ${JSON.stringify(widths)};
  var snap = document.getElementById('snap');
  var idxEl = document.getElementById('ccs-idx');
  var hint = document.getElementById('ccs-hint');
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
    if (idxEl && snaps[activeIdx]) idxEl.textContent = snaps[activeIdx].getAttribute('data-snapshot');
  }
  function cycle() {
    var snaps = snap.querySelectorAll('.snapshot');
    if (snaps.length <= 1) return;
    activeIdx = (activeIdx + 1) % snaps.length;
    apply();
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
