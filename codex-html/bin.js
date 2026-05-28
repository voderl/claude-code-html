#!/usr/bin/env node
// codex-html is just an alias for the `codex-html` bin that ships inside the
// claude-code-html package. Its CLI parses process.argv with commander at load
// time, so requiring it here runs it with this process's arguments untouched.
// https://github.com/voderl/claude-code-html
require("claude-code-html/dist/codex-cli.js");
