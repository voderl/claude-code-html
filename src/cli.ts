#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { Tmux, waitForStable, checkTmuxAvailable } from "./tmux";
import { Snapshot, buildHtml } from "./render";

interface ColsSpec {
  cols: number;
  rows: number;
  px: number; // derived: cols * CHAR_PX, used by buildHtml as a breakpoint
}

// Approximate monospace char width at the default 14px font-size (Menlo).
// Used only to derive responsive breakpoints from --cols for the HTML output.
const CHAR_PX = 8.5;

// Default tmux pane rows. Each --cols entry can still override per-spec via NxROWS.
const DEFAULT_ROWS = 40;

function parseCols(input: string): ColsSpec[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d+)(?:x(\d+))?$/);
      if (!m) throw new Error(`invalid cols spec: ${s}`);
      const cols = parseInt(m[1], 10);
      const rs = m[2] ? parseInt(m[2], 10) : DEFAULT_ROWS;
      return { cols, rows: rs, px: Math.round(cols * CHAR_PX) };
    });
}

function sessionName(sessionId: string): string {
  return `ccs_${sessionId.slice(0, 8)}`;
}

/**
 * Format the "no session id" error in Claude Code's visual idiom — orange
 * ✳ marker for the heading and a pink `!` (foreground 256-colour 211, the
 * same hue Claude Code uses for its bash shortcut) followed by the command
 * in white. Falls back to plain text on non-TTY stderr (CI logs, piped
 * output) so escape sequences don't leak.
 */
function formatMissingSessionId(): string {
  const tty = !!process.stderr.isTTY;
  const sgr = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  const orange = (s: string) => sgr("38;5;173", s); // closest 256-colour match to Claude's ✳ (#cc785c)
  const bold = (s: string) => sgr("1", s);
  const bang = tty
    ? `\x1b[38;5;211m!\x1b[0m \x1b[38;5;231mclaude-code-html\x1b[0m`
    : `! claude-code-html`;
  return [
    "",
    `${orange("✳")} ${bold("claude-code-html needs a Claude Code session id.")}`,
    "",
    `  Run it in a Claude Code session:`,
    "",
    `  ${bang}`,
    "",
  ].join("\n");
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

async function captureSession(opts: {
  tmux: Tmux;
  sessionId: string;
  specs: ColsSpec[];
  stableMs: number;
  settleMs: number;
  pollMs: number;
  maxWaitMs: number;
  claudeBin: string;
  cwd: string;
  log: (s: string) => void;
  debugDir?: string;
}): Promise<{ snapshots: Snapshot[]; paneTitle: string }> {
  const name = sessionName(opts.sessionId);
  if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);

  const cmd = [opts.claudeBin, "--resume", opts.sessionId];
  const first = opts.specs[0];

  opts.log(
    `starting tmux session ${name} (${first.cols}x${first.rows})`
  );
  opts.tmux.newDetachedSession({
    name,
    cols: first.cols,
    rows: first.rows,
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
  const settle = () =>
    waitForStable(opts.tmux, name, {
      stableMs: opts.settleMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
    });

  const snapshots: Snapshot[] = [];
  let paneTitle = "";

  try {
    opts.log(`waiting for initial render to settle...`);
    await wait();

    // If claude exited before producing a transcript (e.g. bad/empty session
    // id), the pane is now dead. Surface whatever it printed instead of
    // continuing to send keys and capture an empty frame.
    if (opts.tmux.paneDead(name)) {
      const lines = opts.tmux
        .capturePane(name, false)
        .split("\n")
        .map((l) => l.replace(ANSI_RE, "").replace(/\s+$/, ""))
        // tmux appends a footer like "Pane is dead (status 1, ...)" once the
        // command exits with remain-on-exit on — drop it from the user-facing
        // message; we already say claude exited.
        .filter((l) => !/^Pane is dead \(status -?\d+/.test(l));
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      const out = lines.join("\n");
      throw new Error(
        `claude exited before the transcript was ready. Its output:\n` +
          (out || "(no output)")
      );
    }

    // One claude process; for each width we trigger the transcript flush
    // (Esc → C-o → `[`), capture, then exit the transcript view, clear
    // scrollback, and resize before the next iteration. Esc serves double
    // duty on later iterations: it leaves the transcript view we just
    // captured so the resize+redraw happens against Claude's normal UI.
    for (let i = 0; i < opts.specs.length; i++) {
      const spec = opts.specs[i];
      const tag = `[cols=${spec.cols}]`;

      if (i > 0) {
        opts.tmux.sendKeys(name, "Escape");
        await settle();
        opts.tmux.resizeWindow(name, spec.cols, spec.rows);
        await settle();
      } else {
        opts.tmux.sendKeys(name, "Escape");
        await settle();
      }
      opts.tmux.sendKeys(name, "C-o");
      await settle();
      opts.tmux.clearHistory(name);
      opts.tmux.sendKeys(name, "[");
      await wait();

      const ansi = opts.tmux.capturePane(name, true);
      if (!paneTitle) paneTitle = opts.tmux.paneTitle(name);

      if (opts.debugDir) {
        const file = path.join(
          opts.debugDir,
          `${opts.sessionId}_c${spec.cols}.ansi`
        );
        fs.writeFileSync(file, ansi);
        opts.log(`${tag} wrote ${file}`);
      }

      const trimmed = trimPaneFrame(ansi);
      opts.log(`${tag} captured ${trimmed.split("\n").length} lines`);
      if (trimmed) {
        snapshots.push({ width: spec.px, cols: spec.cols, ansi: trimmed });
      }
    }
  } finally {
    if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);
  }

  return { snapshots, paneTitle };
}

async function main() {
  // Resolve $PWD at startup: prefer the user-facing $PWD env var (preserves
  // symlinks the user invoked us through) and fall back to Node's
  // realpath-resolved process.cwd().
  const pwd = process.env.PWD || process.cwd();

  const program = new Command();
  program
    .name("claude-code-html")
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
      `comma-separated tmux column counts (each item may be NxROWS to override the default ${DEFAULT_ROWS} rows). One HTML responsive breakpoint per entry.`,
      "120,80,40"
    )
    .option("--stable-ms <n>", "ms of stable content before considering ready (used for initial render and the `[` transcript flush)", "1000")
    .option("--settle-ms <n>", "ms of stable content for lightweight key transitions (Esc / C-o / resize)", "100")
    .option("--max-wait-ms <n>", "max wait per stable cycle", "10000")
    .option("--poll-ms <n>", "poll interval", "100")
    .option("--font-px <n>", "rendered font-size in HTML", "14")
    .option(
      "--mode <mode>",
      "initial fold state: 'preview' (every tool/tool-group <details> collapsed) or 'detail' (everything expanded). URL ?mode=preview|detail overrides this at view time.",
      "preview"
    )
    .option(
      "--no-mock-email",
      "don't mask user emails appearing before the first user turn (banner / account info). By default the banner email is replaced with `*` of the same length, keeping `@`.",
    )
    .option("--claude <bin>", "claude binary", "claude")
    .option("--cwd <dir>", "working directory for the tmux process (default: $PWD)", pwd)
    .option("--history-limit <n>", "tmux history-limit (lines of scrollback)", "1000000")
    .option("--socket <name>", "tmux -L socket name", "claude-code-html")
    .option(
      "--debug-dir <path>",
      "if set, dump the raw ANSI capture for each --cols entry into this directory"
    )
    .option("--quiet", "suppress progress logs")
    .parse(process.argv);

  const opts = program.opts<{
    out?: string;
    cols: string;
    stableMs: string;
    settleMs: string;
    maxWaitMs: string;
    pollMs: string;
    fontPx: string;
    mode: string;
    claude: string;
    cwd: string;
    historyLimit: string;
    socket: string;
    debugDir?: string;
    quiet?: boolean;
    mockEmail: boolean;
  }>();

  const tmuxCheck = checkTmuxAvailable();
  if (!tmuxCheck.ok) {
    console.error(`[claude-code-html] ${tmuxCheck.message}`);
    process.exit(1);
  }

  const sessionId = program.args[0] || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    console.error(formatMissingSessionId());
    process.exit(1);
  }
  const outPath = opts.out
    ? path.resolve(pwd, opts.out)
    : path.join(pwd, `${sessionId}.html`);
  const log = opts.quiet ? () => {} : (s: string) => console.error(s);

  const debugDir = opts.debugDir ? path.resolve(pwd, opts.debugDir) : undefined;
  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    log(`[claude-code-html] dumping raw ANSI to ${debugDir}`);
  }

  const specs = parseCols(opts.cols);

  const tmux = new Tmux(opts.socket);
  tmux.setupServer(parseInt(opts.historyLimit, 10));

  const all: Snapshot[] = [];
  let title = "";
  try {
    const result = await captureSession({
      tmux,
      sessionId,
      specs,
      stableMs: parseInt(opts.stableMs, 10),
      settleMs: parseInt(opts.settleMs, 10),
      pollMs: parseInt(opts.pollMs, 10),
      maxWaitMs: parseInt(opts.maxWaitMs, 10),
      claudeBin: opts.claude,
      cwd: opts.cwd,
      log,
      debugDir,
    });
    all.push(...result.snapshots);
    if (result.paneTitle) title = result.paneTitle;
  } finally {
    // Tear down our private server so we don't leave it lingering.
    tmux.killServer();
    tmux.cleanupConfig();
  }

  if (all.length === 0) {
    console.error("[claude-code-html] no snapshots captured.");
    process.exit(2);
  }

  const modeArg = (opts.mode || "").toLowerCase();
  const mode: "preview" | "detail" = modeArg === "detail" ? "detail" : "preview";
  if (modeArg && modeArg !== "preview" && modeArg !== "detail") {
    log(`[claude-code-html] unknown --mode '${opts.mode}', falling back to 'preview'`);
  }
  const html = buildHtml({
    sessionId,
    snapshots: all,
    fontPx: parseInt(opts.fontPx, 10),
    title,
    mode,
    mockEmail: opts.mockEmail,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  log(
    `[claude-code-html] wrote ${outPath} (${(Buffer.byteLength(html, "utf-8") / 1024).toFixed(1)} KB, ${all.length} snapshots)`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
