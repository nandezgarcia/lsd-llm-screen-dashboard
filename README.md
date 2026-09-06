# LSD — LLM Screen Dashboard

🌐 **Idiomas:** [Español](README.es.md) · [中文](README.zh.md) · [Euskara](README.eu.md) · [Català](README.ca.md) · [Galego](README.gl.md)

**LSD** es un dashboard web local para crear, supervisar y operar sesiones de terminal con agentes IA (kimi, claude, codex, aider). Las sesiones viven en **GNU Screen**, por lo que sobreviven al cierre del navegador, reinicios del dashboard y apagados del servidor.

Construido con **Node.js 20 + Express**, sin framework de frontend. Incluye un gestor Deepseek para crear sesiones, leer output y enviar comandos por chat.

## Qué hace

- Crea y monitoriza sesiones de terminal desde una sola pestaña.
- Gestor por lenguaje natural: "crea una sesión", "qué hace la sesión X", "envía npm test".
- Terminal interactivo real vía WebSocket (`node-pty` + `xterm.js`).
- Persistencia: adopta sesiones vivas y reanuda caídas al reiniciar.
- Historial y conversación desde `wire.jsonl`.
- Bot de Matrix opcional para hablar desde el móvil.

## Requisitos

- Node.js ≥ 20
- GNU Screen (Linux/macOS/WSL2; no nativo en Windows)
- Un CLI de agente instalado: `kimi`, `claude`, `codex`, `aider`…
- API key de Deepseek

## Instalación

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

`install.sh` instala dependencias, crea `.env` y opcionalmente un servicio systemd.

## Quick start

```bash
npm install
cp .env.example .env
# Editar .env con DEEPSEEK_API_KEY
npm start
```

Abre http://localhost:3000.

## Configuración

Variables clave en `.env`:

```env
DEEPSEEK_API_KEY=tu-key
DEEPSEEK_MODEL=deepseek-v4-flash
SESSION_CLI=kimi
PORT=3000
HOST=127.0.0.1
```

## Uso básico

1. Crea una sesión con nombre y directorio.
2. Selecciona la sesión: terminal interactivo a la izquierda.
3. Chatea con el gestor a la derecha.
4. Archiva/reabre sesiones.
5. Descarga historial en Markdown.

## API REST

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/sessions` | Lista sesiones |
| POST | `/api/sessions` | Crea sesión |
| GET | `/api/sessions/:name/output` | Últimas líneas |
| GET | `/api/sessions/:name/conversation` | Conversación completa |
| POST | `/api/sessions/:name/archive` | Archiva |
| POST | `/api/sessions/:name/reopen` | Reabre |
| POST | `/api/chat` | Chat con gestor |
| GET / POST | `/api/config` | Configuración |
| WS | `/ws?name=<sesión>` | Terminal interactivo |

## Matrix bot (opcional)

```env
MATRIX_HOMESERVER=https://matrix.org
MATRIX_USER=@tu-bot:matrix.org
MATRIX_ACCESS_TOKEN=<token>
MATRIX_ALLOWED_USERS=@tu-usuario:matrix.org
```

## Seguridad

- Sin autenticación web. Usa `HOST=127.0.0.1` o un proxy con auth.
- La API key se guarda en `.env` con permisos restringidos.

## Licencia

MIT
