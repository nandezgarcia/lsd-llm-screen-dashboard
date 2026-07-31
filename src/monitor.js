import fs from 'node:fs/promises';
import path from 'node:path';
import * as screen from './screen.js';
import * as registry from './registry.js';
import * as history from './history.js';
import { kimiHomeFor } from './config.js';

// Monitor de actividad: cada tick compara el terminal de cada sesión con la
// última captura. Si cambió hace poco -> 'trabajando'; si lleva unos segundos
// quieta -> 'esperando' (kimi está en su cuadro de entrada o pidiendo aprobación).
// Al pasar a 'esperando' se guarda siempre el snapshot en el registry (requisito:
// que lo hecho hasta ese momento quede persistido) y se anota cuándo persistió
// kimi el contexto por última vez (mtime de su wire.jsonl).
//
// OJO: un attach/detach del terminal web redibuja (y a veces redimensiona) el
// terminal, lo que parecería "trabajo". terminal.js avisa con noteAttach() y
// esos cambios solo actualizan el baseline, sin marcar 'trabajando'.

const IDLE_MS = 4000;
const TICK_MS = 3000;
const ATTACH_GRACE_MS = 5000;

const states = new Map(); // name(sin prefijo) -> { activity, lastChange, lastSnapshot, contextSavedAt }
const quietUntil = new Map(); // name -> ts hasta el que ignorar redibujados

export function noteAttach(short) {
  quietUntil.set(short, Date.now() + ATTACH_GRACE_MS);
}

export function getActivity() {
  const out = {};
  for (const [name, s] of states) {
    out[name] = { activity: s.activity, lastChange: s.lastChange, contextSavedAt: s.contextSavedAt };
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
      states.set(short, { activity: 'esperando', lastChange: 0, lastSnapshot: output, contextSavedAt: null });
      continue;
    }
    if (output !== st.lastSnapshot) {
      st.lastSnapshot = output;
      if ((quietUntil.get(short) || 0) > now) continue; // redibujado por attach/detach nuestro
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
