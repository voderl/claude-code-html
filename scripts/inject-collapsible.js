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
/* Prompt-jump menu */
.ccs-menu {
  position: fixed; top: 10px; right: 12px; z-index: 10;
  font: 12px/1.4 ui-monospace, monospace;
}
.ccs-menu-btn {
  background: rgba(0,0,0,0.55); color: #e5e5e5;
  border: 1px solid #333; border-radius: 4px;
  padding: 4px 8px; cursor: pointer; font: inherit;
}
.ccs-menu-btn:hover { background: rgba(0,0,0,0.75); }
.ccs-menu-list {
  display: none;
  position: absolute; top: calc(100% + 4px); right: 0;
  min-width: 240px; max-width: min(420px, 90vw);
  max-height: 60vh; overflow-y: auto;
  background: #1f1f1f; color: #e5e5e5;
  border: 1px solid #3a3a3a; border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.5);
}
.ccs-menu.open .ccs-menu-list { display: block; }
.ccs-menu-item {
  display: block; padding: 6px 10px; color: inherit;
  text-decoration: none; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-bottom: 1px solid #2a2a2a;
}
.ccs-menu-item:last-child { border-bottom: 0; }
.ccs-menu-item:hover { background: rgba(255,255,255,0.06); }
.ccs-menu-empty {
  padding: 8px 10px; color: #888; font-style: italic;
}
`;
if (!html.includes("details.tool {")) {
  html = html.replace("</style>", `${CSS}</style>`);
}

// Inject the prompt-jump menu (button + list) just before #snap, and the
// click/jump script after the existing IIFE. Idempotent.
const MENU_HTML = `<div class="ccs-menu" id="ccs-menu"><button class="ccs-menu-btn" id="ccs-menu-btn" type="button" aria-label="提问列表">☰</button><div class="ccs-menu-list" id="ccs-menu-list"></div></div>\n`;
if (!html.includes('id="ccs-menu"')) {
  html = html.replace('<div id="snap"></div>', `${MENU_HTML}<div id="snap"></div>`);
}

const MENU_JS = `
<script>
(function () {
  var snap = document.getElementById('snap');
  var menu = document.getElementById('ccs-menu');
  var menuBtn = document.getElementById('ccs-menu-btn');
  var menuList = document.getElementById('ccs-menu-list');
  if (!menu || !menuBtn || !menuList) return;
  function buildMenu() {
    var activeSnap = snap.querySelector('.snapshot.active') || snap;
    var prompts = activeSnap.querySelectorAll('.user-prompt');
    menuList.textContent = '';
    if (!prompts.length) {
      var empty = document.createElement('div');
      empty.className = 'ccs-menu-empty';
      empty.textContent = '（暂无提问）';
      menuList.appendChild(empty);
      return;
    }
    for (var i = 0; i < prompts.length; i++) {
      var raw = (prompts[i].innerText || prompts[i].textContent || '').trim();
      var label = raw.replace(/^❯\\s*/, '');
      var arrow = label.indexOf('⎿');
      if (arrow >= 0) label = label.slice(0, arrow);
      label = label.replace(/\\s+/g, ' ').trim();
      if (!label || /^─/.test(label)) continue;
      var item = document.createElement('a');
      item.className = 'ccs-menu-item';
      item.href = '#';
      item.textContent = label;
      item.title = label;
      (function (target) {
        item.addEventListener('click', function (e) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          menu.classList.remove('open');
        });
      })(prompts[i]);
      menuList.appendChild(item);
    }
    if (!menuList.children.length) {
      var empty2 = document.createElement('div');
      empty2.className = 'ccs-menu-empty';
      empty2.textContent = '（暂无提问）';
      menuList.appendChild(empty2);
    }
  }
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = menu.classList.contains('open');
    if (!open) buildMenu();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    if (menu.classList.contains('open') && !menu.contains(e.target)) {
      menu.classList.remove('open');
    }
  });
})();
</script>
`;
if (!html.includes("'ccs-menu-btn'")) {
  html = html.replace("</body>", `${MENU_JS}</body>`);
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
