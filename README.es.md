# LSD — LLM Screen Dashboard

🌐 **Lee esto en otros idiomas:** [English](README.md) · [中文](README.zh.md) · [Euskara](README.eu.md) · [Català](README.ca.md) · [Galego](README.gl.md)

LSD es un **dashboard web local** para crear, supervisar y operar sesiones de terminal que ejecutan agentes de IA (kimi, claude, codex, aider…). En lugar de tener muchas terminales abiertas, LSD las centraliza en una única interfaz web: ves el estado de cada sesión, chateas con un gestor impulsado por Deepseek, y puedes entrar en cualquier terminal de forma interactiva desde el navegador.

> Cada sesión corre dentro de **GNU Screen**, así que sobrevive a cierres del navegador, del dashboard e incluso a un reinicio del servidor. Al arrancar de nuevo, LSD adopta o restaura las sesiones que aún estén vivas.

---

## ¿Qué hace?

- **Orquesta múltiples agentes de terminal** desde una sola ventana web.
- **Crea sesiones** con un nombre, una carpeta de trabajo y el CLI que prefieras.
- **Supervisa el estado** de cada sesión en tiempo real: `Trabajando`, `Esperando`, `Archivada`.
- **Gestor con Deepseek**: le pides cosas en lenguaje natural (“crea una sesión para analizar este repo”, “mira qué está haciendo la sesión de seguridad”, “envía ‘npm test’ a la sesión demo”) y el gestor usa *function calling* para actuar.
- **Terminal interactiva en el navegador**: adjúntate a cualquier sesión con `screen -x` vía WebSocket, como si estuvieras en una terminal real.
- **Historial y conversación**: consulta el scrollback del terminal o la conversación completa parseada del `wire.jsonl` de kimi.
- **Persistencia automática**: el registro de sesiones, snapshots de pantalla y el contexto de kimi se guardan para sobrevivir a cortes.

---

## Ventajas

| Ventaja | Por qué importa |
| --- | --- |
| **No pierdes el trabajo** | Las sesiones corren en GNU Screen; cierras el navegador y siguen ejecutándose. |
| **Recuperación ante cortes** | Al reiniciar, LSD adopta sesiones vivas y reanuda las caídas con `kimi -c` / `--continue` del CLI correspondiente. |
| **Un solo punto de control** | Gestiona tantos agentes como quieras sin saltar entre pestañas de terminal. |
| **Gestor con memoria** | El chat con Deepseek conoce las sesiones, su estado y su salida, y puede actuar por ti. |
| **Aislamiento por carpeta** | Cada sesión trabaja en su propio directorio; el gestor nunca mezcla proyectos por accidente. |
| **Multi-agente** | Soporta kimi, claude, codex, aider y cualquier CLI que puedas lanzar desde `exec`. |
| **Sin dependencias externas en red** | xterm.js se sirve desde `node_modules`; funciona offline una vez instalado. |
| **Seguridad local** | La web no tiene autenticación, pero puedes limitarla a `127.0.0.1` o ponerla tras un proxy. |

---

## Requisitos

- **Node.js ≥ 20**
- **GNU Screen** (no existe en Windows nativo; se usa WSL2)
- Al menos un CLI de agente instalado y autenticado: `kimi`, `claude`, `codex`, `aider`…
- Una **API key de Deepseek** para el gestor

---

## Instalación

### Ubuntu / Debian (y otras distribuciones Linux)

```bash
git clone <url-del-repo>
cd llm-screen-dashboard
bash install.sh
```

`install.sh` instala lo necesario del sistema (Node 20, `screen`, herramientas de compilación para `node-pty`), ejecuta `npm ci`, crea el `.env` interactivamente y ofrece crear un servicio **systemd** para arranque automático.

### macOS

```bash
git clone <url-del-repo>
cd llm-screen-dashboard
bash install.sh
```

El script detecta macOS, instala las dependencias mediante `brew` si hace falta, y guía la configuración del `.env`.

### Windows

En Windows **no existe GNU Screen de forma nativa**, por lo que LSD corre dentro de **WSL2**:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` comprueba que WSL2 esté instalado, instala Ubuntu si no lo está, y ejecuta `install.sh` dentro de WSL2. Una vez arrancado, la web es accesible desde Windows en `http://localhost:3000`.

> Alternativa manual: instala WSL2 con Ubuntu, clona el repo dentro de Ubuntu y sigue los pasos de Linux.

---

## Puesta en marcha rápida

Si prefieres no usar el instalador automático:

```bash
npm install
cp .env.example .env
# Edita .env y añade tu DEEPSEEK_API_KEY
npm start
```

Abre http://localhost:3000 en tu navegador.

### Variables importantes de `.env`

```env
DEEPSEEK_API_KEY=tu-api-key
DEEPSEEK_MODEL=deepseek-v4-flash   # o deepseek-v4-pro
SESSION_CLI=kimi                  # CLI por defecto para nuevas sesiones
PORT=3000
HOST=127.0.0.1                    # 0.0.0.0 = toda la red (usar solo con proxy auth)
```

---

## Uso básico

1. **Crear una sesión**: escribe un nombre y opcionalmente una carpeta. Si la carpeta tiene contenido, LSD ofrece que el gestor la analice.
2. **Ver la terminal**: selecciona la sesión. El panel izquierdo se convierte en terminal interactiva.
3. **Preguntar al gestor**: escribe en el chat de la derecha. Puedes pedirle que cree sesiones, lea la salida o envíe comandos.
4. **Archivar / reabrir**: cuando termines con una sesión, archívala para cerrar el screen conservando el contexto. Vuelve a abrirla cuando quieras.
5. **Guardar historial**: descarga un Markdown con la conversación completa y la última pantalla.

---

## Características técnicas destacadas

- **Terminal web real** con `node-pty` + `xterm.js`, incluyendo soporte para teclas compuestas (tildes), fullscreen con bloqueo de teclado en Chromium y botones para teclas reservadas como `Ctrl+S` o `Ctrl+T`.
- **Monitor de actividad** que clasifica sesiones como `Trabajando` / `Esperando` comparando hardcopies cada 3 segundos.
- **Archivador de historial** que copia mensajes nuevos del `wire.jsonl` de kimi a `data/history/<slug>.jsonl`.
- **Informe periódico del gestor** configurable (`REPORT_INTERVAL_MIN`) que resume el estado de las sesiones activas (también se envía a Matrix si el bot está activo — ver abajo).
- **Bot de Matrix (opcional)**: habla con el mismo gestor desde el móvil — ver la sección [Bot de Matrix](#bot-de-matrix-opcional).
- **Soporte de Ollama local** como override de modelo para sesiones kimi.
- **Etiquetas con espacios**: nombres legibles en la UI, slugs internos para screen y URLs.

---

## Bot de Matrix (opcional)

Puedes hablar con el mismo gestor de Deepseek desde el móvil a través de [Matrix](https://matrix.org) (Element y otros clientes). El bot vive en `src/matrix.js`, solo responde a usuarios autorizados y necesita una sala **sin cifrar** (no soporta E2EE).

La receta usa **matrix.org**, el servidor público y gratuito — pero vale cualquier homeserver Matrix, incluido **uno propio** (p. ej. un Synapse autoalojado): basta apuntar `MATRIX_HOMESERVER` a él. Con un servidor propio el registro suele estar cerrado, así que la cuenta del bot se crea en el propio servidor (en Synapse: `register_new_matrix_user -c /etc/matrix-synapse/homeserver.yaml`).

1. **Crea una cuenta para el bot** en matrix.org (desde Element: cierra sesión y registra una cuenta nueva, p. ej. `@mi-lsd-bot:matrix.org`).
2. **Obtén su access token**:
   ```bash
   curl -X POST https://matrix.org/_matrix/client/v3/login \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"mi-lsd-bot"},"password":"<contraseña-del-bot>"}'
   ```
   (En Element también está en *Ajustes → Ayuda y acerca de → Token de acceso*.)
3. **Configura el `.env`** y reinicia LSD:
   ```
   MATRIX_HOMESERVER=https://matrix.org
   MATRIX_USER=@mi-lsd-bot:matrix.org
   MATRIX_ACCESS_TOKEN=<token del paso 2>
   MATRIX_ALLOWED_USERS=@tu-usuario:matrix.org
   ```
   Sin estas variables el bot simplemente no arranca. El log de arranque muestra `Matrix: bot conectado como …` al conectar.
4. **Crea una sala sin cifrar** en Element (*ajustes avanzados → desactivar cifrado* al crearla) e invita al bot escribiendo su MXID completo (`@mi-lsd-bot:matrix.org`) — las cuentas nuevas no aparecen en el buscador de usuarios. El bot acepta automáticamente invitaciones solo de usuarios autorizados.

Notas:

- `MATRIX_ALLOWED_USERS` es una lista blanca de MXIDs separados por comas. El bot **ignora en silencio a cualquier otro** — mantenla corta: el gestor puede crear y cerrar sesiones.
- Los DMs de Matrix se cifran por defecto y el bot no puede leer salas cifradas; usa una sala dedicada sin cifrar. En matrix.org eso significa que el operador del servidor podría ver el contenido — con un servidor propio se queda en tus manos (el transporte va cifrado con TLS en ambos casos).
- El informe periódico del gestor (`REPORT_INTERVAL_MIN`) también se envía a las salas del bot.

---

## API REST (extracto)

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/sessions` | Lista activas y archivadas |
| POST | `/api/sessions` | Crea sesión `{ name, workdir?, cli?, model? }` |
| GET | `/api/sessions/:name/output` | Últimas líneas del terminal |
| GET | `/api/sessions/:name/conversation` | Conversación completa parseada |
| POST | `/api/sessions/:name/archive` | Archiva la sesión |
| POST | `/api/sessions/:name/reopen` | Reabre una archivada |
| POST | `/api/chat` | Chat con el gestor Deepseek |
| GET / POST | `/api/config` | Lee / actualiza configuración |
| WS | `/ws?name=<sesión>` | Terminal interactivo |

---

## Seguridad

- La interfaz web **no tiene autenticación**. Usa `HOST=127.0.0.1` para acceso solo local, o coloca LSD detrás de un proxy con autenticación si expones `0.0.0.0`.
- La API key de Deepseek se guarda en `.env` (permisos restringidos por el instalador) y nunca se devuelve completa por la API (`GET /api/config` solo muestra `••••1234`).

---

## Licencia

MIT
