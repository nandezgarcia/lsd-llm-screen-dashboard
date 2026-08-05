# LSD — LLM Screen Dashboard

🌐 **Irakurri beste hizkuntza batean:** [English](README.md) · [Español](README.es.md) · [中文](README.zh.md) · [Català](README.ca.md) · [Galego](README.gl.md)

LSD **web-mahaigain lokal** bat da, terminal-saioak sortzeko, gainbegiratzeko eta erabiltzeko, AI agenteen CLIak exekutatzen dituztenak (kimi, claude, codex, aider…). Terminal-leiho asko kudeatu beharrean, LSD guztia interfaze web bakarrean biltzen du: saio bakoitzaren egoera ikusten duzu, Deepseek-ek bultzatutako kudeatzaile batekin txateatzen duzu, eta edozein terminalera nabigatzailetik modu interaktiboan sartu zaitezke.

> Saio bakoitza **GNU Screen** barruan exekutatzen da, beraz, nabigatzailea ixteak, mahaigainaren berrabiarazteak eta zerbitzariaren berrabiarazteak ere bizirik irauten ditu. LSD berriro abiarazten denean, bizirik dauden saioak adopio edo berrabiarazten ditu.

---

## Zer egiten du?

- **Orkestratu terminal-agente anitzak** web-leiho bakar batetik.
- **Sortu saioak** izen, lanerako direktorio eta CLI hobetsiarekin.
- **Gainbegiratu saio bakoitzaren egoera** denbora errealean: `Working`, `Waiting`, `Archived`.
- **Deepseek kudeatzailea**: eskatu hizkuntza naturalean ("sortu saio bat repositorio hau aztertzeko", "ikusi zer ari den seguritate-saioa egiten", "bidali `npm test` demo-saioari") eta kudeatzaileak *function calling* erabiltzen du ekintzetarako.
- **Nabigatzaileko terminal interaktiboa**: atxikitu edozein saiotara `screen -x` erabiliz WebSocket bidez, terminal erreal baten moduan.
- **Historiala eta elkarrizketa**: ikusi terminalaren scrollback-a edo kimi-ren `wire.jsonl`-tik parseatutako elkarrizketa osoa.
- **Iraunkortasun automatikoa**: saioen erregistroa, pantailaren snapshot-ak eta kimi-ren kontextua gordetzen dira, lanak kraskadurak bizirik iraun dezan.

---

## Zergatik erabili?

| Abantaila | Zergatik garrantzitsua |
| --- | --- |
| **Ez duzu lanik galduko** | Saioak GNU Screen-en exekutatzen dira; itxi nabigatzailea eta exekutatzen jarraituko dute. |
| **Kraskaduraren berreskurapena** | Berrabiaraztean, LSD saio bizidunak adopio eta kraskatutakoak `kimi -c` / CLI-aren berrabiarazte-flag-arekin berrabiarazten ditu. |
| **Kontrol-puntu bakarra** | Kudeatu nahi dituzun agente guztiak terminal-fitxak aldatu gabe. |
| **Memoria duen kudeatzailea** | Deepseek txatak zure saioak, haien egoera eta irteera ezagutzen ditu, eta zuretzat jardun dezake. |
| **Direktorio-isolamendua** | Saio bakoitza bere direktorioan lan egiten du; kudeatzaileak ez ditu inoiz proiektuak nahasten. |
| **Agente anitza** | kimi, claude, codex, aider eta `exec`-rekin abiarazi dezakezun edozein CLI onartzen ditu. |
| **Kanpo CDN-rik gabe** | xterm.js `node_modules`-etik zerbitzatzen da; instalatuta dagoenean lineaz kanpo funtzionatzen du. |
| **Segurtasun lokala** | Web UI-ak autentikaziorik ez du; kontrolatu esposizioa `HOST`-ekin (lehenespenez `127.0.0.1`) edo jarri autentikatutako proxy baten atzean. |

---

## Eskakizunak

- **Node.js ≥ 20**
- **GNU Screen** (ez dago Windows natiboan erabilgarri; erabili WSL2)
- Gutxienez CLI agente bat instalatuta eta autentikatuta: `kimi`, `claude`, `codex`, `aider`…
- **Deepseek API key** bat kudeatzailearentzat

---

## Instalazioa

### Ubuntu / Debian (eta beste Linux banaketak)

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

`install.sh`-ek sistemaren dependentziak instalatzen ditu (Node 20, `screen`, `node-pty`-ren konpilazio-tresnak), `npm ci` exekutatzen du, `.env` interaktiboki sortzen du eta, aukeran, **systemd** zerbitzu bat sortzen du abio automatizaturako.

### macOS

```bash
git clone <repo-url>
cd llm-screen-dashboard
bash install.sh
```

Script-ak macOS detektatzen du, `brew` bidez dependentziak instalatzen ditu beharrezko badira, eta `.env` konfigurazioan gidatzen zaitu.

### Windows

GNU Screen ez dago Windows natiboan, beraz LSD **WSL2** barruan exekutatzen da:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1`-ek WSL2 egiaztatzen du, Ubuntu instalatzen du falta bada, eta WSL2 barruan `install.sh` exekutatzen du. Behin abiarazita, web UI-a Windows-etik eskuragarri dago `http://localhost:3000` helbidean.

> Eskuzko alternatiba: instalatu WSL2 Ubuntu-rekin, klonatu repo-a Ubuntu barruan eta jarraitu Linux-eko pausoetara.

---

## Abio azkarra

Instalatzaile automatizoa erabili nahi ez baduzu:

```bash
npm install
cp .env.example .env
# Editatu .env eta gehitu zure DEEPSEEK_API_KEY
npm start
```

Ireki http://localhost:3000 zure nabigatzailean.

### `.env`-ko aldagai garrantzitsuak

```env
DEEPSEEK_API_KEY=<your-api-key>
DEEPSEEK_MODEL=deepseek-v4-flash   # edo deepseek-v4-pro
SESSION_CLI=kimi                   # saio berrien CLI lehenetsia
PORT=3000
HOST=127.0.0.1                     # 0.0.0.0 = interfaze guztiak (erabili proxy autentikatua bakarrik)
```

---

## Oinarrizko erabilera

1. **Sortu saio bat**: sartu izena eta, aukeran, lanerako direktorio bat. Karpetak edukia badu, LSD-k kudeatzaileari aztertzeko eskaintzen dio.
2. **Ikusi terminala**: hautatu saioa. Ezkerreko panela terminal interaktibo bihurtzen da.
3. **Galdetu kudeatzaileari**: idatzi eskuineko txatean. Saioak sortzea, irteera irakurtzea edo komandoak bidaltzea eskatu diezaiokezu.
4. **Artxibatu / berriro ireki**: saio batekin amaitutakoan, artxibatu hura screen-a ixteko kontextua mantenduz. Berriro ireki edozein unetan.
5. **Gorde historialea**: jaitsi Markdown fitxategi bat elkarrizketa osoarekin eta azken pantaila-snapshot-arekin.

---

## Ezaugarri tekniko nabarmenduak

- **Web terminal erreal** bat `node-pty` + `xterm.js` erabiliz, teklak konposatuak (azentuak) onartzen dituena, Chromium-en pantaila osoko teklatu-blokeoa eta `Ctrl+S` edo `Ctrl+T` bezalako teklatu erreserbatuentzako botoiak barne.
- **Jardueraren monitorea** saioak `Working` / `Waiting` gisa sailkatzen ditu 3 segundoro hardcopy-ak alderatuz.
- **Historialaren artxibatzaileak** kimi-ren `wire.jsonl`-tik mezu berriak kopiatzen ditu `data/history/<slug>.jsonl`-ra.
- **Kudeatzailearen txosten periodikoa** konfiguragarria `REPORT_INTERVAL_MIN` bidez, saio aktiboen laburpena ematen duena (Matrixera ere bidaltzen da bot-a aktibatuta badago — ikusi beherago).
- **Matrix bot-a (aukerakoa)**: hitz egin kudeatzaile berarekin mugikorretik — ikusi [Matrix bot-a](#matrix-bot-a-aukerakoa) atala.
- **Ollama lokalaren sostengua** aukerako modelo-override gisa kimi saioentzat.
- **Zuriuneak dituzten etiketak**: UI-an gizakiarentzako izenak, screen eta URL-entzako slug barnekoak.

---

## Matrix bot-a (aukerakoa)

Deepseek kudeatzaile berarekin hitz egin dezakezu mugikorretik [Matrix](https://matrix.org) bidez (Element eta beste bezero batzuekin). Bot-a `src/matrix.js`-n dago, baimendutako erabiltzaileei soilik erantzuten die eta **zifratu gabeko** gela bat behar du (ez du E2EE onartzen).

Errezetak doako homeserver publiko **matrix.org** erabiltzen du adibide gisa — baina edozein Matrix homeserver balio du, **zeurea** barne (adib. autoostatutako Synapse bat): `MATRIX_HOMESERVER` harantz apuntatu besterik ez. Zeure zerbitzarian erregistroa itxita egoten da normalean, beraz bot-aren kontua zerbitzarian bertan sortzen da (Synapse-en: `register_new_matrix_user -c /etc/matrix-synapse/homeserver.yaml`).

1. **Sortu bot-arentzako kontu bat** matrix.org-en (Elementen: itxi saioa eta erregistratu kontu berri bat, adib. `@my-lsd-bot:matrix.org`).
2. **Lortu access token-a**:
   ```bash
   curl -X POST https://matrix.org/_matrix/client/v3/login \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"my-lsd-bot"},"password":"<bot-aren pasahitza>"}'
   ```
   (Elementen ere badago: *Ezarpenak → Laguntza eta honi buruz → Access Token*.)
3. **Konfiguratu `.env`** eta berrabiarazi LSD:
   ```
   MATRIX_HOMESERVER=https://matrix.org
   MATRIX_USER=@my-lsd-bot:matrix.org
   MATRIX_ACCESS_TOKEN=<2. urratseko tokena>
   MATRIX_ALLOWED_USERS=@your-user:matrix.org
   ```
   Aldagai horiek gabe, bot-a ez da abiarazten. Abiarazte-logak `Matrix: bot conectado como …` erakusten du konektatzean.
4. **Sortu zifratu gabeko gela bat** Elementen (*ezarpen aurreratuak → desaktibatu zifratua* sortzean) eta gonbidatu bot-a bere MXID osoa idatziz (`@my-lsd-bot:matrix.org`) — kontu berriak ez dira erabiltzaile-bilatzailean agertzen. Bot-ak baimendutako erabiltzaileen gonbidapenak bakarrik onartzen ditu automatikoki.

Oharrak:

- `MATRIX_ALLOWED_USERS` MXIDen zerrenda zuria da, komaz bereizita. Bot-ak **gainerako guztiari isilka ez dio kasurik egiten** — mantendu labur: kudeatzaileak saioak sortu eta itxi ditzake.
- Matrix-eko DMak defektuz zifratuta doaz eta bot-ak ezin ditu zifratutako gelak irakurri; erabili zifratu gabeko gela dedikatu bat. matrix.org-en horrek esan nahi du homeserver-aren operadoreak edukia ikus dezakeela — zeure zerbitzariarekin zure eskuetan geratzen da (garraioa TLSz zifratuta doa bi kasuetan).
- Kudeatzailearen txosten periodikoa (`REPORT_INTERVAL_MIN`) bot-aren geletara ere bidaltzen da.

---

## REST API (laburpena)

| Metodoa | Ibilbidea | Deskribapena |
| --- | --- | --- |
| GET | `/api/sessions` | Zerrendatu aktiboak eta artxibatuak |
| POST | `/api/sessions` | Sortu saioa `{ name, workdir?, cli?, model? }` |
| GET | `/api/sessions/:name/output` | Terminalaren azken lerroak |
| GET | `/api/sessions/:name/conversation` | Elkarrizketa osoa parseatua |
| POST | `/api/sessions/:name/archive` | Artxibatu saioa |
| POST | `/api/sessions/:name/reopen` | Berriro ireki saio artxibatua |
| POST | `/api/chat` | Txateatu Deepseek kudeatzailearekin |
| GET / POST | `/api/config` | Irakurri / eguneratu konfigurazioa |
| WS | `/ws?name=<session>` | Terminal interaktiboa |

---

## Segurtasuna

- Web UI-ak **ez du autentikaziorik**. Erabili `HOST=127.0.0.1` sarbide lokalerako soilik, edo jarri LSD autentikatutako proxy baten atzean `0.0.0.0` esposatzen baduzu.
- Deepseek API key-a `.env`-n gordetzen da (instalatzaileak ezarritako baimen murriztuak) eta inoiz ez da oso-osorik itzultzen API bidez (`GET /api/config`-k `••••1234` soilik erakusten du).

---

## Lizentzia

MIT
