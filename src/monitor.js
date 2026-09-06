import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as screen from './screen.js';
import * as registry from './registry.js';
import * as history from './history.js';
import { kimiHomeFor } from './config.js';

const run = promisify(execFile);

// Monitor de actividad: cada tick compara el terminal de cada sesión con la
// última captura. Si cambió hace poco -> 'trabajando'; si lleva unos segundos
// quieta -> 'esperando' (kimi está en su cuadro de entrada o pidiendo aprobación).
// Al pasar a 'esperando' se guarda siempre el snapshot en el registry (requisito:
// que lo hecho hasta ese momento quede persistido) y se anota cuándo persistió
// kimi el contexto por última vez (mtime de su wire.jsonl).
//
// El diff de pantalla SOLO no basta (bug 06/08/26): mientras el LLM piensa
// (llamada a la API sin streaming visible) la pantalla puede quedarse estática
// 20+ s y la sesión marcaba "esperando" estando a mitad de turno. Por eso hay
// dos señales extra sobre el ÁRBOL de procesos de la sesión (hijos del screen):
// - RED: alguna conexión TCP ESTABLISHED a una dirección NO local = llamada a
//   la API en vuelo (medido: 0 en reposo, 1-2 durante el turno; el keep-alive
//   la mantiene ~5 s tras terminar, mismo orden que la ventana IDLE_MS).
//   Las locales (127.x/::1) se excluyen a propósito: una sesión con un dev
//   server (streamlit y su websocket, p. ej.) quedaría siempre "trabajando"
//   mientras alguien la tenga abierta en el navegador.
// - CPU: el utime+stime del árbol crece entre ticks = corre herramientas
//   locales (tests, builds) aunque no impriman nada.
// Ninguna de las dos la produce el attach del terminal web (ese pty cuelga de
// NUESTRO servidor, no del árbol de la sesión).
//
// OJO: un attach/detach del terminal web redibuja (y a veces redimensiona) el
// terminal, lo que parecería "trabajo". terminal.js avisa con noteAttach() y
// esos cambios solo actualizan el baseline, sin marcar 'trabajando'.

const IDLE_MS = 4000;
const TICK_MS = 3000;
const ATTACH_GRACE_MS = 5000;

const states = new Map(); // name(sin prefijo) -> { activity, lastChange, lastSnapshot, contextSavedAt, lastMsgAt, prevCpu }
const quietUntil = new Map(); // name -> ts hasta el que ignorar redibujados

// PIDs con alguna conexión TCP establecida a una dirección NO local (una vez
// por tick para todas las sesiones)
async function pidsWithRemoteConnections() {
  try {
    const { stdout } = await run('ss', ['-tnHp', 'state', 'established']);
    const pids = new Set();
    for (const line of stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      const peer = cols[4] || '';
      if (/^(127\.|\[?::1)/.test(peer)) continue; // local: no es llamada a API
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
    }
    return pids;
  } catch {
    return new Set();
  }
}

// Mapa ppid -> [pids hijos], una vez por tick
async function processTree() {
  const tree = new Map();
  try {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=']);
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!tree.has(ppid)) tree.set(ppid, []);
      tree.get(ppid).push(pid);
    }
  } catch { /* ps falló: sin señales de proceso este tick */ }
  return tree;
}

function descendantsOf(rootPid, tree) {
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop();
    out.push(pid);
    for (const c of tree.get(pid) || []) queue.push(c);
  }
  return out;
}

// Suma de utime+stime del árbol (campos 14/15 de /proc/<pid>/stat; el comm
// puede contener espacios/paréntesis: se recorta hasta el último ')')
async function treeCpu(pids) {
  let sum = 0;
  for (const p of pids) {
    try {
      const stat = await fs.readFile(`/proc/${p}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      sum += Number(fields[11]) + Number(fields[12]);
    } catch { /* proceso muerto a mitad de lectura */ }
  }
  return sum;
}

export function noteAttach(short) {
  quietUntil.set(short, Date.now() + ATTACH_GRACE_MS);
}

export function getActivity() {
  const out = {};
  for (const [name, s] of states) {
    out[name] = { activity: s.activity, lastChange: s.lastChange, contextSavedAt: s.contextSavedAt, lastMsgAt: s.lastMsgAt };
  }
  return out;
}

// Cuándo persistió kimi por última vez el contexto de la sesión de ese workdir
// (kimi escribe su wire.jsonl continuamente; lo leemos de su propio índice).
// Las sesiones Ollama tienen su propio KIMI_CODE_HOME: se localiza por baseUrl.
async function kimiContextSavedAt(workdir, baseUrl) {
  if (!workdir) return null;
  try {
    const home = kimiHomeFor(baseUrl);
    const lines = (await fs.readFile(path.join(home, 'session_index.jsonl'), 'utf8'))
      .trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = JSON.parse(lines[i]);
      if (e.workDir === workdir) {
        const wire = path.join(e.sessionDir, 'agents', 'main', 'wire.jsonl');
        return (await fs.stat(wire)).mtime.toISOString();
      }
    }
  } catch {
    /* sin índice o sin wire todavía */
  }
  return null;
}

async function tick() {
  let sessions;
  try {
    sessions = (await screen.listSessions()).filter((s) => s.managed);
  } catch {
    return;
  }
  const now = Date.now();
  const alive = new Set();
  // Señales de proceso, una vez por tick para todas las sesiones
  const [busyNet, tree] = await Promise.all([pidsWithRemoteConnections(), processTree()]);

  for (const s of sessions) {
    const short = s.name.slice(screen.PREFIX.length);
    alive.add(short);
    let output;
    try {
      output = await screen.readOutput(s.name, 120);
    } catch {
      continue;
    }
    let st = states.get(short);
    if (!st) {
      // Primera vez que la vemos: fijar baseline SIN marcar actividad
      states.set(short, { activity: 'esperando', lastChange: 0, lastSnapshot: output, contextSavedAt: null, lastMsgAt: null, prevCpu: null });
      continue;
    }
    // Último mensaje persistido por kimi (mtime del wire.jsonl): se actualiza
    // en cada tick — es la señal de "última sesión con la que el usuario
    // interactuó" para ordenar la lista (su mensaje se persiste al enviarlo)
    const entryNow = await registry.get(short).catch(() => null);
    const lastMsgAt = await kimiContextSavedAt(entryNow?.workdir, entryNow?.baseUrl);
    if (lastMsgAt) st.lastMsgAt = lastMsgAt; // null = sin wire (otro CLI o fallo de lectura): conservar la última conocida
    const changed = output !== st.lastSnapshot;
    if (changed) st.lastSnapshot = output;
    const pids = descendantsOf(s.pid, tree);
    const cpu = await treeCpu(pids);
    // Umbral: en reposo el TUI gasta ~1 jiffy/4 s (timers/GC); trabajando se
    // miden 150-500 jiffies/tick. 10 jiffies (0,1 s de CPU por tick) separa
    // ambos mundos con margen
    const cpuBusy = st.prevCpu != null && cpu - st.prevCpu >= 10;
    st.prevCpu = cpu;
    const netBusy = pids.some((p) => busyNet.has(p));
    const quiet = (quietUntil.get(short) || 0) > now; // redibujado por attach/detach nuestro
    const busy = netBusy || cpuBusy || (changed && !quiet);
    if (busy) {
      st.lastChange = now;
      if (st.activity !== 'trabajando') {
        st.activity = 'trabajando';
        await persist(short, st, s.status).catch(() => {});
      }
    } else if (st.activity === 'trabajando' && now - st.lastChange > IDLE_MS) {
      st.activity = 'esperando';
      // transición a esperando: guardar siempre el estado, el snapshot y
      // la marca temporal del contexto persistido por kimi
      const entry = await registry.get(short);
      st.contextSavedAt = await kimiContextSavedAt(entry?.workdir, entry?.baseUrl);
      await persist(short, st, s.status).catch(() => {});
    }
  }

  // Sesión desaparecida con el servidor corriendo: se ARCHIVA (queda en el
  // registry para reabrirla), salvo que ya no tenga entrada (eliminada a
  // propósito por el endpoint DELETE). Si el servidor muere a la vez (luz),
  // la entrada queda sin archivar y recovery.js la restaurará al arrancar.
  for (const short of [...states.keys()]) {
    if (!alive.has(short)) {
      states.delete(short);
      quietUntil.delete(short);
      const entry = await registry.get(short).catch(() => null);
      if (entry) await registry.upsert(short, { archived: true }).catch(() => {});
    }
  }

  // Archivado incremental de la conversación (data/history/<slug>.jsonl):
  // solo hace stat por sesión si nada cambió, así que es barato por tick
  await history.archiveTick();
}

async function persist(short, st, status) {
  const snapshot = st.lastSnapshot ? st.lastSnapshot.split('\n').slice(-200).join('\n') : '';
  await registry.upsert(short, {
    activity: st.activity,
    status,
    snapshot,
    contextSavedAt: st.contextSavedAt,
  });
}

export function startMonitor() {
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  timer.unref();
  tick().catch(() => {});
  return timer;
}

// Guardado bajo demanda (botón "Hasta mañana"): persiste AHORA el snapshot
// visible y la marca de contexto de una sesión, sin esperar a una transición
// de actividad. Devuelve también la actividad actual para el aviso previo.
export async function persistNow(short) {
  const output = await screen.readOutput(screen.PREFIX + short, 120);
  const entry = await registry.get(short);
  const contextSavedAt = await kimiContextSavedAt(entry?.workdir, entry?.baseUrl);
  await registry.upsert(short, {
    snapshot: output ? output.split('\n').slice(-200).join('\n') : '',
    contextSavedAt,
  });
  return { name: short, label: entry?.label || null, activity: states.get(short)?.activity || null, contextSavedAt };
}
