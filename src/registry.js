import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Registro persistente de sesiones: permite al dashboard recuperarse tras un
// reinicio (adoptar sesiones vivas) o un corte de luz (recrearlas con kimi -c).
// El contexto conversacional lo persiste kimi en ~/.kimi-code/sessions (wire.jsonl);
// aquí guardamos metadatos + snapshot visible del terminal.

const FILE = path.join(config.root, 'data', 'registry.json');

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    cache = { sessions: {} };
  }
  if (!cache.sessions) cache.sessions = {};
  return cache;
}

// Escritura atómica (tmp + rename) y DURABLE (fsync del archivo y del
// directorio). Sin fsync, un apagado brusco puede perder el rename y dejar
// el registry en un estado anterior (p.ej. sin las marcas de archivado:
// las archivadas "resucitan" en el siguiente arranque).
async function save() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(cache, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, FILE);
  const dir = await fs.open(path.dirname(FILE), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export async function getAll() {
  return (await load()).sessions;
}

export async function get(name) {
  return (await load()).sessions[name] || null;
}

export async function upsert(name, fields) {
  const sessions = (await load()).sessions;
  sessions[name] = { ...(sessions[name] || {}), ...fields, updatedAt: new Date().toISOString() };
  await save();
  return sessions[name];
}

export async function remove(name) {
  const sessions = (await load()).sessions;
  if (name in sessions) {
    delete sessions[name];
    await save();
  }
}
