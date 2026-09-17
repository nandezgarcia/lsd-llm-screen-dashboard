#!/usr/bin/env node
// Lista las tareas cron internas de kimi-cli de TODAS las sesiones.
// Las tareas viven como registros cron.add / cron.delete dentro del
// wire.jsonl de cada sesión (~/.kimi-code/sessions y, para sesiones Ollama
// del dashboard, data/kimi-ollama-home/sessions). No despierta a los agentes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const homes = [
  path.join(os.homedir(), '.kimi-code', 'sessions'),
  path.join(process.cwd(), 'data', 'kimi-ollama-home', 'sessions'),
];

const wires = [];
for (const root of homes) {
  if (!fs.existsSync(root)) continue;
  for (const wd of fs.readdirSync(root)) {
    const wdDir = path.join(root, wd);
    if (!fs.statSync(wdDir).isDirectory()) continue;
    for (const ses of fs.readdirSync(wdDir)) {
      const wire = path.join(wdDir, ses, 'agents', 'main', 'wire.jsonl');
      const state = path.join(wdDir, ses, 'state.json');
      if (fs.existsSync(wire)) wires.push({ wire, state });
    }
  }
}

let total = 0;
for (const { wire, state } of wires) {
  const tasks = new Map();
  for (const line of fs.readFileSync(wire, 'utf8').split('\n')) {
    if (!line.includes('"cron.')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'cron.add' && rec.task?.id) tasks.set(rec.task.id, rec.task);
    else if (rec.type === 'cron.delete') for (const id of rec.ids || []) tasks.delete(id);
  }
  if (!tasks.size) continue;
  let info = {};
  try { info = JSON.parse(fs.readFileSync(state, 'utf8')); } catch { /* sin state */ }
  console.log(`\n=== ${info.title || '(sin título)'} — ${info.cwd || wire}`);
  for (const t of tasks.values()) {
    total++;
    const prompt = t.prompt.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`  [${t.recurring === false ? 'una vez' : 'recurrente'}] ${t.cron}`);
    console.log(`    id: ${t.id} — creada: ${new Date(t.createdAt).toLocaleString('es-ES')}`);
    console.log(`    prompt: ${prompt}${t.prompt.length > 90 ? '…' : ''}`);
  }
}
if (!total) console.log('No hay tareas cron activas en ninguna sesión.');
else console.log(`\n${total} tarea(s) cron activas.`);
