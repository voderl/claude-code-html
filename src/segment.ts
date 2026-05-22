// Strip ANSI escape codes that ansi_up doesn't understand. OSC sequences
// (hyperlinks like ESC ] 8 ; … ST) and non-SGR CSI (cursor positioning,
// mode set/reset) leak as garbage text into the HTML if we leave them in.
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const NON_SGR_CSI_RE = /\x1b\[\??[0-9;]*[hlABCDsuJKf]/g;
const SGR_RE = /\x1b\[[\d;]*[a-zA-Z]/g;

export function cleanAnsi(s: string): string {
  return s.replace(OSC_RE, "").replace(NON_SGR_CSI_RE, "");
}

function firstVisibleChar(line: string): string {
  const m = line.replace(SGR_RE, "").match(/^\s*(\S)/);
  return m ? m[1] : "";
}

// A block-marker line in Claude's transcript always starts with an SGR
// escape (the marker glyph is painted in some palette colour). Requiring
// a leading SGR keeps us from misreading raw user text — e.g. a paragraph
// that genuinely begins with `!` — as a marker; the exact colour values
// are intentionally not pinned, since Claude reuses the same glyphs across
// a few palette tones (green vs white ⏺, etc.).
const SGR_PREFIX_RE = /^\x1b\[[\d;]*m/;

export type Segment =
  | { kind: "plain"; ansi: string }
  | { kind: "prompt"; ansi: string }
  | { kind: "tool"; cmdAnsi: string; outAnsi: string }
  | { kind: "bashTool"; cmdAnsi: string; outAnsi: string }
  | { kind: "gap"; count: number };

type BlockKind = "tool" | "prompt" | "bashTool";

function detectStart(line: string): BlockKind | "" {
  if (!SGR_PREFIX_RE.test(line)) return "";
  switch (firstVisibleChar(line)) {
    case "⏺":
      return "tool";
    case "❯":
      return "prompt";
    case "!":
      return "bashTool";
    default:
      return "";
  }
}

function isOutputArrow(line: string): boolean {
  return SGR_PREFIX_RE.test(line) && firstVisibleChar(line) === "⎿";
}

/**
 * Group cleaned ANSI line-by-line into anchored blocks:
 *   - A line whose first visible glyph is ⏺ / ❯ / ! opens a block. The next
 *     such glyph (anywhere) ends it.
 *   - Inside a block, the first line whose first visible glyph is ⎿ splits
 *     the block into "cmd" (above) and "out" (from ⎿ down).
 *   - ⏺ blocks without ⎿ are assistant text; rendered as plain.
 *     ❯ blocks are always prompts.
 *     ! blocks fold into a bashTool when they have a ⎿; otherwise prompt.
 *
 * Working on ANSI (before ansi_up) avoids the post-HTML gymnastics the old
 * implementation needed: leading empty spans, classifier name drift, span
 * boundaries across newlines.
 */
export function segmentAnsi(ansi: string): Segment[] {
  const lines = ansi.split("\n");
  const segs: Segment[] = [];

  let plainBuf: string[] = [];
  let blockKind: BlockKind | "" = "";
  let cmdBuf: string[] = [];
  let outBuf: string[] = [];
  let arrow = false;

  const peelTrailing = (buf: string[]): number => {
    let n = 0;
    while (buf.length && buf[buf.length - 1] === "") {
      buf.pop();
      n++;
    }
    return n;
  };
  const pushGap = (n: number) => {
    if (n > 0) segs.push({ kind: "gap", count: n });
  };

  const flushPlain = () => {
    if (plainBuf.length === 0) return;
    const trail = peelTrailing(plainBuf);
    if (plainBuf.length) segs.push({ kind: "plain", ansi: plainBuf.join("\n") });
    pushGap(trail);
    plainBuf = [];
  };

  const flushBlock = () => {
    if (!blockKind) return;
    if (arrow && (blockKind === "tool" || blockKind === "bashTool")) {
      const trail = peelTrailing(outBuf);
      segs.push({
        kind: blockKind,
        cmdAnsi: cmdBuf.join("\n"),
        outAnsi: outBuf.join("\n"),
      });
      pushGap(trail);
    } else if (blockKind === "prompt") {
      // Slash-command output (⎿ …) follows the prompt as plain text rather
      // than being bundled into the prompt segment, so the .user-prompt span
      // stays clean — the menu can use its textContent verbatim as a title.
      const trail = peelTrailing(arrow ? outBuf : cmdBuf);
      segs.push({ kind: "prompt", ansi: cmdBuf.join("\n") });
      if (arrow && outBuf.length) {
        segs.push({ kind: "plain", ansi: outBuf.join("\n") });
      }
      pushGap(trail);
    } else if (blockKind === "bashTool") {
      // No ⎿ output — degrade to a prompt-only segment (just `! cmd`).
      const trail = peelTrailing(cmdBuf);
      segs.push({ kind: "prompt", ansi: cmdBuf.join("\n") });
      pushGap(trail);
    } else {
      // ⏺ without ⎿: assistant prose, render as plain.
      const trail = peelTrailing(cmdBuf);
      segs.push({ kind: "plain", ansi: cmdBuf.join("\n") });
      pushGap(trail);
    }
    blockKind = "";
    cmdBuf = [];
    outBuf = [];
    arrow = false;
  };

  for (const line of lines) {
    const starter = detectStart(line);
    if (starter) {
      flushBlock();
      flushPlain();
      blockKind = starter;
      cmdBuf.push(line);
      continue;
    }
    if (blockKind) {
      if (!arrow && isOutputArrow(line)) arrow = true;
      (arrow ? outBuf : cmdBuf).push(line);
    } else {
      plainBuf.push(line);
    }
  }
  flushBlock();
  flushPlain();
  return segs;
}
