# LSD — LLM Screen Dashboard

🌐 **Llegeix-ho en un altre idioma:** [English](README.md) · [Español](README.es.md) · [中文](README.zh.md) · [Euskara](README.eu.md) · [Galego](README.gl.md)

LSD és un **panell web local** per crear, supervisar i operar sessions de terminal que executen CLIs d'agents d'IA (kimi, claude, codex, aider…). En lloc de fer malabarismes amb moltes finestres de terminal, LSD centralitza tot en una única interfície web: veus l'estat de cada sessió, xatejes amb un gestor impulsat per Deepseek i pots entrar a qualsevol terminal interactiu des del navegador.

> Cada sessió s'executa dins de **GNU Screen**, així que sobreviu al tancament del navegador, als reinicis del panell i fins i tot als reinicis del servidor. Quan LSD torna a arrencar, adopta o restaura qualsevol sessió que encara estigui viva.

---

## Què fa?

- **Orquestra múltiples agents de terminal** des d'una sola finestra web.
- **Crea sessions** amb un nom, un directori de treball i la CLI que prefereixis.
- **Monitoritza l'estat en temps real** de cada sessió: `Working`, `Waiting`, `Archived`.
- **Gestor Deepseek**: pregunta en llenguatge natural («crea una sessió per analitzar aquest repositori», «mira què està fent la sessió de seguretat», «envia `npm test` a la sessió demo») i el gestor utilitza *function calling* per actuar.
- **Terminal interactiu al navegador**: connecta't a qualsevol sessió amb `screen -x` via WebSocket, com una terminal real.
- **Historial i conversa**: inspecciona l'scrollback de la terminal o la conversa completa analitzada des del `wire.jsonl` de kimi.
- **Persistència automàtica**: el registre de sessions, les instantànies de pantalla i el context de kimi es guarden perquè la feina sobreviveixi a les caigudes.

---

## Per què fer-lo servir?

| Avantatge | Per què importa |
| --- | --- |
| **No perdràs la feina** | Les sessions s'executen a GNU Screen; tanca el navegador i segueixen corrent. |
| **Recuperació de caigudes** | En reiniciar, LSD adopta les sessions vives i reprèn les caigudes amb `kimi -c` / el flag de continuació de la CLI. |
| **Punt de control únic** | Gestiona tants agents com vulguis sense canviar de pestanya de terminal. |
| **Gestor amb memòria** | El xat de Deepseek coneix les teves sessions, el seu estat i la seva sortida, i pot actuar per tu. |
| **Aïllament de carpetes** | Cada sessió treballa al seu propi directori; el gestor mai barreja projectes per error. |
| **Multi-agent** | Suporta kimi, claude, codex, aider i qualsevol CLI que puguis llançar amb `exec`. |
| **Sense CDN extern** | xterm.js es serveix des de `node_modules`; funciona sense connexió un cop instal·lat. |
| **Seguretat local** | La interfície web no té autenticació; controla l'exposició amb `HOST` (`127.0.0.1` per defecte) o posa-la darrere d'un proxy autenticat. |

---

## Requisits

- **Node.js ≥ 20**
- **GNU Screen** (no disponible a Windows natiu; utilitza WSL2)
- Almenys una CLI d'agent instal·lada i autenticada: `kimi`, `claude`, `codex`, `aider`…
- Una **Deepseek API key** per al gestor

---

## Instal·lació

### Ubuntu / Debian (i altres distribucions Linux)

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

`install.sh` instal·la les dependències del sistema (Node 20, `screen`, eines de compilació per a `node-pty`), executa `npm ci`, crea `.env` de forma interactiva i, opcionalment, crea un servei **systemd** per a l'arrencada automàtica.

### macOS

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

L'script detecta macOS, instal·la les dependències via `brew` si cal, i guia la configuració de `.env`.

### Windows

GNU Screen no existeix nativament a Windows, així que LSD s'executa dins de **WSL2**:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` comprova WSL2, instal·la Ubuntu si falta, i executa `install.sh` dins de WSL2. Un cop en marxa, la interfície web és accessible des de Windows a `http://localhost:3000`.

> Alternativa manual: instal·la WSL2 amb Ubuntu, clona el repositori dins d'Ubuntu i segueix els passos de Linux.

---

## Inici ràpid

Si prefereixes no fer servir l'instal·lador automàtic:

```bash
npm install
cp .env.example .env
# Edita .env i afegeix la teva DEEPSEEK_API_KEY
npm start
```

Obre http://localhost:3000 al navegador.

### Variables importants de `.env`

```env
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=deepseek-v4-flash   # o deepseek-v4-pro
SESSION_CLI=kimi                   # CLI per defecte per a sessions noves
PORT=3000
HOST=127.0.0.1                     # 0.0.0.0 = totes les interfícies (només amb proxy autenticat)
```

---

## Ús bàsic

1. **Crea una sessió**: introdueix un nom i, opcionalment, un directori de treball. Si la carpeta té contingut, LSD ofereix deixar que el gestor l'analitzi.
2. **Visualitza la terminal**: selecciona la sessió. El panell esquerre es converteix en una terminal interactiva.
3. **Pregunta al gestor**: escriu al xat del costat dret. Pots demanar-li que creï sessions, llegeixi sortida o enviï comandaments.
4. **Arxiva / reobre**: quan acabis amb una sessió, arxiva-la per tancar la pantalla mentre conserva el context. Reobre-la quan vulguis.
5. **Desa l'historial**: descarrega un fitxer Markdown amb la conversa completa i l'última instantània de pantalla.

---

## Característiques tècniques destacades

- **Terminal web real** amb `node-pty` + `xterm.js`, incloent suport per a tecles compostes (accents), bloqueig de teclat a pantalla completa a Chromium i botons per a tecles reservades com `Ctrl+S` o `Ctrl+T`.
- **Monitor d'activitat** classifica les sessions com `Working` / `Waiting` comparant hardcopies cada 3 segons.
- **Arxivador d'historial** copia els missatges nous del `wire.jsonl` de kimi a `data/history/<slug>.jsonl`.
- **Informe periòdic del gestor** configurable via `REPORT_INTERVAL_MIN` que resumeix les sessions actives (també s'envia a Matrix si el bot està actiu — vegeu més avall).
- **Bot de Matrix (opcional)**: parla amb el mateix gestor des del mòbil — vegeu la secció [Bot de Matrix](#bot-de-matrix-opcional).
- **Suport local d'Ollama** com a override opcional de model per a sessions de kimi.
- **Etiquetes amb espais**: noms amigables per a humans a la interfície, slugs interns per a screen i URLs.

---

## Bot de Matrix (opcional)

Pots parlar amb el mateix gestor de Deepseek des del mòbil a través de [Matrix](https://matrix.org) (Element i altres clients). El bot viu a `src/matrix.js`, només respon a usuaris autoritzats i necessita una sala **sense xifrar** (no suporta E2EE).

La recepta fa servir **matrix.org**, el servidor públic i gratuït — però qualsevol homeserver Matrix serveix, incloent-hi **un de propi** (p. ex. un Synapse autoallotjat): només cal apuntar `MATRIX_HOMESERVER` cap a ell. Amb un servidor propi el registre sol estar tancat, així que el compte del bot es crea al mateix servidor (a Synapse: `register_new_matrix_user -c /etc/matrix-synapse/homeserver.yaml`).

1. **Crea un compte per al bot** a matrix.org (a Element: tanca la sessió i registra un compte nou, p. ex. `@my-lsd-bot:matrix.org`).
2. **Obtén el seu access token**:
   ```bash
   curl -X POST https://matrix.org/_matrix/client/v3/login \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"my-lsd-bot"},"password":"<contrasenya-del-bot>"}'
   ```
   (A Element també hi és a *Configuració → Ajuda i quant a → Token d'accés*.)
3. **Configura el `.env`** i reinicia LSD:
   ```
   MATRIX_HOMESERVER=https://matrix.org
   MATRIX_USER=@my-lsd-bot:matrix.org
   MATRIX_ACCESS_TOKEN=<token del pas 2>
   MATRIX_ALLOWED_USERS=@your-user:matrix.org
   ```
   Sense aquestes variables el bot simplement no s'engega. El log d'engegada mostra `Matrix: bot conectado como …` en connectar.
4. **Crea una sala sense xifrar** a Element (*configuració avançada → desactivar el xifratge* en crear-la) i convida el bot escrivint el seu MXID complet (`@my-lsd-bot:matrix.org`) — els comptes nous no apareixen al cercador d'usuaris. El bot accepta automàticament invitacions només d'usuaris autoritzats.

Notes:

- `MATRIX_ALLOWED_USERS` és una llista blanca de MXIDs separats per comes. El bot **ignora en silenci qualsevol altre usuari** — mantén-la curta: el gestor pot crear i tancar sessions.
- Els DMs de Matrix es xifren per defecte i el bot no pot llegir sales xifrades; fes servir una sala dedicada sense xifrar. A matrix.org això vol dir que l'operador del servidor podria veure el contingut — amb un servidor propi es queda a les teves mans (el transport va xifrat amb TLS en ambdós casos).
- L'informe periòdic del gestor (`REPORT_INTERVAL_MIN`) també s'envia a les sales del bot.

---

## REST API (extracte)

| Mètode | Ruta | Descripció |
| --- | --- | --- |
| GET | `/api/sessions` | Llista les sessions actives i arxivades |
| POST | `/api/sessions` | Crea una sessió `{ name, workdir?, cli?, model? }` |
| GET | `/api/sessions/:name/output` | Últimes línies de la terminal |
| GET | `/api/sessions/:name/conversation` | Conversa completa analitzada |
| POST | `/api/sessions/:name/archive` | Arxiva la sessió |
| POST | `/api/sessions/:name/reopen` | Reobre una sessió arxivada |
| POST | `/api/chat` | Xat amb el gestor Deepseek |
| GET / POST | `/api/config` | Llegir / actualitzar la configuració |
| WS | `/ws?name=<session>` | Terminal interactiu |

---

## Seguretat

- La interfície web **no té autenticació**. Utilitza `HOST=127.0.0.1` per a accés només local, o posa LSD darrere d'un proxy autenticat si exposes `0.0.0.0`.
- La Deepseek API key s'emmagatzema a `.env` (permisos restringits establerts per l'instal·lador) i mai es retorna completa per l'API (`GET /api/config` només mostra `••••1234`).

---

## Llicència

MIT
