---
name: board
description: Open Spadework's board, the local web page where plans are read, edited and approved. Starts it if it isn't running; `stop` stops it.
argument-hint: "[stop] | -help"
disable-model-invocation: true
---

# Spadework: board

If the arguments are `-help` (or start with it), print exactly this and stop:

> **/spadework:board**: open the board in your browser
> Usage: `/spadework:board` starts the board's page if it isn't running and opens it. `/spadework:board stop` stops it.
> The board shows the plans Spadework wrote, one row each. Review them, answer questions, give feedback and approve; then run `/spadework:implement`.
> The page runs on your machine only (127.0.0.1) and keeps running until you stop it or restart the computer. It opens through a file in `~/.spadework/board` that carries its key: don't share that file.

Arguments: $ARGUMENTS

1. If the arguments are `stop`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" board stop`, print its output and stop.
2. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/spadework.js" board`. It starts the page if needed and opens it in the browser.
3. Print its output word for word, and nothing else. Never print the board's key or read the file it names.
