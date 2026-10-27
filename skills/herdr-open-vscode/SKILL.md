---
name: herdr-open-vscode
description: Open a file in the user's VS Code editor when they ask to see a file or a specific line from an agent conversation.
---

Run VS Code's CLI from the agent's working directory:

```sh
code --reuse-window --goto "./src/example.ts:42:1"
```

Replace the example with the requested file and optional one-based line and column.
Quote the entire argument so spaces in paths work. Existing files can be opened
without changing their contents. Multiple files can be passed as separate arguments.

In Remote-SSH, WSL, or a dev container, use the `code` command provided by that
VS Code environment. Herdr tabs created by the extension inherit
`VSCODE_IPC_HOOK_CLI` when available to route requests to the originating window.
Otherwise `--reuse-window` uses the last active VS Code window. If `code` is
unavailable, report that rather than installing or launching another editor.
