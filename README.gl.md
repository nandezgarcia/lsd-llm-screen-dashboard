# LSD — LLM Screen Dashboard

🌐 **Le isto noutro idioma:** [English](README.md) · [Español](README.es.md) · [中文](README.zh.md) · [Euskara](README.eu.md) · [Català](README.ca.md)

LSD é un **panel de control web local** para crear, supervisar e operar sesións de terminal que executan CLIs de axentes de IA (kimi, claude, codex, aider…). En vez de xestionar moitas xanelas de terminal, LSD centraliza todo nunha única interface web: ves o estado de cada sesión, falas por chat cun xestor impulsado por Deepseek, e podes acceder a calquera terminal de forma interactiva dende o navegador.

> Cada sesión executase dentro de **GNU Screen**, así que sobrevive a peches do navegador, a reinicios do panel e incluso a reinicios do servidor. Cando LSD volve arrancar, adopta ou restaura as sesións que aínda estean vivas.

---

## Que fai?

- **Orquestrar múltiples axentes de terminal** desde unha soa xanela web.
- **Crear sesións** cun nome, un directorio de traballo e o CLI que prefiras.
- **Monitorizar o estado en tempo real** de cada sesión: `Traballando`, `Agardando`, `Arquivada`.
- **Xestor con Deepseek**: preguntas en linguaxe natural («crea unha sesión para analizar este repo», «comproba que está a facer a sesión de seguridade», «envía `npm test` á sesión demo») e o xestor usa *function calling* para actuar.
- **Terminal interactivo no navegador**: conéctate a calquera sesión con `screen -x` a través de WebSocket, coma se estiveses nun terminal real.
- **Historial e conversación**: inspecciona o scrollback do terminal ou a conversación completa analizada a partir do `wire.jsonl` de kimi.
- **Persistencia automática**: o rexistro de sesións, os snapshots da pantalla e o contexto de kimi gárdanse para que o traballo sobreviva a fallos.

---

## Por que usalo?

| Vantaxe | Por que importa |
| --- | --- |
| **Non perderás o traballo** | As sesións executanse en GNU Screen; pecha o navegador e seguen funcionando. |
| **Recuperación ante fallos** | Ao reiniciar, LSD adopta sesións vivas e restaura as caídas con `kimi -c` / o flag `--continue` do CLI correspondente. |
| **Punto de control único** | Xestiona tantos axentes como queiras sen cambiar de lapelas do terminal. |
| **Xestor con memoria** | O chat de Deepseek coñece as túas sesións, o seu estado e a súa saída, e pode actuar por ti. |
| **Aislamento por cartafol** | Cada sesión traballa no seu propio directorio; o xestor nunca mestura proxectos accidentalmente. |
| **Multi-axente** | Soporta kimi, claude, codex, aider e calquera CLI que poidas lanzar con `exec`. |
| **Sen CDN externo** | xterm.js servese dende `node_modules`; funciona sen conexión unha vez instalado. |
| **Seguridade local** | A interface web non ten autenticación; controla a exposición con `HOST` (`127.0.0.1` por defecto) ou pon LSD detrás dun proxy autenticado. |

---

## Requisitos

- **Node.js ≥ 20**
- **GNU Screen** (non dispoñible en Windows nativo; usar WSL2)
- Polo menos un CLI de axente instalado e autenticado: `kimi`, `claude`, `codex`, `aider`…
- Unha **API key de Deepseek** para o xestor

---

## Instalación

### Ubuntu / Debian (e outras distribucións Linux)

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

`install.sh` instala as dependencias do sistema (Node 20, `screen`, ferramentas de compilación para `node-pty`), executa `npm ci`, crea `.env` de forma interactiva e ofrece crear un servizo **systemd** para o inicio automático.

### macOS

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

O script detecta macOS, instala dependencias a través de `brew` se é necesario, e guía a configuración de `.env`.

### Windows

GNU Screen non existe de forma nativa en Windows, así que LSD executase dentro de **WSL2**:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` comproba se hai WSL2, instala Ubuntu se falta, e executa `install.sh` dentro de WSL2. Unha vez en execución, a interface web é accesible dende Windows en `http://localhost:3000`.

> Alternativa manual: instala WSL2 con Ubuntu, clona o repo dentro de Ubuntu e segue os pasos de Linux.

---

## Inicio rápido

Se prefires non usar o instalador automático:

```bash
npm install
cp .env.example .env
# Edita .env e engade a túa DEEPSEEK_API_KEY
npm start
```

Abre http://localhost:3000 no teu navegador.

### Variables importantes de `.env`

```env
DEEPSEEK_API_KEY=<your-api-key>
DEEPSEEK_MODEL=deepseek-v4-flash   # ou deepseek-v4-pro
SESSION_CLI=kimi                  # CLI por defecto para novas sesións
PORT=3000
HOST=127.0.0.1                    # 0.0.0.0 = todas as interfaces (usar só con proxy autenticado)
```

---

## Uso básico

1. **Crear unha sesión**: introduce un nome e, opcionalmente, un directorio de traballo. Se o cartafol ten contido, LSD ofrece deixar que o xestor o analice.
2. **Ver o terminal**: selecciona a sesión. O panel esquerdo convértese nun terminal interactivo.
3. **Preguntar ao xestor**: escribe no chat da dereita. Pódeslle pedir que cree sesións, lea a saída ou envíe comandos.
4. **Arquivar / reabrir**: cando remates cunha sesión, arquíaa para pechar a pantalla mantendo o contexto. Reábrea cando queiras.
5. **Gardar historial**: descarga un ficheiro Markdown coa conversación completa e o último snapshot da pantalla.

---

## Características técnicas destacadas

- **Terminal web real** con `node-pty` + `xterm.js`, incluíndo soporte para teclas compostas (acentos), bloqueo de teclado a pantalla completa en Chromium e botóns para teclas reservadas como `Ctrl+S` ou `Ctrl+T`.
- **Monitor de actividade** que clasifica as sesións como `Traballando` / `Agardando` comparando hardcopies cada 3 segundos.
- **Arquivador de historial** que copia mensaxes novas do `wire.jsonl` de kimi a `data/history/<slug>.jsonl`.
- **Informe periódico do xestor** configurable a través de `REPORT_INTERVAL_MIN` que resume as sesións activas.
- **Soporte local de Ollama** como un override opcional de modelo para sesións de kimi.
- **Etiquetas con espazos**: nomes amigables para humanos na interface, slugs internos para screen e URLs.

---

## API REST (extracto)

| Método | Ruta | Descrición |
| --- | --- | --- |
| GET | `/api/sessions` | Listar sesións activas e arquivadas |
| POST | `/api/sessions` | Crear sesión `{ name, workdir?, cli?, model? }` |
| GET | `/api/sessions/:name/output` | Últimas liñas do terminal |
| GET | `/api/sessions/:name/conversation` | Conversación completa analizada |
| POST | `/api/sessions/:name/archive` | Arquivar a sesión |
| POST | `/api/sessions/:name/reopen` | Reabrir unha sesión arquivada |
| POST | `/api/chat` | Falar por chat co xestor Deepseek |
| GET / POST | `/api/config` | Ler / actualizar configuración |
| WS | `/ws?name=<sesión>` | Terminal interactivo |

---

## Seguridade

- A interface web **non ten autenticación**. Usa `HOST=127.0.0.1` para acceso só local, ou pon LSD detrás dun proxy autenticado se expoñes `0.0.0.0`.
- A API key de Deepseek gárdase en `.env` (permisos restritivos establecidos polo instalador) e nunca se devolve completa pola API (`GET /api/config` só mostra `••••1234`).

---

## Licenza

MIT
