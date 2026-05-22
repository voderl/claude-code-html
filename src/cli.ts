#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { Tmux, waitForStable, checkTmuxAvailable } from "./tmux";
import { Snapshot, ansiToHtml, buildHtml } from "./render";

interface ColsSpec {
  cols: number;
  rows: number;
  px: number; // derived: cols * CHAR_PX, used by buildHtml as a breakpoint
}

// Approximate monospace char width at the default 14px font-size (Menlo).
// Used only to derive responsive breakpoints from --cols for the HTML output.
const CHAR_PX = 8.5;

function parseCols(input: string, rows: number): ColsSpec[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d+)(?:x(\d+))?$/);
      if (!m) throw new Error(`invalid cols spec: ${s}`);
      const cols = parseInt(m[1], 10);
      const rs = m[2] ? parseInt(m[2], 10) : rows;
      return { cols, rows: rs, px: Math.round(cols * CHAR_PX) };
    });
}

function sessionName(sessionId: string, cols: number): string {
  return `ccs_${sessionId.slice(0, 8)}_${cols}c`;
}

const ANSI_RE = /\x1b\[[\d;]*[a-zA-Z]/g;
const STATUS_BAR_RE = /Showing detailed transcript/;

/**
 * Trim Claude's live UI off the bottom of the captured pane: the status bar
 * ("Showing detailed transcript · …"), its box-drawing separator, and any
 * trailing blank padding. The transcript content sits above that chrome.
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

async function captureWidth(opts: {
  tmux: Tmux;
  sessionId: string;
  spec: ColsSpec;
  stableMs: number;
  pollMs: number;
  maxWaitMs: number;
  claudeBin: string;
  cwd: string;
  log: (s: string) => void;
  debugDir?: string;
}): Promise<{ snapshots: Snapshot[]; paneTitle: string }> {
  const name = sessionName(opts.sessionId, opts.spec.cols);
  if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);

  const cmd = [opts.claudeBin, "--resume", opts.sessionId];
  const tag = `[cols=${opts.spec.cols}]`;

  opts.log(
    `${tag} starting tmux session ${name} (${opts.spec.cols}x${opts.spec.rows})`
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

  const wait = () =>
    waitForStable(opts.tmux, name, {
      stableMs: opts.stableMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
    });

  let paneTitle = "";
  let html = "";
  try {
    opts.log(`${tag} waiting for initial render to settle...`);
    await wait();

    // Esc → C-o → `[` asks Claude to flush every transcript row into the
    // pane (and therefore tmux's scrollback) in one pass. Once the buffer
    // stops changing, a single capture-pane reads the whole thing — no
    // paging, no frame stitching.
    opts.tmux.sendKeys(name, "Escape");
    await wait();
    opts.tmux.sendKeys(name, "C-o");
    await wait();
    opts.tmux.sendKeys(name, "[");
    await wait();

    const ansi = opts.tmux.capturePane(name, true);
    paneTitle = opts.tmux.paneTitle(name);

    if (opts.debugDir) {
      const file = path.join(
        opts.debugDir,
        `${opts.sessionId}_c${opts.spec.cols}.ansi`
      );
      fs.writeFileSync(file, ansi);
      opts.log(`${tag} wrote ${file}`);
    }

    const trimmed = trimPaneFrame(ansi);
    html = ansiToHtml(trimmed);
    opts.log(`${tag} captured ${trimmed.split("\n").length} lines`);
  } finally {
    if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);
  }

  const snapshots: Snapshot[] = html
    ? [{ width: opts.spec.px, cols: opts.spec.cols, index: 0, html }]
    : [];
  return { snapshots, paneTitle };
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
      "--cols <list>",
      "comma-separated tmux column counts (each item may be NxROWS to override rows). One HTML responsive breakpoint per entry.",
      "50,100"
    )
    .option("--rows <n>", "default tmux pane rows when an entry has no xROWS", "1000")
    .option("--stable-ms <n>", "ms of stable content before considering ready", "1500")
    .option("--max-wait-ms <n>", "max wait per stable cycle", "20000")
    .option("--poll-ms <n>", "poll interval", "250")
    .option("--font-px <n>", "rendered font-size in HTML", "14")
    .option("--claude <bin>", "claude binary", "claude")
    .option("--cwd <dir>", "working directory for the tmux process (default: $PWD)", pwd)
    .option("--history-limit <n>", "tmux history-limit (lines of scrollback)", "1000000")
    .option("--socket <name>", "tmux -L socket name", "claude-code-share")
    .option(
      "--debug-dir <path>",
      "if set, dump the raw ANSI capture for each --cols entry into this directory"
    )
    .option("--quiet", "suppress progress logs")
    .parse(process.argv);

  const opts = program.opts<{
    out?: string;
    cols: string;
    rows: string;
    stableMs: string;
    maxWaitMs: string;
    pollMs: string;
    fontPx: string;
    claude: string;
    cwd: string;
    historyLimit: string;
    socket: string;
    debugDir?: string;
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

  const debugDir = opts.debugDir ? path.resolve(pwd, opts.debugDir) : undefined;
  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    log(`[claude-code-share] dumping raw ANSI to ${debugDir}`);
  }

  const specs = parseCols(opts.cols, parseInt(opts.rows, 10));

  const tmux = new Tmux(opts.socket);
  tmux.setupServer(parseInt(opts.historyLimit, 10));

  const all: Snapshot[] = [];
  let title = "";
  try {
    for (const spec of specs) {
      const result = await captureWidth({
        tmux,
        sessionId,
        spec,
        stableMs: parseInt(opts.stableMs, 10),
        pollMs: parseInt(opts.pollMs, 10),
        maxWaitMs: parseInt(opts.maxWaitMs, 10),
        claudeBin: opts.claude,
        cwd: opts.cwd,
        log,
        debugDir,
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
