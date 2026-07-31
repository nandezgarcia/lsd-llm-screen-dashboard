// Asistente de PRIMERA EJECUCIÓN: si el servidor arranca sin configuración
// (no existe .env o falta DEEPSEEK_API_KEY) y hay TTY, pide interactivamente
// los dos modelos: el del gestor (API: base URL + key + modelo, con lista en
// vivo de {baseUrl}/models) y el CLI de terminal de las sesiones (con
// instrucciones de instalación si el elegido no está en el PATH).
// Sin TTY (systemd, docker, CI) se salta con un aviso: NUNCA bloquea el
// arranque no interactivo. Con config existente ni se entera.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { config, updateEnv } from './config.js';

const ENV_PATH = path.join(config.root, '.env');
const MODEL_RE = /^[\w./:-]{1,100}$/;
const CLI_RE = /^[a-z0-9-]{1,30}$/;

// Instrucciones de instalación de los CLIs conocidos (texto para el usuario)
const INSTALL_HINTS = {
  kimi:
    '  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash\n' +
    '  (o: npm install -g @moonshot-ai/kimi-code — requiere Node >= 22.19)\n' +
    '  Después ejecuta `kimi` y haz /login con ESTE usuario.',
  claude:
    '  npm install -g @anthropic-ai/claude-code\n' +
    '  Después ejecuta `claude` y autentícate con ESTE usuario.',
  codex:
    '  npm install -g @openai/codex\n' +
    '  Después ejecuta `codex` y autentícate con ESTE usuario.',
};

function installHint(cli) {
  return (
    INSTALL_HINTS[cli] ||
    `  Instala '${cli}' siguiendo su documentación oficial y autentícalo con ESTE usuario.`
  );
}

async function askModel(rl, baseUrl, apiKey) {
  let models = [];
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) models = (await r.json()).data?.map((m) => m.id) || [];
  } catch {
    /* sin lista: se pide a mano */
  }
  if (models.length > 0) {
    console.log('\nModelos disponibles en la API:');
    models.forEach((m, i) => console.log(`  ${i + 1}) ${m}`));
    const def = models.includes('deepseek-chat') ? 'deepseek-chat' : models[0];
    for (;;) {
      const ans = await rl.question(`Modelo del gestor [${def}]: `);
      const v = ans.trim();
      if (v === '') return def;
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= models.length) return models[n - 1];
      if (MODEL_RE.test(v)) return v;
      console.log('Elige un número de la lista o escribe un nombre de modelo válido.');
    }
  }
  console.log('\n(No se pudo obtener la lista de modelos de la API; se pide a mano.)');
  for (;;) {
    const ans = await rl.question('Modelo del gestor [deepseek-chat]: ');
    const v = ans.trim() || 'deepseek-chat';
    if (MODEL_RE.test(v)) return v;
    console.log('Nombre inválido (letras, números y . _ / : -).');
  }
}

async function askCli(rl, installed) {
  const names = Object.keys(installed);
  if (names.length > 0) {
    console.log('\nCLIs de agente detectados en este equipo:');
    for (const n of names) console.log(`  - ${n} (${installed[n]})`);
  } else {
    console.log('\nNo se ha detectado ningún CLI de agente instalado.');
  }
  const def = installed.kimi ? 'kimi' : names[0] || 'kimi';
  let detected = { ...installed };
  for (;;) {
    const ans = await rl.question(`CLI de terminal para las sesiones [${def}]: `);
    const cli = (ans.trim() || def).toLowerCase();
    if (!CLI_RE.test(cli)) {
      console.log('Nombre inválido (minúsculas, números y guiones).');
      continue;
    }
    if (detected[cli]) return cli;
    console.log(`\n'${cli}' no está instalado (o no está en el PATH). Para instalarlo:`);
    console.log(installHint(cli));
    console.log('\nOpciones: instálalo en OTRA terminal y pulsa Enter para re-detectar,');
    console.log("escribe otro CLI, o escribe 'continuar' para guardarlo igualmente.");
    const sub = await rl.question('> ');
    const v = sub.trim().toLowerCase();
    if (v === 'continuar') {
      console.log(`AVISO: '${cli}' se guarda sin estar instalado; las sesiones no arrancarán hasta que lo instales.`);
      return cli;
    }
    if (v === '') {
      const { execFileSync } = await import('node:child_process');
      detected = {};
      for (const c of ['kimi', 'claude', 'codex', 'gemini', 'aider', 'opencode', 'goose', cli]) {
        try {
          const p = execFileSync('bash', ['-lc', `command -v ${c}`], { encoding: 'utf8' }).trim().split('\n')[0];
          if (p) detected[c] = p;
        } catch { /* no está */ }
      }
      const found = Object.keys(detected);
      console.log(found.length > 0 ? `Detectados ahora: ${found.join(', ')}` : 'Sigo sin detectar ninguno.');
      continue;
    }
    if (CLI_RE.test(v)) {
      if (detected[v]) return v;
      console.log(`'${v}' tampoco está instalado.`);
      console.log(installHint(v));
    } else {
      console.log('Nombre inválido.');
    }
  }
}

export async function maybeRunFirstSetup(installedAgents = {}) {
  if (fs.existsSync(ENV_PATH) && config.deepseekApiKey) return;
  if (!process.stdin.isTTY) {
    console.warn(
      'AVISO: configuración incompleta (sin .env o sin DEEPSEEK_API_KEY) y no hay terminal\n' +
      'interactiva para el asistente de primera ejecución. Edita .env o ejecuta install.sh.'
    );
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n==============================================================');
    console.log(' LSD — primera ejecución: configuración inicial');
    console.log('==============================================================');
    console.log('Se guardará en .env (editable luego con el botón ⚙ de la web).\n');

    // --- Paso 1: modelo del gestor (API) ---
    const baseAns = await rl.question(`Base URL de la API del gestor [${config.deepseekBaseUrl}]: `);
    const baseUrl = (baseAns.trim() || config.deepseekBaseUrl).replace(/\/+$/, '');
    let apiKey = config.deepseekApiKey;
    if (!apiKey) {
      const keyAns = await rl.question("API key del gestor (vacío = 'skip', configurarla luego): ");
      apiKey = keyAns.trim();
      if (!apiKey || apiKey.toLowerCase() === 'skip') {
        apiKey = '';
        console.log('AVISO: sin API key el gestor no funcionará hasta configurarla (web ⚙ o .env).');
      }
    }
    const model = apiKey
      ? await askModel(rl, baseUrl, apiKey)
      : config.deepseekModel;

    // --- Paso 2: CLI de terminal de las sesiones ---
    const cli = await askCli(rl, installedAgents);

    // --- Paso 3: persistir ---
    const changed = updateEnv({
      deepseekApiKey: apiKey,
      deepseekModel: model,
      deepseekBaseUrl: baseUrl,
      sessionCli: cli,
    });
    try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* mejor esfuerzo */ }
    console.log('\nConfiguración guardada en .env:');
    console.log(`  API:    ${config.deepseekBaseUrl} (modelo ${config.deepseekModel})`);
    console.log(`  Key:    ${config.deepseekApiKey ? '••••' + config.deepseekApiKey.slice(-4) : '(sin configurar)'}`);
    console.log(`  CLI:    ${config.sessionCli}`);
    if (Object.keys(changed).length === 0) console.log('  (sin cambios: valores vacíos)');
    console.log('');
  } catch (err) {
    // Ctrl-C / EOF: no abortar el arranque por el asistente
    console.warn(`\nAsistente de primera ejecución interrumpido (${err.message}); sigue el arranque.`);
  } finally {
    rl.close();
  }
}
