import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import * as registry from './registry.js';

const run = promisify(execFile);

// Solo gestionamos sesiones screen con este prefijo (las creadas por el gestor).
export const PREFIX = 'kimi-';

const shortName = (name) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

export function isValidName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,48}$/.test(name);
}

// Etiqueta legible (lo que escribe el usuario: puede tener espacios, tildes…)
export function isValidLabel(label) {
  return (
    typeof label === "string" &&
    label.trim().length > 0 &&
    label.length <= 50 &&
    !/[\\/\u0000-\u001f]/.test(label) // sin barras ni caracteres de control
  );
}

// La etiqueta se muestra en la UI; internamente todo usa un slug id seguro
// para screen, workdir y URLs ("Análisis seguridad" -> "analisis-seguridad").
export function slugify(label) {
  return String(label)
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // quita tildes/diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Slug único: si "mi sesion" ya existe, genera "mi-sesion-2", etc.
export async function uniqueSlug(label) {
  const base = slugify(label);
  if (!base) return null;
  const taken = new Set((await listSessions()).map((s) => s.name));
  let saved = {};
  try {
    saved = await registry.getAll();
  } catch { /* registry aún no disponible */ }
  let slug = base;
  let n = 2;
  while (taken.has(PREFIX + slug) || saved[slug]) slug = `${base}-${n++}`;
  return slug;
}

function assertManaged(name) {
  if (!isValidName(name)) throw new Error(`Nombre de sesión inválido: ${name}`);
}

// screen -ls devuelve líneas tipo: "  12345.kimi-demo\t(Detached)"
export async function listSessions() {
  let out = '';
  try {
    ({ stdout: out } = await run('screen', ['-ls']));
  } catch (err) {
    // screen -ls sale con código 1 cuando hay sesiones; solo propagamos si no hay salida
    out = err.stdout || '';
    if (!out) return [];
  }
  const sessions = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\.(\S+)\s+(.*)$/);
    if (!m) continue;
    // El estado es el ÚLTIMO grupo entre paréntesis (antes va la fecha)
    const parens = [...m[3].matchAll(/\(([^)]+)\)/g)];
    if (parens.length === 0) continue;
    sessions.push({
      pid: Number(m[1]),
      name: m[2],
      status: parens[parens.length - 1][1],
      managed: m[2].startsWith(PREFIX),
    });
  }
  return sessions;
}

async function exists(name) {
  return (await listSessions()).some((s) => s.name === name);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export async function createSession({ name, workdir, env, resume = false, cli = 'kimi', resumeArgs = '', label = null, model = null, baseUrl = null }) {
  assertManaged(name);
  if (!/^[a-z0-9-]{1,30}$/.test(cli)) throw new Error(`CLI de agente inválido: ${cli}`);
  if (await exists(name)) throw new Error(`La sesión '${name}' ya existe`);
  await fs.mkdir(workdir, { recursive: true });
  // Log crudo continuo del terminal (capa B del historial): caja negra
  // forense en disco. NO se integra en la UI — un TUI repinta constantemente
  // y el crudo ANSI es ilegible; es solo para inspección manual.
  const logsDir = path.join(config.root, 'data', 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shQuote(v)};`)
    .join(' ');
  // resume: reanuda la conversación previa del CLI (kimi -c, claude --continue…)
  const script = `cd ${shQuote(workdir)} && ${exports} exec ${cli}${resume ? resumeArgs : ''}`;
  // -U fuerza modo UTF-8 para que los hardcopy no vuelquen el alternate charset crudo
  // -fn desactiva el flow control de screen: si no, ^S (Ctrl+S) tecleado desde un
  // display adjunto (terminal web) lo intercepta screen como XOFF y NUNCA llega a
  // la app (con `screen -X stuff` no se nota: inyecta directo en la ventana)
  await run('screen', ['-U', '-fn', '-L', '-Logfile', path.join(logsDir, `${shortName(name)}.log`), '-dmS', name, 'bash', '-lc', script]);
  // model/baseUrl: override por sesión — se guarda para que reopen/recovery
  // la restauren con EL MISMO modelo aunque la config global cambie
  await registry.upsert(shortName(name), {
    workdir,
    cli,
    ...(label ? { label } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  }).catch(() => {});
  return { name, workdir };
}

// GNU screen tiene un bug conocido: hardcopy no escribe UTF-8, sino el byte bajo
// del codepoint de cada celda. Reconstruimos lo posible:
// - 0x00-0x1F y 0x80-0x9F  -> U+2500+byte (bordes ─ │ y bloques ▀▐█ del TUI)
// - 0xA0-0xFF              -> Latin-1 (tildes, ñ...) — el TUI casi no usa U+25A0+
// - esquinas redondeadas ╭╮╰╯ llegan como 'm' 'n' 'p' 'o' y se restauran por contexto
// - emojis/caracteres anchos llegan como <byte bajo>+0xFF ("4ÿ"=🔴, "àÿ"=🟠):
//   el original es irrecuperable -> se sustituye la pareja por ◆
// - uniones de tablas cuyo byte bajo es ASCII imprimible se restauran por contexto:
//   ┬ (0x2C ',') en bordes con ┌, ┴ (0x34 '4') en bordes con └,
//   ┼ (0x3C '<') y ┤ (0x24 '$') cuando van pegados a ─
function decodeHardcopy(buf) {
  let s = '';
  for (const b of buf) {
    if (b === 0x0a) s += '\n';
    else if (b === 0x09) s += '\t';
    else if (b < 0x20 || b === 0x7f || (b >= 0x80 && b <= 0x9f)) s += String.fromCodePoint(0x2500 + b);
    else s += String.fromCharCode(b); // ASCII imprimible y Latin-1
  }
  return s
    .replace(/^(\s*)m(─+)n(\s*)$/gm, '$1╭$2╮$3')
    .replace(/^(\s*)p(─+)o(\s*)$/gm, '$1╰$2╯$3')
    .replace(/.\u00FF/g, '◆ ') // 2 celdas -> 2 chars, conserva el ancho
    .split('\n')
    .map(fixTableLine)
    .join('\n');
}

function fixTableLine(line) {
  if (!line.includes('─')) return line;
  let l = line;
  if (l.includes('┌')) l = l.replace(/,/g, '┬');
  if (l.includes('└')) l = l.replace(/4/g, '┴');
  l = l.replace(/(?<=─)</g, '┼').replace(/(?<=─)\$/g, '┤');
  return l;
}

// Captura el contenido visible del terminal de la sesión (con scrollback corto).
export async function readOutput(name, lines = 120) {
  return hardcopy(name, lines, false);
}

// Captura visible + scrollback completo de screen (hardcopy -h) para el historial.
export async function readHistory(name, lines = 2000) {
  return hardcopy(name, lines, true);
}

async function hardcopy(name, lines, withScrollback) {
  assertManaged(name);
  if (!(await exists(name))) throw new Error(`La sesión '${name}' no existe`);
  // nombre único: monitor + endpoints pueden capturar a la vez
  const tmp = path.join(
    os.tmpdir(),
    `ksg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  try {
    const args = ['-S', name, '-X', 'hardcopy'];
    if (withScrollback) args.push('-h');
    args.push(tmp);
    await run('screen', args);
    const content = decodeHardcopy(await fs.readFile(tmp));
    const trimmed = content.split('\n');
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    return trimmed.slice(-Math.min(Math.max(lines, 1), 5000)).join('\n');
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// Envía texto a la sesión seguido de Enter (retorno de carro real).
// La pausa intermedia es necesaria: si el \r llega antes de que el TUI haya
// procesado el texto pegado, el Enter se pierde y el comando no se ejecuta.
export async function sendInput(name, text) {
  assertManaged(name);
  if (typeof text !== 'string' || text.length === 0 || text.length > 2000) {
    throw new Error('Texto de entrada inválido');
  }
  if (!(await exists(name))) throw new Error(`La sesión '${name}' no existe`);
  await run('screen', ['-S', name, '-X', 'stuff', text]);
  await new Promise((r) => setTimeout(r, 400));
  await run('screen', ['-S', name, '-X', 'stuff', '\r']);
  return { sent: true };
}

export async function killSession(name) {
  assertManaged(name);
  if (!(await exists(name))) throw new Error(`La sesión '${name}' no existe`);
  await run('screen', ['-S', name, '-X', 'quit']);
  // El registry lo gestiona el monitor (marca archivada) o el endpoint DELETE
  return { killed: name };
}
