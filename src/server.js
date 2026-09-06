import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, publicConfig, sessionEnv, sessionResumeArgs, updateEnv, assertSessionModelUp, parseDeployTargets } from './config.js';
import * as screen from './screen.js';
import { runManagerChat } from './deepseek.js';
import { setupTerminalWS } from './terminal.js';
import { startMonitor, getActivity, persistNow } from './monitor.js';
import { recoverSessions } from './recovery.js';
import * as registry from './registry.js';
import * as history from './history.js';
import { readConversation } from './conversation.js';
import { maybeRunFirstSetup } from './firstrun.js';
import { startMatrixBot, sendMatrixReport } from './matrix.js';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(config.root, 'public')));
// Assets de xterm.js servidos desde node_modules (sin CDN, funciona offline)
app.use('/vendor/xterm', express.static(path.join(config.root, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(config.root, 'node_modules', '@xterm', 'addon-fit')));

const asyncRoute = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(400).json({ error: err.message }));

const runFile = promisify(execFile);

app.get('/api/sessions', asyncRoute(async (_req, res) => {
  const activity = getActivity();
  const saved = await registry.getAll();
  const sessions = await Promise.all((await screen.listSessions()).map(async (s) => {
    const short = s.name.slice(screen.PREFIX.length);
    // Publicable: el workdir pinta una web (estática o con build npm)
    const workdir = saved[short]?.workdir;
    const publishable = workdir
      ? await Promise.any([
          fs.access(path.join(workdir, 'index.html')),
          fs.access(path.join(workdir, 'package.json')),
        ]).then(() => true, () => false)
      : false;
    return {
      ...s,
      activity: activity[short]?.activity || null,
      contextSavedAt: activity[short]?.contextSavedAt || null,
      lastMsgAt: activity[short]?.lastMsgAt || null,
      label: saved[short]?.label || null,
      publishable,
    };
  }));
  const aliveNames = new Set(sessions.map((s) => s.name.slice(screen.PREFIX.length)));
  const archived = Object.entries(saved)
    .filter(([short, e]) => e.archived && !aliveNames.has(short))
    .map(([short, e]) => ({
      name: short,
      label: e.label || null,
      workdir: e.workdir || null,
      cli: e.cli || null,
      contextSavedAt: e.contextSavedAt || null,
      updatedAt: e.updatedAt || null,
      snapshot: e.snapshot || '',
    }));
  res.json({ sessions, archived });
}));

app.post('/api/sessions', asyncRoute(async (req, res) => {
  const { name, workdir } = req.body || {};
  if (!screen.isValidLabel(name)) {
    return res.status(400).json({ error: 'Nombre inválido (máx 50 caracteres, sin barras)' });
  }
  if (!config.deepseekApiKey) {
    return res.status(500).json({ error: 'Falta DEEPSEEK_API_KEY en .env' });
  }
  const slug = await screen.uniqueSlug(name);
  if (!slug) return res.status(400).json({ error: 'El nombre no genera un identificador válido' });
  const label = name.trim();
  const full = screen.PREFIX + slug;
  let dir = workdir ? path.resolve(workdir) : path.join(config.workspacesDir, slug);
  // El contenedor workspaces/ nunca es workdir: sin carpeta válida, la sesión
  // recibe su propia workspaces/<nombre> vacía para trabajar solo ahí
  if (dir === config.workspacesDir) dir = path.join(config.workspacesDir, slug);
  const cli = /^[a-z0-9-]{1,30}$/.test(req.body.cli || '') ? req.body.cli : config.sessionCli;
  // Modelo por sesión (opcional): si viene, manda sobre el override global.
  // Se valida y se guarda en el registry para reopen/recovery.
  let model = null;
  let baseUrl = null;
  // El override de modelo por sesión SOLO aplica a kimi (KIMI_MODEL_*): otros
  // CLIs usan siempre su propia configuración y no se guarda nada
  if (cli === 'kimi' && typeof req.body.model === 'string' && req.body.model.trim() !== '') {
    if (!/^[\w./:-]{1,100}$/.test(req.body.model.trim())) {
      return res.status(400).json({ error: 'Modelo inválido' });
    }
    model = req.body.model.trim();
    if (req.body.baseUrl !== undefined) {
      if (!/^https?:\/\/\S{1,200}$/.test(String(req.body.baseUrl).trim())) {
        return res.status(400).json({ error: 'Base URL inválida' });
      }
      baseUrl = String(req.body.baseUrl).trim();
    }
  }
  const env = sessionEnv(cli, model ? { model, baseUrl } : undefined);
  // Si el modelo apunta a un servidor local caído (p. ej. Ollama parado),
  // la sesión saldría rota: se rechaza la creación con mensaje accionable
  await assertSessionModelUp(env);
  const result = await screen.createSession({
    name: full,
    workdir: dir,
    env,
    cli,
    resumeArgs: sessionResumeArgs(cli),
    label,
    model,
    baseUrl,
  });
  // si el directorio ya tenía contenido, el frontend ofrecerá analizarlo con el gestor
  const entries = await fs.readdir(dir).catch(() => []);
  res.status(201).json({ ...result, slug, label, hasContent: entries.length > 0 });
}));

// Autocompletado de directorios para el workdir (solo lectura, dentro del home)
app.get('/api/browse', asyncRoute(async (req, res) => {
  const home = os.homedir();
  const raw = String(req.query.path || home);
  if (!raw.startsWith('/')) return res.status(400).json({ error: 'Ruta absoluta requerida' });
  let dir = path.resolve(raw);
  let prefix = '';
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) {
    prefix = path.basename(dir);
    dir = path.dirname(dir);
  }
  if (dir !== home && !dir.startsWith(home + path.sep)) {
    return res.status(400).json({ error: 'Solo dentro de tu home' });
  }
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = ents
    .filter((e) => e.isDirectory())
    .filter((e) => (prefix.startsWith('.') || !e.name.startsWith('.')) && e.name.startsWith(prefix))
    .slice(0, 50)
    .map((e) => path.join(dir, e.name));
  res.json({ base: dir, dirs });
}));

app.get('/api/sessions/:name/output', asyncRoute(async (req, res) => {
  const full = screen.PREFIX + req.params.name;
  const output = await screen.readOutput(full, Number(req.query.lines) || 120);
  res.json({ name: req.params.name, output });
}));

app.get('/api/sessions/:name/history', asyncRoute(async (req, res) => {
  const full = screen.PREFIX + req.params.name;
  const output = await screen.readHistory(full, Number(req.query.lines) || 2000);
  res.json({ name: req.params.name, output });
}));

// Conversación real de la sesión: primero el archivo duradero propio
// (data/history/<slug>.jsonl, mensajes con ts de archivado); si aún no
// existe, parseo en caliente del wire.jsonl de kimi (sin ts)
app.get('/api/sessions/:name/conversation', asyncRoute(async (req, res) => {
  const entry = await registry.get(req.params.name);
  if (!entry?.workdir) throw new Error('Sesión sin workdir registrado');
  const archived = await history.readArchive(req.params.name);
  if (archived && archived.length) return res.json({ name: req.params.name, messages: archived });
  const messages = await readConversation(entry.workdir, entry.baseUrl);
  res.json({ name: req.params.name, messages });
}));

app.delete('/api/sessions/:name', asyncRoute(async (req, res) => {
  const short = req.params.name;
  const entry = await registry.get(short);
  // eliminar = matar el screen si vive + olvidar del registry (no archivable)
  await screen.killSession(screen.PREFIX + short).catch(() => {});
  await registry.remove(short);
  // borrado de carpeta solo si está dentro de workspaces/ y se pide explícito
  let workdirDeleted = false;
  if (req.query.deleteWorkdir === '1' && entry?.workdir) {
    const dir = path.resolve(entry.workdir);
    if (dir.startsWith(config.workspacesDir + path.sep)) {
      await fs.rm(dir, { recursive: true, force: true });
      workdirDeleted = true;
    }
  }
  res.json({ deleted: short, workdirDeleted });
}));

// Archivar: marcar PRIMERO (durable) y cerrar el screen después. Si el kill
// falla, queda viva pero archivada, y recovery la cerrará en el próximo arranque.
app.post('/api/sessions/:name/archive', asyncRoute(async (req, res) => {
  const short = req.params.name;
  await registry.upsert(short, { archived: true });
  await screen.killSession(screen.PREFIX + short).catch(() => {});
  res.json({ archived: short });
}));

// Reabrir una archivada: recrear el screen reanudando la conversación del CLI
app.post('/api/sessions/:name/reopen', asyncRoute(async (req, res) => {
  const short = req.params.name;
  const entry = await registry.get(short);
  if (!entry) return res.status(404).json({ error: `La sesión '${short}' no está archivada` });
  const workdir = entry.workdir || path.join(config.workspacesDir, short);
  const cli = entry.cli || config.sessionCli;
  // Primero se levanta la marca y luego se crea el screen: al revés, un
  // reinicio del servidor entre ambas operaciones vería "archivada pero viva"
  // y recovery la cerraría. Si la creación falla, se repone la marca.
  await registry.upsert(short, { archived: false });
  try {
    // Se restaura con el MISMO modelo con que se creó (override por sesión)
    const env = sessionEnv(cli, entry.model ? { model: entry.model, baseUrl: entry.baseUrl } : undefined);
    await assertSessionModelUp(env);
    await screen.createSession({
      name: screen.PREFIX + short,
      workdir,
      env,
      cli,
      resume: true,
      resumeArgs: sessionResumeArgs(cli),
      label: entry.label || null,
    });
  } catch (err) {
    await registry.upsert(short, { archived: true }).catch(() => {});
    throw err;
  }
  res.json({ reopened: short, workdir });
}));

// "Hasta mañana": persiste AHORA el snapshot y la marca de contexto de todas
// las sesiones vivas, y devuelve cuáles están trabajando (para el aviso previo)
app.post('/api/sessions/save-all', asyncRoute(async (_req, res) => {
  const sessions = (await screen.listSessions()).filter((s) => s.managed);
  const saved = [];
  for (const s of sessions) {
    const short = s.name.slice(screen.PREFIX.length);
    try {
      saved.push(await persistNow(short));
    } catch (err) {
      saved.push({ name: short, error: err.message });
    }
  }
  res.json({ saved, trabajando: saved.filter((r) => r.activity === 'trabajando').map((r) => r.label || r.name) });
}));

// ---------- Despliegue SSH (botón ⬆ Subir) ----------
// Quién despliega: el AGENTE de la sesión por SSH (como se hizo a mano con
// kiokao → farnsworth), orquestado por el gestor. Aquí solo se prueba la
// conexión y se arranca el despliegue con un prompt construido en el servidor
// (el cliente solo manda el nombre del destino — nunca texto libre al prompt).

// Probar la conexión SSH de un destino (BatchMode = sin preguntar contraseña:
// verifica que la clave del usuario ya está autorizada en el servidor).
// Acepta el destino completo (no hace falta guardarlo antes de probarlo);
// pasa por el mismo saneado de config.js y va a execFile SIN shell.
app.post('/api/deploy/test', asyncRoute(async (req, res) => {
  const t = parseDeployTargets(JSON.stringify([req.body || {}]))[0];
  if (!t) {
    return res.status(400).json({ error: 'Destino inválido (name, user, host y basePath absoluta son obligatorios)' });
  }
  try {
    await runFile('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(t.port), `${t.user}@${t.host}`, 'true',
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.json({
      ok: false,
      error: String(err.stderr || err.message).slice(0, 300),
      hint: `ssh-copy-id -p ${t.port} ${t.user}@${t.host}`,
    });
  }
}));

// Arrancar el despliegue de una sesión: el GESTOR lo ejecuta él mismo con
// run_command (ssh/rsync al destino, systemd endurecido, nginx, SSL con
// certbot, verificación https) — no delega en el agente de la sesión.
// El prompt se construye aquí: el cliente solo manda { target, subdomain,
// domain }. Puede tardar minutos (certbot, npm/pip remotos): se responde
// cuando el gestor termina (por eso maxIterations=25).
app.post('/api/sessions/:name/deploy', asyncRoute(async (req, res) => {
  const short = req.params.name;
  if (!screen.isValidName(short)) return res.status(400).json({ error: 'Nombre inválido' });
  const entry = (await registry.getAll())[short] || {};
  if (!entry.workdir) {
    return res.status(400).json({ error: 'La sesión no tiene workdir conocido en el registry' });
  }
  const t = config.deployTargets.find((x) => x.name === String(req.body?.target || ''));
  if (!t) {
    return res.status(400).json({ error: 'Destino de despliegue no encontrado (configúralo en ⚙ Configuración)' });
  }
  const subdomain = String(req.body?.subdomain || '').trim().toLowerCase();
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    return res.status(400).json({ error: 'Subdominio inválido (letras minúsculas, números y guiones)' });
  }
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ error: 'Dominio inválido (p. ej. kiokao.com)' });
  }
  const fqdn = `${subdomain}.${domain}`;
  const remoteDir = `${t.basePath.replace(/\/$/, '')}/${fqdn}`;
  const prompt =
    `Despliega AHORA el proyecto de la sesión '${short}'` + (entry.label ? ` ("${entry.label}")` : '') +
    ` al servidor '${t.name}'. Lo ejecutas TÚ con run_command paso a paso (NO uses send_input ni delegues en la sesión). ` +
    'Datos del despliegue:\n' +
    `- Workdir local del proyecto: ${entry.workdir}\n` +
    `- SSH: ssh -p ${t.port} ${t.user}@${t.host} (auth por clave; añade -o BatchMode=yes. En el servidor hay sudo sin contraseña: sudo -n).\n` +
    `- Ruta remota: ${remoteDir}\n` +
    `- URL final objetivo: https://${fqdn}\n` +
    'Pasos obligatorios, verificando la salida de cada comando antes de seguir:\n' +
    '1. Inspecciona el workdir local (ls, README, package.json/requirements.txt…) para saber qué tipo de proyecto es, qué dependencias tiene y en qué puerto puede correr.\n' +
    `2. Copia el proyecto al servidor (rsync -avz --exclude .venv --exclude node_modules --exclude .git; crea antes ${remoteDir}). NUNCA subas el .env local ni secretos.\n` +
    '3. En el servidor: instala las dependencias (npm ci / python venv + pip / lo que toque) con el usuario del destino.\n' +
    `4. Crea un servicio systemd (sudo -n) llamado '${subdomain}-${domain.split('.')[0]}' que corra el proyecto con el usuario del destino en un puerto local libre, con hardening: NoNewPrivileges=yes, PrivateTmp=yes, ProtectSystem=strict con ReadWritePaths=${remoteDir}, Restart=on-failure. Actívalo (enable --now) y comprueba que está active.\n` +
    `5. nginx (sudo -n): virtualhost para ${fqdn} con proxy_pass a http://127.0.0.1:<puerto> (websockets si el proyecto los usa).\n` +
    `6. SSL: sudo -n certbot --nginx -d ${fqdn} (no interactivo: --non-interactive --agree-tos -m admin@${domain} --redirect). Si falla por DNS (el FQDN no resuelve al servidor), dilo claramente y deja el vhost HTTP funcionando.\n` +
    '7. Permisos y seguridad: propietario correcto, nada world-writable, el servicio sin más privilegios de los necesarios.\n' +
    `8. Verificación final: curl -sI https://${fqdn} (o http:// si no hubo SSL) debe responder.\n` +
    'Si un comando falla, lee el error, corrige y reintenta (tienes margen de iteraciones). ' +
    'Responde con un resumen: URL, servicio systemd, qué quedó configurado y cualquier pendiente (DNS, secretos, etc.).';
  res.json(await runManagerChat([{ role: 'user', content: prompt }], short, 25));
}));

// ---------- Publicación web (botón 🌐 Publicar) ----------
// Destino ÚNICO configurado en ⚙ (PUBLISH_*: dominio kiokao.com por defecto).
// A diferencia de ⬆ Subir (clave SSH), la auth es por CONTRASEÑA vía sshpass:
// la contraseña está en el entorno del proceso (PUBLISH_PASSWORD) y los
// comandos del gestor la usan como $PUBLISH_PASSWORD con `sshpass -e` — nunca
// se escribe en el prompt, en el toolLog ni sale por la API.

// sshpass es imprescindible para la auth por contraseña; sin él, error accionable
async function assertSshpass() {
  try {
    await runFile('bash', ['-lc', 'command -v sshpass']);
  } catch {
    throw new Error('Falta sshpass en este equipo (instálalo: sudo apt install sshpass)');
  }
}

// Config efectiva de publicación: la guardada, con overrides puntuales del body
// (permite Probar con cambios del formulario aún sin guardar; la contraseña del
// body solo se usa si viene con valor — si no, la del .env)
function publishConfigFrom(body = {}) {
  const p = config.publish;
  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return {
    domain: clean(body.domain) || p.domain,
    host: clean(body.host) || clean(body.domain) || p.host,
    user: clean(body.user) || p.user,
    password: clean(body.password) || p.password,
    basePath: clean(body.basePath) || p.basePath,
    port: Number(body.port) > 0 ? Number(body.port) : p.port,
  };
}

// Probar la conexión SSH por contraseña del destino de publicación
app.post('/api/publish/test', asyncRoute(async (req, res) => {
  await assertSshpass();
  const p = publishConfigFrom(req.body);
  if (!p.user || !p.password) {
    return res.status(400).json({ error: 'Publicación no configurada: faltan usuario y/o contraseña (⚙ Configuración → Publicación web)' });
  }
  try {
    await runFile('sshpass', [
      '-e', 'ssh',
      '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'NumberOfPasswordPrompts=1',
      '-p', String(p.port), `${p.user}@${p.host}`, 'true',
    ], { env: { ...process.env, SSHPASS: p.password } });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String(err.stderr || err.message).slice(0, 300) });
  }
}));

// Publicar la web de una sesión: el GESTOR lo ejecuta todo con run_command
// (sshpass + rsync + nginx + certbot). El cliente solo manda { subdomain } —
// dominio, servidor, usuario y contraseña salen de la configuración.
app.post('/api/sessions/:name/publish', asyncRoute(async (req, res) => {
  const short = req.params.name;
  if (!screen.isValidName(short)) return res.status(400).json({ error: 'Nombre inválido' });
  const entry = (await registry.getAll())[short] || {};
  if (!entry.workdir) {
    return res.status(400).json({ error: 'La sesión no tiene workdir conocido en el registry' });
  }
  const p = config.publish;
  if (!p.user || !p.password) {
    return res.status(400).json({ error: 'Publicación no configurada: faltan usuario y/o contraseña (⚙ Configuración → Publicación web)' });
  }
  await assertSshpass();
  const subdomain = String(req.body?.subdomain || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    return res.status(400).json({ error: 'Subdominio inválido (letras minúsculas, números y guiones)' });
  }
  const fqdn = `${subdomain}.${p.domain}`;
  const remoteDir = `${p.basePath.replace(/\/$/, '')}/${fqdn}`;
  const prompt =
    `Publica AHORA la web del proyecto de la sesión '${short}'` + (entry.label ? ` ("${entry.label}")` : '') +
    ` en https://${fqdn}. Lo ejecutas TÚ con run_command paso a paso (NO uses send_input ni delegues en la sesión). ` +
    'Datos de la publicación:\n' +
    `- Workdir local del proyecto: ${entry.workdir}\n` +
    `- Servidor: ${p.user}@${p.host} (puerto SSH ${p.port}), auth por CONTRASEÑA: la contraseña está en la variable de entorno $PUBLISH_PASSWORD del entorno de bash. NUNCA la escribas literalmente en un comando, ni la muestres ni la subas a ningún sitio. Cada run_command es una shell nueva: empieza con export SSHPASS="$PUBLISH_PASSWORD" y usa sshpass -e, p. ej. sshpass -e ssh -o StrictHostKeyChecking=accept-new -p ${p.port} ${p.user}@${p.host} '<comando>' o sshpass -e rsync -avz -e "ssh -p ${p.port} -o StrictHostKeyChecking=accept-new" ...\n` +
    `- Ruta remota: ${remoteDir}\n` +
    `- URL final objetivo: https://${fqdn}\n` +
    'Pasos obligatorios, verificando la salida de cada comando antes de seguir:\n' +
    '1. Inspecciona el workdir local (ls, README, package.json…): si es una web ESTÁTICA (index.html en la raíz) se sube tal cual; si tiene build (npm run build que genera dist/ o build/), constrúyela primero en local y sube el resultado.\n' +
    `2. Sube el contenido con rsync (excluye .git, node_modules, .env y cualquier secreto — NUNCA subas el .env; crea antes ${remoteDir} en el servidor).\n` +
    `3. nginx: virtualhost para ${fqdn} con root ${remoteDir} (si el proyecto necesita un proceso — puerto, API— en vez de estático, monta el servicio systemd y el proxy_pass como corresponda). Para sudo en el servidor usa la contraseña: echo "$PUBLISH_PASSWORD" | sudo -S <comando>.\n` +
    `4. SSL: certbot --nginx -d ${fqdn} con --non-interactive --agree-tos -m admin@${p.domain} --redirect (vía sudo -S). Si falla por DNS (el FQDN no resuelve al servidor), dilo claramente y deja el vhost HTTP funcionando.\n` +
    `5. Permisos y seguridad: propietario correcto, nada world-writable.\n` +
    `6. Verificación final: curl -sI https://${fqdn} (o http:// si no hubo SSL) debe responder.\n` +
    'Si un comando falla, lee el error, corrige y reintenta (tienes margen de iteraciones). ' +
    'Responde con un resumen: URL final, qué quedó configurado y cualquier pendiente (DNS, etc.).';
  res.json(await runManagerChat([{ role: 'user', content: prompt }], short, 25));
}));


// ---------- Informe periódico del gestor ----------
// Cada config.reportIntervalMin minutos (0 = desactivado) el gestor revisa las
// sesiones activas y genera un resumen; la web lo recoge vía GET /api/reports
// y lo muestra en el chat. En memoria (últimos 20), sin persistencia.
const reports = [];
let reportTimer = null;

const AUTO_REPORT_PROMPT =
  'Informe periódico automático (NO escribe el usuario, no le contestes a nadie en concreto). ' +
  'Usa list_sessions para ver las sesiones activas (campo activity: trabajando/esperando) y ' +
  'revisa con read_session_output las últimas líneas de cada activa. Resume en pocas líneas ' +
  'cómo va cada una: en qué está trabajando o qué espera del usuario. Si alguna lleva mucho ' +
  'tiempo esperando entrada, indícalo. Si no hay sesiones activas, dilo en una línea. ' +
  'No envíes instrucciones a ninguna sesión (no uses send_input).';

async function runAutoReport() {
  if (!config.deepseekApiKey) return;
  try {
    const r = await runManagerChat([{ role: 'user', content: AUTO_REPORT_PROMPT }], null);
    reports.push({ ts: new Date().toISOString(), reply: r.reply, toolLog: r.toolLog });
    if (reports.length > 20) reports.shift();
    console.log('Informe periódico generado');
    // Si el bot de Matrix está activo, el informe llega también a sus salas
    sendMatrixReport(`⏱ Informe periódico:\n${r.reply}`);
  } catch (err) {
    console.warn(`Informe periódico falló: ${err.message}`);
  }
}

function scheduleReporter() {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  if (config.reportIntervalMin > 0) {
    reportTimer = setInterval(runAutoReport, config.reportIntervalMin * 60000);
    reportTimer.unref();
    // primer informe al poco de activarlo/arrancar (da tiempo a la recovery)
    setTimeout(runAutoReport, 20000).unref();
  }
}

app.get('/api/reports', asyncRoute(async (req, res) => {
  const after = String(req.query.after || '');
  res.json({ reports: after ? reports.filter((r) => r.ts > after) : reports });
}));

app.post('/api/chat', asyncRoute(async (req, res) => {
  const { messages, activeSession } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Se espera { messages: [...] }' });
  }
  const active = typeof activeSession === 'string' && screen.isValidName(activeSession)
    ? activeSession
    : null;
  res.json(await runManagerChat(messages, active));
}));

// Configuración: lectura enmascarada (nunca sale la API key completa) y
// actualización de valores del .env. Campos vacíos = sin cambios.
app.get('/api/config', asyncRoute(async (_req, res) => {
  res.json({ ...publicConfig(), installedAgents: Object.keys(installedAgents) });
}));

// Modelos disponibles: los de la API de Deepseek y los locales de Ollama
// (si su servidor está corriendo en :11434)
app.get('/api/models', asyncRoute(async (_req, res) => {
  const out = { deepseek: [], deepseekError: null, ollama: [], ollamaRunning: false };
  try {
    const r = await fetch(`${config.deepseekBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.deepseekApiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) out.deepseek = (await r.json()).data?.map((m) => m.id) || [];
    else out.deepseekError = `HTTP ${r.status}`;
  } catch (err) {
    out.deepseekError = err.message;
  }
  try {
    const r = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      out.ollamaRunning = true;
      out.ollama = (await r.json()).models?.map((m) => m.name) || [];
    }
  } catch {
    /* ollama parado */
  }
  res.json(out);
}));

app.post('/api/config', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const modelRe = /^[\w./:-]{1,100}$/;
  for (const f of ['deepseekModel', 'kimiSessionModel']) {
    if (body[f] && !modelRe.test(body[f].trim())) {
      return res.status(400).json({ error: `Modelo inválido: ${f}` });
    }
  }
  for (const f of ['deepseekBaseUrl', 'kimiSessionBaseUrl']) {
    if (body[f] && !/^https?:\/\/\S{1,200}$/.test(body[f].trim())) {
      return res.status(400).json({ error: `URL inválida: ${f}` });
    }
  }
  if (body.sessionCli && !/^[a-z0-9-]{1,30}$/.test(body.sessionCli.trim())) {
    return res.status(400).json({ error: 'CLI de agente inválido (minúsculas, números, guiones)' });
  }
  if (body.reportIntervalMin !== undefined && body.reportIntervalMin !== '') {
    const n = Number(body.reportIntervalMin);
    if (!Number.isFinite(n) || n < 0 || n > 1440) {
      return res.status(400).json({ error: 'Intervalo de informe inválido (0-1440 minutos)' });
    }
  }
  // Destinos de despliegue: debe ser un JSON array y todos los items válidos
  // (se reutiliza el saneado de config.js; la comparación de longitud detecta
  // items descartados). Vacío = sin destinos (CLEARABLE).
  if (typeof body.deployTargets === 'string' && body.deployTargets.trim() !== '') {
    const parsed = parseDeployTargets(body.deployTargets.trim());
    let rawLen = -1;
    try { rawLen = JSON.parse(body.deployTargets.trim()).length; } catch { /* JSON roto */ }
    if (rawLen === -1 || parsed.length !== rawLen || parsed.length === 0) {
      return res.status(400).json({
        error: 'Destinos inválidos: JSON array de {name, user, host, port?, basePath} ' +
          '(name [\\w-], user/host sin espacios, basePath absoluta)',
      });
    }
  }
  // Destinos de publicación: mismos regex que en config.js (acaban como args
  // de ssh/rsync y en prompts del gestor)
  if (body.publishDomain && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/.test(body.publishDomain.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Dominio de publicación inválido (p. ej. kiokao.com)' });
  }
  if (body.publishHost && !/^[\w.-]{1,100}$/.test(body.publishHost.trim())) {
    return res.status(400).json({ error: 'Host de publicación inválido' });
  }
  if (body.publishUser && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(body.publishUser.trim())) {
    return res.status(400).json({ error: 'Usuario de publicación inválido' });
  }
  if (body.publishBasePath && !/^\/[\w./-]{0,200}$/.test(body.publishBasePath.trim())) {
    return res.status(400).json({ error: 'Ruta base de publicación inválida (absoluta, sin espacios)' });
  }
  if (body.publishPort !== undefined && body.publishPort !== '') {
    const n = Number(body.publishPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: 'Puerto SSH de publicación inválido (1-65535)' });
    }
  }
  const changed = updateEnv(body);
  if (changed.REPORT_INTERVAL_MIN !== undefined) scheduleReporter();
  res.json({ changed: Object.keys(changed), config: publicConfig() });
}));

// Detección determinista de CLIs de agente instalados (fallback: el gestor
// tiene la tool discover_agents para una búsqueda guiada por el LLM).
// Se ejecuta sola al arrancar el servidor y se expone en /api/config.
const AGENT_CANDIDATES = ['kimi', 'claude', 'codex', 'gemini', 'aider', 'opencode', 'goose'];
let installedAgents = {};

async function detectAgents() {
  const { execFile } = await import('node:child_process');
  const found = {};
  for (const c of AGENT_CANDIDATES) {
    const p = await new Promise((resolve) => {
      execFile('bash', ['-lc', `command -v ${c}`], (err, stdout) => {
        resolve(err || !stdout.trim() ? null : stdout.trim().split('\n')[0]);
      });
    });
    if (p) found[c] = p;
  }
  return found;
}

app.get('/api/agents', asyncRoute(async (_req, res) => {
  installedAgents = await detectAgents();
  res.json({ agents: installedAgents });
}));

const server = http.createServer(app);
setupTerminalWS(server);

async function main() {
  // Detectar los CLIs de agente instalados (para los desplegables de la UI)
  installedAgents = await detectAgents().catch(() => ({}));
  // Asistente de primera ejecución (sin .env o sin API key y con TTY):
  // pide modelo de API + CLI de terminal antes de aceptar trabajo
  await maybeRunFirstSetup(installedAgents);
  // Recuperar el estado de las sesiones antes de aceptar tráfico:
  // adoptar vivas, registrar desconocidas y restaurar las caídas con kimi -c
  const rec = await recoverSessions().catch((err) => ({ fallidas: [err.message] }));
  console.log(
    `Recuperación: ${rec.adoptadas?.length || 0} adoptadas, ` +
    `${rec.registradas?.length || 0} registradas, ${rec.restauradas?.length || 0} restauradas` +
    (rec.archivadasVivas?.length ? `, ${rec.archivadasVivas.length} archivadas con screen vivo (cerradas)` : '') +
    (rec.fallidas?.length ? `, fallidas: ${rec.fallidas.join('; ')}` : '')
  );
  const monitorTimer = startMonitor();
  // Archivador duradero del historial (dirs + offsets; lo dispara el monitor)
  await history.initHistory().catch((err) => console.warn(`historial: init falló: ${err.message}`));
  scheduleReporter();
  // Bot de Matrix (opcional; solo si hay MATRIX_* en .env, nunca bloquea)
  startMatrixBot();
  // Apagado limpio: parar el monitor YA para que no archive las sesiones que
  // mueran durante el cierre; las activas deben quedar archived:false para
  // que recovery las restaure en el próximo arranque
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      clearInterval(monitorTimer);
      process.exit(0);
    });
  }

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`LSD (LLM Screen Dashboard) en http://${shown}:${config.port} (bind ${config.host})`);
    if (!config.deepseekApiKey) {
      console.warn('AVISO: DEEPSEEK_API_KEY no está definida; copia .env.example a .env');
    }
  });
}

main();
