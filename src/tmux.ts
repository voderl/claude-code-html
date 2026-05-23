import { spawnSync, SpawnSyncReturns } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Probe `tmux -V` once at startup. Returns { ok, message } so the CLI can
 * print a clean message and exit 1 instead of unwinding a confusing
 * spawnSync error from the middle of a capture loop.
 */
export function checkTmuxAvailable(): { ok: true } | { ok: false; message: string } {
  const r = spawnSync("tmux", ["-V"], { encoding: "utf-8" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      ok: false,
      message:
        "tmux is not installed or not on PATH.\n" +
        "  • macOS:  brew install tmux\n" +
        "  • Debian/Ubuntu:  sudo apt install tmux\n" +
        "  • Fedora/RHEL:  sudo dnf install tmux",
    };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      message: `tmux -V failed (status ${r.status}): ${(r.stderr || r.stdout || "").trim() || "unknown error"}`,
    };
  }
  return { ok: true };
}

/**
 * Thin wrapper around the `tmux` CLI that pins every call to a dedicated socket
 * (`-L <socket>`) so the tool runs on its own server, isolated from the user's
 * everyday tmux. That makes option overrides predictable and lets us reset the
 * world by killing only our own server.
 */
export class Tmux {
  private configFile: string | null = null;

  constructor(public readonly socket: string) {}

  private run(args: string[], opts: { check?: boolean; env?: Record<string, string> } = {}): SpawnSyncReturns<string> {
    const prefix = ["-L", this.socket];
    if (this.configFile) prefix.push("-f", this.configFile);
    const result = spawnSync("tmux", [...prefix, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...(opts.env || {}) },
    });
    if (opts.check && result.status !== 0) {
      throw new Error(
        `tmux ${prefix.join(" ")} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`
      );
    }
    return result;
  }

  hasSession(name: string): boolean {
    return this.run(["has-session", "-t", name]).status === 0;
  }

  killSession(name: string): void {
    this.run(["kill-session", "-t", name]);
  }

  killServer(): void {
    this.run(["kill-server"]);
  }

  /**
   * Write a tmux config file and have every subsequent invocation pass it via
   * `-f`. tmux reads -f only when the server first starts, so the options take
   * effect on first `new-session` and persist for the server's lifetime.
   */
  setupServer(historyLimit: number): void {
    const conf = [
      `set-option -g history-limit ${historyLimit}`,
      // TUIs go through the normal screen so their output ends up in scrollback.
      `set-window-option -g alternate-screen off`,
      // Suppress claude's "tmux focus-events off · add 'set -g focus-events on'" advice.
      `set-option -g focus-events on`,
      // No bells / activity flashes / status bar — they steal rows or paint
      // foreign chrome into the captured pane.
      `set-option -g bell-action none`,
      `set-option -g visual-bell off`,
      `set-option -g visual-activity off`,
      `set-option -g status off`,
      // Keep the pane (and its session) around after the spawned command exits
      // so we can read whatever it printed. Without this, a fast-failing
      // `claude --resume <bad-id>` destroys the session before we capture, and
      // tmux exits with "no server running".
      `set-window-option -g remain-on-exit on`,
      `set-option -g exit-empty off`,
      // Permit fancy 24-bit color reporting.
      `set-option -ga terminal-overrides ",*256col*:Tc"`,
    ].join("\n") + "\n";
    const file = path.join(os.tmpdir(), `claude-code-share-${process.pid}-${Date.now()}.tmux.conf`);
    fs.writeFileSync(file, conf, { mode: 0o600 });
    this.configFile = file;
  }

  cleanupConfig(): void {
    if (this.configFile) {
      try { fs.unlinkSync(this.configFile); } catch {}
      this.configFile = null;
    }
  }

  newDetachedSession(opts: {
    name: string;
    cols: number;
    rows: number;
    cwd?: string;
    command: string[];
    env?: Record<string, string>;
  }): void {
    const args = [
      "new-session",
      "-d",
      "-s",
      opts.name,
      "-x",
      String(opts.cols),
      "-y",
      String(opts.rows),
    ];
    if (opts.cwd) args.push("-c", opts.cwd);
    args.push(...opts.command);
    this.run(args, { check: true, env: opts.env });
  }

  capturePane(name: string, withAnsi: boolean): string {
    const args = ["capture-pane", "-p", "-S", "-", "-E", "-", "-t", name];
    if (withAnsi) args.push("-e");
    return this.run(args, { check: true }).stdout;
  }

  /**
   * Capture only the visible pane (no scrollback). Used while paginating
   * through Claude's transcript with PageDown: each page is a fresh frame,
   * scrollback is irrelevant because NO_FLICKER mode redraws in place.
   */
  capturePaneVisible(name: string, withAnsi: boolean): string {
    const args = ["capture-pane", "-p", "-S", "0", "-E", "-", "-t", name];
    if (withAnsi) args.push("-e");
    return this.run(args, { check: true }).stdout;
  }

  /**
   * Read the pane title (the string the TUI most recently set via OSC 0/2,
   * exposed as tmux's #{pane_title} format). Returns "" if unavailable.
   */
  paneTitle(name: string): string {
    const r = this.run(["display-message", "-p", "-t", name, "#{pane_title}"]);
    if (r.status !== 0) return "";
    return r.stdout.replace(/\r?\n$/, "");
  }

  /**
   * True when the pane's command has exited but the pane is still held open by
   * `remain-on-exit`. Used to detect e.g. `claude --resume <bad-id>` failing
   * immediately, so we can surface its stderr instead of dying inside a poll.
   */
  paneDead(name: string): boolean {
    const r = this.run(["display-message", "-p", "-t", name, "#{pane_dead}"]);
    if (r.status !== 0) return false;
    return r.stdout.trim() === "1";
  }

  sendKeys(name: string, ...keys: string[]): void {
    this.run(["send-keys", "-t", name, ...keys], { check: true });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export interface WaitOpts {
  stableMs: number;
  pollMs: number;
  maxWaitMs: number;
}

/**
 * Poll capture-pane until the content stops changing for `stableMs`, or until
 * `maxWaitMs` elapses. Uses plain (non-ANSI) capture for the diff so SGR noise
 * doesn't keep resetting the timer.
 */
export async function waitForStable(tmux: Tmux, name: string, opts: WaitOpts): Promise<void> {
  const start = Date.now();
  let last = "";
  let stableSince = 0;
  while (Date.now() - start < opts.maxWaitMs) {
    const cur = tmux.capturePane(name, false);
    if (cur === last && cur.trim().length > 0) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= opts.stableMs) return;
    } else {
      stableSince = 0;
      last = cur;
    }
    await sleep(opts.pollMs);
  }
}
