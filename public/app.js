const sessionList = document.getElementById('session-list');
const terminalEl = document.getElementById('terminal');
const outputTitle = document.getElementById('output-title');
const createForm = document.getElementById('create-form');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

let selected = null;
let chatHistory = []; // historial que se reenvía al gestor (sin el system prompt)

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Terminal interactivo (xterm.js + WebSocket) ----------

let term = null;
let termSocket = null;
let fitAddon = null;

function detachTerminal() {
  closeHistory();
  if (termSocket) {
    termSocket.onclose = null;
    termSocket.close();
    termSocket = null;
  }
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }
  terminalEl.textContent = t('terminal.selectSession');
  outputTitle.textContent = t('terminal.title');
}

// ---------- Historial (overlay con pestañas) ----------
// Pestaña Conversación: markdown íntegro desde el wire.jsonl de kimi (la vista
// rica, con colores). Pestaña Terminal: scrollback crudo de screen
// (hardcopy -h) — GNU screen NO puede volcar color, es una limitación de
// hardcopy (no hay equivalente a `tmux capture-pane -e`); por eso el default
// es Conversación y Terminal queda como vista forense con formato mínimo.

const historyOverlay = document.getElementById('history-overlay');
const historyContent = document.getElementById('history-content');
const historyName = document.getElementById('history-name');
let historyMode = localStorage.getItem('hist-mode') || 'conv'; // recuerda la última pestaña usada

function refitTerminal() {
  if (!term || !fitAddon) return;
  fitAddon.fit();
  if (termSocket && termSocket.readyState === WebSocket.OPEN) {
    termSocket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function openHistory() {
  if (!selected || !historyOverlay.classList.contains('hidden')) return;
  historyName.textContent = selected;
  document.getElementById('hist-tab-conv').classList.toggle('active', historyMode === 'conv');
  document.getElementById('hist-tab-term').classList.toggle('active', historyMode === 'term');
  historyOverlay.classList.remove('hidden');
  loadHistory();
}

function setHistoryMode(mode) {
  historyMode = mode;
  localStorage.setItem('hist-mode', mode);
  document.getElementById('hist-tab-conv').classList.toggle('active', mode === 'conv');
  document.getElementById('hist-tab-term').classList.toggle('active', mode === 'term');
  loadHistory();
}

// Separador de turnos en la vista Terminal del historial: la burbuja del
// usuario llega como "◆  <texto>" (el emoji ✨ del TUI, vía decodeHardcopy).
// Antes de cada una (salvo la primera) = donde acabó la respuesta del LLM y
// empezó tu siguiente consulta. En la TUI en vivo no se puede inyectar nada
// (kimi se dibuja a sí misma; los hooks de kimi no imprimen en pantalla).
// El texto se traduce: por eso es función y no const (se evalúa al pintar).
// El scrollback no tiene horas: el ts llega del historial archivado (capa C)
// cruzando el texto de la burbuja con el del mensaje (ver loadHistory).
function fmtTurnTs(ts) {
  return new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function turnSep(ts = null) {
  const when = ts ? ` — ${fmtTurnTs(ts)}` : '';
  return '─'.repeat(18) + ' ' + t('history.turnSep') + when + ' ' + '─'.repeat(18);
}
const normText = (s) => s.replace(/\s+/g, ' ').trim();

// lookup texto de burbuja -> ts del mensaje archivado. Se comparan los
// primeros 60 chars normalizados (la burbuja corta por ancho de terminal)
function userTsLookup(messages) {
  const map = new Map();
  for (const m of messages || []) {
    if (m.role !== 'user' || !m.ts) continue;
    const key = normText(m.text).slice(0, 60);
    if (key) map.set(key, m.ts);
  }
  return (line) => map.get(normText(line.replace(/^ ◆ {2}/, '')).slice(0, 60)) || null;
}

function markTurns(text, tsOf = () => null) {
  if (!text) return text;
  let first = true;
  return text
    .split('\n')
    .map((line) => {
      if (!/^ ◆ {2}\S/.test(line)) return line;
      if (first) {
        first = false;
        return line;
      }
      return `${turnSep(tsOf(line))}\n${line}`;
    })
    .join('\n');
}

// Vista Terminal del historial: el hardcopy de screen es SOLO texto (sin
// color posible), así que se le da un mínimo de formato al propio texto:
// burbujas del usuario (◆) con el look oscuro del TUI y separadores de turno
// atenuados. Todo el contenido se escapa antes de envolverlo.
function renderTermHistory(text) {
  if (!text) return '';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sepText = t('history.turnSep');
  return text
    .split('\n')
    .map((line) => {
      const e = esc(line);
      if (/^ ◆ {2}\S/.test(line)) return `<span class="hist-user">${e}</span>`;
      if (line.includes(sepText)) return `<span class="hist-sep">${e}</span>`;
      return e;
    })
    .join('\n');
}

async function loadHistory() {
  if (!selected || historyOverlay.classList.contains('hidden')) return;
  historyContent.className = historyMode === 'term' ? 'term-view' : 'conv-view';
  historyContent.textContent = t('common.loading');
  if (historyMode === 'term') {
    try {
      // El scrollback no tiene horas: se cruzan las burbujas del usuario con
      // los mensajes archivados (que sí traen ts) para fechar cada separador
      const [{ output }, conv] = await Promise.all([
        api(`/api/sessions/${encodeURIComponent(selected)}/history?lines=2000`),
        api(`/api/sessions/${encodeURIComponent(selected)}/conversation`).catch(() => ({ messages: [] })),
      ]);
      const marked = markTurns(output, userTsLookup(conv.messages));
      if (marked) historyContent.innerHTML = renderTermHistory(marked);
      else historyContent.textContent = t('history.empty');
    } catch (err) {
      historyContent.textContent = `${t('common.error')}: ${err.message}`;
    }
  } else {
    try {
      const { messages } = await api(`/api/sessions/${encodeURIComponent(selected)}/conversation`);
      historyContent.innerHTML = '';
      if (!messages.length) historyContent.textContent = t('history.emptyConv');
      let firstUser = true;
      for (const m of messages) {
        if (m.role === 'user') {
          // separador de turnos: cada consulta nueva tras la respuesta anterior.
          // Si el mensaje trae ts (historial archivado), se muestra cuándo se hizo
          if (!firstUser) {
            const sep = document.createElement('div');
            sep.className = 'turn-sep';
            sep.textContent = t('history.turnSep') + (m.ts ? ` — ${fmtTurnTs(m.ts)}` : '');
            historyContent.appendChild(sep);
          }
          firstUser = false;
        }
        const div = document.createElement('div');
        div.className = `conv-msg ${m.role}`;
        if (m.role === 'assistant') {
          div.classList.add('md');
          div.innerHTML = renderMarkdown(m.text);
        } else div.textContent = m.text;
        historyContent.appendChild(div);
      }
    } catch (err) {
      historyContent.textContent = t('history.noConv', { error: err.message });
    }
  }
  historyContent.scrollTop = historyContent.scrollHeight; // empezar por lo último
}

function closeHistory() {
  historyOverlay.classList.add('hidden');
  if (term) term.focus();
}

document.getElementById('history-close').onclick = closeHistory;
document.getElementById('history-btn').onclick = openHistory;
document.getElementById('hist-tab-conv').onclick = () => setHistoryMode('conv');
document.getElementById('hist-tab-term').onclick = () => setHistoryMode('term');
// Recargar sin perder la posición de scroll (si estabas abajo del todo, sigue abajo)
document.getElementById('history-reload').onclick = () => {
  const atBottom =
    historyContent.scrollTop + historyContent.clientHeight >= historyContent.scrollHeight - 20;
  const prevScroll = historyContent.scrollTop;
  loadHistory().then(() => {
    if (!atBottom) historyContent.scrollTop = prevScroll;
  });
};

// Clic en el contenido = volver al terminal (salvo que estés seleccionando
// texto para copiar o pulses un enlace)
historyContent.addEventListener('mouseup', (e) => {
  if (e.target.closest('a')) return;
  if (!window.getSelection().toString()) closeHistory();
});

window.addEventListener('keydown', (e) => {
  if (historyOverlay.classList.contains('hidden')) return;
  if (e.key === 'Escape') return closeHistory();
  // Escribiendo en el chat/config o con un modal abierto encima: la tecla es
  // para ese control, NO para la sesión (antes se colaba y se enviaba igual)
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (document.querySelector('[id$="-modal"]:not(.hidden)')) return;
  // Empezar a escribir también vuelve al terminal (y la tecla no se pierde)
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (printable || e.key === 'Enter') {
    closeHistory();
    if (termSocket && termSocket.readyState === WebSocket.OPEN) {
      termSocket.send(JSON.stringify({ type: 'data', data: e.key === 'Enter' ? '\r' : e.key }));
    }
  }
});

function attachTerminal(short, attempt = 0) {
  detachTerminal();
  terminalEl.textContent = '';

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
    theme: { background: '#0d1117' },
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalEl);
  fitAddon.fit();
  term.focus();

  // Rueda sobre el terminal: en buffer normal, scroll nativo de xterm.js.
  // En buffer alternativo (el TUI de kimi usa ↑/↓ para el historial del input,
  // NO para hacer scroll), la rueda hacia arriba abre la vista de Historial.
  term.attachCustomWheelEventHandler((e) => {
    if (term.buffer.active.type !== 'alternate') return true;
    if (e.deltaY < 0) openHistory();
    return false;
  });

  // Tildes: composición propia a nivel keydown (antes de xterm.js)
  term.attachCustomKeyEventHandler(deadKeyHandler);

  // …y tragar el commit del IME: en Linux (IBus) la composición la cierra el
  // sistema de entrada, no el navegador, y el carácter compuesto llega IGUAL al
  // textarea oculto de xterm (compositionend/input) aunque el keydown se haya
  // preventDefaulteado — sin este filtro, á salía duplicada (áá). Listeners en
  // fase de captura = corren antes que los de xterm (bubble). Solo se traga el
  // carácter exacto que acabamos de enviar nosotros, en una ventana corta; el
  // tecleo normal (data distinta o fuera de ventana) no se toca.
  const ta = term.textarea;
  if (ta) {
    // Seguimiento de si hay una composición IME activa (para no confundir los
    // commits de composición real con los commits sueltos de teclas Process)
    let compositionActive = false;
    ta.addEventListener('compositionstart', () => { compositionActive = true; }, true);
    ta.addEventListener('compositionend', () => { compositionActive = false; }, true);
    const swallow = (ev) => {
      if (!swallowIme.text || Date.now() > swallowIme.until) return;
      const data = typeof ev.data === 'string' && ev.data ? ev.data : ta.value;
      if (!data.includes(swallowIme.text)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      ta.value = '';
      swallowIme = { text: '', until: 0 };
    };
    ta.addEventListener('beforeinput', swallow, true);
    ta.addEventListener('compositionend', swallow, true);
    ta.addEventListener('input', swallow, true);
    // Commit del IME con keydown 'Process' (01/09/26, la ñ en IBus): xterm
    // cancela los keydown 'Process' (espera el ciclo compositionstart→
    // compositionend) y el commit llega como beforeinput/input SUELTO — sin
    // compositionstart y hasta con inputType 'insertText' — así que xterm lo
    // descartaba y la ñ casi nunca llegaba. Regla: si acaba de llegar un
    // keydown 'Process', el beforeinput que le sigue es ese commit; lo
    // entregamos nosotros y cancelamos la inserción en el textarea.
    ta.addEventListener('beforeinput', (ev) => {
      if (compositionActive || !ev.data) return;
      if (Date.now() - lastProcessKeyAt > 150) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      sendToSession(ev.data);
    }, true);
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?name=${encodeURIComponent(short)}` +
    `&cols=${term.cols}&rows=${term.rows}`;
  termSocket = new WebSocket(url);

  termSocket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'data') term.write(fixLightBlocks(msg.data));
    else if (msg.type === 'error') term.writeln(`\r\n\x1b[31m${msg.data}\x1b[0m`);
  };
  termSocket.onclose = () => {
    // detachTerminal anula este handler antes de cerrar: aquí solo llegan
    // desconexiones inesperadas (pestaña en segundo plano, suspensión, red…)
    if (selected !== short) return;
    if (attempt < 5) {
      if (term) term.writeln('\r\n\x1b[33m' + t('terminal.reconnecting') + '\x1b[0m');
      setTimeout(() => {
        if (selected === short) attachTerminal(short, attempt + 1);
      }, 2000);
    } else {
      outputTitle.textContent = t('terminal.disconnected', { name: short });
    }
  };
  // Red de seguridad anti-duplicado de tildes a nivel de DATOS: cubre cualquier
  // camino interno de xterm por el que el commit del IME pueda colarse. Si
  // xterm emite exactamente el carácter que acabamos de componer nosotros
  // (mismo texto, dentro de la ventana), es el duplicado: no reenviarlo.
  // Un tecleo legítimo del mismo carácter exige volver a pulsar la tecla muerta
  // antes, así que no puede colisionar dentro de la ventana.
  term.onData((data) => {
    if (swallowIme.text && Date.now() <= swallowIme.until && data === swallowIme.text) {
      swallowIme = { text: '', until: 0 };
      return;
    }
    sendToSession(data);
  });

  outputTitle.textContent = t('terminal.titleWith', { name: short });
}

// Fondos casi blancos (burbuja del usuario, vallas de código de kimi): la TUI
// los pinta con bg blanco (47/107/48;5;7/15/truecolor) y texto con el fg por
// defecto — que en xterm.js es BLANCO → bloque blanco invisible hasta que lo
// seleccionas. En un terminal oscuro esos fondos no deberían ser blancos:
// se remapean a gris oscuro (#303030 ≈ palette 236) conservando el resto del SGR.
let ansiCarry = '';
function fixLightBlocks(data) {
  const s = ansiCarry + data;
  ansiCarry = '';
  // si el chunk acaba a mitad de una posible secuencia ANSI, guardar el resto
  const tail = s.match(/\x1b\[[0-9;]*$/);
  let head = s;
  if (tail) {
    head = s.slice(0, tail.index);
    ansiCarry = s.slice(tail.index);
  }
  return head.replace(/\x1b\[([0-9;]*)m/g, (seq, params) => {
    const p = params.split(';').filter(Boolean);
    const nearWhite = (v) => Number(v) >= 245;
    let found = false;
    const out = [];
    for (let i = 0; i < p.length; i++) {
      if (p[i] === '47' || p[i] === '107') {
        found = true;
        continue;
      }
      if (p[i] === '48' && p[i + 1] === '5' && (p[i + 2] === '7' || p[i + 2] === '15')) {
        found = true;
        i += 2;
        continue;
      }
      if (p[i] === '48' && p[i + 1] === '2' && nearWhite(p[i + 2]) && nearWhite(p[i + 3]) && nearWhite(p[i + 4])) {
        found = true;
        i += 4;
        continue;
      }
      out.push(p[i]);
    }
    if (!found) return seq;
    out.push('48', '5', '236');
    return '\x1b[' + out.join(';') + 'm';
  });
}

// ---------- Entrada de teclado ----------

// Envío crudo a la sesión (lo usa también la composición de tildes)
function sendToSession(data) {
  if (termSocket && termSocket.readyState === WebSocket.OPEN) {
    termSocket.send(JSON.stringify({ type: 'data', data }));
  }
}

// Botones de teclas reservadas (encima del terminal): el navegador se queda
// Ctrl+S/Ctrl+T para sí; el botón envía el byte de control equivalente (^S=\x13,
// ^T=\x14) a la sesión. data-ctrl="s" → letra - 64 = código de control.
document.querySelectorAll('#term-keys button[data-ctrl]').forEach((btn) => {
  btn.onclick = () => {
    sendToSession(String.fromCharCode(btn.dataset.ctrl.toUpperCase().charCodeAt(0) - 64));
    term?.focus();
  };
});

// Configuración: vive en un modal que se abre desde el ⚙ de la cabecera
// (el panel izquierdo es solo terminal; las sesiones están en la columna derecha)
const configModal = document.getElementById('config-modal');
document.getElementById('config-btn').onclick = () => configModal.classList.remove('hidden');
document.getElementById('config-close').onclick = () => configModal.classList.add('hidden');
configModal.onclick = (e) => {
  if (e.target === configModal) configModal.classList.add('hidden');
};

// Teclas muertas (tildes): componemos NOSOTROS a nivel keydown, antes de que
// xterm.js o el navegador toquen la tecla (preventDefault). El enfoque anterior
// (componer sobre el flujo de datos) perdía vocales cuando el navegador tragaba
// la composición: "Cómo" llegaba como "C´mo".
// Qué acento es: key 'Dead' no lo dice, así que se deduce de ev.code + Shift.
// Cubre teclado ES (´/¨ junto a la Ñ en Quote, `/^ junto a la P en
// BracketLeft) y US-International ('/" en Quote, `/~ en Backquote, ^ en
// Shift+6) — en US-Intl la Ñ se escribe ~+n, de ahí el mapeo de ~.
// Algunos sistemas reportan el carácter directamente en vez de 'Dead'; solo se
// interceptan ´ y ¨ directos (` ~ ^ NO: en layouts donde no son muertas son
// caracteres normales de terminal — ~ = home).
// La composición es genérica por normalización Unicode (base + marca
// combinante → NFC): vale para á, ñ, ü, â, à, ã… y lo no componible se suelta
// (´+m → ´m, ~+espacio → ~).
const DEAD_BY_CODE = {          // [sin Shift, con Shift]
  Quote: ['´', '¨'],            // ES: ´/¨ (junto a Ñ) · US-Intl: '/"
  BracketLeft: ['`', '^'],      // ES: `/^ (junto a P)
  Backquote: ['`', '~'],        // US-Intl: `/~
  Digit6: [null, '^'],          // US-Intl: ^
};
const COMBINING = { '´': 0x301, '¨': 0x308, '`': 0x300, '~': 0x303, '^': 0x302 };
const composeDead = (base, dead) => {
  const c = (base + String.fromCharCode(COMBINING[dead])).normalize('NFC');
  return c.length === 1 ? c : null; // no componible: null
};
let pendingDead = '';
// Carácter que acabamos de enviar nosotros por composición manual: el IME
// (IBus en Linux) confirma su propia copia en el textarea oculto de xterm a
// pesar del preventDefault del keydown — sin tragar ese commit, sale
// duplicada (áá). Los listeners que lo cazan están en attachTerminal.
let swallowIme = { text: '', until: 0 };
// Último keydown 'Process' (tecla entregada vía IME, p. ej. la ñ en IBus): lo
// usan los listeners del textarea para entregar el commit que xterm descarta
let lastProcessKeyAt = 0;

function deadKeyHandler(ev) {
  if (ev.type !== 'keydown') return true;
  // Ctrl+S: Chrome lo reserva (Guardar página) y el Keyboard Lock NO lo captura
  // (no está en su lista de teclas bloqueables, a diferencia de Ctrl+T/W/N).
  // Como es una tecla que la página sí puede interceptar con preventDefault,
  // la cazamos aquí y la mandamos a la sesión como ^S (\x13).
  if (ev.ctrlKey && !ev.altKey && !ev.metaKey && (ev.key === 's' || ev.key === 'S')) {
    ev.preventDefault();
    sendToSession('\x13');
    return false;
  }
  if (ev.key === 'Process') lastProcessKeyAt = Date.now();
  const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
  let dead = '';
  if (plain && ev.key === 'Dead') {
    const byCode = DEAD_BY_CODE[ev.code];
    dead = (byCode && byCode[ev.shiftKey ? 1 : 0]) || (ev.shiftKey ? '¨' : '´');
  } else if (plain && (ev.key === '´' || ev.key === '¨')) dead = ev.key;
  if (dead) {
    ev.preventDefault();
    if (pendingDead) sendToSession(pendingDead); // dos acentos seguidos: suelta el primero
    pendingDead = dead;
    return false;
  }
  if (!pendingDead) return true;
  // El IME (IBus) está componiendo él mismo: durante una composición activa los
  // keydown llegan como 'Process' y el carácter final lo entrega el commit
  // (compositionend/input) por su propio camino. No componer nosotros NI soltar
  // el acento: dejar pasar y que el commit entregue el carácter una sola vez.
  if (ev.key === 'Process') {
    pendingDead = '';
    return true;
  }
  // Firefox compone ya en el keydown (la vocal llega como ev.key = 'á'): si la
  // tecla YA es la composición del acento pendiente, dejarla pasar tal cual —
  // enviar algo aquí duplicaría o soltaría un acento suelto de más
  if (ev.key && ev.key.length === 1) {
    const nfd = ev.key.normalize('NFD');
    const mark = String.fromCharCode(COMBINING[pendingDead]);
    if (nfd.length === 2 && nfd[1] === mark) {
      pendingDead = '';
      return true;
    }
  }
  const composed = ev.key && ev.key.length === 1 ? composeDead(ev.key, pendingDead) : null;
  const d = pendingDead;
  pendingDead = '';
  if (composed && plain) {
    ev.preventDefault();
    swallowIme = { text: composed, until: Date.now() + 1500 };
    sendToSession(composed);
    return false;
  }
  sendToSession(d); // no componible (consonante, Enter, flecha…): suelta el acento
  return true;
}

// Reajuste escalonado del terminal: al cambiar de ventana/pestaña/monitor el
// layout (y el devicePixelRatio al mover entre pantallas) tarda en estabilizarse
// y un solo fit() medía mal — el terminal volvía roto hasta F5. Pasadas a
// 0/50/300/1000 ms, rearmadas en cada evento (arrastre continuo = debounce).
// clearTextureAtlas fuerza a xterm a re-medir los glifos si cambió el DPI.
let refitTimers = [];
function scheduleRefits() {
  for (const t of refitTimers) clearTimeout(t);
  refitTimers = [0, 50, 300, 1000].map((d) =>
    setTimeout(() => {
      refitTerminal();
      term?.clearTextureAtlas?.();
    }, d)
  );
}
window.addEventListener('resize', () => scheduleRefits());

// Pantalla completa + Keyboard Lock (SOLO Chromium): con el bloqueo, las
// teclas reservadas del navegador (Ctrl+T, Ctrl+W, Ctrl+N…) llegan al terminal
// y van a la sesión. En Firefox no existe Keyboard Lock: allí el fullscreen
// solo da espacio y las reservadas siguen siendo del navegador (el ⓘ lo avisa).
const terminalWrap = document.querySelector('.terminal-wrap');
let keyboardLocked = false;
document.getElementById('fullscreen-btn').onclick = async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await terminalWrap.requestFullscreen();
      if (navigator.keyboard?.lock) {
        await navigator.keyboard.lock();
        keyboardLocked = true;
      }
    }
  } catch { /* fullscreen/keyboard-lock no disponible en este navegador */ }
};
// Salida visible DENTRO del área fullscreen (el ⛶ del header queda fuera)
document.getElementById('fullscreen-exit').onclick = () => document.exitFullscreen();
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && keyboardLocked) {
    navigator.keyboard?.unlock?.();
    keyboardLocked = false;
  }
  // Reajustar xterm al nuevo tamaño (pasadas escalonadas): si el fullscreen se
  // salió en segundo plano (p. ej. Ctrl+T abrió otra pestaña), el layout tarda
  // en estabilizarse y un solo refit medía mal
  scheduleRefits();
});

// Texto del ⓘ según soporte: en navegadores sin Keyboard Lock (Firefox) el
// mensaje prometedor sería mentira. Es función porque applyI18n repone el texto
// de Chromium al cambiar de idioma y hay que volver a poner este después.
function applyFullscreenHelp() {
  if (navigator.keyboard?.lock) return;
  const help = document.getElementById('fullscreen-help');
  if (help) help.innerHTML = t('terminal.fullscreenHelpNoLock');
}
applyFullscreenHelp();

// ---------- Archivadas: modal con buscador (botón 🗄 de la cabecera) ----------

const archivedList = document.getElementById('archived-list');
const archivedBtn = document.getElementById('archived-btn');
const archivedSearch = document.getElementById('archived-search');
// Última lista recibida del servidor: el buscador filtra sobre ella sin
// refetch (refreshSessions la actualiza cada 4 s y al cambiar de idioma)
let lastArchived = [];

function downloadText(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Descarga el historial en Markdown: conversación íntegra (wire.jsonl, funciona
// incluso con la sesión archivada) + la última pantalla guardada en el registry
async function saveHistory(a) {
  let messages = [];
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(a.name)}/conversation`);
    messages = r.messages || [];
  } catch { /* sin wire.jsonl accesible */ }
  const d = new Date(a.contextSavedAt || a.updatedAt);
  let md = t('export.title', { name: a.label || a.name }) + '\n\n';
  md += t('export.meta', {
    id: a.name,
    cli: a.cli || 'kimi',
    workdir: a.workdir || '',
    date: d.toLocaleString('es-ES'),
  });
  if (messages.length) {
    for (const m of messages) {
      if (m.role === 'user') md += `${t('export.user')}\n\n${m.text}\n\n`;
      else if (m.role === 'assistant') md += `${t('export.assistant')}\n\n${m.text}\n\n`;
      else md += `> ⚙ ${m.text}\n\n`;
    }
  } else {
    md += t('export.noConv') + '\n\n';
  }
  if (a.snapshot) md += `---\n\n${t('export.snapshot')}\n\n\`\`\`\n${a.snapshot}\n\`\`\`\n`;
  downloadText(`${a.name}-historial.md`, md);
}

function renderArchived(archived) {
  lastArchived = archived;
  archivedBtn.textContent = t('header.archivedCount', { count: archived.length });
  // Filtro del buscador: por etiqueta o por id, sin distinguir mayúsculas
  const q = archivedSearch.value.trim().toLowerCase();
  const filtered = q
    ? archived.filter((a) =>
        (a.label || a.name).toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    : archived;
  archivedList.innerHTML = '';
  if (!filtered.length) {
    archivedList.innerHTML = `<li class="empty">${t(archived.length ? 'archived.noMatch' : 'sessions.emptyArchived')}</li>`;
    return;
  }
  for (const a of filtered) {
    const display = a.label || a.name;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = display;
    if (a.label) label.title = `id: ${a.name}`;
    const info = document.createElement('span');
    info.className = 'badge';
    info.textContent = a.cli || 'kimi';
    const date = document.createElement('span');
    date.className = 'badge saved';
    const d = new Date(a.contextSavedAt || a.updatedAt);
    date.textContent = `💾 ${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
    date.title = t('sessions.lastContextSaved');
    const reopen = document.createElement('button');
    reopen.className = 'mini-btn';
    reopen.textContent = t('sessions.reopen');
    reopen.title = t('sessions.reopenTitle');
    reopen.onclick = async () => {
      await api(`/api/sessions/${encodeURIComponent(a.name)}/reopen`, { method: 'POST' }).catch(alert);
      refreshSessions();
    };
    const save = document.createElement('button');
    save.className = 'mini-btn';
    save.textContent = t('sessions.historyBtn');
    save.title = t('sessions.historyBtnTitle');
    save.onclick = () => saveHistory(a).catch((err) => alert(err.message));
    const del = document.createElement('button');
    del.className = 'mini-btn';
    del.textContent = '🗑';
    del.title = t('sessions.deleteTitle');
    del.onclick = async () => {
      const ok = await askConfirm(
        t('confirm.deleteArchived', { name: display }),
        { title: t('confirm.deleteTitle'), yes: t('confirm.deleteYes') }
      );
      if (!ok) return;
      let q = '';
      if (a.workdir && a.workdir.includes('/workspaces/')) {
        const rm = await askConfirm(t('confirm.deleteWorkdir', { workdir: a.workdir }), {
          title: t('confirm.deleteWorkdirTitle'),
          yes: t('confirm.deleteWorkdirYes'),
        });
        if (rm) q = '?deleteWorkdir=1';
      }
      await api(`/api/sessions/${encodeURIComponent(a.name)}${q}`, { method: 'DELETE' }).catch(alert);
      refreshSessions();
    };
    li.append(label, info, date, reopen, save, del);
    archivedList.appendChild(li);
  }
}

// Modal de archivadas: abre desde el 🗄 de la cabecera (con el buscador limpio
// y el foco puesto), cierra con ✕ o clic fuera; el buscador refiltra en vivo
const archivedModal = document.getElementById('archived-modal');
archivedBtn.onclick = () => {
  archivedModal.classList.remove('hidden');
  archivedSearch.value = '';
  renderArchived(lastArchived);
  archivedSearch.focus();
};
document.getElementById('archived-close').onclick = () => archivedModal.classList.add('hidden');
archivedModal.onclick = (e) => {
  if (e.target === archivedModal) archivedModal.classList.add('hidden');
};
archivedSearch.oninput = () => renderArchived(lastArchived);

// Sección plegable de activas. Nace abierta; si el usuario la pliega a mano,
// se respeta (localStorage).
for (const [headerId, listEl, key] of [
  ['active-header', sessionList, 'ls-active'],
]) {
  const h = document.getElementById(headerId);
  const arrow = h.querySelector('.arrow');
  const setCollapsed = (c) => {
    listEl.classList.toggle('collapsed', c);
    arrow.textContent = c ? '▸' : '▾';
  };
  setCollapsed(localStorage.getItem(key) === 'collapsed');
  h.onclick = () => {
    const c = !listEl.classList.contains('collapsed');
    setCollapsed(c);
    localStorage.setItem(key, c ? 'collapsed' : 'open');
  };
}

// ---------- Sesiones ----------

// Actividad conocida de las sesiones (para el aviso del botón "Hasta mañana")
let lastManaged = [];

async function refreshSessions() {
  try {
    const { sessions, archived } = await api('/api/sessions');
    renderArchived(archived || []);
    const managed = sessions.filter((s) => s.managed);
    // Orden: primero la última sesión con la que interactuaste. Señal =
    // lastMsgAt (mtime del wire.jsonl, que kimi actualiza al enviar tu
    // mensaje); sin ella, contextSavedAt; sin fecha, al final. sort es
    // estable: a igualdad de fecha se conserva el orden de screen -ls.
    managed.sort((a, b) =>
      (b.lastMsgAt || b.contextSavedAt || '').localeCompare(a.lastMsgAt || a.contextSavedAt || '')
    );
    lastManaged = managed.map((s) => ({
      name: s.name.slice('kimi-'.length),
      label: s.label,
      activity: s.activity,
    }));
    document.getElementById('active-count').textContent = managed.length;
    sessionList.innerHTML = '';
    if (selected && !managed.some((s) => s.name === 'kimi-' + selected)) {
      selected = null;
      detachTerminal();
    }
    if (managed.length === 0) {
      sessionList.innerHTML = `<li class="empty">${t('sessions.emptyActive')}</li>`;
      return;
    }
    for (const s of managed) {
      const short = s.name.slice('kimi-'.length);
      const display = s.label || short; // etiqueta legible si la tiene
      const li = document.createElement('li');
      if (short === selected) li.classList.add('selected');
      const label = document.createElement('span');
      label.textContent = display;
      if (s.label) label.title = `id: ${short}`;
      const badge = document.createElement('span');
      badge.className = 'badge' + (s.status.toLowerCase().includes('attach') && !s.status.toLowerCase().includes('det') ? ' attached' : '');
      badge.textContent = s.status;
      li.append(label, badge);
      if (s.activity) {
        const act = document.createElement('span');
        act.className = 'badge ' + (s.activity === 'trabajando' ? 'working' : 'waiting');
        act.textContent = s.activity === 'trabajando' ? t('sessions.working') : t('sessions.waiting');
        li.appendChild(act);
      }
      if (s.contextSavedAt) {
        const saved = document.createElement('span');
        saved.className = 'badge saved';
        const d = new Date(s.contextSavedAt);
        const day = d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        saved.textContent = `💾 ${day} ${time}`;
        saved.title = t('sessions.contextSavedTitle', { date: d.toLocaleString('es-ES') });
        li.appendChild(saved);
      }
      const up = document.createElement('button');
      up.className = 'up-btn';
      up.textContent = t('deploy.btn');
      up.title = t('sessions.uploadTitle');
      up.onclick = (e) => {
        e.stopPropagation();
        openDeployModal(short, display);
      };
      li.append(up);
      const kill = document.createElement('button');
      kill.className = 'kill-btn';
      kill.textContent = '📦';
      kill.title = t('sessions.archiveTitle');
      kill.onclick = async (e) => {
        e.stopPropagation();
        const ok = await askConfirm(
          t('confirm.archive', { name: display }),
          { title: t('confirm.archiveTitle'), yes: t('confirm.archiveYes') }
        );
        if (!ok) return;
        await api(`/api/sessions/${encodeURIComponent(short)}/archive`, { method: 'POST' }).catch(alert);
        if (selected === short) {
          selected = null;
          detachTerminal();
        }
        refreshSessions();
      };
      li.append(kill);
      li.onclick = () => {
        // mismo ítem ya seleccionado: no hacer nada si el terminal sigue vivo,
        // pero permitir el re-clic para reconectar si el socket cayó
        const socketAlive = termSocket && termSocket.readyState === WebSocket.OPEN;
        if (selected === short && socketAlive) return;
        selected = short;
        refreshSessions();
        attachTerminal(short);
      };
      sessionList.appendChild(li);
    }
  } catch (err) {
    sessionList.innerHTML = `<li class="empty">${t('common.error')}: ${err.message}</li>`;
  }
}

// Al volver a la ventana/pestaña: refrescar estados (el navegador estrangula
// los timers en segundo plano) y reconectar el terminal si el socket cayó
function onWindowBack() {
  refreshSessions();
  loadModels(); // por si Ollama se arrancó/paró mientras la pestaña estaba atrás
  scheduleRefits(); // por si el tamaño/DPI cambió en segundo plano u otro monitor
  if (selected && (!termSocket || termSocket.readyState !== WebSocket.OPEN)) {
    attachTerminal(selected);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onWindowBack();
});
window.addEventListener('focus', onWindowBack);

// Autocompletado de directorios existentes para el workdir
const workdirInput = document.getElementById('create-workdir');
const workdirList = document.getElementById('workdir-list');
let browseTimer = null;
workdirInput.addEventListener('input', () => {
  clearTimeout(browseTimer);
  const q = workdirInput.value.trim();
  if (!q.startsWith('/')) { workdirList.innerHTML = ''; return; }
  browseTimer = setTimeout(async () => {
    try {
      const { dirs } = await api(`/api/browse?path=${encodeURIComponent(q)}`);
      workdirList.innerHTML = '';
      for (const d of dirs) {
        const opt = document.createElement('option');
        opt.value = d;
        workdirList.appendChild(opt);
      }
    } catch { /* ruta fuera de home o ilegible: sin sugerencias */ }
  }, 250);
});

// ---------- Explorador de directorios ----------
const dirModal = document.getElementById('dir-modal');
const dirPath = document.getElementById('dir-path');
const dirList = document.getElementById('dir-list');
let dirCurrent = '';

async function loadDir(p) {
  dirList.innerHTML = `<li class="empty">${t('common.loading')}</li>`;
  try {
    const q = p ? `?path=${encodeURIComponent(p)}` : ''; // sin path: home
    const { base, dirs } = await api(`/api/browse${q}`);
    dirCurrent = base;
    dirPath.textContent = base;
    dirList.innerHTML = '';
    if (!dirs.length) dirList.innerHTML = `<li class="empty">${t('dir.empty')}</li>`;
    for (const d of dirs) {
      const li = document.createElement('li');
      li.textContent = '📁 ' + d.split('/').pop();
      li.onclick = () => loadDir(d);
      dirList.appendChild(li);
    }
  } catch (err) {
    dirList.innerHTML = `<li class="empty">${t('common.error')}: ${err.message}</li>`;
  }
}

document.getElementById('dir-picker-btn').onclick = () => {
  dirModal.classList.remove('hidden');
  loadDir(workdirInput.value.trim());
};
document.getElementById('dir-cancel').onclick = () => dirModal.classList.add('hidden');
document.getElementById('dir-up').onclick = () =>
  loadDir(dirCurrent.split('/').slice(0, -1).join('/') || '/');
document.getElementById('dir-select').onclick = () => {
  workdirInput.value = dirCurrent;
  dirModal.classList.add('hidden');
};
dirModal.addEventListener('click', (e) => {
  if (e.target === dirModal) dirModal.classList.add('hidden');
});

createForm.onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('create-name').value.trim();
  const workdir = document.getElementById('create-workdir').value.trim();
  // Modelo de la sesión: '' = el de la config global; 'ol:' = Ollama local;
  // 'ds:' = API del gestor. La sesión se lanza con el modelo ELEGIDO aquí.
  const body = { name, workdir: workdir || undefined, cli: createCli.value };
  // Un solo selector de agente: un CLI instalado, o un modelo local de
  // Ollama ('ol:<modelo>' = kimi con override de modelo)
  if (createCli.value.startsWith('ol:')) {
    body.cli = 'kimi';
    body.model = createCli.value.slice(3);
    body.baseUrl = 'http://localhost:11434/v1';
  }
  try {
    const result = await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    createForm.reset();
    selected = result.slug; // internamente todo usa el slug; la etiqueta es solo visual
    refreshSessions();
    attachTerminal(result.slug);
    // Directorio con contenido: ofrecer que el gestor lo analice para dar contexto
    if (result.hasContent) {
      const analyze = await askAnalyze(result.workdir, result.label);
      if (analyze) {
        await sendChat(
          `Acabo de crear la sesión '${result.slug}' con workdir ${result.workdir}, que ya tiene contenido. ` +
          `Dale unos segundos para arrancar, comprueba con read_session_output que está lista y, ` +
          `cuando lo esté, envíale con send_input una instrucción para que analice el proyecto ` +
          `(estructura, README, puntos de entrada, tecnologías) y genere un resumen de contexto ` +
          `para trabajar en él.`
        );
      }
    }
  } catch (err) {
    alert(err.message);
  }
};

// Diálogo propio (nada de confirm() del navegador) para ofrecer el análisis
function askAnalyze(workdir, name) {
  return new Promise((resolve) => {
    const modal = document.getElementById('analyze-modal');
    document.getElementById('analyze-text').innerHTML = t('analyze.text', { workdir, name });
    modal.classList.remove('hidden');
    const done = (v) => { modal.classList.add('hidden'); resolve(v); };
    document.getElementById('analyze-yes').onclick = () => done(true);
    document.getElementById('analyze-no').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}

// Confirmación genérica con el estilo del dashboard.
// `no: null` oculta el botón de cancelar (diálogo solo informativo)
function askConfirm(text, { title = t('confirm.title'), yes = t('confirm.yes'), no = t('confirm.no') } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    document.getElementById('confirm-yes').textContent = yes;
    const noBtn = document.getElementById('confirm-no');
    noBtn.textContent = no || '';
    noBtn.style.display = no === null ? 'none' : '';
    modal.classList.remove('hidden');
    const done = (v) => { modal.classList.add('hidden'); resolve(v); };
    document.getElementById('confirm-yes').onclick = () => done(true);
    noBtn.onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}

// ---------- Chat con el gestor ----------

// Mini-renderizador markdown (sin dependencias): escapa HTML primero y luego
// aplica código, negrita, cursiva, enlaces, encabezados, listas y bloques ```.
function mdInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderMarkdown(text) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  text.split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      html += `<pre><code>${esc(part.replace(/^[a-z-]*\n/i, ''))}</code></pre>`;
      return;
    }
    let inList = false;
    for (const line of part.split('\n')) {
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)/);
      if (h) {
        if (inList) { html += '</ul>'; inList = false; }
        html += `<h4>${mdInline(esc(h[2]))}</h4>`;
      } else if (li) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${mdInline(esc(li[1]))}</li>`;
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        if (line.trim()) html += `<p>${mdInline(esc(line))}</p>`;
      }
    }
    if (inList) html += '</ul>';
  });
  return html;
}

function addMsg(text, cls) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  if (cls === 'assistant') {
    div.classList.add('md');
    div.innerHTML = renderMarkdown(text);
  } else div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

// Registro de herramientas plegable: el JSON queda disponible pero no ensucia el chat
function toolLogEl(t) {
  const det = document.createElement('details');
  det.className = 'msg tool';
  const sum = document.createElement('summary');
  sum.textContent = `⚙ ${t.tool}(${JSON.stringify(t.args)})`;
  const body = document.createElement('pre');
  body.textContent = JSON.stringify(t.result, null, 1);
  det.append(sum, body);
  return det;
}

function addToolLog(t) {
  chatLog.appendChild(toolLogEl(t));
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChat(text) {
  addMsg(text, 'user');
  chatHistory.push({ role: 'user', content: text });
  const thinking = addMsg('…', 'assistant');
  try {
    const result = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory, activeSession: selected }),
    });
    thinking.remove();
    for (const t of result.toolLog || []) addToolLog(t);
    addMsg(result.reply || t('chat.noReply'), 'assistant');
    chatHistory = result.messages; // incluye respuestas del asistente y resultados de tools
    refreshSessions();
    return result;
  } catch (err) {
    thinking.remove();
    addMsg(`${t('common.error')}: ${err.message}`, 'error');
    chatHistory.pop(); // no conservar el mensaje fallido
    return null;
  }
}

chatForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  await sendChat(text);
};

// ---------- Configuración (.env, con API key enmascarada) ----------

const cfgFields = {
  deepseekModel: document.getElementById('cfg-manager-model'),
  kimiSessionModel: document.getElementById('cfg-session-model'),
  deepseekBaseUrl: document.getElementById('cfg-manager-url'),
  kimiSessionBaseUrl: document.getElementById('cfg-session-url'),
  deepseekApiKey: document.getElementById('cfg-api-key'),
  reportIntervalMin: document.getElementById('cfg-report-interval'),
};
const cfgStatus = document.getElementById('cfg-status');
const cfgKeyHint = document.getElementById('cfg-key-hint');
const cfgSessionCli = document.getElementById('cfg-session-cli');
const createCli = document.getElementById('create-cli');

let agentClis = ['kimi'];

function fillCliOptions(clis, keepSelection = true) {
  const current = keepSelection ? cfgSessionCli.value : null;
  agentClis = [...new Set([...clis, current].filter(Boolean))];
  cfgSessionCli.innerHTML = '';
  for (const c of agentClis) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    cfgSessionCli.appendChild(opt);
  }
  if (current) cfgSessionCli.value = current;
  fillCreateAgentOptions(current);
}

// Selector de agente del formulario de crear: los CLIs instalados y, si
// Ollama corre, sus modelos locales ('ol:<modelo>' = kimi con override)
function fillCreateAgentOptions(prefer) {
  const prev = prefer ?? createCli.value;
  createCli.innerHTML = '';
  for (const c of agentClis) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    createCli.appendChild(opt);
  }
  for (const id of modelsCache.ollama) {
    const opt = document.createElement('option');
    opt.value = `ol:${id}`;
    opt.textContent = `${id} (Ollama)`;
    createCli.appendChild(opt);
  }
  if ([...createCli.options].some((o) => o.value === prev)) createCli.value = prev;
}

// El desplegable del formulario de creación sigue al de configuración
cfgSessionCli.addEventListener('change', () => {
  createCli.value = cfgSessionCli.value;
});

async function loadConfig() {
  try {
    const c = await api('/api/config');
    configCache = c;
    cfgFields.deepseekModel.value = c.deepseekModel;
    cfgFields.kimiSessionModel.value = c.kimiSessionModel;
    cfgFields.deepseekBaseUrl.value = c.deepseekBaseUrl;
    cfgFields.kimiSessionBaseUrl.value = c.kimiSessionBaseUrl;
    fillCliOptions(
      c.installedAgents?.length ? c.installedAgents : [c.sessionCli || 'kimi'],
      false
    );
    cfgKeyHint.textContent = c.apiKeySet ? t('config.keyHintSet', { hint: c.apiKeyHint }) : t('config.keyHintUnset');
    cfgFields.reportIntervalMin.value = c.reportIntervalMin ?? 0;
    deployTargetsEl.innerHTML = '';
    for (const tg of c.deployTargets || []) addDeployTargetRow(tg);
    syncSessionUrlState();
    fillCreateAgentOptions();
    updateSessionWarning();
  } catch (err) {
    cfgStatus.textContent = `${t('common.error')}: ${err.message}`;
  }
}

document.getElementById('config-form').onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const [k, el] of Object.entries(cfgFields)) body[k] = el.value.trim();
  body.sessionCli = cfgSessionCli.value;
  // Destinos de despliegue: array serializado (vacío = sin destinos, CLEARABLE)
  const targets = collectDeployTargets();
  body.deployTargets = targets.length ? JSON.stringify(targets) : '';
  try {
    const { changed } = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    cfgFields.deepseekApiKey.value = ''; // nunca dejar la key escrita en el form
    cfgStatus.textContent = changed.length
      ? t('config.saved', { changed: changed.join(', ') })
      : t('config.noChanges');
    loadConfig();
  } catch (err) {
    cfgStatus.textContent = `${t('common.error')}: ${err.message}`;
  }
};

// ---------- Despliegue SSH (destinos en Config + botón ⬆ en sesiones) ----------
// Quién despliega: el AGENTE de la sesión por SSH, orquestado por el gestor.
// Aquí se editan los destinos (DEPLOY_TARGETS, JSON en .env vía /api/config),
// se prueba la conexión y se arranca el despliegue con /api/sessions/:name/deploy.

const deployTargetsEl = document.getElementById('deploy-targets');
const deployModal = document.getElementById('deploy-modal');
const deployText = document.getElementById('deploy-text');
const deployTargetSelect = document.getElementById('deploy-target-select');
let deployPending = null; // { slug, display } de la sesión a subir

// Una fila del editor de destinos: nombre/usuario/host/puerto/ruta + Probar + 🗑
function addDeployTargetRow(tg = {}) {
  const row = document.createElement('div');
  row.className = 'deploy-row';
  const inputs = {};
  for (const [cls, val, ph] of [
    ['name', tg.name || '', t('deploy.namePh')],
    ['user', tg.user || '', t('deploy.userPh')],
    ['host', tg.host || '', t('deploy.hostPh')],
    ['port', tg.port ?? '', t('deploy.portPh')],
    ['path', tg.basePath || '', t('deploy.pathPh')],
  ]) {
    const i = document.createElement('input');
    i.className = `deploy-f-${cls}`;
    i.placeholder = ph;
    i.value = val;
    inputs[cls] = i;
    row.appendChild(i);
  }
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'btn-secondary deploy-test';
  test.textContent = t('deploy.test');
  test.title = t('deploy.testTitle');
  const result = document.createElement('span');
  result.className = 'deploy-test-result';
  test.onclick = async () => {
    test.disabled = true;
    result.className = 'deploy-test-result';
    result.textContent = t('deploy.testing');
    try {
      const r = await api('/api/deploy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: inputs.name.value.trim(),
          user: inputs.user.value.trim(),
          host: inputs.host.value.trim(),
          port: Number(inputs.port.value) || 22,
          basePath: inputs.path.value.trim() || '/',
        }),
      });
      if (r.ok) {
        result.textContent = t('deploy.testOk');
        result.classList.add('ok');
      } else {
        result.textContent = `${t('deploy.testFail')} ${r.error || ''}` + (r.hint ? ` — ${r.hint}` : '');
        result.classList.add('fail');
      }
    } catch (err) {
      result.textContent = `${t('deploy.testFail')} ${err.message}`;
      result.classList.add('fail');
    } finally {
      test.disabled = false;
    }
  };
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn-secondary deploy-del';
  del.textContent = '🗑';
  del.title = t('deploy.removeTitle');
  del.onclick = () => row.remove();
  row.append(test, result, del);
  deployTargetsEl.appendChild(row);
  return row;
}

// Filas → array para DEPLOY_TARGETS (solo filas con lo mínimo: nombre+user+host)
function collectDeployTargets() {
  const out = [];
  for (const row of deployTargetsEl.querySelectorAll('.deploy-row')) {
    const v = (cls) => row.querySelector(`.deploy-f-${cls}`).value.trim();
    if (!v('name') || !v('user') || !v('host')) continue;
    out.push({
      name: v('name'),
      user: v('user'),
      host: v('host'),
      port: Number(v('port')) || 22,
      basePath: v('path') || '/',
    });
  }
  return out;
}

document.getElementById('deploy-add').onclick = () => addDeployTargetRow();

// Modal de despliegue: elegir destino + subdominio/dominio y arrancar.
// El GESTOR ejecuta el despliegue completo con run_command (rsync, deps,
// systemd endurecido, nginx, SSL certbot) — puede tardar minutos.
const deploySubdomain = document.getElementById('deploy-subdomain');
const deployDomain = document.getElementById('deploy-domain');

function openDeployModal(slug, display) {
  const targets = configCache?.deployTargets || [];
  if (!targets.length) {
    askConfirm(t('deploy.noTargets'), { title: t('deploy.modalTitle'), no: null });
    return;
  }
  deployPending = { slug, display };
  deployText.textContent = t('deploy.modalText', { name: display });
  deployTargetSelect.innerHTML = '';
  for (const tg of targets) {
    const opt = document.createElement('option');
    opt.value = tg.name;
    opt.textContent = `${tg.name} (${tg.user}@${tg.host}:${tg.port} ${tg.basePath})`;
    deployTargetSelect.appendChild(opt);
  }
  // subdominio = slug de la sesión; dominio = el último usado (se recuerda)
  deploySubdomain.value = slug;
  deployDomain.value = localStorage.getItem('lsd-deploy-domain') || '';
  deployModal.classList.remove('hidden');
}

document.getElementById('deploy-cancel').onclick = () => deployModal.classList.add('hidden');
deployModal.onclick = (e) => { if (e.target === deployModal) deployModal.classList.add('hidden'); };

// Ventana emergente de progreso/resultado del despliegue (no el chat principal)
const deployRunModal = document.getElementById('deploy-run-modal');
const deployRunTitle = document.getElementById('deploy-run-title');
const deployRunLog = document.getElementById('deploy-run-log');
document.getElementById('deploy-run-close').onclick = () => deployRunModal.classList.add('hidden');
// mientras corre NO se cierra con clic fuera (un deploy tarda minutos); con el
// resultado a la vista, sí
deployRunModal.onclick = (e) => {
  if (e.target === deployRunModal && !deployRunLog.dataset.running) deployRunModal.classList.add('hidden');
};

document.getElementById('deploy-go').onclick = async () => {
  const sess = deployPending;
  const target = deployTargetSelect.value;
  const subdomain = deploySubdomain.value.trim().toLowerCase();
  const domain = deployDomain.value.trim().toLowerCase();
  if (!sess || !target) return;
  if (!subdomain || !domain) {
    deployText.textContent = t('deploy.needFqdn');
    return;
  }
  deployModal.classList.add('hidden');
  localStorage.setItem('lsd-deploy-domain', domain);
  const fqdn = `${subdomain}.${domain}`;
  deployRunTitle.textContent = t('deploy.runTitle', { name: sess.display, fqdn });
  deployRunLog.innerHTML = '';
  deployRunLog.dataset.running = '1';
  const spin = document.createElement('p');
  spin.className = 'muted';
  spin.textContent = t('deploy.working');
  deployRunLog.appendChild(spin);
  deployRunModal.classList.remove('hidden');
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sess.slug)}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, subdomain, domain }),
    });
    spin.remove();
    for (const tl of result.toolLog || []) deployRunLog.appendChild(toolLogEl(tl));
    const reply = document.createElement('div');
    reply.className = 'msg assistant md';
    reply.innerHTML = renderMarkdown(result.reply || t('chat.noReply'));
    deployRunLog.appendChild(reply);
    // el gestor conserva el despliegue en contexto para próximos turnos
    // (silencioso: no se muestra en el chat principal)
    chatHistory.push(...result.messages);
    refreshSessions();
  } catch (err) {
    spin.remove();
    const errEl = document.createElement('div');
    errEl.className = 'msg error';
    errEl.textContent = `${t('common.error')}: ${err.message}`;
    deployRunLog.appendChild(errEl);
  } finally {
    delete deployRunLog.dataset.running;
    deployRunLog.scrollTop = deployRunLog.scrollHeight;
  }
};

// Detectar CLIs de agente: primero búsqueda determinista (/api/agents);
// si no encuentra nada, se lo pedimos al gestor (LLM) con su tool discover_agents
document.getElementById('discover-agents').onclick = async () => {
  cfgStatus.textContent = t('config.detecting');
  try {
    const { agents } = await api('/api/agents');
    const found = Object.keys(agents || {});
    if (found.length) {
      fillCliOptions(found);
      cfgStatus.textContent = t('config.detected', { found: found.join(', ') });
      return;
    }
  } catch { /* seguir con el fallback del gestor */ }
  cfgStatus.textContent = t('config.detectingFallback');
  const result = await sendChat(
    'Usa discover_agents para comprobar qué CLIs de agente hay instalados en el sistema ' +
    '(kimi, claude, codex, gemini, aider, opencode, goose y cualquier otro que conozcas) ' +
    'y dime la lista de los encontrados.'
  );
  const found = new Set();
  for (const t of result?.toolLog || []) {
    if (t.tool === 'discover_agents' && t.result?.found) {
      for (const c of Object.keys(t.result.found)) found.add(c);
    }
  }
  if (found.size) {
    fillCliOptions([...found]);
    cfgStatus.textContent = t('config.detectedByManager', { found: [...found].join(', ') });
  } else {
    cfgStatus.textContent = t('config.noneDetected');
  }
};

// Cachés compartidas de modelos y config (datalists, selector de agente,
// aviso de Ollama parado)
let modelsCache = { deepseek: [], ollama: [], ollamaRunning: false };
let configCache = null;

// Aviso visible en Configuración si el override de sesiones apunta a un
// Ollama que no está arrancado (las sesiones nuevas fallarían al 1er mensaje)
function updateSessionWarning() {
  const el = document.getElementById('cfg-session-warning');
  if (!el) return;
  const m = configCache?.kimiSessionModel || '';
  const down =
    m && (configCache?.kimiSessionBaseUrl || '').includes('11434') && !modelsCache.ollamaRunning;
  el.classList.toggle('hidden', !down);
  el.textContent = down ? t('config.ollamaWarning', { model: m }) : '';
}

// Modelos disponibles (API Deepseek + Ollama local SOLO si corre) como sugerencias
let ollamaModels = [];
async function loadModels() {
  try {
    const m = await api('/api/models');
    modelsCache = {
      deepseek: m.deepseek || [],
      ollama: m.ollama || [],
      ollamaRunning: !!m.ollamaRunning,
    };
    ollamaModels = modelsCache.ollama;
    // Datalists separados por plano: el GESTOR sugiere los modelos de su API;
    // el override de SESIONES solo modelos locales de Ollama (si corre)
    const list = document.getElementById('model-list');
    list.innerHTML = '';
    for (const id of modelsCache.deepseek) {
      const opt = document.createElement('option');
      opt.value = id;
      list.appendChild(opt);
    }
    const sList = document.getElementById('model-list-sessions');
    sList.innerHTML = '';
    for (const id of ollamaModels) {
      const opt = document.createElement('option');
      opt.value = id;
      sList.appendChild(opt);
    }
    if (m.deepseekError) cfgStatus.textContent = `Deepseek /models: ${m.deepseekError}`;
  } catch { /* sugerencias no críticas */ }
  fillCreateAgentOptions();
  updateSessionWarning();
}

// Con un modelo de Ollama en sesiones, la base URL local se rellena sola
cfgFields.kimiSessionModel.addEventListener('change', () => {
  const v = cfgFields.kimiSessionModel.value.trim();
  if (ollamaModels.includes(v) && !cfgFields.kimiSessionBaseUrl.value.trim()) {
    cfgFields.kimiSessionBaseUrl.value = 'http://localhost:11434/v1';
  }
});

// La Base URL de sesiones solo aplica si hay override de modelo: sin modelo,
// se deshabilita para dejar claro que no se usa
function syncSessionUrlState() {
  cfgFields.kimiSessionBaseUrl.disabled = !cfgFields.kimiSessionModel.value.trim();
}
cfgFields.kimiSessionModel.addEventListener('input', syncSessionUrlState);

// ---------- Hasta mañana (guardado de fin de jornada) ----------

document.getElementById('goodnight-btn').onclick = async () => {
  const working = lastManaged.filter((s) => s.activity === 'trabajando').map((s) => s.label || s.name);
  if (working.length) {
    const go = await askConfirm(
      t('goodnight.workingWarn', { names: working.join(', ') }),
      { title: t('goodnight.workingTitle'), yes: t('goodnight.saveAnyway'), no: t('goodnight.wait') }
    );
    if (!go) return;
  }
  const r = await api('/api/sessions/save-all', { method: 'POST' }).catch((err) => ({ error: err.message }));
  if (r.error) {
    await askConfirm(t('goodnight.saveError', { error: r.error }), {
      title: t('goodnight.title'),
      yes: t('confirm.yes'),
      no: null,
    });
    return;
  }
  const fmt = (ts) =>
    ts ? new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const lines = r.saved.map(
    (s) =>
      `• ${s.label || s.name} — ${t('goodnight.lineContext', { when: fmt(s.contextSavedAt) })}` +
      (s.error ? ` ${t('goodnight.lineError', { error: s.error })}` : '')
  );
  await askConfirm(
    t('goodnight.summary', { count: r.saved.length, lines: lines.join('\n') }),
    { title: t('goodnight.title'), yes: t('confirm.yes'), no: null }
  );
};

// ---------- Informes periódicos del gestor ----------
// El servidor genera un resumen de las sesiones activas cada N minutos
// (configurable); aquí se recogen y se muestran en el chat.
let lastReportTs = null;
let firstReportPoll = true;
async function pollReports() {
  try {
    const q = lastReportTs ? `?after=${encodeURIComponent(lastReportTs)}` : '';
    const { reports: list } = await api('/api/reports' + q);
    if (!list.length) {
      firstReportPoll = false;
      return;
    }
    // primera carga: solo el último informe (no volcar el histórico en memoria)
    const show = firstReportPoll ? [list[list.length - 1]] : list;
    firstReportPoll = false;
    for (const r of show) {
      for (const t of r.toolLog || []) addToolLog(t);
      const cuando = new Date(r.ts).toLocaleString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      addMsg(`${t('report.prefix', { when: cuando })}\n\n${r.reply || t('report.empty')}`, 'assistant');
      chatHistory.push({ role: 'assistant', content: r.reply || '' });
    }
    lastReportTs = list[list.length - 1].ts;
  } catch { /* informes no críticos */ }
}

// ---------- Selector de idioma ----------
// setLang() re-aplica los data-i18n del HTML estático; aquí se re-renderiza lo
// dinámico visible: badges de sesiones, historial si está abierto y el título
// del terminal. En Firefox el ⓘ de fullscreen lleva su propio texto (sin
// Keyboard Lock) y applyI18n le habría puesto el de Chromium: se repone.
document.getElementById('lang-select').onchange = (e) => {
  setLang(e.target.value);
  applyFullscreenHelp();
  refreshSessions();
  if (!historyOverlay.classList.contains('hidden')) loadHistory();
  if (selected) outputTitle.textContent = t('terminal.titleWith', { name: selected });
  else if (!term) {
    terminalEl.textContent = t('terminal.selectSession');
    outputTitle.textContent = t('terminal.title');
  }
};

// ---------- Arranque ----------

detachTerminal();
refreshSessions();
loadConfig();
loadModels();
setInterval(refreshSessions, 4000);
// Los modelos de Ollama aparecen/desaparecen según su servidor esté arrancado;
// se reconsultan cada 30 s (y al volver el foco) sin recargar la página
setInterval(loadModels, 30000);
pollReports();
setInterval(pollReports, 20000);
