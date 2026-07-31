import fs from 'node:fs/promises';
import path from 'node:path';
import { kimiHomeFor } from './config.js';

// Conversación real de una sesión kimi a partir de su wire.jsonl (formato
// interno de kimi, protocol_version 1.x): usuarios en `context.append_message`
// (role user) y respuestas del assistant en `context.append_loop_event` con
// event.type 'content.part' y part.type 'text' (markdown íntegro). Las partes
// de un mismo turno se agrupan. Si el formato cambia, fallamos en limpio y el
// frontend usa la vista Terminal (hardcopy) como fallback.
// Las sesiones Ollama tienen su propio KIMI_CODE_HOME: se localiza por baseUrl.

const MAX_TEXT = 20000;

// Exportada también para history.js (el archivador localiza el wire igual)
export async function findSessionDir(workdir, baseUrl) {
  const home = kimiHomeFor(baseUrl);
  const lines = (await fs.readFile(path.join(home, 'session_index.jsonl'), 'utf8'))
    .trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]);
    if (e.workDir === workdir) return e.sessionDir;
  }
  return null;
}

// Parser puro del wire: extrae los mensajes (user/assistant/tool) de un
// contenido de wire.jsonl (completo o un trozo de líneas enteras). Lo
// comparten readConversation (vista en caliente) y el archivador de
// history.js. Las partes de un turno solo se agrupan DENTRO del texto
// recibido: si un turno queda partido entre dos llamadas, salen dos
// mensajes assistant contiguos (límite aceptado del archivado incremental).
export function parseWire(raw) {
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'context.append_message' && j.message?.role === 'user') {
      const text = (j.message.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (text.trim()) messages.push({ role: 'user', text: text.slice(0, MAX_TEXT) });
    } else if (j.type === 'context.append_loop_event') {
      const ev = j.event || {};
      if (ev.type === 'content.part' && ev.part?.type === 'text' && ev.part.text.trim()) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant' && last.turnId === ev.turnId) {
          last.text += '\n\n' + ev.part.text;
        } else {
          messages.push({ role: 'assistant', turnId: ev.turnId, text: ev.part.text.slice(0, MAX_TEXT) });
        }
      } else if (ev.type === 'tool.call') {
        messages.push({ role: 'tool', text: ev.description || ev.name || 'herramienta' });
      }
    }
  }
  for (const m of messages) delete m.turnId;
  return messages;
}

export async function readConversation(workdir, baseUrl) {
  const sessionDir = await findSessionDir(workdir, baseUrl);
  if (!sessionDir) throw new Error('Sin sesión kimi registrada para ese workdir');
  const wire = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  return parseWire(await fs.readFile(wire, 'utf8'));
}
