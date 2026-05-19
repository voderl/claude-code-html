#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { Tmux, waitForStable, sleep } from "./tmux";
import {
  Snapshot,
  ansiToHtml,
  buildHtml,
  buildSplitHtml,
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
}): Promise<Snapshot[]> {
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
    },
  });

  const out: Snapshot[] = [];
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

    opts.log(`[w=${opts.spec.px}] capturing snapshot 0 (post-ESC)`);
    out.push({
      width: opts.spec.px,
      cols: opts.spec.cols,
      index: 0,
      html: ansiToHtml(opts.tmux.capturePane(name, true)),
    });

    for (let i = 1; i < opts.snapshots; i++) {
      opts.tmux.sendKeys(name, "C-o");
      await waitForStable(opts.tmux, name, {
        stableMs: opts.stableMs,
        pollMs: opts.pollMs,
        maxWaitMs: opts.maxWaitMs,
      });
      opts.log(`[w=${opts.spec.px}] capturing snapshot ${i} (post-Ctrl+O #${i})`);
      const html = ansiToHtml(opts.tmux.capturePane(name, true));
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
  return out;
}

async function main() {
  const program = new Command();
  program
    .name("claude-code-share")
    .description("Capture a Claude Code session via tmux and render it as HTML.")
    .argument("<sessionId>", "session ID to resume (claude --resume <id>)")
    .option("-o, --out <path>", "output html file or directory", "session.html")
    .option(
      "--widths <list>",
      "comma-separated pixel widths (each may be NxROWS)",
      "360,720,1080"
    )
    .option("--char-px <n>", "approx monospace char width in px (Menlo 14px ≈ 8.43)", "8.5")
    .option("--rows <n>", "terminal rows", "40")
    .option("--snapshots <n>", "max snapshots per width (1+Ctrl+O cycles)", "2")
    .option("--stable-ms <n>", "ms of stable content before considering ready", "1500")
    .option("--max-wait-ms <n>", "max wait per stable cycle", "20000")
    .option("--poll-ms <n>", "poll interval", "250")
    .option("--font-px <n>", "rendered font-size in HTML", "14")
    .option(
      "--split-bytes <n>",
      "force split-to-directory above this html size in bytes",
      String(2 * 1024 * 1024)
    )
    .option("--claude <bin>", "claude binary", "claude")
    .option("--cwd <dir>", "working directory for the tmux process", process.cwd())
    .option("--history-limit <n>", "tmux history-limit (lines of scrollback)", "1000000")
    .option("--socket <name>", "tmux -L socket name", "claude-code-share")
    .option("--quiet", "suppress progress logs")
    .parse(process.argv);

  const opts = program.opts<{
    out: string;
    widths: string;
    charPx: string;
    rows: string;
    snapshots: string;
    stableMs: string;
    maxWaitMs: string;
    pollMs: string;
    fontPx: string;
    splitBytes: string;
    claude: string;
    cwd: string;
    historyLimit: string;
    socket: string;
    quiet?: boolean;
  }>();

  const sessionId = program.args[0];
  const log = opts.quiet ? () => {} : (s: string) => console.error(s);

  const widths = parseWidths(opts.widths, parseFloat(opts.charPx), parseInt(opts.rows, 10));

  const tmux = new Tmux(opts.socket);
  tmux.setupServer(parseInt(opts.historyLimit, 10));

  const all: Snapshot[] = [];
  try {
    for (const spec of widths) {
      const snaps = await captureWidth({
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
      all.push(...snaps);
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
  });

  const limit = parseInt(opts.splitBytes, 10);
  const outPath = opts.out;
  const outIsDir = outPath.endsWith("/") || outPath.endsWith(path.sep);

  if (Buffer.byteLength(html, "utf-8") <= limit && !outIsDir) {
    fs.writeFileSync(outPath, html);
    log(
      `[claude-code-share] wrote ${outPath} (${(Buffer.byteLength(html, "utf-8") / 1024).toFixed(1)} KB, ${all.length} snapshots)`
    );
    return;
  }

  const dir = outIsDir
    ? outPath
    : outPath.replace(/\.html?$/i, "") || "session";
  fs.mkdirSync(dir, { recursive: true });
  const split = buildSplitHtml({
    sessionId,
    snapshots: all,
    fontPx: parseInt(opts.fontPx, 10),
  });
  fs.writeFileSync(path.join(dir, "index.html"), split.index);
  for (const [name, content] of Object.entries(split.files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  log(
    `[claude-code-share] wrote ${dir}/ (split mode, ${Object.keys(split.files).length + 1} files, ${all.length} snapshots)`
  );
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
