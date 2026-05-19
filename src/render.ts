import { AnsiUp } from "ansi_up";

export interface Snapshot {
  width: number; // pixel bucket
  cols: number; // tmux column count used at capture
  index: number; // 0 = initial (post-ESC), 1 = post-Ctrl+O, ...
  html: string; // rendered <pre>-inner HTML
}

export function ansiToHtml(ansi: string): string {
  const up = new AnsiUp();
  // Inline styles — produces a single self-contained HTML with no CSS class deps.
  up.use_classes = false;
  // Strip leading/trailing blank lines that tmux pads to fill the visible pane,
  // but keep internal whitespace intact.
  const stripped = ansi.replace(/^[\s ]*\n/g, "").replace(/[\s ]*\n*$/g, "\n");
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
const CJK_RE = /[⺀-⻿　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]/g;

/**
 * Walk the ansi_up output, splitting it into HTML tags vs raw text, and wrap
 * every CJK code point in the text portions with <span class="cjk">…</span>.
 * The .cjk span gets width:2ch in CSS so each wide glyph takes exactly two
 * monospace cells, matching the terminal's cell grid.
 */
export function wrapCJK(html: string): string {
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_m, tag: string, text: string) => {
    if (tag) return tag;
    return text.replace(CJK_RE, (c) => `<span class="cjk">${c}</span>`);
  });
}

export interface BuildHtmlOpts {
  sessionId: string;
  snapshots: Snapshot[];
  fontPx?: number; // base monospace font size
}

/**
 * Build a single HTML document where:
 *   - Each snapshot index becomes a wrapper <div class="snapshot">.
 *   - Within each snapshot, every width-bucket becomes a <pre>.
 *   - CSS media queries pick the right width-bucket based on viewport.
 *   - Pressing Ctrl+O in the page cycles the active snapshot.
 */
export function buildHtml(opts: BuildHtmlOpts): string {
  const { sessionId, snapshots } = opts;
  const fontPx = opts.fontPx ?? 14;

  const widths = uniqSorted(snapshots.map((s) => s.width));
  const snapIdx = uniqSorted(snapshots.map((s) => s.index));

  let body = "";
  for (const idx of snapIdx) {
    const cls = idx === snapIdx[0] ? "snapshot active" : "snapshot";
    body += `<div class="${cls}" data-snapshot="${idx}">\n`;
    for (const w of widths) {
      const snap = snapshots.find((s) => s.index === idx && s.width === w);
      if (!snap) continue;
      body += `  <pre class="terminal width-${w}" data-cols="${snap.cols}">${snap.html}</pre>\n`;
    }
    body += `</div>\n`;
  }

  let widthCss = "";
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    const next = widths[i + 1];
    if (i === 0 && widths.length === 1) {
      widthCss += `.width-${w} { display: block; }\n`;
    } else if (i === 0) {
      widthCss += `@media (max-width: ${next - 1}px) { .snapshot.active .width-${w} { display: block; } }\n`;
    } else if (next) {
      widthCss += `@media (min-width: ${w}px) and (max-width: ${next - 1}px) { .snapshot.active .width-${w} { display: block; } }\n`;
    } else {
      widthCss += `@media (min-width: ${w}px) { .snapshot.active .width-${w} { display: block; } }\n`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Session ${escapeHtml(sessionId)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #181818; }
  body {
    color: #e5e5e5;
    /* ASCII chars use the mono stack; per-glyph fallback hands CJK to
       PingFang (macOS) / Hiragino / Noto CJK as the browser walks the list.
       Keeping the mono families first means ch resolves to the ASCII
       advance, which the .cjk clamp below relies on. */
    font-family: Menlo, Monaco, "SF Mono", SFMono-Regular, ui-monospace,
                 Consolas, "Liberation Mono", "Courier New",
                 "PingFang SC", "PingFang TC", "Hiragino Sans GB",
                 "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC",
                 monospace;
    font-size: ${fontPx}px;
    line-height: 1.4;
    /* No horizontal padding: it would eat into the per-bucket width, making
       the minimum-width breakpoint trigger overflow-x. Vertical padding only. */
    padding: 16px 0 48px;
    font-variant-ligatures: none;
  }
  .terminal {
    white-space: pre;
    margin: 0;
    display: none;
    overflow-x: auto;
    tab-size: 4;
  }
  .snapshot { display: none; }
  .snapshot.active { display: block; }
  /* Wide East-Asian glyphs occupy 2 terminal cells. Clamp their advance to
     exactly 2 ASCII cells (2ch resolves against the inherited mono font's '0')
     so table borders (│ ─ ┌ ┐) keep their grid alignment. We do NOT override
     font-family here — otherwise ch would resolve against the CJK font and
     drift away from the ASCII grid. We must NOT set overflow:hidden either:
     per CSS 2.1 §10.8.1, that flips the inline-block's baseline to the bottom
     margin edge, dragging neighboring ASCII text down half a line. */
  .cjk {
    display: inline-block;
    width: 2ch;
    vertical-align: baseline;
  }
  .hint {
    position: fixed;
    bottom: 10px;
    right: 12px;
    font: 11px/1.4 ui-monospace, monospace;
    color: #b0b0b0;
    background: rgba(0,0,0,0.55);
    border: 1px solid #333;
    padding: 4px 8px;
    border-radius: 4px;
    user-select: none;
    pointer-events: none;
  }
  .hint b { color: #fff; }
${widthCss}</style>
</head>
<body>
${body}<div class="hint" id="ccs-hint"><b id="ccs-idx">${snapIdx[0]}</b>/${snapIdx[snapIdx.length - 1]} · <kbd>Ctrl</kbd>+<kbd>O</kbd> 切换</div>
<script>
(function () {
  var snaps = Array.prototype.slice.call(document.querySelectorAll('.snapshot'));
  var idxEl = document.getElementById('ccs-idx');
  if (snaps.length <= 1) {
    var hint = document.getElementById('ccs-hint');
    if (hint) hint.style.display = 'none';
    return;
  }
  function cycle() {
    var cur = snaps.findIndex(function (n) { return n.classList.contains('active'); });
    var next = (cur + 1) % snaps.length;
    snaps[cur].classList.remove('active');
    snaps[next].classList.add('active');
    if (idxEl) idxEl.textContent = snaps[next].getAttribute('data-snapshot');
  }
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

/**
 * Split into a directory of per-width HTML pages plus an iframe-routed entry.
 * Used when the inline-everything HTML would be too large for one file.
 */
export interface SplitHtmlOpts {
  sessionId: string;
  snapshots: Snapshot[];
  fontPx?: number;
}

export function buildSplitHtml(opts: SplitHtmlOpts): { index: string; files: Record<string, string> } {
  const { sessionId, snapshots } = opts;
  const fontPx = opts.fontPx ?? 14;
  const widths = uniqSorted(snapshots.map((s) => s.width));
  const snapIdx = uniqSorted(snapshots.map((s) => s.index));

  const files: Record<string, string> = {};
  for (const w of widths) {
    let body = "";
    for (const idx of snapIdx) {
      const cls = idx === snapIdx[0] ? "snapshot active" : "snapshot";
      const snap = snapshots.find((s) => s.width === w && s.index === idx);
      if (!snap) continue;
      body += `<div class="${cls}" data-snapshot="${idx}"><pre class="terminal" data-cols="${snap.cols}">${snap.html}</pre></div>\n`;
    }
    files[`w${w}.html`] = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(sessionId)} @${w}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #181818; }
body { color: #e5e5e5; font-family: Menlo, Monaco, "SF Mono", SFMono-Regular, ui-monospace, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "PingFang TC", "Hiragino Sans GB", "Heiti SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: ${fontPx}px; line-height: 1.4; padding: 16px 0; font-variant-ligatures: none; }
.terminal { white-space: pre; margin: 0; overflow-x: auto; tab-size: 4; }
.snapshot { display: none; } .snapshot.active { display: block; }
.cjk { display: inline-block; width: 2ch; vertical-align: baseline; }
</style></head><body>${body}<script>
window.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'ccs-cycle') return;
  var snaps = Array.prototype.slice.call(document.querySelectorAll('.snapshot'));
  var cur = snaps.findIndex(function (n) { return n.classList.contains('active'); });
  var next = (cur + 1) % snaps.length;
  snaps[cur].classList.remove('active');
  snaps[next].classList.add('active');
  parent.postMessage({ type: 'ccs-snapshot', index: snaps[next].getAttribute('data-snapshot') }, '*');
});
</script></body></html>
`;
  }

  let widthCss = "";
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    const next = widths[i + 1];
    const sel = `iframe[data-w="${w}"]`;
    if (i === 0 && widths.length === 1) {
      widthCss += `${sel} { display: block; }\n`;
    } else if (i === 0) {
      widthCss += `@media (max-width: ${next - 1}px) { ${sel} { display: block; } }\n`;
    } else if (next) {
      widthCss += `@media (min-width: ${w}px) and (max-width: ${next - 1}px) { ${sel} { display: block; } }\n`;
    } else {
      widthCss += `@media (min-width: ${w}px) { ${sel} { display: block; } }\n`;
    }
  }

  let frames = "";
  for (const w of widths) {
    frames += `<iframe data-w="${w}" src="w${w}.html"></iframe>\n`;
  }

  const index = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Session ${escapeHtml(sessionId)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; background: #181818; height: 100%; }
  iframe { display: none; border: 0; width: 100%; height: 100vh; background: #181818; }
  ${widthCss}
  .hint { position: fixed; bottom: 10px; right: 12px; font: 11px/1.4 ui-monospace, monospace; color: #b0b0b0; background: rgba(0,0,0,0.55); border: 1px solid #333; padding: 4px 8px; border-radius: 4px; }
</style>
</head>
<body>
${frames}<div class="hint" id="ccs-hint"><b id="ccs-idx">${snapIdx[0]}</b>/${snapIdx[snapIdx.length - 1]} · <kbd>Ctrl</kbd>+<kbd>O</kbd> 切换</div>
<script>
(function () {
  var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
  var idxEl = document.getElementById('ccs-idx');
  function activeFrame() {
    return frames.find(function (f) { return getComputedStyle(f).display !== 'none'; });
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      var f = activeFrame();
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'ccs-cycle' }, '*');
    }
  });
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'ccs-snapshot') return;
    if (idxEl) idxEl.textContent = e.data.index;
    // Mirror across other frames so re-flowing keeps the same snapshot active.
    frames.forEach(function (f) {
      if (!f.contentWindow) return;
      // No-op; mirroring optional. Could implement set-index if needed.
    });
  });
})();
</script>
</body>
</html>
`;
  return { index, files };
}
