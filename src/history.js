import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import * as registry from './registry.js';
import { findSessionDir, parseWire } from './conversation.js';

// Archivador incremental de conversación (capa duradera del historial).
// kimi persiste todo en su wire.jsonl, pero ese archivo vive en el home de
// kimi y puede compactarse/recrearse; aquí copiamos los mensajes a un
// archivo append-only PROPIO por sesión: data/history/<slug>.jsonl, una
// entrada por línea: {"ts", "role": "user"|"assistant"|"tool", "text"}.
// Los eventos del wire NO tienen timestamp: ts = momento de archivado.
//
// Se avanza por offset de bytes leídos del wire (en memoria + persistido en
// data/history/.offsets.json, tmp+rename SIN fsync: es reconstruible con un
// re-escaneo). Si el wire mengua (kimi lo compactó), se re-escanea entero y
// se deduplica por solape (best-effort, ver rescanWithDedup).
//
// Límite conocido: las partes de un turno assistant solo se agrupan dentro
// de una misma pasada; si un turno queda partido entre dos pasadas salen
// dos mensajes assistant contiguos. Se acepta por simplicidad.

const HISTORY_DIR = path.join(config.root, 'data', 'history');
const OFFSETS_FILE = path.join(HISTORY_DIR, '.offsets.json');
const OVERLAP_MAX = 1000; // ventana máxima para el dedup por solape

let offsets = null; // slug -> bytes consumidos del wire
let offsetsDirty = false;

const archivePath = (slug) => path.join(HISTORY_DIR, `${slug}.jsonl`);

export async function initHistory() {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  try {
    offsets = JSON.parse(await fs.readFile(OFFSETS_FILE, 'utf8'));
  } catch {
    offsets = {};
  }
}

// tmp + rename (sin fsync: los offsets se reconstruyen re-escaneando)
async function saveOffsets() {
  const tmp = OFFSETS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(offsets));
  await fs.rename(tmp, OFFSETS_FILE);
}

// Una pasada de archivado sobre TODAS las sesiones del registry (activas y
// archivadas: una archivada puede tener restos del wire aún sin archivar).
// Idempotente y NUNCA lanza: un fallo en una sesión no frena a las demás.
export async function archiveTick() {
  try {
    if (!offsets) await initHistory();
    const sessions = await registry.getAll();
    for (const [slug, entry] of Object.entries(sessions)) {
      try {
        await archiveSession(slug, entry);
      } catch (err) {
        console.warn(`historial: no se pudo archivar '${slug}': ${err.message}`);
      }
    }
    if (offsetsDirty) {
      offsetsDirty = false;
      await saveOffsets().catch(() => {});
    }
  } catch (err) {
    console.warn(`historial: pasada fallida: ${err.message}`);
  }
}

async function archiveSession(slug, entry) {
  if (!entry?.workdir) return;
  const sessionDir = await findSessionDir(entry.workdir, entry.baseUrl);
  if (!sessionDir) return; // sin wire (otro CLI, o kimi aún sin indexar)
  const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const st = await fs.stat(wire);
  const offset = offsets[slug] || 0;
  if (st.size < offset) {
    // kimi compactó/recreó el wire: re-escaneo completo con dedup por solape
    await rescanWithDedup(slug, wire, st.size);
    return;
  }
  if (st.size === offset) return;

  // Leer SOLO los bytes nuevos
  const fh = await fs.open(wire, 'r');
  let buf;
  try {
    buf = Buffer.alloc(st.size - offset);
    await fh.read(buf, 0, buf.length, offset);
  } finally {
    await fh.close();
  }
  let text = buf.toString('utf8');
  // Si el corte deja una línea parcial al final (kimi escribiendo a la vez),
  // se retrocede al último \n y esa línea se releerá entera en la próxima
  // pasada (los offsets siempre caen tras un \n: el inicio es borde de línea
  // y un \n nunca aparece dentro de un carácter UTF-8 multibyte).
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return; // todavía no hay ninguna línea completa nueva
  text = text.slice(0, lastNl + 1);
  const consumed = offset + Buffer.byteLength(text, 'utf8');

  const messages = parseWire(text);
  if (messages.length) await appendEntries(slug, messages);
  offsets[slug] = consumed;
  offsetsDirty = true;
}

// Re-escaneo desde 0 tras detectar que el wire menguó (kimi lo compactó o
// recreó). Dedup por solape: se busca el mayor k tal que las últimas k
// entradas archivadas == primeras k del re-escaneo (comparando role+text,
// ventana máx OVERLAP_MAX) y se añade solo el resto. Si no hay solape se
// añade todo con un warning — best-effort: preferimos duplicar a perder.
async function rescanWithDedup(slug, wire, size) {
  const fresh = parseWire(await fs.readFile(wire, 'utf8'));
  const existing = (await readArchive(slug)) || [];
  const window = existing.slice(-OVERLAP_MAX);
  let k = 0;
  const maxK = Math.min(window.length, fresh.length);
  outer: for (let cand = maxK; cand >= 1; cand--) {
    for (let i = 0; i < cand; i++) {
      const a = window[window.length - cand + i];
      if (a.role !== fresh[i].role || a.text !== fresh[i].text) continue outer;
    }
    k = cand;
    break;
  }
  if (k === 0 && fresh.length && existing.length) {
    console.warn(`historial: '${slug}' re-escaneado sin solape (wire recreado); se añade todo`);
  }
  const rest = fresh.slice(k);
  if (rest.length) await appendEntries(slug, rest);
  offsets[slug] = size;
  offsetsDirty = true;
}

async function appendEntries(slug, messages) {
  const now = Date.now();
  const lines = messages.map((m) => JSON.stringify({ ts: now, role: m.role, text: m.text })).join('\n') + '\n';
  await fs.appendFile(archivePath(slug), lines);
}

// Mensajes archivados de una sesión (con ts), o null si no hay archivo.
export async function readArchive(slug) {
  let raw;
  try {
    raw = await fs.readFile(archivePath(slug), 'utf8');
  } catch {
    return null;
  }
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j.text === 'string') messages.push({ ts: j.ts, role: j.role, text: j.text });
    } catch {
      /* línea parcial/corrupta: se ignora */
    }
  }
  return messages;
}
