#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { Tmux, waitForStable, checkTmuxAvailable } from "./tmux";
import { Snapshot, buildHtml } from "./render";

// Approximate monospace char width at the default 14px font-size (Menlo).
// Mirrors src/cli.ts so the responsive breakpoint maths line up.
const CHAR_PX = 8.5;
const DEFAULT_COLS = "120,80,47";
// Codex's transcript-view renderer has reliability issues above ~500 rows
// (welcome banner + initial chat that codex prints before Ctrl-T stays
// visible in the upper rows, and the transcript header / `%` footer end up
// partially overdrawn or absent). 500 is the highest verified stable value.
const DEFAULT_ROWS = 500;

interface ColsSpec {
  cols: number;
  rows: number;
  px: number; // pixel breakpoint, used by buildHtml as a responsive width key
}

function parseCols(input: string, defaultRows: number): ColsSpec[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d+)(?:x(\d+))?$/);
      if (!m) throw new Error(`invalid cols spec: ${s}`);
      const cols = parseInt(m[1], 10);
      const rows = m[2] ? parseInt(m[2], 10) : defaultRows;
      return { cols, rows, px: Math.round(cols * CHAR_PX) };
    });
}

const ANSI_RE = /\x1b\[[\d;]*[a-zA-Z]/g;

// Top of the codex transcript view: a line of slash-separated letters like
// "/ T R A N S C R I P T / / / / / ...". We only need to recognise the word,
// the slashes vary in count with pane width.
const TRANSCRIPT_RE = /T\s+R\s+A\s+N\s+S\s+C\s+R\s+I\s+P\s+T/;

// Bottom progress line: a run of `─` separators with a percentage in the
// middle. We anchor on the whole-line shape to avoid matching a stray
// percentage inside body content.
const PROGRESS_RE = /^[─\s]*(\d+)%[─\s]*$/;

interface PageInfo {
  raw: string;
  lines: string[];
  headerIdx: number;
  footerIdx: number;
  percent: number;
}

function stripAnsiRight(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\s+$/, "");
}

function parsePage(raw: string): PageInfo | null {
  const lines = raw.split("\n");
  let headerIdx = -1;
  let footerIdx = -1;
  let percent = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(ANSI_RE, "");
    if (headerIdx === -1) {
      if (TRANSCRIPT_RE.test(text)) headerIdx = i;
      continue;
    }
    const m = text.match(PROGRESS_RE);
    if (m) {
      footerIdx = i;
      percent = parseInt(m[1], 10);
      break;
    }
  }
  if (headerIdx < 0 || footerIdx < 0) return null;
  return { raw, lines, headerIdx, footerIdx, percent };
}

function pageBody(p: PageInfo): string[] {
  return p.lines.slice(p.headerIdx + 1, p.footerIdx);
}

/**
 * Largest k where the last k lines of `prev` equal the first k lines of
 * `next` (ANSI-stripped, right-trimmed). Used to peel the duplicated head
 * off the last page when a final PageDown advances less than a full pane.
 */
function findOverlap(prev: string[], next: string[]): number {
  const max = Math.min(prev.length, next.length);
  for (let k = max; k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (stripAnsiRight(prev[prev.length - k + i]) !== stripAnsiRight(next[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

/**
 * Strip a trailing `■ Conversation interrupted - …` block from the merged
 * body. Codex appends this canned line to the rollout JSONL when the previous
 * codex process exited abruptly — which is what happens when codex-html spawns
 * `codex resume <id>` while the same thread is already live in another tmux,
 * so the existing session sees a SIGHUP-equivalent and logs the interruption.
 * The marker doesn't belong in the transcript export, so peel it off the tail.
 *
 * The message wraps in the captured pane at our pane width (the second line
 * is the canned continuation, e.g. `issue.`). We anchor on the `■` line and
 * pull everything from there to the end of body, plus any blank lines that
 * preceded it. We only do this if nothing past the `■` line opens a new
 * codex block (›/•/■) — otherwise the interrupted line is part of real
 * history, not the trailing artifact, and we leave it alone.
 */
function stripTrailingInterrupted(body: string[]): string[] {
  const cleaned = body.map((l) => l.replace(ANSI_RE, "").trim());
  let cut = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (cleaned[i].startsWith("■") && cleaned[i].includes("Conversation interrupted")) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return body;
  for (let i = cut + 1; i < body.length; i++) {
    if (cleaned[i] && /^[›•■]/.test(cleaned[i])) return body;
  }
  while (cut > 0 && cleaned[cut - 1] === "") cut--;
  return body.slice(0, cut);
}

function mergePages(pages: PageInfo[]): string {
  if (pages.length === 0) return "";
  const last = pages[pages.length - 1];

  let footerLines = last.lines.slice(last.footerIdx);
  while (
    footerLines.length > 0 &&
    stripAnsiRight(footerLines[footerLines.length - 1]) === ""
  ) {
    footerLines.pop();
  }

  let body: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const b = pageBody(pages[i]);
    if (i === 0) {
      body.push(...b);
    } else {
      const overlap = findOverlap(body, b);
      body.push(...b.slice(overlap));
    }
  }
  while (body.length > 0 && stripAnsiRight(body[body.length - 1]) === "") {
    body.pop();
  }
  body = stripTrailingInterrupted(body);
  // Drop the leading TRANSCRIPT marker line (the first page's headerLine) —
  // it's chrome from codex's transcript view, not content. Same for any
  // blank rows immediately after it.
  while (body.length > 0 && stripAnsiRight(body[0]) === "") {
    body.shift();
  }

  return [...body, ...footerLines].join("\n");
}

function sessionName(threadId: string): string {
  return `codex_${threadId.slice(0, 8)}`;
}

/**
 * Format the "no thread id" error in Codex's visual idiom — lavender `>_`
 * marker for the heading (matches codex's banner identifier and the favicon
 * gradient's starting hue) followed by a pink `!` and the command in white,
 * mirroring claude-code-html's missing-id message structure. Falls back to
 * plain text on non-TTY stderr (CI logs, piped output) so escape sequences
 * don't leak.
 */
function formatMissingThreadId(): string {
  const tty = !!process.stderr.isTTY;
  const sgr = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  const lavender = (s: string) => sgr("38;5;147", s); // closest 256-colour match to codex's `#b5a6f0`
  const bold = (s: string) => sgr("1", s);
  const bang = tty
    ? `\x1b[38;5;211m!\x1b[0m \x1b[38;5;231mcodex-html\x1b[0m`
    : `! codex-html`;
  return [
    "",
    `${lavender(">_")} ${bold("codex-html needs a Codex thread id.")}`,
    "",
    `  Run it in a Codex session:`,
    "",
    `  ${bang}`,
    "",
  ].join("\n");
}

async function captureSnapshots(opts: {
  tmux: Tmux;
  threadId: string;
  specs: ColsSpec[];
  codexBin: string;
  cwd: string;
  stableMs: number;
  settleMs: number;
  maxWaitMs: number;
  pollMs: number;
  maxPages: number;
  log: (s: string) => void;
  debugDir?: string;
}): Promise<Snapshot[]> {
  const name = sessionName(opts.threadId);
  if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);

  const first = opts.specs[0];
  opts.log(`starting tmux session ${name} (${first.cols}x${first.rows})`);
  opts.tmux.newDetachedSession({
    name,
    cols: first.cols,
    rows: first.rows,
    cwd: opts.cwd,
    command: [opts.codexBin, "resume", opts.threadId, "--no-alt-screen"],
    // Pin TERM to tmux-256color (tmux's own default-terminal) instead of
    // inheriting whatever TERM the caller's shell has. This keeps codex's
    // render decisions stable across hosts and matches what tmux would have
    // set in the pane anyway. COLORTERM=truecolor + FORCE_COLOR=3 signal
    // 24-bit color capability independently.
    //
    // NO_COLOR / CLICOLOR are explicitly *unset* (Node treats `undefined`
    // values as "don't set this key", so the inherited copy of process.env
    // gets shadowed): per https://no-color.org any non-empty value disables
    // color SGRs, and codex respects it. If the caller's shell exports
    // NO_COLOR, the captured ANSI loses all 38;5;N / 38;2;R;G;B codes and
    // leaves only dim/reset attributes. We always want colors in the
    // capture; this overrides that at the spawn boundary instead of
    // mutating the parent process's env globally.
    env: {
      TERM: "tmux-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "3",
      NO_COLOR: undefined,
      CLICOLOR: undefined,
    },
  });

  const waitStable = () =>
    waitForStable(opts.tmux, name, {
      stableMs: opts.stableMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
    });
  const waitSettle = () =>
    waitForStable(opts.tmux, name, {
      stableMs: opts.settleMs,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
    });

  // End-of-transcript detection: codex's percentage hits 100% as soon as the
  // *bottom* of the viewport reaches the last document row — there can still
  // be unread lines above the current top that a further PageDown would
  // scroll into view. So we ignore percent for termination and stop only
  // when PageDown produces no visible change (compared on stripped text, to
  // ignore harmless SGR/cursor reset variation between renders).
  const stripForCompare = (s: string) => s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "");

  const snapshots: Snapshot[] = [];

  try {
    await waitStable();

    if (opts.tmux.paneDead(name)) {
      const out = opts.tmux
        .capturePane(name, false)
        .split("\n")
        .map((l) => l.replace(ANSI_RE, "").replace(/\s+$/, ""))
        .filter((l) => !/^Pane is dead \(status -?\d+/.test(l));
      while (out.length && out[out.length - 1] === "") out.pop();
      throw new Error(
        `codex exited before the transcript was ready. Its output:\n` +
          (out.join("\n") || "(no output)")
      );
    }

    // Press Esc once before any Ctrl-T toggling. On resume codex can come up
    // with a transient overlay focused (a popup, the model picker, an
    // approval prompt, etc.) that swallows Ctrl-T, leaving us on the live UI
    // and capturing 0 transcript pages. Esc dismisses that overlay so the
    // subsequent Ctrl-T reliably toggles into the transcript view.
    opts.tmux.sendKeys(name, "Escape");
    await waitSettle();

    for (let s = 0; s < opts.specs.length; s++) {
      const spec = opts.specs[s];

      // Subsequent specs reuse the same codex process: toggle out of the
      // previous transcript view (Ctrl-T toggles between live UI and
      // transcript view, symmetrically), resize the pane, then toggle back
      // in. Reusing one codex process matters here — every fresh
      // `codex resume <id>` against the same thread appends a `■ Conversation
      // interrupted` to the rollout JSONL.
      //
      // We deliberately do NOT use `q` to leave: `q` is documented in codex's
      // transcript-view footer, but in practice it doesn't reliably exit the
      // view via tmux send-keys (last spec captured fine, earlier specs
      // didn't — the symptom of `q` being eaten and the *next* Ctrl-T then
      // toggling away from where we wanted to be). The symmetric Ctrl-T
      // toggle doesn't have that ambiguity.
      if (s > 0) {
        opts.tmux.sendKeys(name, "C-t");
        await waitStable();
        opts.tmux.resizeWindow(name, spec.cols, spec.rows);
        await waitStable();
      }

      opts.tmux.sendKeys(name, "C-t");
      await waitStable();
      opts.tmux.sendKeys(name, "Home");
      await waitStable();

      const pages: PageInfo[] = [];
      let lastStripped = "";
      for (let i = 0; i < opts.maxPages; i++) {
        const raw = opts.tmux.capturePaneVisible(name, true);
        const stripped = stripForCompare(raw);
        if (pages.length > 0 && stripped === lastStripped) break;
        const parsed = parsePage(raw);
        if (!parsed) {
          if (opts.debugDir) {
            fs.writeFileSync(
              path.join(
                opts.debugDir,
                `c${spec.cols}-page-${String(i + 1).padStart(3, "0")}-unparsed.ansi`
              ),
              raw
            );
          }
          break;
        }
        pages.push(parsed);
        if (opts.debugDir) {
          fs.writeFileSync(
            path.join(
              opts.debugDir,
              `c${spec.cols}-page-${String(i + 1).padStart(3, "0")}.ansi`
            ),
            raw
          );
        }
        lastStripped = stripped;
        opts.tmux.sendKeys(name, "PageDown");
        await waitSettle();
      }

      const merged = mergePages(pages);
      if (opts.debugDir && merged) {
        fs.writeFileSync(
          path.join(opts.debugDir, `c${spec.cols}-merged.ansi`),
          merged
        );
      }
      if (merged) {
        snapshots.push({ width: spec.px, cols: spec.cols, ansi: merged });
      }
      opts.log(
        `[cols=${spec.cols}] captured ${pages.length} page(s), ${merged ? merged.split("\n").length : 0} lines`
      );
    }
  } finally {
    if (opts.tmux.hasSession(name)) opts.tmux.killSession(name);
  }

  return snapshots;
}

async function main() {
  const pwd = process.env.PWD || process.cwd();

  const program = new Command();
  program
    .name("codex-html")
    .description(
      "Capture a Codex session via tmux and render it as HTML.\n" +
        "If <threadId> is omitted, falls back to $CODEX_THREAD_ID. " +
        "Working dir and output dir both default to $PWD."
    )
    .argument(
      "[threadId]",
      "thread ID to resume (default: $CODEX_THREAD_ID)"
    )
    .option("-o, --out <path>", "output html file or directory (default: <threadId>.html in $PWD)")
    .option(
      "--cols <list>",
      `comma-separated tmux column counts (each item may be NxROWS to override the default ${DEFAULT_ROWS} rows). One HTML responsive breakpoint per entry.`,
      DEFAULT_COLS
    )
    .option("--stable-ms <n>", "ms of stable content before considering ready (used for initial render and after Ctrl-T / Home)", "1000")
    .option("--settle-ms <n>", "ms of stable content for lightweight key transitions (PageDown / resize)", "100")
    .option("--max-wait-ms <n>", "max wait per stable cycle", "10000")
    .option("--poll-ms <n>", "poll interval", "100")
    .option("--max-pages <n>", "safety cap on PageDown iterations per width", "1000")
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
    .option("--codex <bin>", "codex binary", "codex")
    .option("--cwd <dir>", "working directory for the tmux process (default: $PWD)", pwd)
    .option("--history-limit <n>", "tmux history-limit (lines of scrollback)", "1000000")
    .option("--socket <name>", "tmux -L socket name", "codex-html")
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
    maxPages: string;
    fontPx: string;
    mode: string;
    codex: string;
    cwd: string;
    historyLimit: string;
    socket: string;
    debugDir?: string;
    quiet?: boolean;
    mockEmail: boolean;
  }>();

  const tmuxCheck = checkTmuxAvailable();
  if (!tmuxCheck.ok) {
    console.error(`[codex-html] ${tmuxCheck.message}`);
    process.exit(1);
  }

  const threadId = program.args[0] || process.env.CODEX_THREAD_ID;
  if (!threadId) {
    console.error(formatMissingThreadId());
    process.exit(1);
  }

  const outPath = opts.out
    ? path.resolve(pwd, opts.out)
    : path.join(pwd, `${threadId}.html`);
  const log = opts.quiet
    ? () => {}
    : (s: string) => console.error(`[codex-html] ${s}`);

  const debugDir = opts.debugDir ? path.resolve(pwd, opts.debugDir) : undefined;
  if (debugDir) {
    fs.mkdirSync(debugDir, { recursive: true });
    log(`dumping raw ANSI to ${debugDir}`);
  }

  const specs = parseCols(opts.cols, DEFAULT_ROWS);

  const tmux = new Tmux(opts.socket);
  tmux.setupServer(parseInt(opts.historyLimit, 10));

  let snapshots: Snapshot[] = [];
  try {
    snapshots = await captureSnapshots({
      tmux,
      threadId,
      specs,
      codexBin: opts.codex,
      cwd: opts.cwd,
      stableMs: parseInt(opts.stableMs, 10),
      settleMs: parseInt(opts.settleMs, 10),
      maxWaitMs: parseInt(opts.maxWaitMs, 10),
      pollMs: parseInt(opts.pollMs, 10),
      maxPages: parseInt(opts.maxPages, 10),
      log,
      debugDir,
    });
  } finally {
    tmux.killServer();
    tmux.cleanupConfig();
  }

  if (snapshots.length === 0) {
    console.error("[codex-html] no transcript captured.");
    process.exit(2);
  }

  const modeArg = (opts.mode || "").toLowerCase();
  const mode: "preview" | "detail" = modeArg === "detail" ? "detail" : "preview";
  if (modeArg && modeArg !== "preview" && modeArg !== "detail") {
    log(`unknown --mode '${opts.mode}', falling back to 'preview'`);
  }

  const html = buildHtml({
    sessionId: threadId,
    snapshots,
    fontPx: parseInt(opts.fontPx, 10),
    title: `Codex Session ${threadId}`,
    mode,
    mockEmail: opts.mockEmail,
    codex: true,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  log(
    `wrote ${outPath} (${(Buffer.byteLength(html, "utf-8") / 1024).toFixed(1)} KB)`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
