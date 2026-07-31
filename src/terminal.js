import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import * as screen from './screen.js';
import { noteAttach } from './monitor.js';

// Terminal interactivo: cada conexión a /ws?name=<sesión> adjunta el navegador
// a la sesión screen con `screen -x` (multi-display: no expulsa a otros y la
// sesión pasa a Attached). Al cerrarse el WS se mata el pty y queda Detached.

const clamp = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : dflt;
};

export function setupTerminalWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, url));
  });
}

async function attach(ws, url) {
  const fail = (msg) => {
    ws.send(JSON.stringify({ type: 'error', data: msg }));
    ws.close();
  };

  const short = url.searchParams.get('name') || '';
  if (!screen.isValidName(short)) return fail(`Nombre inválido: ${short}`);
  const name = screen.PREFIX + short;

  const sessions = await screen.listSessions().catch(() => []);
  if (!sessions.some((s) => s.name === name)) return fail(`La sesión '${short}' no existe`);

  const cols = clamp(url.searchParams.get('cols'), 20, 300, 80);
  const rows = clamp(url.searchParams.get('rows'), 5, 100, 24);

  const term = pty.spawn('screen', ['-U', '-xS', name], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME,
    env: process.env,
  });
  // El attach (y el detach al cerrar) redibuja/redimensiona el terminal:
  // avisar al monitor para que no lo confunda con actividad de la sesión
  noteAttach(short);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'data' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize') {
      term.resize(clamp(msg.cols, 20, 300, cols), clamp(msg.rows, 5, 100, rows));
    }
  });
  ws.on('close', () => {
    noteAttach(short);
    term.kill();
  });
}
