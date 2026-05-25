# claude-code-html

**Share your Claude Code transcripts in web — pixel-for-pixel the same as it looks in your terminal.**

## Usage

Inside a Claude Code session:

```bash
! npx claude-code-html
```

Requires Node ≥ 18 and `tmux` on `PATH`. Open the resulting `.html` in any browser — it's a single file with no assets, no JS framework, and no network.

## How it works

`claude-code-html` resumes a Claude Code session inside a headless tmux pane, flushes the full detailed transcript (`Esc → Ctrl-O → [`), captures the raw ANSI, and bakes it into a single self-contained HTML file you can drop into a PR, send over chat, or open offline. Colours, bold weights, box-drawing, OSC 8 links, CJK wrapping — everything lands in the browser exactly the way you saw it in the TTY.

## What you get in the HTML

- **Terminal-accurate rendering.** ANSI 16/256/truecolor and bold all preserved. "Bold" is rendered at weight 500 instead of 700 so it matches what your terminal actually shows, not the heavier browser default.
- **Responsive breakpoints.** `--cols 120,80,40` captures the session at three widths; the browser picks the right one for the viewport.
- **OSC 8 + bare URL hyperlinks.** Cmd-click-style behaviour from the terminal carries over — clickable links open in a new tab.
- **CJK-aware wrapping.** Wide characters wrap correctly inside the monospace grid.
- **Collapsible tool calls.** Each tool use / tool result group is wrapped in a `<details>` so long sessions stay readable. `--mode preview` (default) starts folded; `--mode detail` starts expanded. The viewer can also override via `?mode=preview|detail`.

## Common flags

| Flag | Default | Notes |
|---|---|---|
| `-o, --out <path>` | `<sessionId>.html` in `$PWD` | Output file or directory. |
| `--cols <list>` | `120,80,40` | Comma-separated tmux widths. `NxROWS` overrides per-spec rows. |
| `--mode <mode>` | `preview` | Initial fold state: `preview` or `detail`. |
| `--font-px <n>` | `14` | Rendered font-size in the HTML. |
| `--claude <bin>` | `claude` | Path to the `claude` binary. |
| `--cwd <dir>` | `$PWD` | Working directory for the resumed `claude` process. |
| `--debug-dir <path>` | — | Dump the raw ANSI capture per `--cols` entry. |
| `--no-mock-email` | (masking on) | Disable email masking. By default any email appearing before the first user turn (the Claude Code banner / account info) is replaced with `*` of the same length, keeping the `@`. |
| `--quiet` | — | Suppress progress logs. |

Run `claude-code-html --help` for the full list (timing knobs, tmux socket name, history limit, etc).

## Caveats

- The session must be resumable — `claude --resume <id>` has to succeed.
- Long sessions take a few seconds per `--cols` width because tmux has to actually render the transcript before capture.
- The capture is a snapshot at run time. It doesn't follow a live session.
