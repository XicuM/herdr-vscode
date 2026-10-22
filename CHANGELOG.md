# Changelog

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
- Add **Herdr: Rename Agent Tab**.
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
