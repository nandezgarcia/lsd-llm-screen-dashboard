import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, sessionEnv, sessionResumeArgs } from './config.js';
import * as screen from './screen.js';
import * as registry from './registry.js';

const run = promisify(execFile);

// Recuperación al arrancar el servidor:
// - sesión viva y registrada     -> adoptar (solo cayó el servidor)
// - sesión viva sin registrar    -> registrar (se creó con el servidor caído);
//                                   workdir por /proc/<pid-hijo>/cwd, si se puede
// - registrada pero no viva      -> restaurar con `kimi -c` (corte de luz/reboot:
//                                   kimi reanuda su última sesión en ese workdir)

async function workdirOf(screenPid) {
  try {
    const { stdout } = await run('ps', ['-o', 'pid=', '--ppid', String(screenPid)]);
    const child = stdout.trim().split('\n')[0].trim();
    if (child) return await fs.readlink(`/proc/${child}/cwd`);
  } catch {
    /* mejor esfuerzo */
  }
  return null;
}

export async function recoverSessions() {
  const result = { adoptadas: [], registradas: [], restauradas: [], fallidas: [], archivadasVivas: [] };
  const saved = await registry.getAll();
  const alive = (await screen.listSessions()).filter((s) => s.managed);
  const aliveNames = new Map(alive.map((s) => [s.name.slice(screen.PREFIX.length), s]));

  // Vivas: adoptar o registrar. OJO: si está archivada pero el screen sigue
  // vivo (el kill del archivado falló o se recreó fuera del dashboard), manda
  // el registry: se cierra el screen y sigue archivada. NUNCA se levanta la
  // marca de archivado desde aquí (antes un upsert con archived:false la
  // destruía silenciosamente y la sesión "resucitaba" en el próximo reinicio).
  for (const [short, s] of aliveNames) {
    const entry = saved[short];
    if (entry?.archived) {
      await screen.killSession(s.name).catch(() => {});
      result.archivadasVivas.push(short);
    } else if (entry?.workdir) {
      await registry.upsert(short, { status: s.status });
      result.adoptadas.push(short);
    } else {
      const workdir =
        (await workdirOf(s.pid)) || path.join(config.workspacesDir, short);
      await registry.upsert(short, { workdir, status: s.status, archived: false });
      result.registradas.push(short);
    }
  }

  // Registradas pero no vivas: restaurar con el contexto guardado por el CLI.
  // Las archivadas NO se restauran: el usuario las cerró a propósito.
  for (const [short, entry] of Object.entries(saved)) {
    if (aliveNames.has(short) || entry.archived) continue;
    const workdir = entry.workdir || path.join(config.workspacesDir, short);
    const cli = entry.cli || config.sessionCli;
    try {
      // Se restaura con el MISMO modelo con que se creó (override por sesión).
      // Sin guardia de modelo aquí: en el arranque se restaura aunque el
      // servidor local del modelo esté parado (la sesión arranca igualmente)
      await screen.createSession({
        name: screen.PREFIX + short,
        workdir,
        env: sessionEnv(cli, entry.model ? { model: entry.model, baseUrl: entry.baseUrl } : undefined),
        cli,
        resume: true,
        resumeArgs: sessionResumeArgs(cli),
      });
      await registry.upsert(short, { workdir, cli, status: 'Detached', restaurada: true });
      result.restauradas.push(short);
    } catch (err) {
      result.fallidas.push(`${short}: ${err.message}`);
    }
  }

  return result;
}
