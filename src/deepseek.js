import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, sessionEnv, sessionResumeArgs, assertSessionModelUp } from './config.js';
import * as screen from './screen.js';
import * as registry from './registry.js';
import * as history from './history.js';
import { getActivity } from './monitor.js';

const run = promisify(execFile);

const SYSTEM_PROMPT = `Eres el gestor de sesiones de este entorno local. Controlas sesiones de GNU Screen que ejecutan CLIs de agente (kimi, claude u otros). Puedes crear sesiones, listarlas, leer su salida de terminal, enviarles texto (seguido de Enter) y cerrarlas.

Reglas:
- Responde siempre en español.
- Antes de actuar sobre una sesión, comprueba que existe con list_sessions si no estás seguro.
- list_sessions devuelve { active, archived }. En 'active', el campo 'activity' de cada sesión indica si está 'trabajando' o 'esperando' (quieta, a la espera de entrada del usuario — el buen momento para mandarle instrucciones). En 'archived' están las sesiones cerradas a propósito (conservan su contexto y pueden reabrirse desde la web): NO son activas, no las confundas con las que están 'esperando'.
- Para dar instrucciones a una sesión usa send_input; el texto se pega en su terminal y se pulsa Enter. Ten en cuenta que son TUIs: espera unos segundos y usa read_session_output para ver el resultado.
- read_session_output solo muestra las últimas líneas visibles del terminal. Para saber qué ha hecho una sesión kimi DESDE EL PRINCIPIO (conversación completa archivada, con fecha de cada mensaje) usa read_session_history: es la fuente buena para resúmenes de largo recorrido.
- No crees ni cierres sesiones salvo que el usuario lo pida explícitamente.
- Las sesiones tienen un nombre id (slug sin espacios, p.ej. 'analisis-seguridad') y pueden tener una etiqueta legible con espacios. Al crear, puedes pasar nombres con espacios (el sistema genera el slug); el resto de herramientas usan siempre el nombre id que devuelve list_sessions.
- Puedes descubrir qué CLIs de agente hay instalados en el sistema con discover_agents (tú decides qué candidatos comprobar: kimi, claude, codex, gemini, aider, opencode…). Las sesiones nuevas se lanzan con el CLI que el usuario tenga configurado en el panel de Configuración.
- Cuando ejecutes acciones, resume al usuario qué hiciste y qué observaste.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description: 'Lista las sesiones: { active, archived }. Las activas incluyen estado (attached/detached), activity (trabajando/esperando) y contextSavedAt; las archivadas están cerradas a propósito (reabribles desde la web).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_session',
      description: 'Crea una nueva sesión screen ejecutando kimi con Deepseek como modelo. El directorio de trabajo por defecto es workspaces/<nombre>.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre de la sesión (puede tener espacios; el sistema genera el id slug).' },
          workdir: { type: 'string', description: 'Directorio de trabajo absoluto (opcional).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session_output',
      description: 'Lee las últimas líneas del terminal de una sesión.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          lines: { type: 'number', description: 'Número de líneas a leer (por defecto 120, máximo 500).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session_history',
      description: 'Lee el historial archivado de la conversación de una sesión kimi: todos los turnos desde el primer mensaje (rol, fecha, texto), no solo lo visible en pantalla. Sin parámetros devuelve los últimos 20 mensajes; con from (índice 0 = primer mensaje) puedes paginar a cualquier punto. El campo total indica cuántos mensajes hay.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          messages: { type: 'number', description: 'Cuántos mensajes devolver (por defecto 20, máximo 100).' },
          from: { type: 'number', description: 'Índice del primer mensaje a devolver (0 = el primero de la sesión; por defecto, los últimos).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_input',
      description: 'Envía texto al terminal de una sesión seguido de Enter. Úsalo para dar instrucciones al kimi que corre dentro.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          text: { type: 'string', description: 'Texto a escribir (máximo 2000 caracteres).' },
        },
        required: ['name', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_session',
      description: 'Cierra (mata) una sesión screen gestionada.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discover_agents',
      description: 'Comprueba qué CLIs de agente están instalados en el sistema (busca los binarios en el PATH del usuario). Pasa candidatos concretos o deja vacío para una lista habitual.',
      parameters: {
        type: 'object',
        properties: {
          candidates: {
            type: 'array',
            items: { type: 'string' },
            description: 'CLIs a comprobar (ej. ["kimi","claude","codex"]). Vacío = lista habitual.',
          },
        },
        required: [],
      },
    },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case 'list_sessions': {
      const sessions = await screen.listSessions();
      const saved = await registry.getAll().catch(() => ({}));
      const activity = getActivity();
      const active = sessions
        .filter((s) => s.managed)
        .map((s) => {
          const short = s.name.slice(screen.PREFIX.length);
          return {
            name: short,
            label: saved[short]?.label || null,
            status: s.status,
            activity: activity[short]?.activity || null,
            contextSavedAt: activity[short]?.contextSavedAt || null,
            pid: s.pid,
          };
        });
      const aliveNames = new Set(active.map((s) => s.name));
      const archived = Object.entries(saved)
        .filter(([short, e]) => e.archived && !aliveNames.has(short))
        .map(([short, e]) => ({
          name: short,
          label: e.label || null,
          contextSavedAt: e.contextSavedAt || null,
        }));
      return { active, archived };
    }
    case 'create_session': {
      if (!screen.isValidLabel(args.name)) throw new Error(`Nombre inválido: ${args.name}`);
      const slug = await screen.uniqueSlug(args.name);
      if (!slug) throw new Error('El nombre no genera un identificador válido');
      const label = args.name.trim();
      let workdir = args.workdir
        ? path.resolve(args.workdir)
        : path.join(config.workspacesDir, slug);
      // Igual que en la API web: el contenedor workspaces/ nunca es workdir
      if (workdir === config.workspacesDir) workdir = path.join(config.workspacesDir, slug);
      const full = screen.PREFIX + slug;
      const cli = config.sessionCli;
      const env = sessionEnv(cli);
      await assertSessionModelUp(env);
      await screen.createSession({
        name: full,
        workdir,
        env,
        cli,
        resumeArgs: sessionResumeArgs(cli),
        label,
      });
      return { created: slug, label, workdir, cli };
    }
    case 'read_session_output':
      return { output: await screen.readOutput(screen.PREFIX + args.name, args.lines ?? 120) };
    case 'read_session_history': {
      // Historial archivado (capa C): conversación completa desde el primer
      // mensaje. Se recorta cada texto para no reventar el contexto del gestor;
      // 'total' le dice que hay más si lo necesita (puede pedir más mensajes).
      const all = await history.readArchive(args.name);
      if (!all) throw new Error(`Sin historial archivado para '${args.name}' (¿no es kimi o es muy reciente?)`);
      const n = Math.min(Math.max(Number(args.messages) || 20, 1), 100);
      const from = args.from != null
        ? Math.min(Math.max(Number(args.from) || 0, 0), Math.max(all.length - 1, 0))
        : Math.max(all.length - n, 0);
      const tail = all.slice(from, from + n).map((m) => ({
        role: m.role,
        ts: m.ts ? new Date(m.ts).toISOString() : null,
        text: m.text.length > 2000 ? m.text.slice(0, 2000) + '…[recortado]' : m.text,
      }));
      return { total: all.length, from, returned: tail.length, messages: tail };
    }
    case 'send_input':
      return screen.sendInput(screen.PREFIX + args.name, args.text);
    case 'kill_session':
      return screen.killSession(screen.PREFIX + args.name);
    case 'discover_agents': {
      const DEFAULTS = ['kimi', 'claude', 'codex', 'gemini', 'aider', 'opencode', 'goose', 'amp', 'cursor-agent'];
      const candidates = (Array.isArray(args.candidates) && args.candidates.length
        ? args.candidates
        : DEFAULTS
      ).filter((c) => /^[a-z0-9._-]{1,40}$/i.test(c)).slice(0, 30);
      const found = {};
      const notFound = [];
      for (const c of candidates) {
        try {
          const { stdout } = await run('bash', ['-lc', `command -v ${c}`]);
          if (stdout.trim()) found[c] = stdout.trim().split('\n')[0];
          else notFound.push(c);
        } catch {
          notFound.push(c);
        }
      }
      return { found, notFound };
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

async function callDeepseek(messages) {
  const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.deepseekApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    }),
  });
  if (!res.ok) {
    throw new Error(`Deepseek API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

// Bucle de agente: el usuario manda el historial; devolvemos la respuesta final,
// el registro de herramientas ejecutadas y el historial completo para persistirlo.
// activeSession: sesión que el usuario tiene adjuntada en la web (si pide algo
// "de la sesión" sin nombrarla, se refiere a esa).
export async function runManagerChat(userMessages, activeSession = null) {
  if (!config.deepseekApiKey) throw new Error('Falta DEEPSEEK_API_KEY en .env');
  const system = activeSession
    ? SYSTEM_PROMPT +
      `\n\nContexto actual: el usuario tiene seleccionada y adjuntada la sesión '${activeSession}' en la web. Si pide algo sobre "la sesión", "esta sesión" o similar sin dar nombre, se refiere a '${activeSession}'.`
    : SYSTEM_PROMPT;
  const messages = [{ role: 'system', content: system }, ...userMessages];
  const toolLog = [];

  for (let i = 0; i < 10; i++) {
    const data = await callDeepseek(messages);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Respuesta vacía de Deepseek');
    messages.push(msg);

    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      return { reply: msg.content ?? '', toolLog, messages: messages.slice(1) };
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        /* args vacíos */
      }
      let result;
      try {
        result = await executeTool(tc.function.name, args);
      } catch (err) {
        result = { error: err.message };
      }
      toolLog.push({ tool: tc.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return {
    reply: '(se alcanzó el límite de iteraciones del gestor)',
    toolLog,
    messages: messages.slice(1),
  };
}
