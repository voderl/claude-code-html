#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";
import { renderJsonlToHtml } from "./jsonl";

/**
 * Convert a CWD to Claude Code's project directory name: every `/` is replaced
 * with `-`, matching how Claude Code stores transcripts under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function defaultJsonlPath(sessionId: string, pwd: string): string {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodeProjectDir(pwd),
    `${sessionId}.jsonl`,
  );
}

async function main() {
  const pwd = process.env.PWD || process.cwd();

  const program = new Command();
  program
    .name("claude-code-share")
    .description(
      "Render a Claude Code session JSONL transcript as HTML.\n" +
        "If <sessionId> is omitted, falls back to $CLAUDE_CODE_SESSION_ID. " +
        "JSONL is read from ~/.claude/projects/${PWD//\\//-}/${sessionId}.jsonl. " +
        "Output defaults to <sessionId>.html in $PWD.",
    )
    .argument(
      "[sessionId]",
      "session ID (default: $CLAUDE_CODE_SESSION_ID)",
    )
    .option(
      "-o, --out <path>",
      "output html file (default: <sessionId>.html in $PWD)",
    )
    .option(
      "--jsonl <path>",
      "explicit jsonl path (overrides the default ~/.claude/projects/… lookup)",
    )
    .option("--title <s>", "override the document title")
    .option("--font-px <n>", "rendered font-size in HTML", "14")
    .option("--quiet", "suppress progress logs")
    .parse(process.argv);

  const opts = program.opts<{
    out?: string;
    jsonl?: string;
    title?: string;
    fontPx: string;
    quiet?: boolean;
  }>();

  const sessionId = program.args[0] || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId && !opts.jsonl) {
    console.error(
      "[claude-code-share] missing session id — pass it as the first argument or set $CLAUDE_CODE_SESSION_ID.",
    );
    process.exit(1);
  }

  const jsonlPath = opts.jsonl
    ? path.resolve(opts.jsonl)
    : defaultJsonlPath(sessionId!, pwd);

  if (!fs.existsSync(jsonlPath)) {
    console.error(`[claude-code-share] jsonl not found: ${jsonlPath}`);
    process.exit(1);
  }

  const outPath = opts.out
    ? path.resolve(pwd, opts.out)
    : path.join(pwd, `${sessionId || path.basename(jsonlPath, ".jsonl")}.html`);

  const html = renderJsonlToHtml({
    jsonlPath,
    title: opts.title,
    fontPx: parseInt(opts.fontPx, 10),
  });

  fs.writeFileSync(outPath, html);
  if (!opts.quiet) {
    const kb = (Buffer.byteLength(html, "utf-8") / 1024).toFixed(1);
    console.error(`[claude-code-share] wrote ${outPath} (${kb} KB)`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
