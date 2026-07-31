# LSD — LLM Screen Dashboard

🌐 **Read this in other languages:** [Español](README.es.md) · [中文](README.zh.md) · [Euskara](README.eu.md) · [Català](README.ca.md) · [Galego](README.gl.md)

LSD is a **local web dashboard** to create, supervise and operate terminal sessions running AI agent CLIs (kimi, claude, codex, aider…). Instead of juggling many terminal windows, LSD centralizes everything in a single web interface: you see the status of each session, chat with a Deepseek-powered manager, and can drop into any terminal interactively from the browser.

> Every session runs inside **GNU Screen**, so it survives browser closures, dashboard restarts and even server reboots. When LSD starts again, it adopts or restores any still-alive sessions.

---

## What does it do?

- **Orchestrate multiple terminal agents** from one web window.
- **Create sessions** with a name, working directory and your preferred CLI.
- **Monitor real-time status** of each session: `Working`, `Waiting`, `Archived`.
- **Deepseek manager**: ask in natural language (“create a session to analyze this repo”, “check what the security session is doing”, “send `npm test` to the demo session”) and the manager uses *function calling* to act.
- **Interactive browser terminal**: attach to any session with `screen -x` via WebSocket, just like a real terminal.
- **History & conversation**: inspect terminal scrollback or the full conversation parsed from kimi's `wire.jsonl`.
- **Automatic persistence**: session registry, screen snapshots and kimi context are saved so work survives crashes.

---

## Why use it?

| Advantage | Why it matters |
| --- | --- |
| **You won't lose work** | Sessions run in GNU Screen; close the browser and they keep running. |
| **Crash recovery** | On restart, LSD adopts live sessions and resumes crashed ones with `kimi -c` / the CLI's continue flag. |
| **Single control point** | Manage as many agents as you want without switching terminal tabs. |
| **Manager with memory** | The Deepseek chat knows your sessions, their state and output, and can act for you. |
| **Folder isolation** | Each session works in its own directory; the manager never accidentally mixes projects. |
| **Multi-agent** | Supports kimi, claude, codex, aider and any CLI you can launch with `exec`. |
| **No external CDN** | xterm.js is served from `node_modules`; works offline once installed. |
| **Local security** | The web UI has no authentication; control exposure with `HOST` (`127.0.0.1` by default) or put it behind an authenticated proxy. |

---

## Requirements

- **Node.js ≥ 20**
- **GNU Screen** (not available on native Windows; use WSL2)
- At least one installed and authenticated agent CLI: `kimi`, `claude`, `codex`, `aider`…
- A **Deepseek API key** for the manager

---

## Installation

### Ubuntu / Debian (and other Linux distributions)

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

`install.sh` installs system dependencies (Node 20, `screen`, build tools for `node-pty`), runs `npm ci`, creates `.env` interactively and optionally creates a **systemd** service for automatic startup.

### macOS

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

The script detects macOS, installs dependencies via `brew` if needed, and guides `.env` setup.

### Windows

GNU Screen does not exist natively on Windows, so LSD runs inside **WSL2**:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` checks for WSL2, installs Ubuntu if missing, and runs `install.sh` inside WSL2. Once running, the web UI is accessible from Windows at `http://localhost:3000`.

> Manual alternative: install WSL2 with Ubuntu, clone the repo inside Ubuntu and follow the Linux steps.

---

## Quick start

If you prefer not to use the automatic installer:

```bash
npm install
cp .env.example .env
# Edit .env and add your DEEPSEEK_API_KEY
npm start
```

Open http://localhost:3000 in your browser.

### Important `.env` variables

```env
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=deepseek-v4-flash   # or deepseek-v4-pro
SESSION_CLI=kimi                   # default CLI for new sessions
PORT=3000
HOST=127.0.0.1                     # 0.0.0.0 = all interfaces (use only with authenticated proxy)
```

---

## Basic usage

1. **Create a session**: enter a name and optionally a working directory. If the folder has content, LSD offers to let the manager analyze it.
2. **View the terminal**: select the session. The left panel becomes an interactive terminal.
3. **Ask the manager**: type in the right-side chat. You can ask it to create sessions, read output or send commands.
4. **Archive / reopen**: when done with a session, archive it to close the screen while keeping context. Reopen it anytime.
5. **Save history**: download a Markdown file with the full conversation and latest screen snapshot.

---

## Highlighted technical features

- **Real web terminal** with `node-pty` + `xterm.js`, including support for composed keys (accents), fullscreen keyboard lock in Chromium and buttons for reserved keys like `Ctrl+S` or `Ctrl+T`.
- **Activity monitor** classifies sessions as `Working` / `Waiting` by comparing hardcopies every 3 seconds.
- **History archiver** copies new messages from kimi's `wire.jsonl` to `data/history/<slug>.jsonl`.
- **Periodic manager report** configurable via `REPORT_INTERVAL_MIN` summarizing active sessions.
- **Local Ollama support** as an optional model override for kimi sessions.
- **Labels with spaces**: human-friendly names in the UI, internal slugs for screen and URLs.

---

## REST API (excerpt)

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/sessions` | List active and archived sessions |
| POST | `/api/sessions` | Create session `{ name, workdir?, cli?, model? }` |
| GET | `/api/sessions/:name/output` | Latest terminal lines |
| GET | `/api/sessions/:name/conversation` | Full parsed conversation |
| POST | `/api/sessions/:name/archive` | Archive the session |
| POST | `/api/sessions/:name/reopen` | Reopen an archived session |
| POST | `/api/chat` | Chat with the Deepseek manager |
| GET / POST | `/api/config` | Read / update configuration |
| WS | `/ws?name=<session>` | Interactive terminal |

---

## Security

- The web UI has **no authentication**. Use `HOST=127.0.0.1` for local-only access, or place LSD behind an authenticated proxy if you expose `0.0.0.0`.
- The Deepseek API key is stored in `.env` (restricted permissions set by the installer) and is never returned in full by the API (`GET /api/config` only shows `••••1234`).

---

## License

MIT
