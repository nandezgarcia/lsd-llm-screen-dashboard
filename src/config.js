import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Parser .env mínimo (KEY=VALUE por línea, sin dependencias externas)
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

loadEnv();

// Parsea y sanea DEPLOY_TARGETS (JSON array). Cualquier item inválido se
// descarta; JSON roto = [] (con aviso). Los regex importan: estos valores
// acaban como argumentos de ssh (execFile, sin shell) y en prompts del gestor.
const TARGET_RE = {
  name: /^[\w-]{1,40}$/,
  user: /^[a-z_][a-z0-9_-]{0,31}$/i,
  host: /^[\w.-]{1,100}$/,
  basePath: /^\/[\w./-]{0,200}$/,
};
export function parseDeployTargets(json) {
  if (!json) return [];
  let arr;
  try {
    arr = JSON.parse(json);
  } catch {
    console.warn('[config] DEPLOY_TARGETS no es JSON válido; ignorado');
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((t) => t && TARGET_RE.name.test(t.name || '') &&
      TARGET_RE.user.test(t.user || '') && TARGET_RE.host.test(t.host || '') &&
      TARGET_RE.basePath.test(t.basePath || '/'))
    .map((t) => ({
      name: t.name,
      user: t.user,
      host: t.host,
      port: Number(t.port) > 0 && Number(t.port) < 65536 ? Number(t.port) : 22,
      basePath: t.basePath || '/',
    }))
    .slice(0, 20);
}

// Config de "Publicar" (botón 🌐): UN solo destino fijo (por defecto el hosting
// de kiokao.com) con auth por CONTRASEÑA (sshpass), a diferencia de ⬆ Subir
// (DEPLOY_TARGETS, varios destinos con clave SSH). La contraseña vive solo en
// .env y en process.env: el gestor la usa como $PUBLISH_PASSWORD vía sshpass -e
// (nunca aparece en prompts ni en la API pública).
const PUBLISH_DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/;
function publishFromEnv() {
  const domain = PUBLISH_DOMAIN_RE.test(process.env.PUBLISH_DOMAIN || '')
    ? process.env.PUBLISH_DOMAIN
    : 'kiokao.com';
  const host = TARGET_RE.host.test(process.env.PUBLISH_HOST || '')
    ? process.env.PUBLISH_HOST
    : '';
  return {
    domain,
    // vacío = el servidor es el propio dominio
    host: host || domain,
    user: TARGET_RE.user.test(process.env.PUBLISH_USER || '') ? process.env.PUBLISH_USER : '',
    password: process.env.PUBLISH_PASSWORD || '',
    basePath: TARGET_RE.basePath.test(process.env.PUBLISH_BASE_PATH || '')
      ? process.env.PUBLISH_BASE_PATH
      : '/var/www',
    port: Number(process.env.PUBLISH_PORT) > 0 && Number(process.env.PUBLISH_PORT) < 65536
      ? Number(process.env.PUBLISH_PORT)
      : 22,
  };
}

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  // Interfaz de escucha: 127.0.0.1 = solo esta máquina, 0.0.0.0 = toda la red.
  // No editable desde la web (solo se aplica al arrancar); se define en .env.
  host: process.env.HOST || '0.0.0.0',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  sessionCli: process.env.SESSION_CLI || 'kimi',
  // Informe periódico del gestor sobre las sesiones activas (minutos; 0 = off)
  reportIntervalMin: Number(process.env.REPORT_INTERVAL_MIN || 0),
  // Bot de Matrix (opcional; sin estas claves no arranca). No editable desde
  // la web (como HOST): se define en .env y se aplica al arrancar.
  matrixHomeserver: process.env.MATRIX_HOMESERVER || '',
  matrixUser: process.env.MATRIX_USER || '',
  matrixAccessToken: process.env.MATRIX_ACCESS_TOKEN || '',
  matrixAllowedUsers: (process.env.MATRIX_ALLOWED_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  workspacesDir: path.join(ROOT, 'workspaces'),
  // Destinos de despliegue SSH (botón ⬆ Subir): JSON array en DEPLOY_TARGETS.
  // Sin secretos aquí: la auth son las claves ~/.ssh del usuario. El despliegue
  // lo ejecuta el AGENTE de la sesión por SSH, orquestado por el gestor.
  deployTargets: parseDeployTargets(process.env.DEPLOY_TARGETS),
  // Publicación web (botón 🌐 Publicar): destino único con contraseña
  publish: publishFromEnv(),
};

// Variables que recibe cada sesión kimi dentro de screen.
// Sin override: la sesión usa la configuración propia de kimi (config.toml del
// usuario), sin inyectar nada. El override puede ser GLOBAL (KIMI_SESSION_MODEL
// del .env) o POR SESIÓN ({ model, baseUrl } elegido en el formulario de crear;
// el por-sesión manda sobre el global).
// Ollama (:11434) NO soporta thinking (`400 does not support thinking`) y no
// hay env/flag para desactivarlo (capabilities solo AÑADE, documentado). La
// única palanca es `[thinking] enabled = false` en config.toml, así que las
// sesiones Ollama arrancan con KIMI_CODE_HOME propio (ver ensureOllamaKimiHome).
export function kimiEnv({ model, baseUrl } = {}) {
  const m = model || process.env.KIMI_SESSION_MODEL;
  if (!m) return {};
  const env = {
    KIMI_MODEL_NAME: m,
    KIMI_MODEL_PROVIDER_TYPE: 'openai',
    KIMI_MODEL_BASE_URL:
      baseUrl || process.env.KIMI_SESSION_BASE_URL || 'https://api.deepseek.com/v1',
    KIMI_MODEL_API_KEY: config.deepseekApiKey,
  };
  if (process.env.KIMI_SESSION_CAPABILITIES) {
    env.KIMI_MODEL_CAPABILITIES = process.env.KIMI_SESSION_CAPABILITIES;
  }
  if (env.KIMI_MODEL_BASE_URL.includes('11434')) {
    env.KIMI_CODE_HOME = ensureOllamaKimiHome();
  }
  return env;
}

// Entorno de lanzamiento según el CLI de agente elegido para las sesiones.
// kimi usa KIMI_MODEL_*; otros CLIs heredan el entorno del login shell del usuario.
export function sessionEnv(cli, override) {
  return cli === 'kimi' ? kimiEnv(override) : {};
}

// ---------- Home de kimi para sesiones Ollama ----------

export function defaultKimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

// Home compartido de las sesiones Ollama: config del usuario con thinking
// APAGADO de fábrica (Ollama rechaza thinking y no hay otra forma de
// desactivarlo por sesión — ver kimiEnv). Determinista desde el primer byte;
// sustituye al antiguo autoDisableThinkingForOllama, que conducía el menú
// /model a ciegas y perdía la carrera si el usuario escribía antes.
export const OLLAMA_KIMI_HOME = path.join(ROOT, 'data', 'kimi-ollama-home');

// Home efectivo de una sesión según la base URL de su modelo — para localizar
// su session_index.jsonl (monitor 💾 y vista Conversación)
export function kimiHomeFor(baseUrl) {
  return baseUrl?.includes('11434') ? OLLAMA_KIMI_HOME : defaultKimiHome();
}

// Fuerza `enabled = false` dentro de la sección [thinking] (o la añade)
function withThinkingDisabled(toml) {
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[thinking]');
  if (start === -1) return toml.trimEnd() + '\n\n[thinking]\nenabled = false\n';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  for (let i = start + 1; i < end; i++) {
    if (/^\s*enabled\s*=/.test(lines[i])) {
      lines[i] = lines[i].replace(/enabled\s*=\s*[^#\s]+/, 'enabled = false');
      return lines.join('\n');
    }
  }
  lines.splice(start + 1, 0, 'enabled = false');
  return lines.join('\n');
}

// Construye/actualiza el home Ollama: config.toml del usuario con thinking
// off + enlaces a sus recursos (skills, tui.toml…) para que la sesión no
// pierda nada. Las sesiones y su índice son propios del home (kimi -c las
// reanuda por workdir). Se regenera en cada creación (barato, config al día).
export function ensureOllamaKimiHome() {
  const src = defaultKimiHome();
  fs.mkdirSync(OLLAMA_KIMI_HOME, { recursive: true });
  for (const name of ['skills', 'agents', 'plugins', 'hooks', 'mcp.json', 'tui.toml', 'workspaces.json']) {
    const target = path.join(src, name);
    const link = path.join(OLLAMA_KIMI_HOME, name);
    try {
      if (fs.existsSync(target) && !fs.existsSync(link)) fs.symlinkSync(target, link);
    } catch { /* enlazar es mejor esfuerzo */ }
  }
  // Marcas de "migración kimi-cli gestionada": sin ellas, kimi mostraría el
  // asistente interactivo de migración en este home y bloquearía el arranque
  for (const name of ['migration-report.json', 'migration-errors.log', 'migrations-effort.json']) {
    const target = path.join(src, name);
    const dest = path.join(OLLAMA_KIMI_HOME, name);
    try {
      if (fs.existsSync(target) && !fs.existsSync(dest)) fs.copyFileSync(target, dest);
    } catch { /* mejor esfuerzo */ }
  }
  let toml = '';
  try {
    toml = fs.readFileSync(path.join(src, 'config.toml'), 'utf8');
  } catch { /* sin config del usuario: se crea mínima */ }
  const out = path.join(OLLAMA_KIMI_HOME, 'config.toml');
  fs.writeFileSync(out, withThinkingDisabled(toml));
  fs.chmodSync(out, 0o600); // puede contener claves del usuario
  return OLLAMA_KIMI_HOME;
}

// Guardia de creación: si la base URL del modelo de la sesión es LOCAL
// (localhost/127.0.0.1/::1, p. ej. Ollama) y no responde, la sesión saldría
// rota en silencio (kimi arranca pero toda llamada da connection_error).
// Mejor fallar la creación con un mensaje accionable. URLs remotas: no se
// comprueban (un corte de red no debe impedir crear sesiones).
export async function assertSessionModelUp(env) {
  const base = env?.KIMI_MODEL_BASE_URL;
  if (!base) return;
  let u;
  try {
    u = new URL(base);
  } catch {
    return;
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return;
  try {
    await fetch(base, { signal: AbortSignal.timeout(1500) });
  } catch {
    throw new Error(
      `El servidor local del modelo no responde (${base}). ` +
      `Arráncalo (p. ej. \`ollama serve\`) o elige otro modelo para la sesión.`
    );
  }
}

// Flag para reanudar la conversación previa al restaurar una sesión
export function sessionResumeArgs(cli) {
  return { kimi: ' -c', claude: ' --continue' }[cli] || '';
}

// ---------- Configuración editable desde la web ----------

const ENV_PATH = path.join(ROOT, '.env');

// Config pública para la UI: NUNCA devuelve la API key completa, solo una pista.
// Las URLs devuelven el valor EFECTIVO (con defaults aplicados), no el del .env.
export function publicConfig() {
  const key = config.deepseekApiKey;
  return {
    deepseekModel: config.deepseekModel,
    deepseekBaseUrl: config.deepseekBaseUrl,
    // vacío = sin override: las sesiones kimi usan su propia configuración
    kimiSessionModel: process.env.KIMI_SESSION_MODEL || '',
    kimiSessionBaseUrl: process.env.KIMI_SESSION_BASE_URL || '',
    sessionCli: config.sessionCli,
    reportIntervalMin: config.reportIntervalMin,
    // Solo el flag, nunca el token
    matrixEnabled: Boolean(config.matrixHomeserver && config.matrixAccessToken),
    // Destinos de despliegue SSH (sin secretos: la auth son las ~/.ssh del usuario)
    deployTargets: config.deployTargets,
    // Publicación web: configuración visible EXCEPTO la contraseña (solo flag)
    publish: {
      domain: config.publish.domain,
      host: config.publish.host,
      user: config.publish.user,
      basePath: config.publish.basePath,
      port: config.publish.port,
      passwordSet: Boolean(config.publish.password),
      configured: Boolean(config.publish.user && config.publish.password),
    },
    apiKeySet: Boolean(key),
    apiKeyHint: key ? `••••${key.slice(-4)}` : '',
  };
}

// Actualiza claves del .env (y process.env/config en caliente). `updates` solo
// admite las claves conocidas; los valores vacíos NO se escriben (sin cambios),
// EXCEPTO en CLEARABLE (override opcional del modelo de sesiones kimi), donde
// vacío significa "quitar el override y usar la config propia de kimi".
const EDITABLE = {
  deepseekModel: 'DEEPSEEK_MODEL',
  deepseekBaseUrl: 'DEEPSEEK_BASE_URL',
  kimiSessionModel: 'KIMI_SESSION_MODEL',
  kimiSessionBaseUrl: 'KIMI_SESSION_BASE_URL',
  deepseekApiKey: 'DEEPSEEK_API_KEY',
  sessionCli: 'SESSION_CLI',
  reportIntervalMin: 'REPORT_INTERVAL_MIN',
  deployTargets: 'DEPLOY_TARGETS',
  publishDomain: 'PUBLISH_DOMAIN',
  publishHost: 'PUBLISH_HOST',
  publishUser: 'PUBLISH_USER',
  publishPassword: 'PUBLISH_PASSWORD',
  publishBasePath: 'PUBLISH_BASE_PATH',
  publishPort: 'PUBLISH_PORT',
};
const CLEARABLE = new Set(['KIMI_SESSION_MODEL', 'KIMI_SESSION_BASE_URL', 'DEPLOY_TARGETS', 'PUBLISH_HOST']);

export function updateEnv(updates) {
  const changed = {};
  for (const [field, envKey] of Object.entries(EDITABLE)) {
    const value = updates[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '' || CLEARABLE.has(envKey)) changed[envKey] = trimmed;
  }
  if (Object.keys(changed).length === 0) return changed;

  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] in changed && !line.trim().startsWith('#')) {
      seen.add(m[1]);
      return `${m[1]}=${changed[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(changed)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n'));

  // Aplicar en caliente
  for (const [k, v] of Object.entries(changed)) process.env[k] = v;
  if (changed.DEEPSEEK_API_KEY) config.deepseekApiKey = changed.DEEPSEEK_API_KEY;
  if (changed.DEEPSEEK_MODEL) config.deepseekModel = changed.DEEPSEEK_MODEL;
  if (changed.DEEPSEEK_BASE_URL) config.deepseekBaseUrl = changed.DEEPSEEK_BASE_URL;
  if (changed.SESSION_CLI) config.sessionCli = changed.SESSION_CLI;
  if (changed.REPORT_INTERVAL_MIN !== undefined) {
    config.reportIntervalMin = Number(changed.REPORT_INTERVAL_MIN) || 0;
  }
  if (changed.DEPLOY_TARGETS !== undefined) {
    config.deployTargets = parseDeployTargets(changed.DEPLOY_TARGETS);
  }
  if (Object.keys(changed).some((k) => k.startsWith('PUBLISH_'))) {
    config.publish = publishFromEnv();
  }
  return changed;
}
