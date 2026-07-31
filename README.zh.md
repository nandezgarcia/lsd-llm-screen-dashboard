# LSD — LLM Screen Dashboard

🌐 **选择其他语言阅读：** [English](README.md) · [Español](README.es.md) · [Euskara](README.eu.md) · [Català](README.ca.md) · [Galego](README.gl.md)

LSD 是一个**本地 Web 仪表板**，用于创建、监督和运行运行 AI agent CLI（kimi、claude、codex、aider…）的终端会话。它无需在多个终端窗口之间切换，而是将所有内容集中到一个 Web 界面中：你可以查看每个会话的状态、与由 Deepseek 驱动的管理器聊天，并可以从浏览器进入任何终端进行交互。

> 每个会话都在 **GNU Screen** 中运行，因此即使关闭浏览器、重启仪表板甚至服务器重启，会话仍然保持运行。当 LSD 再次启动时，它会接管或恢复任何仍然存活的会话。

---

## 它能做什么？

- 从一个 Web 窗口**编排多个终端 agent**。
- **创建会话**，指定名称、工作目录和首选 CLI。
- **实时监控**每个会话的状态：`Working`、`Waiting`、`Archived`。
- **Deepseek 管理器**：用自然语言提问（例如“创建一个会话来分析这个仓库”、“查看安全会话在做什么”、“向 demo 会话发送 `npm test`”），管理器会使用*function calling*来执行操作。
- **交互式浏览器终端**：通过 WebSocket 使用 `screen -x` 附加到任何会话，就像真正的终端一样。
- **历史记录与对话**：检查终端回滚内容，或从 kimi 的 `wire.jsonl` 解析完整对话。
- **自动持久化**：会话注册表、screen 快照和 kimi 上下文都会被保存，因此即使崩溃也不会丢失工作。

---

## 为什么要用它？

| 优势 | 重要性 |
| --- | --- |
| **不会丢失工作** | 会话在 GNU Screen 中运行；关闭浏览器后它们仍会继续运行。 |
| **崩溃恢复** | 重启时，LSD 会接管存活会话，并通过 `kimi -c` / 对应 CLI 的 continue 标志恢复崩溃的会话。 |
| **单一控制点** | 无需切换终端标签页即可管理任意数量的 agent。 |
| **有记忆的管理器** | Deepseek 聊天了解你的会话、它们的状态和输出，并可以代你执行操作。 |
| **文件夹隔离** | 每个会话都在自己的目录中工作；管理器不会意外混淆项目。 |
| **多 agent 支持** | 支持 kimi、claude、codex、aider 以及任何可通过 `exec` 启动的 CLI。 |
| **无外部 CDN** | xterm.js 从 `node_modules` 提供；安装完成后可离线工作。 |
| **本地安全** | Web UI 没有身份验证；通过 `HOST` 控制暴露范围（默认 `127.0.0.1`），或将其置于带身份验证的代理之后。 |

---

## 环境要求

- **Node.js ≥ 20**
- **GNU Screen**（原生 Windows 不可用；请使用 WSL2）
- 至少一个已安装并通过身份验证的 agent CLI：`kimi`、`claude`、`codex`、`aider`…
- 用于管理器的 **Deepseek API key**

---

## 安装

### Ubuntu / Debian（以及其他 Linux 发行版）

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

`install.sh` 会安装系统依赖（Node 20、`screen`、用于 `node-pty` 的构建工具），运行 `npm ci`，以交互方式创建 `.env`，并可选择创建 **systemd** 服务以实现自动启动。

### macOS

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

脚本会检测 macOS，如有需要通过 `brew` 安装依赖，并引导完成 `.env` 配置。

### Windows

GNU Screen 在原生 Windows 上不存在，因此 LSD 在 **WSL2** 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` 会检查 WSL2，如果缺少则安装 Ubuntu，然后在 WSL2 中运行 `install.sh`。运行后，可以在 Windows 上通过 `http://localhost:3000` 访问 Web UI。

> 手动替代方案：安装带有 Ubuntu 的 WSL2，在 Ubuntu 中克隆仓库，然后按照 Linux 步骤操作。

---

## 快速开始

如果你不想使用自动安装程序：

```bash
npm install
cp .env.example .env
# 编辑 .env 并添加你的 DEEPSEEK_API_KEY
npm start
```

在浏览器中打开 http://localhost:3000。

### 重要的 `.env` 变量

```env
DEEPSEEK_API_KEY=<your-api-key>
DEEPSEEK_MODEL=deepseek-v4-flash   # 或 deepseek-v4-pro
SESSION_CLI=kimi                   # 新会话的默认 CLI
PORT=3000
HOST=127.0.0.1                     # 0.0.0.0 = 所有接口（仅在带身份验证的代理后使用）
```

---

## 基本使用

1. **创建会话**：输入名称，并可选输入工作目录。如果文件夹包含内容，LSD 会提供让管理器分析它的选项。
2. **查看终端**：选择会话。左侧面板将变为交互式终端。
3. **询问管理器**：在右侧聊天中输入。你可以让它创建会话、读取输出或发送命令。
4. **归档 / 重新打开**：完成会话后，将其归档以关闭 screen 同时保留上下文。随时可以重新打开。
5. **保存历史记录**：下载包含完整对话和最新 screen 快照的 Markdown 文件。

---

## 突出的技术特性

- 使用 `node-pty` + `xterm.js` 实现的**真正 Web 终端**，支持组合键（重音符号）、Chromium 中的全屏键盘锁定，以及 `Ctrl+S`、`Ctrl+T` 等保留键按钮。
- **活动监控器**每 3 秒比较 hardcopy，将会话分类为 `Working` / `Waiting`。
- **历史归档器**将 kimi `wire.jsonl` 中的新消息复制到 `data/history/<slug>.jsonl`。
- 可通过 `REPORT_INTERVAL_MIN` 配置的**周期性管理器报告**，汇总活动会话。
- **本地 Ollama 支持**，作为 kimi 会话的可选模型覆盖。
- **带空格的标签**：UI 中显示人性化的名称，screen 和 URL 使用内部 slug。

---

## REST API（摘录）

| 方法 | 路由 | 说明 |
| --- | --- | --- |
| GET | `/api/sessions` | 列出活动和已归档会话 |
| POST | `/api/sessions` | 创建会话 `{ name, workdir?, cli?, model? }` |
| GET | `/api/sessions/:name/output` | 最新终端行 |
| GET | `/api/sessions/:name/conversation` | 完整解析后的对话 |
| POST | `/api/sessions/:name/archive` | 归档会话 |
| POST | `/api/sessions/:name/reopen` | 重新打开已归档会话 |
| POST | `/api/chat` | 与 Deepseek 管理器聊天 |
| GET / POST | `/api/config` | 读取 / 更新配置 |
| WS | `/ws?name=<session>` | 交互式终端 |

---

## 安全

- Web UI **没有身份验证**。使用 `HOST=127.0.0.1` 仅允许本地访问，或者如果要暴露 `0.0.0.0`，请将 LSD 放在带身份验证的代理之后。
- Deepseek API key 存储在 `.env` 中（安装程序会设置受限权限），API 永远不会完整返回该密钥（`GET /api/config` 仅显示 `••••1234`）。

---

## 许可证

MIT
