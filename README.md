# Herdr (VS Code extension)

A fast, lightweight VS Code extension for managing AI coding agent conversations
(opencode, claude, codex, grok, agy, copilot, etc.) backed by [Herdr](https://herdr.dev).

## Agent Status Mapping

- 🟡 `working` – yellow dot / active processing
- 🔴 `blocked` – red dot / waiting for your input (triggers notification and brings terminal to foreground)
- 🟢 `done` – green dot / completed
- ⚪ `idle` – grey dot / waiting
- `unknown` – plain shell / no dot

## Features

- **Status Bar Live Overview**: Shows active agent conversations and their live statuses directly in the VS Code status bar. Highlights in red when an agent is blocked and waiting for user input.
- **Fast Switcher (`Alt+A` / `Cmd+Alt+A`)**: QuickPick menu to jump between agent terminals, sorted by status priority (blocked first).
- **Previous / Next Navigation (`Alt+[` / `Alt+]`)**: Cycle through active agents quickly without touching the mouse.
- **Focus on Blocked**: Automatically brings the relevant agent terminal into view when it requires input.
- **Single Master Terminal**: Automatically hosts and connects to Herdr in your workspace folder.

## Keybindings

- `Alt+A` (macOS: `Cmd+Alt+A`) – Switch Agent Conversation
- `Alt+]` (macOS: `Cmd+Alt+]`) – Next Agent Terminal
- `Alt+[` (macOS: `Cmd+Alt+[`) – Previous Agent Terminal

## Requirements

- Herdr installed and running (`herdr` in a terminal, or `curl -fsSL https://herdr.dev/install.sh | sh`).
- Linux or macOS.

## Configuration

- `herdr.focusOnBlocked` (default `true`) – When an agent becomes `blocked`, bring its VS Code terminal to the foreground and show a notification.

## Build

```sh
npm install
npm run compile
```
