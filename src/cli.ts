#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { Tmux, waitForStable, checkTmuxAvailable } from "./tmux";
import {
  Snapshot,
  ansiToHtml,
  buildHtml,
} from "./render";

interface WidthSpec {
  px: number;
  cols: number;
  rows: number;
}

function parseWidths(input: string, charPx: number, rows: number): WidthSpec[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d+)(?:x(\d+))?$/);
      if (!m) throw new Error(`invalid width spec: ${s}`);
      const px = parseInt(m[1], 10);
      const rs = m[2] ? parseInt(m[2], 10) : rows;
      return { px, cols: Math.max(40, Math.floor(px / charPx)), rows: rs };
    });
}

function sessionName(sessionId: string, w: number): string {
  return `ccs_${sessionId.slice(0, 8)}_${w}`;
}

const ANSI_RE = /\x1b\[[\d;]*[a-zA-Z]/g;
const STATUS_BAR_RE = /Showing detailed transcript/;

/**
 * A captured pane from Claude's detailed-transcript view ends with a
 * status bar ("Showing detailed transcript · ctrl+o to toggle · …") and a
 * box-drawing separator above it, followed by blank padding to fill the
 * pane. Cut everything from the status bar down so the bar doesn't repeat
 * once per page when we stitch frames together.
 */
function trimPaneFrame(page: string): string {
  const lines = page.split("\n");
  let bottom = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (STATUS_BAR_RE.test(lines[i].replace(ANSI_RE, ""))) {
      bottom = i;
      while (
        bottom > 0 &&
        /^[\s─]*$/.test(lines[bottom - 1].replace(ANSI_RE, ""))
      ) {
        bottom--;
      }
      break;
    }
  }
  while (bottom > 0 && lines[bottom - 1].replace(ANSI_RE, "").trim() === "") {
    bottom--;
  }
  return lines.slice(0, bottom).join("\n");
}

/**
 * Stitch consecutive trimmed pane frames into one stream. Adjacent pages
 * usually share a few overlapping context lines (PageUp doesn't move by
 * exactly one page on its own); find the largest k such that the last k
 * lines of `acc` equal the first k lines of `next`, then drop those k
 * lines from `next` before concatenating. Comparison ignores ANSI codes.
 */
function joinFrames(frames: string[]): string {
  if (frames.length === 0) return "";
  let acc = frames[0];
  for (let i = 1; i < frames.length; i++) {
    const next = frames[i];
    const overlap = findOverlap(acc, next);
    const remaining = next.split("\n").slice(overlap).join("\n");
    if (remaining) acc = acc + "\n" + remaining;
  }
  return acc;
}

/**
 * Send the given key repeatedly until the visible pane stops changing for two
 * consecutive pulses — used to scroll to the top or bottom of Claude's
 * detailed-transcript view before/after a capture cycle.
 */
async function pageToEnd(
  tmux: Tmux,
  name: string,
  key: "PageUp" | "PageDown",
  pollMs: number
): Promise<number> {
  let lastPlain = tmux.capturePaneVisible(name, false);
  let stable = 0;
  let count = 0;
  const MAX = 500;
  for (let p = 0; p < MAX; p++) {
    tmux.sendKeys(name, key);
    await new Promise((r) => setTimeout(r, pollMs));
    const plain = tmux.capturePaneVisible(name, false);
    if (plain === lastPlain) {
      stable++;
      if (stable >= 2) return count;
    } else {
      stable = 0;
      lastPlain = plain;
    }
    count++;
  }
  return count;
}

/**
 * Capture the visible pane while paging up. Returns frames in chronological
 * order (oldest first). Assumes Claude is at the bottom of its detailed
 * transcript view when called.
 */
async function capturePagesUp(
  tmux: Tmux,
  name: string,
  pollMs: number
): Promise<{ frames: string[]; scrolled: number }> {
  const frames: string[] = [tmux.capturePaneVisible(name, true)];
  let lastPlain = tmux.capturePaneVisible(name, false);
  let stable = 0;
  let scrolled = 0;
  const MAX = 500;
  for (let p = 0; p < MAX; p++) {
    tmux.sendKeys(name, "PageUp");
    await new Promise((r) => setTimeout(r, pollMs));
    const plain = tmux.capturePaneVisible(name, false);
    if (plain === lastPlain) {
      stable++;
      if (stable >= 2) break;
      continue;
    }
    stable = 0;
    lastPlain = plain;
    frames.push(tmux.capturePaneVisible(name, true));
    scrolled++;
  }
  return { frames: frames.reverse(), scrolled };
}

function findOverlap(prev: string, cur: string): number {
  const stripped = (s: string) => s.replace(ANSI_RE, "");
  const p = stripped(prev).split("\n");
  const c = stripped(cur).split("\n");
  // Adjacent pages can overlap by hundreds of lines (PgUp inside Claude's
  // detailed transcript often leaves most of the previous viewport in place
  // and just reveals a few new lines at the top). The cap has to cover the
  // entire frame, not a token slice.
  const cap = Math.min(p.length, c.length);
  for (let k = cap; k >= 1; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (p[p.length - k + j] !== c[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

async function captureWidth(opts: {
  tmux: Tmux;
  sessionId: string;
  spec: WidthSpec;
  stableMs: number;
  pollMs: number;
  maxWaitMs: number;
  snapshots: number;
  claudeBin: string;
  cwd: string;
  log: (s: string) => void;
}): Promise<{ snapshots: Snapshot[]; paneTitle: string }> {
  const name = sessionName(opts.sessionId, opts.spec.px);
  if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);

  const cmd = [opts.claudeBin, "--resume", opts.sessionId];

  opts.log(
    `[w=${opts.spec.px}] starting tmux session ${name} (${opts.spec.cols}x${opts.spec.rows})`
  );
  opts.tmux.newDetachedSession({
    name,
    cols: opts.spec.cols,
    rows: opts.spec.rows,
    cwd: opts.cwd,
    command: cmd,
    env: {
      TERM: process.env.TERM || "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
      // Tell Claude to emit the transcript without its usual partial-redraw
      // tricks. Without this, Claude virtualizes long transcripts and never
      // pushes older messages into tmux's scrollback. The user can override
      // by exporting CLAUDE_CODE_NO_FLICKER=0 in their environment.
      CLAUDE_CODE_NO_FLICKER: process.env.CLAUDE_CODE_NO_FLICKER || "1",
    },
  });

  const out: Snapshot[] = [];
  let paneTitle = "";
  try {
    opts.log(`[w=${opts.spec.px}] waiting for initial render to settle...`);
    await waitForStable(opts.tmux, name, {
      stableMs: opts.stableMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
    });

    opts.tmux.sendKeys(name, "Escape");
    await waitForStable(opts.tmux, name, {
      stableMs: opts.stableMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
    });

    // Both snapshots come from Claude's detailed-transcript view (Ctrl+O),
    // paged with PgUp from the bottom up. snap 0 captures the compact view;
    // snap 1 sends Ctrl+E first to expand every tool output. We need to be
    // at the *bottom* of the transcript before each capture cycle so PgUp
    // actually walks the whole history.
    opts.tmux.sendKeys(name, "C-o");
    await waitForStable(opts.tmux, name, {
      stableMs: opts.stableMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
    });

    for (let i = 0; i < opts.snapshots; i++) {
      if (i === 1) {
        // Snap 0 left us at the top. Scroll back to the bottom, expand all
        // entries with Ctrl+E, then re-page from the (possibly shifted) bottom.
        await pageToEnd(opts.tmux, name, "PageDown", opts.pollMs);
        opts.tmux.sendKeys(name, "C-e");
        await waitForStable(opts.tmux, name, {
          stableMs: opts.stableMs,
          pollMs: opts.pollMs,
          maxWaitMs: opts.maxWaitMs,
        });
        await pageToEnd(opts.tmux, name, "PageDown", opts.pollMs);
      }

      const { frames, scrolled } = await capturePagesUp(
        opts.tmux,
        name,
        opts.pollMs
      );
      opts.log(
        `[w=${opts.spec.px}] snapshot ${i}: ${scrolled} PageUps, ${frames.length} pages`
      );

      const ordered = frames.map(trimPaneFrame);
      const combined = joinFrames(ordered);
      const html = ansiToHtml(combined);
      if (i === 0) paneTitle = opts.tmux.paneTitle(name);

      const prev = out[out.length - 1];
      if (prev && prev.html === html) {
        opts.log(`[w=${opts.spec.px}] snapshot ${i} == ${i - 1}, stopping early`);
        break;
      }
      out.push({
        width: opts.spec.px,
        cols: opts.spec.cols,
        index: i,
        html,
      });
    }
  } finally {
    if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);
  }
  return { snapshots: out, paneTitle };
}

async function main() {
  // Resolve $PWD at startup: prefer the user-facing $PWD env var (preserves
  // symlinks the user invoked us through) and fall back to Node's
  // realpath-resolved process.cwd().
  const pwd = process.env.PWD || process.cwd();

  const program = new Command();
  program
    .name("claude-code-share")
    .description(
      "Capture a Claude Code session via tmux and render it as HTML.\n" +
        "If <sessionId> is omitted, falls back to $CLAUDE_CODE_SESSION_ID. " +
        "Working dir and output dir both default to $PWD."
    )
    .argument(
      "[sessionId]",
      "session ID to resume (default: $CLAUDE_CODE_SESSION_ID)"
    )
    .option("-o, --out <path>", "output html file or directory (default: <sessionId>.html in $PWD)")
    .option(
      "--widths <list>",
      "comma-separated pixel widths (each may be NxROWS)",
      "360,720,1080"
    )
    .option("--char-px <n>", "approx monospace char width in px (Menlo 14px ≈ 8.43)", "8.5")
    .option(
      "--rows <n>",
      "tmux pane rows — one page. Page-up from the bottom captures each page, findOverlap dedupes the overlap between adjacent pages.",
      "1000"
    )
    .option("--snapshots <n>", "max snapshots per width (1+Ctrl+O cycles)", "2")
    .option("--stable-ms <n>", "ms of stable content before considering ready", "1500")
    .option("--max-wait-ms <n>", "max wait per stable cycle", "20000")
    .option("--poll-ms <n>", "poll interval", "250")
    .option("--font-px <n>", "rendered font-size in HTML", "14")
    .option("--claude <bin>", "claude binary", "claude")
    .option("--cwd <dir>", "working directory for the tmux process (default: $PWD)", pwd)
    .option("--history-limit <n>", "tmux history-limit (lines of scrollback)", "1000000")
    .option("--socket <name>", "tmux -L socket name", "claude-code-share")
    .option("--quiet", "suppress progress logs")
    .parse(process.argv);

  const opts = program.opts<{
    out?: string;
    widths: string;
    charPx: string;
    rows: string;
    snapshots: string;
    stableMs: string;
    maxWaitMs: string;
    pollMs: string;
    fontPx: string;
    claude: string;
    cwd: string;
    historyLimit: string;
    socket: string;
    quiet?: boolean;
  }>();

  const tmuxCheck = checkTmuxAvailable();
  if (!tmuxCheck.ok) {
    console.error(`[claude-code-share] ${tmuxCheck.message}`);
    process.exit(1);
  }

  const sessionId = program.args[0] || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    console.error(
      "[claude-code-share] missing session id — pass it as the first argument or set $CLAUDE_CODE_SESSION_ID."
    );
    process.exit(1);
  }
  const outPath = opts.out
    ? path.resolve(pwd, opts.out)
    : path.join(pwd, `${sessionId}.html`);
  const log = opts.quiet ? () => {} : (s: string) => console.error(s);

  const widths = parseWidths(opts.widths, parseFloat(opts.charPx), parseInt(opts.rows, 10));

  const tmux = new Tmux(opts.socket);
  tmux.setupServer(parseInt(opts.historyLimit, 10));

  const all: Snapshot[] = [];
  let title = "";
  try {
    for (const spec of widths) {
      const result = await captureWidth({
        tmux,
        sessionId,
        spec,
        stableMs: parseInt(opts.stableMs, 10),
        pollMs: parseInt(opts.pollMs, 10),
        maxWaitMs: parseInt(opts.maxWaitMs, 10),
        snapshots: Math.max(1, parseInt(opts.snapshots, 10)),
        claudeBin: opts.claude,
        cwd: opts.cwd,
        log,
      });
      all.push(...result.snapshots);
      if (!title && result.paneTitle) title = result.paneTitle;
    }
  } finally {
    // Tear down our private server so we don't leave it lingering.
    tmux.killServer();
    tmux.cleanupConfig();
  }

  if (all.length === 0) {
    console.error("[claude-code-share] no snapshots captured.");
    process.exit(2);
  }

  const html = buildHtml({
    sessionId,
    snapshots: all,
    fontPx: parseInt(opts.fontPx, 10),
    title,
  });

  fs.writeFileSync(outPath, html);
  log(
    `[claude-code-share] wrote ${outPath} (${(Buffer.byteLength(html, "utf-8") / 1024).toFixed(1)} KB, ${all.length} snapshots)`
  );
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
