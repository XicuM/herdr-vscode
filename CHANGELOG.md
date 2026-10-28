# Changelog

## 0.4.5

- The view is now titled **Herdr: Agents**.
- The first tab opened in a folder without a herdr workspace no longer leaves an extra
  empty tab beside it: the new workspace's own first tab is used.

## 0.4.4

- The view's terminal reattaches after its stream ends (herdr restarted, pane exited) instead
  of staying dead until another tab is picked; clicking a tab switches the terminal at once.
- Closing the view stops its terminal stream, so herdr gets the pane's size back.
- Starting an agent no longer closes its tab when a later focus call fails.
- Closing an agent tab (Delete, middle-click, menu) asks first.
- Changing `herdr.session` starts that session's server when `herdr.autoStart` is on.
- A rejected event subscription is retried with backoff instead of leaving live updates off.
- A herdr server that is slow to accept connections keeps its socket.
- Requests fail as soon as herdr drops the connection instead of after the 15 s timeout.
- The tab strip scrolls at normal speed with the wheel; Previous wraps to the last tab.
- Removed the global Shift+Enter keybinding for integrated terminals; the Herdr view
  handles Shift+Enter itself.
- A terminal attach that another client takes over is no longer re-attached with `--takeover`
  on the next snapshot, which made a stale extension host and the live one fight over a pane.

- One **Herdr** view, like herdr-obsidian: herdr's tabs on top and the active tab's
  terminal (xterm.js, streamed with `herdr terminal session control`) below. It
  replaces the native terminal and the left activity-bar **Agents** tree (and its
  drag-and-drop target).
- A single `+` opens a new terminal tab; start an agent by running it there.
- `herdr.autoStart` now defaults to on, so the `vscode` session starts on its own
  (dev containers and fresh installs no longer show "Herdr is not running").

## 0.4.2

- **Tab strip.** A **Herdr Tabs** view in the panel mirrors herdr's tabs like
  Obsidian's terminal: agent glyphs, status badges (blocked tabs pulse and
  scroll into view, working tabs spin), close buttons, double-click or F2 to
  rename, middle-click to close, drag to reorder and a right-click menu.
  Drag the view into the Terminal group to dock it above the terminal.
- Tab order from the strip is remembered per workspace and also drives next/previous.
- Ctrl+Tab / Ctrl+Shift+Tab cycle tabs while the Herdr terminal has focus (add
  `herdr.switchNext` and `herdr.switchPrev` to `terminal.integrated.commandsToSkipShell`).

## 0.4.1

- Updated extension icon and activity bar icon to the minimalistic Herdr ram mascot.
- Drop files or selected text onto agent conversations in the Herdr view, with
  harness-specific references, multiple files and bracketed multiline paste.
- Send references and drops directly to their target pane, avoiding terminal
  focus races.
- Add **Install Agent Skill (Open Files in VS Code)**, documenting VS Code's
  existing `code --reuse-window --goto` command for agents. New tabs inherit
  the extension host's CLI routing when available.

## 0.4.0

First release as **Herdr for VS Code** (`xicu.herdr-vscode`), superseding
`xicu.herdr-companion`.

- Event-driven state: no more 2-second polling; one queued snapshot per burst of
  herdr events, with reconnect and backoff. Agent status changes are subscribed
  per pane (herdr rejects a global `pane.agent_status_changed` without a
  `pane_id`).
- Fix startup focus stealing: already-blocked agents no longer notify or grab the
  terminal. Only a transition into blocked does.
- Stop rewriting herdr tab labels with emoji every refresh; tab names belong to
  the user again.
- Add the **Herdr** activity-bar view: every herdr workspace, its agents, status
  icons, and inline new/rename/close actions.
- Add **Herdr: Send Selection to Agent**, with per-harness path/line syntax.
- Add **Herdr: Rename Tab**.
- Next/previous now follows herdr's tab order and tracks focus changed inside the
  herdr TUI.
- Multi-root support: new conversations use the active editor's folder; the
  status bar and tree cover every herdr workspace.
- New conversations and shells get `COLORFGBG`, so TUIs start with the right
  light/dark palette.
- Add `herdr.autoStart` (off by default); requests no longer spawn a daemon
  silently.
- Offline state now reports the real error instead of requiring the `herdr`
  binary on the extension host's `PATH`. Clicking the status bar when offline
  opens the terminal, which starts the isolated session.
- Do not inherit `HERDR_SOCKET_PATH` or pane variables when VS Code itself was
  launched from a herdr pane. The configured session and its terminal stay
  isolated; auto-start clears them for the spawned server too.
- Remove dead code and the fragile terminal-name cleanup.
- Add tests (resolver, notifier, mentions) and CI packaging.
- Add Marketplace icon, keywords, banner, homepage and issue links.
