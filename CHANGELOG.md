# Changelog

## 0.4.0

First release as **Herdr for VS Code** (`xicu.herdr-vscode`), superseding
`xicu.herdr-companion`.

- Event-driven state: no more 2-second polling; one queued snapshot per burst of
  herdr events, with reconnect and backoff.
- Fix startup focus stealing: already-blocked agents no longer notify or grab the
  terminal. Only a transition into blocked does.
- Stop rewriting herdr tab labels with emoji every refresh; tab names belong to
  the user again.
- Add the **Herdr** activity-bar view: workspace folders, agents, status icons,
  and inline new/rename/close actions.
- Add **Herdr: Send Selection to Agent**, with per-harness path/line syntax.
- Add **Herdr: Rename Agent Tab**.
- Next/previous now follows herdr's tab order and tracks focus changed inside the
  herdr TUI.
- Multi-root support: status bar and new tabs follow the active editor's folder.
- New conversations and shells get `COLORFGBG`, so TUIs start with the right
  light/dark palette.
- Add `herdr.autoStart` (off by default); requests no longer spawn a daemon
  silently.
- Offline state now reports the real error instead of requiring the `herdr`
  binary on the extension host's `PATH`.
- Remove dead code and the fragile terminal-name cleanup.
- Add tests (resolver, notifier, mentions) and CI packaging.
- Add Marketplace icon, keywords, banner, homepage and issue links.
