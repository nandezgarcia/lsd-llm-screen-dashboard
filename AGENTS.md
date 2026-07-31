# LSD (LLM Screen Dashboard) — contexto del proyecto

Web local (Node 20 + Express, sin framework de frontend) para crear y supervisar
sesiones de **GNU Screen** que ejecutan CLIs de agente (**kimi**, claude, codex…),
orquestadas por un gestor que usa la **API de Deepseek** (function calling). El
usuario habla con el gestor por chat y, además, puede escribir directamente en la
sesión seleccionada (terminal interactivo en el navegador).
**La carpeta del proyecto NO se renombra** (kimi indexa sesiones por la ruta del
workdir; renombrarla dejaría el contexto huérfano — ya pasó una vez).

## Arranque

```sh
npm start          # http://localhost:3000  (requiere .env con DEEPSEEK_API_KEY)
```

**Primera ejecución sin configurar** (25/07/26): si arranca sin `.env` o sin
`DEEPSEEK_API_KEY` y hay TTY, `src/firstrun.js` pide interactivamente los dos
modelos antes de aceptar trabajo: el del GESTOR (base URL + API key + modelo,
con lista en vivo de `{baseUrl}/models` y menú numerado; si la consulta falla,
texto libre con default `deepseek-chat`) y el CLI de TERMINAL de las sesiones
(menú con los detectados; si el elegido no está instalado, muestra instrucciones
de instalación —kimi/claude/codex— y permite re-detectar con Enter, cambiar de
CLI o `continuar` guardándolo igualmente). Guarda vía `updateEnv()` + chmod 600.
Sin TTY (systemd/docker) el asistente se SALTA con aviso: nunca bloquea un
arranque no interactivo. Ctrl-C en el asistente tampoco aborta el arranque.

Despliegue nuevo: `install.sh` (Linux/macOS/WSL2: deps del sistema, npm ci, .env
interactivo, systemd opcional) e `install.ps1` (Windows: NO nativo — GNU Screen
no existe; prepara WSL2 y delega en install.sh).
La interfaz de escucha se define con `HOST` en `.env` (25/07/26): 127.0.0.1 =
solo local, 0.0.0.0 = toda la red (la web NO tiene auth; 0.0.0.0 solo tras un
proxy con auth). Se aplica al arrancar; NO es editable desde la web a propósito.

Para reiniciar el servidor: NO usar `pkill -f 'node src/server.js'` (coincide con
la línea de comandos del propio shell y se automata). Buscar el PID por puerto:
`ss -ltnp | grep ':3000'` y hacer `kill <pid>`.

## Estructura

- `src/config.js` — parser .env propio + `kimiEnv()` (variables KIMI_MODEL_* por sesión;
  para modelos Ollama asigna `KIMI_CODE_HOME=data/kimi-ollama-home` vía
  `ensureOllamaKimiHome()`, clon del config del usuario con thinking off)
  + `publicConfig()` (API key enmascarada) y `updateEnv()` (edita .env y aplica en
  caliente; solo claves conocidas, valores vacíos = sin cambios)
- `src/firstrun.js` — asistente de primera ejecución (sin .env o sin API key y
  con TTY): pide modelo del gestor (base URL + key + modelo, con lista en vivo
  de la API) y CLI de terminal (con instrucciones de instalación si falta);
  guarda con `updateEnv()`; sin TTY se salta con aviso
- `src/screen.js` — wrapper de screen: list / create / readOutput / sendInput / kill
- `src/deepseek.js` — bucle de agente con tools: list_sessions, create_session,
  read_session_output, read_session_history, send_input, kill_session (nombres sin
  prefijo; se añade `kimi-`).
  `list_sessions` devuelve `{ active, archived }`: las activas llevan `activity`
  (trabajando/esperando, del monitor) y `contextSavedAt`; las archivadas se listan
  aparte para que el gestor NO las confunda con activas-esperando.
  `read_session_history` (24/07/26) lee el archivo duradero (capa C): últimos N
  mensajes o paginado con `from` (0 = primer mensaje), textos recortados a 2000
  chars y campo `total` — es la fuente para resúmenes de largo recorrido;
  `read_session_output` solo ve las últimas líneas de pantalla (el system prompt
  se lo deja claro al gestor).
- `src/server.js` — Express: API REST + estáticos de `public/` + assets xterm en
  `/vendor/*` (servidos desde node_modules); crea el `http.Server` compartido con el WS
- `src/terminal.js` — WebSocket `/ws?name=<sesión>`: adjunta la sesión con
  `screen -U -xS` vía **node-pty** y reenvía I/O (JSON `{type:'data'|'resize'|'error'}`)
- `src/monitor.js` — clasifica cada sesión como `trabajando`/`esperando` comparando
  hardcopies cada 3 s; al pasar a `esperando` guarda siempre el snapshot en el registry
- `src/registry.js` — persistencia en `data/registry.json` (escritura atómica
  tmp+rename y DURABLE: fsync del archivo y del directorio — sin fsync, un
  apagado brusco podía perder el rename y devolver el registry a un estado
  anterior, p.ej. sin las marcas de archivado): workdir, actividad, status y
  snapshot (últimas 200 líneas) por sesión
- `src/recovery.js` — al arrancar: adopta sesiones vivas registradas (SIN tocar
  `archived`), registra vivas desconocidas (workdir vía `/proc/<pid-hijo>/cwd`),
  restaura las caídas con `kimi -c` y CIERRA screens vivos de sesiones
  archivadas (el registry manda: archivada+viva = kill; antes un upsert con
  `archived:false` destruía la marca y la sesión "resucitaba" tras el reinicio)
- `src/conversation.js` — lee la conversación real de una sesión desde su `wire.jsonl`
  (usuarios: `context.append_message`; assistant: loop events `content.part` tipo
  `text`; formato interno de kimi, si cambia el frontend cae a la pestaña Terminal)
- `workspaces/<nombre>` — workdir por defecto de cada sesión creada

## Decisiones técnicas clave (no "desarreglar")

- **Auth de las sesiones**: el gestor SIEMPRE tira de API (DEEPSEEK_API_KEY/​MODEL/​BASE_URL).
  Las sesiones kimi, en cambio, usan por defecto **la configuración propia de kimi**
  del usuario. `KIMI_MODEL_*` es un OVERRIDE opcional: solo se exporta si
  `KIMI_SESSION_MODEL` tiene valor (vacío en .env = sin override; desde la web se
  puede limpiar porque esos campos son CLEARABLE en `updateEnv`). Otros CLIs
  (claude, codex…) siempre heredan el entorno del login shell.
  **Override POR SESIÓN** (22/07/26): el form de crear tiene UN SOLO desplegable
  de agente — los CLIs instalados y, si Ollama corre, sus modelos locales
  (`ol:<modelo>`, que internamente es kimi con override de modelo). Lo elegido se
  guarda en el registry (`model`/`baseUrl` por sesión) y reopen/recovery la
  restauran con ESE modelo aunque la config global cambie. **Planos separados**:
  para sesiones solo se ofrecen CLIs y modelos LOCALES de Ollama; los modelos del
  gestor (Deepseek) NUNCA se ofrecen para sesiones — datalists separados
  (`model-list` gestor / `model-list-sessions` Ollama). El override solo aplica a
  kimi: el backend ignora `model`/`baseUrl` con otro CLI.
  **Guardia anti-sesiones-rotas**: si la base URL
  efectiva del modelo es local (localhost/127.0.0.1/::1) y no responde (Ollama
  parado), `assertSessionModelUp()` rechaza la creación/reapertura con mensaje
  accionable (también en la tool `create_session` del gestor); recovery en el
  arranque NO la aplica (restaura igualmente, mejor esfuerzo).
- **Prefijo obligatorio**: solo se gestionan sesiones screen con prefijo `kimi-`.
- **Bug hardcopy de screen**: GNU screen 4.x escribe en hardcopy el byte bajo del
  codepoint Unicode (╭→'m', ─→0x00, █→0x88). Por eso existe `decodeHardcopy()` en
  `src/screen.js` (mapea bytes a U+2500+, conserva Latin-1 para tildes/ñ, restaura
  esquinas por contexto, restaura uniones de tabla ┬┴┼┤ cuyo byte bajo es ASCII
  —',' '4' '<' '$'— por contexto de línea, y sustituye restos de emoji `<byte>+0xFF`
  por `◆ `) y las sesiones se crean con `screen -U`. No quitar.
- **send_input**: envía el texto y luego un retorno de carro real (`\r`) con
  `screen -X stuff` (kimi es un TUI; hay que leer la salida unos segundos después).
- **Terminal web interactivo**: el navegador se adjunta con `screen -x` (multi-display,
  no expulsa a otros attaches) a través de `ws` + `node-pty` + `xterm.js`. Mientras el
  WS está abierto la sesión sale `Attached`; al cerrarse se mata el pty y vuelve a
  `Detached`. El hardcopy sigue usándose solo para el gestor Deepseek y el monitor.
  **Pantalla completa (⛶) + Keyboard Lock**: en una pestaña normal, Ctrl+T/Ctrl+W/
  Ctrl+N son del navegador y NINGUNA página puede capturarlas. El botón ⛶ (junto a
  📜 Historial) pone el terminal en fullscreen y llama a `navigator.keyboard.lock()`
  — **API SOLO de Chromium**: esas teclas llegan al terminal y van a la sesión como
  en un terminal real. En Firefox no hay Keyboard Lock: el fullscreen solo da
  espacio y las reservadas siguen siendo del navegador (el ⓘ se adapta y lo dice
  claramente, no promete lo que no puede cumplir). Salida: botón flotante
  **✕ Salir** DENTRO del área fullscreen (el ⛶ del header queda fuera; con el
  bloqueo activo, Esc va a la sesión y no sirve para salir) — en Chromium también
  vale mantener Esc. Requiere gesto real del usuario (transient activation: no se
  puede automatizar con eventos sintéticos ni CDP en este entorno).
  **Ctrl+S**: el Keyboard Lock de Chromium NO lo captura (no está en su lista de
  teclas bloqueables; seguía abriendo "Guardar página"). Como Ctrl+S sí es
  interceptable por la página con preventDefault, `deadKeyHandler()` lo caza a
  nivel keydown y lo envía a la sesión como `^S` (`\x13`) — funciona con y sin
  fullscreen, en Chromium y en Firefox. Además hay una barra de **botones de
  teclas reservadas** (`#term-keys`, encima del terminal) con Ctrl+S y Ctrl+T:
  envían el byte de control equivalente (letra − 64) con `sendToSession()`, para
  las teclas que el navegador nunca suelta (Ctrl+T no es interceptable ni con
  Keyboard Lock fuera de fullscreen).
  **^S y flow control de screen (MINA, 23/07/26)**: para que `^S` llegue a la app
  desde el terminal web, la sesión debe crearse con `-fn` (flow control off) —
  ya está en `createSession()`. **NUNCA usar `screen -X flow off` en caliente**:
  en screen 4.9.1 (Ubuntu) ese comando por socket hace SIGABRT al PROCESO
  SERVIDOR de la sesión si está Detached y corre un TUI en raw mode (reproducido;
  mató 3 sesiones reales de golpe — /var/crash/_usr_bin_screen.*.crash). Con la
  sesión Attached o corriendo una shell no se reproduce, pero no arriesgarlo.
  Ojo al diagnosticar: `screen -X stuff` inyecta directo en la ventana y NO pasa
  por el camino del display (donde actúa el flow control) — un `stuff` de ^S que
  funciona NO prueba que el terminal web lo entregue. Sesiones creadas antes del
  23/07 no tienen `-fn` (Ctrl+S no les llega hasta que se reabran).
  **Refit**: `scheduleRefits()` reajusta el terminal en pasadas escalonadas
  (0/50/300/1000 ms, rearmadas en cada evento = debounce en arrastre) y se llama
  ante CUALQUIER cambio de contexto visual: resize de ventana, fullscreenchange,
  visibilitychange→visible y focus. Además fuerza `term.clearTextureAtlas()`:
  al mover la ventana entre monitores con distinto DPI, xterm re-mide los
  glifos (sin esto el terminal volvía borroso/roto hasta F5 — un solo fit()
  medía mal porque el layout tarda en estabilizarse).
- **Scroll ≠ flechas en kimi**: en el TUI de kimi `↑`/`↓` navegan el historial del
  cuadro de entrada, NO hacen scroll (doc oficial). Por eso se eliminó el hack
  rueda→flechas (rellenaba el input con prompts viejos) y se sustituyó por la vista
  Historial: `screen -X hardcopy -h` vuelca el scrollback completo y la rueda ↑ sobre
  el terminal abre ese overlay a pantalla completa (se probó panel dividido y al
  usuario no le gustó). La cabecera indica que es solo lectura y se sale con
  Volver/Esc. No reintroducir el envío de flechas.
  El WS del terminal se reconecta solo (5 intentos, 2 s) si cae por segundo plano
  o suspensión; al volver el foco (`visibilitychange`/`focus`) se refrescan las
  sesiones y se reconecta si hace falta; re-clicar la sesión seleccionada con el
  socket caído fuerza la reconexión.
- **Persistencia del contexto**: kimi guarda cada sesión en
  `~/.kimi-code/sessions/<wd_key>/<sessionId>/agents/main/wire.jsonl` y `kimi -c`
  reanuda la última sesión de un workdir. El registry del dashboard (`data/`) guarda
  metadatos + snapshot; la restauración es recrear el screen con `kimi -c`.
- **Historial duradero (23/07/26, dos capas)**: antes el historial estaba acotado
  (hardcopy -h = scrollback volátil de ~1024 líneas que muere con el screen, y la
  conversación se parseaba en caliente sin copia propia).
  - *Capa C — archivador* (`src/history.js`): en cada tick del monitor,
    `archiveTick()` copia los mensajes NUEVOS del wire.jsonl de cada sesión del
    registry (activas y archivadas) a `data/history/<slug>.jsonl` append-only
    (`{ts, role, text}`; el wire no tiene timestamps: ts = momento de archivado).
    Avanza por offset de bytes (persistido en `data/history/.offsets.json`,
    tmp+rename sin fsync — reconstruible); línea parcial al final = retrocede al
    último \n. Si el wire MENGUA (kimi lo compactó/recreó): re-escaneo con dedup
    por solape (best-effort, NO probado en vivo; sin solape añade todo + warning).
    Límite: turnos assistant partidos entre dos pasadas salen como dos mensajes
    contiguos. El parser del wire (`parseWire`) vive en conversation.js y lo
    comparten vista en caliente y archivador. El endpoint `/conversation` prefiere
    el archivo (mensajes con ts) y cae al parseo en caliente si no hay archivo;
    el frontend muestra la fecha en el separador `✂ tu consulta — dd/mm/aaaa HH:MM`.
  - *Capa B — caja negra*: `createSession()` lanza el screen con
    `-L -Logfile data/logs/<slug>.log` (cubre reopen/recovery). Log crudo ANSI
    continuo, SOLO forense (un TUI repinta y el crudo es ilegible): NO se integra
    en la UI. Screen lo vuelca cada ~10 s (un log recién escrito puede parecer
    vacío unos segundos). Sesiones creadas antes de esta fecha no tienen log.
- **Semántica del registry (ciclo de vida)**: una sesión que desaparece con el
  servidor corriendo se ARCHIVA (`archived: true`) — cerrada a propósito pero
  reabrible (`POST /:name/reopen` recrea el screen con resume). Solo el endpoint
  `DELETE` la borra del registry (con `?deleteWorkdir=1` borra la carpeta si está
  dentro de `workspaces/`). Si el servidor muere a la vez (luz), la entrada queda
  sin archivar y recovery.js la restaura; las archivadas NO se restauran.
  `killSession` en screen.js ya NO toca el registry (primitiva pura de proceso).
  Endurecido (22/07/26, bug "archivadas que vuelven activas" tras apagado brusco):
  el registry es la fuente de verdad y la marca `archived` es intocable salvo por
  archivar/reabrir — archivar marca PRIMERO y mata después (si el kill falla,
  recovery cierra el screen zombi en el próximo arranque); reabrir levanta la
  marca primero y crea después (si falla, la repone); recovery nunca escribe
  `archived:false` al adoptar; el monitor se para al recibir SIGINT/SIGTERM para
  no archivar activas durante un apagado limpio. Verificado con simulacro:
  archivada no resucita, activa se restaura, zombi archivada se cierra.
- **send_input**: pausa de 400 ms entre el texto y el `\r` — sin ella el Enter
  podía llegar antes de que el TUI procesara el pegado y el comando no se ejecutaba.
- **Falso "Trabajando"**: attach/detach del terminal web redibuja (y redimensiona) el
  terminal de la sesión, lo que el monitor vería como actividad. Por eso `terminal.js`
  avisa con `noteAttach()` y el monitor ignora cambios durante 5 s (solo actualiza el
  baseline). Efecto aceptado: teclear justo tras cambiar de sesión no marca
  "Trabajando" hasta pasada la gracia. No quitar sin alternativa.
- **contextSavedAt**: al pasar a `esperando`, el monitor guarda el mtime del
  `wire.jsonl` de kimi (vía `session_index.jsonl` por workDir) — es la marca honesta
  de cuándo persistió kimi el contexto; se muestra como badge 💾 en la lista.
- **Separador de turnos en el historial** (22/07/26): en la vista Terminal del
  overlay, `markTurns()` inserta `──── ✂ tu consulta ────` antes de cada burbuja
  del usuario (líneas `◆  texto`, el ✨ del TUI vía decodeHardcopy) salvo la
  primera = donde acabó la respuesta anterior y empezó tu siguiente consulta.
  En la vista Conversación, un `.turn-sep` con el mismo texto antes de cada
  mensaje user. En la TUI EN VIVO no se puede inyectar nada (kimi se dibuja a
  sí misma; los hooks de kimi —evento `Stop`— escriben al contexto, no a
  pantalla; comprobado en la doc oficial).
- **Bloques blancos invisibles (burbuja del usuario, vallas de código)**: la TUI de
  kimi pinta esos bloques con bg blanco (SGR 47/107/48;5;7/15/truecolor) y texto con
  el fg POR DEFECTO — blanco en xterm.js → blanco sobre blanco, invisible hasta
  seleccionarlo con el ratón. `fixLightBlocks()` (`app.js`) remapea fondos casi
  blancos (incl. truecolor ≥245 y secuencias SGR compuestas, con carry si el chunk
  WS corta una secuencia) a gris oscuro (palette 236) en el flujo entrante. No
  toca fg, ni el vídeo inverso (SGR 7), ni los fondos oscuros. Verificado a nivel
  de buffer xterm (p15→p236) y con captura.
- **Teclas muertas (tildes)**: el frontend compone a nivel **keydown** con
  `preventDefault` en `deadKeyHandler()` (`app.js`, vía `attachCustomKeyEventHandler`),
  ANTES de que xterm.js o el navegador toquen la tecla: ´/¨ quedan pendientes y se
  componen con la siguiente vocal (´+o→ó, ¨+u→ü) o se sueltan si no es componible
  (´+m→´m). key `Dead` no dice qué acento es: en teclado ES, ´ sin Shift y ¨ con
  Shift. Solo ´ y ¨ (` ~ ^ no se tocan: son caracteres normales de terminal).
  El enfoque anterior (componer en el flujo de datos con `fixDeadKeys()`) perdía
  vocales cuando el navegador tragaba la composición ("Cómo" llegaba "C´mo").
- **Directorio con contenido**: `POST /api/sessions` devuelve `hasContent`; si es
  true, el frontend ofrece (modal propio, no `confirm()`) que el gestor analice el
  proyecto vía chat para dar contexto a la sesión. El explorador 📁 usa
  `GET /api/browse` (solo home).
- **Regla de workdir**: el contenedor `workspaces/` NUNCA es workdir de una sesión
  (guardia en `server.js` y en la tool `create_session` del gestor): sin carpeta
  válida, la sesión recibe su propia `workspaces/<nombre>` vacía. Cada sesión debe
  controlar solo su carpeta; el aislamiento real lo da el sistema de permisos del
  CLI de cada agente (claude/kimi preguntan al salir del workdir), no el dashboard.
- **Sesión activa en el gestor**: el frontend manda `activeSession` (la sesión
  adjuntada) en `POST /api/chat` y `deepseek.js` la añade al system prompt: si el
  usuario habla de "la sesión" sin nombrarla, el gestor entiende que es esa.
- **Modelos sugeridos**: `GET /api/models` lista los modelos de la API de Deepseek
  y los de Ollama local SOLO si corre (`localhost:11434`). El datalist del GESTOR
  usa los de Deepseek; el del override de SESIONES solo los de Ollama (planos
  separados). El frontend los reconsulta cada 30 s y al volver el foco (arrancar/
  parar Ollama se refleja solo), y muestra un aviso ⚠ en Configuración si el
  override guardado apunta a un Ollama parado.
- **Botón "🌙 Hasta mañana"** (22/07/26): botón ROJO en la cabecera (arriba a la
  derecha). Al pulsarlo: si alguna sesión está `trabajando` (estado cacheado del
  último refresh), primero avisa con modal ("espera o perderás lo que se está
  haciendo": Guardar de todos modos / Esperar). Luego llama a
  `POST /api/sessions/save-all`, que ejecuta `persistNow()` (monitor.js) por
  sesión viva: refresca el snapshot (hardcopy) y el `contextSavedAt` en el
  registry — el contexto de kimi ya lo escribe él solo continuamente, esto sella
  lo demás. Resumen modal por sesión con hora del contexto (askConfirm admite
  `no: null` = sin botón cancelar).
- **Informe periódico del gestor** (22/07/26): `REPORT_INTERVAL_MIN` (minutos,
  0 = off; campo "Informe de sesiones cada N min" en Configuración, editable y
  hot-apply vía `scheduleReporter()`). El servidor corre `runManagerChat` con un
  prompt automático (list_sessions + read_session_output de cada activa, SIN
  send_input) y guarda los últimos 20 informes EN MEMORIA en `GET /api/reports`
  (`?after=<ts>` incremental). El frontend los sondea cada 20 s y los muestra en
  el chat con prefijo "⏱ *Informe periódico — dd/mm/aaaa, HH:MM*" (primera
  carga: solo el último, no vuelca el histórico); además los añade a
  `chatHistory` para que el gestor los tenga en contexto.
- **CLI de las sesiones (`SESSION_CLI`)**: las sesiones se lanzan con
  `exec <cli>` (kimi por defecto; claude y otros heredan el entorno del login
  shell, solo kimi recibe `KIMI_MODEL_*`). Detección: `GET /api/agents`
  (determinista, `command -v`) y, como fallback, el gestor tiene la tool
  `discover_agents` (el LLM decide los candidatos). El registry guarda el `cli`
  por sesión y recovery restaura con su flag (`kimi -c`, `claude --continue`).
  El desplegable está junto a "Modelo de las sesiones" en Configuración, y el
  formulario de crear tiene otro sincronizado (`POST /api/sessions` acepta `cli`,
  validado, con caída al configurado si no vale).

## Estado al guardar este archivo

- **Renombrado a LSD (LLM Screen Dashboard)**: logo `public/logo.svg`, header,
  título, package.json (`lsd-llm-screen-dashboard`), log de arranque. La CARPETA
  del proyecto sigue siendo `llm-screen-dashboard` a propósito (kimi indexa por
  ruta; no renombrarla nunca).
- **Ciclo de vida verificado end-to-end**: crear ("ciclo vida" → slug `ciclo-vida`)
  → archivar → aparece en Archivadas → reabrir (kimi reanudó con `-c`) → eliminar
  con `deleteWorkdir=1` (carpeta borrada, registro limpio). Guardar historial (⬇)
  descarga `<slug>-historial.md` con conversación (wire.jsonl) + snapshot del registry.
- **send_input con pausa**: verificado que el comando se ejecuta (ENTER_OK_42).
- **Historial**: pestaña recordada en localStorage (`hist-mode`); secciones
  Activas/Archivadas plegables (`ls-active`/`ls-archived`).
- **Sesiones vivas**: seguridad-en-in2ai, audioyou, Prueba, prueba_2 (adoptadas).
- **Estado 22/07/26 (cierre del día)** — jornada larga de trabajo, todo verificado:
  - *Ciclo de vida*: registry con fsync; recovery nunca levanta `archived` (cierra
    zombis archivadas); monitor parado en SIGINT/SIGTERM. Bug "archivadas que
    vuelven activas" resuelto y probado con simulacros.
  - *Modelos*: selector ÚNICO de agente al crear (CLIs + modelos Ollama si corre);
    override por sesión guardado en registry (model/baseUrl), respetado por
    reopen/recovery; guardia anti-sesiones-rotas si la URL local no responde;
    datalists separados gestor(Deepseek)/sesiones(Ollama); aviso ⚠ Ollama parado.
  - *Ollama/thinking*: sesiones Ollama con `KIMI_CODE_HOME=data/kimi-ollama-home`
    (config clonada con thinking off) — determinista, sin 400.
  - *Terminal*: tildes por keydown (`deadKeyHandler`); ⛶ fullscreen + Keyboard
    Lock (Chromium; ⓘ honesto en Firefox) con botón ✕ Salir; fixLightBlocks
    (burbujas/código legibles); separador ✂ tu consulta en historial.
  - *Gestor*: list_sessions {active, archived} con activity; informe periódico
    configurable (REPORT_INTERVAL_MIN=**60** min ahora mismo) con fecha/hora;
    botón rojo 🌙 Hasta mañana (avisa si alguna está Trabajando).
  - *Config actual*: sessionCli=kimi, override de modelo vacío, Ollama PARADO.
  - *Sesiones al cerrar el día*: activas Dunlins.eu, Tesis, Seguridad en IN2AI,
    audioyou (todas esperando); archivadas prueba_2, Prueba, Poner KIMI en
    servidor, Element en Ubuntu.
  - *Pendiente*: `callDeepseek` sin
    timeout; re-test real de Ctrl+T en fullscreen (no automatizable).
- **Corrección de datos kimi (21/07/26)**: sesiones creadas con el proyecto llamado
  `kimi-screen-gestor` migradas a la ruta nueva en `~/.kimi-code/session_index.jsonl`
  (kimi indexa por `wd_<slug>_<sha256(workDir)[:12]>`). Backup:
  `~/.kimi-code/session_index.jsonl.bak-path-fix`. Verificado con simulacro de corte.
- **Terminal interactivo**: attach real por `/ws` (node-pty + xterm.js), reconexión
  automática (5×2 s) y refresco/reconexión al volver el foco; historial overlay con
  pestañas Terminal (scrollback, por defecto) y Conversación (markdown desde
  wire.jsonl), botón ↻, cierre con Volver/Esc/clic/teclear.
- **Tildes**: composición propia a nivel keydown en `deadKeyHandler()` (ver la
  decisión técnica "Teclas muertas"; el antiguo `fixDeadKeys()` de flujo de
  datos fue reemplazado el 22/07/26).
- **Estados**: badges Trabajando / Esperando respuesta usuario + 💾 contextSavedAt
  (mtime del wire.jsonl); ventana de gracia 5 s tras attach/detach del dashboard.
- **Layout (23/07/26)**: panel izquierdo = SOLO el terminal activo (`#terminal-panel`,
  con la barra `#term-keys` y el header de acciones); columna derecha = panel
  Sesiones (`#sessions-panel`: form de crear + listas activas/archivadas) arriba y
  chat del gestor abajo; grid 3fr/2fr a favor del terminal. La **configuración vive
  en un modal** (`#config-modal`, mismo patrón que dir/analyze/confirm) que se abre
  con el botón ⚙ de la cabecera (`#config-btn`; cierra con ✕ o clic fuera) — ya no
  hay panel de configuración permanente. Los ids del form de config no cambiaron,
  solo se movió el bloque al modal.
- **i18n (24/07/26)**: UI multi-idioma con selector en la cabecera (`#lang-select`,
  es/en/zh/eu/ca/gl; default es; localStorage `lsd-lang`). `public/i18n.js` (se carga
  antes de app.js): diccionarios `I18N` (124 claves simétricas por idioma, es como
  caída), `t(key, {vars})`, `applyI18n()` (atributos `data-i18n`=textContent,
  `data-i18n-ph`=placeholder, `data-i18n-title`=title, `data-i18n-html`=innerHTML
  para las ayudas con <strong>/<br>) y `setLang()`. El HTML mantiene el español como
  contenido por defecto (degrada bien sin JS). Las cadenas dinámicas de app.js usan
  `t()` (~66 claves); lo que NO se traduce a propósito: contenido del servidor
  (snapshots, err.message, informes), nombres de sesión, prompts al LLM gestor y
  formatos de fecha (siguen en es-ES). Al añadir texto a la UI: clave nueva en los
  6 diccionarios + atributo/t() — verificar simetría antes de dar por hecho.
- **Configuración (contenido)**: fieldsets Gestor/Sesiones; Base URL y API key del
  gestor colapsadas en "⚙ Avanzado"; ayuda larga tras icono ⓘ; URLs con valor
  efectivo; override de modelo de sesiones OPCIONAL (vacío = config propia de kimi,
  campos CLEARABLE en updateEnv; el usuario ya lo dejó vacío: sus sesiones usan la
  auth propia de kimi). Base URL de sesiones se deshabilita sin modelo.
- **Agentes multi-CLI**: `SESSION_CLI` (kimi/claude/codex, detectados los 3 instalados);
  select en config junto al modelo de sesiones + select en el form de crear (cae al
  configurado). Detección: `GET /api/agents` determinista **y también al arrancar**
  (se expone como `installedAgents` en `/api/config`, los desplegables siempre vienen
  poblados tras reinicio); fallback LLM con la tool `discover_agents`. Recovery
  restaura con flag por CLI (`kimi -c`, `claude --continue`).
- **Etiquetas con espacios**: los nombres de sesión admiten espacios/tildes; el id
  interno es un slug (`slugify` + `uniqueSlug` con dedup `-N` en `screen.js`) usado
  para screen/workdir/URLs, y la etiqueta se guarda en el registry (`label`) y se
  muestra en la lista. El gestor acepta espacios al crear y usa el slug para operar.
- **Gestor**: recibe `activeSession` (sesión adjuntada) en el system prompt — entiende
  "la sesión" sin nombre. Tool calls plegables; respuestas con mini-markdown propio.
- **Workdir**: el contenedor `workspaces/` nunca es workdir (guardia en API y tool);
  sin carpeta → `workspaces/<nombre>` vacía; con contenido → modal propio ofrece
  análisis del gestor. Explorador 📁 + autocompletado (`/api/browse`, solo home).
- **Ojo (25/07/26)**: el endpoint de Deepseek del usuario RECHAZA `deepseek-chat`
  (400: solo acepta `deepseek-v4-pro` o `deepseek-v4-flash`; antes lo toleraba).
  `DEEPSEEK_MODEL=deepseek-v4-flash` ya aplicado en local y en farnsworth vía
  POST /api/config (hot-apply). Verificado: el gestor responde.
- **farnsworth (25/07/26)**: el servidor 10.13.0.1 renombrado de `ubuntu` a
  `farnsworth` (hostnamectl + /etc/hosts).
- **Ollama** (probado 22/07/26): instalado (0.12.6) con modelos gpt-oss, llama3.1:8b,
  minimax-m2:cloud y mistral (4.4 GB, el más pequeño). Funciona como override de
  sesiones vía `localhost:11434/v1`. Ollama rechaza thinking
  (`400 does not support thinking`) y NO hay env/flag para desactivarlo
  (`KIMI_MODEL_CAPABILITIES` solo añade capacidades, documentado: "unioned, never
  removed"): la única palanca es `[thinking] enabled = false` en config.toml.
  Solución (sustituye al antiguo autoDisableThinkingForOllama, que conducía el
  menú /model a ciegas y perdía la carrera con el usuario): las sesiones Ollama
  arrancan con **KIMI_CODE_HOME propio** (`data/kimi-ollama-home`, compartido):
  `ensureOllamaKimiHome()` genera un config.toml clonado del del usuario con
  thinking off (0600, data/ está en .gitignore), enlaza skills/tui.toml/etc. y
  siembra las marcas de migración (sin ellas kimi abre el asistente interactivo
  de migración y bloquea el arranque). `kimiHomeFor(baseUrl)` localiza el home
  en monitor (💾) y conversación. Verificado: mensaje inmediato → respuesta en
  8 s sin 400; `kimi -c` reanuda por el índice del home. Sesiones Ollama LEGADO
  (creadas en el home por defecto): migrar su sessionDir + línea de índice al
  home Ollama (hecho con prueba4 el 22/07). El usuario NO mantiene Ollama
  levantado por defecto; override global vacío (para usar: `ollama serve` y
  elegir el modelo en el desplegable de crear — aparece solo si corre).
- Dependencias: express, ws, node-pty (nativa), @xterm/xterm, @xterm/addon-fit
  (assets en `/vendor/*`, sin CDN). Sin tests automatizados (verificación manual
  node/curl). Sin git.
- **Instaladores (25/07/26)**: `install.sh` (Linux/macOS/WSL2) e `install.ps1`
  (Windows vía WSL2) — ver sección Arranque. Bind configurable con `HOST` en
  `.env` (cierra el pendiente del bind a 127.0.0.1; el `.env` de ESTA máquina
  no tiene HOST, así que aquí sigue escuchando en 0.0.0.0 hasta definirlo).
- **Despliegue en servidor (25/07/26)**: instancia en `andres@10.13.0.1:~/llm-screen-dashboard`
  vía install.sh, servicio systemd `lsd.service`, `HOST=10.13.0.1` (solo VPN
  10.13.0.0/24; ufw regla 6 ya la permite entera, no hubo que añadir nada).
  URL: http://10.13.0.1:3000. OJO: el `.env` local no termina en `\n` — al
  añadir líneas con `>>` se concatenan (ya pasó con HOST). kimi (0.29.0) está en
  `~/.kimi-code/bin` del usuario andres: el PATH se exportaba en `.bashrc` tras
  la guardia de interactividad, invisible para `bash -lc` (sesiones y detección
  de agentes) — resuelto exportándolo también en `~/.profile` (25/07/26).
  Verificado end-to-end: sesión creada, kimi arrancó, borrada limpia.
