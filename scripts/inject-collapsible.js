#!/usr/bin/env node
// Rewrite an existing rendered HTML to add the collapsible tool-call wrappers.
// Takes one path; modifies in place. The pre content inside each snapshot
// `<div class="snapshot ..."><pre class="terminal">...</pre></div>` is replaced
// with the segmented structure (plain pre + <details> tool blocks).

const fs = require("fs");
const path = require("path");

const { segmentSnapshot, renderSegments } = require(
  path.resolve(__dirname, "..", "dist", "render.js"),
);

const target = process.argv[2];
if (!target) {
  console.error("usage: inject-collapsible.js <html-path>");
  process.exit(1);
}

let html = fs.readFileSync(target, "utf-8");

// Replace every <pre class="terminal">...</pre> with segmented output. The
// regex is non-greedy and consumes only the outermost pre wrappers that were
// in the rendered file before we ran — the inserted output uses nested pre's
// but is generated in a single .replace() pass so they aren't re-matched.
const PRE_RE = /<pre class="terminal">([\s\S]*?)<\/pre>/g;
let count = 0;
html = html.replace(PRE_RE, (_m, body) => {
  count++;
  return renderSegments(segmentSnapshot(body));
});

// Inject the CSS rules right before the closing </style>. Idempotent — skip if
// already present.
const CSS = `
/* Inline tool blocks inside the terminal pre. */
details.tool { display: inline-block; }
details.tool > summary {
  display: inline; cursor: pointer; list-style: none; outline: none;
  border-radius: 4px; padding: 4px 4px 4px 0;
}
details.tool > summary::-webkit-details-marker { display: none; }
details.tool > summary::marker { content: ""; }
details.tool::details-content { display: contents; }
details.tool > .tool-out { display: inline; }
details.tool:not([open]) > .tool-out { display: none; }
details.tool > summary:hover { background: rgba(255,255,255,0.06); }
details.tool[open] > summary { background: rgba(255,255,255,0.03); }
`;
if (!html.includes("details.tool {")) {
  html = html.replace("</style>", `${CSS}</style>`);
}

// Rewrite the hint label so it shows "View" / "Detail" instead of the raw
// snapshot index, and rewrite the JS that updates it on cycle.
html = html.replace(
  /<b id="ccs-idx">[^<]*<\/b>[^·]*·/,
  '<b id="ccs-idx">View</b> ·',
);
html = html.replace(
  /idxEl\.textContent = snaps\[activeIdx\]\.getAttribute\('data-snapshot'\);/,
  "idxEl.textContent = activeIdx === 0 ? 'View' : 'Detail';",
);

fs.writeFileSync(target, html);
console.error(`[inject-collapsible] rewrote ${count} <pre> block(s) in ${target}`);
