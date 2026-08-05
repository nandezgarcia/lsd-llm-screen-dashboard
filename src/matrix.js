// Bot de Matrix: otro canal de entrada al MISMO gestor (runManagerChat de
// deepseek.js) para hablar con él desde el móvil. Sala dedicada SIN cifrar
// (opción A acordada: el Synapse es privado, sin federación; el bot no
// implementa E2EE — en salas cifradas no puede leer nada).
// Sin MATRIX_HOMESERVER/USER/ACCESS_TOKEN en .env el bot no arranca y el
// resto del dashboard no se entera.
import path from 'node:path';
import { MatrixClient, SimpleFsStorageProvider, LogService, LogLevel } from 'matrix-bot-sdk';
import { config } from './config.js';
import { runManagerChat } from './deepseek.js';

let client = null;

// Historial por sala EN MEMORIA (como los informes: no sobrevive al reinicio;
// el gestor tampoco necesita más que el contexto reciente de la conversación)
const histories = new Map(); // roomId -> [{ role, content }]
const MAX_HISTORY = 20;
// Cola por sala: dos mensajes seguidos del usuario no deben solapar dos
// llamadas al gestor sobre el mismo historial
const queues = new Map(); // roomId -> Promise

const allowed = () => new Set(config.matrixAllowedUsers);

function enqueue(roomId, text) {
  const prev = queues.get(roomId) || Promise.resolve();
  const next = prev.then(() => handleMessage(roomId, text)).catch((err) => {
    console.warn(`Matrix: error procesando mensaje: ${err.message}`);
  });
  queues.set(roomId, next);
}

async function handleMessage(roomId, text) {
  const hist = histories.get(roomId) || [];
  hist.push({ role: 'user', content: text });
  await client.setTyping(roomId, true, 30000).catch(() => {});
  try {
    const r = await runManagerChat(hist.slice(-MAX_HISTORY), null);
    hist.push({ role: 'assistant', content: r.reply });
    histories.set(roomId, hist.slice(-MAX_HISTORY));
    await client.setTyping(roomId, false, 0).catch(() => {});
    await client.sendText(roomId, r.reply);
  } catch (err) {
    await client.setTyping(roomId, false, 0).catch(() => {});
    await client.sendText(roomId, `Error del gestor: ${err.message}`).catch(() => {});
  }
}

// Envía un texto a TODAS las salas del bot (informe periódico del gestor).
// No-op si el bot no está activo.
export async function sendMatrixReport(text) {
  if (!client) return;
  try {
    const rooms = await client.getJoinedRooms();
    for (const roomId of rooms) {
      await client.sendText(roomId, text).catch(() => {});
    }
  } catch (err) {
    console.warn(`Matrix: no se pudo enviar el informe: ${err.message}`);
  }
}

// Arranca el bot si hay config Matrix en .env; devuelve true si quedó activo.
// NUNCA lanza: un fallo de Matrix no debe impedir el arranque del dashboard.
export async function startMatrixBot() {
  if (!config.matrixHomeserver || !config.matrixAccessToken || !config.matrixUser) return false;
  try {
    LogService.setLevel(LogLevel.WARN); // la SDK es ruidosa en INFO
    // Storage en disco: persiste el sync token para no reprocesar mensajes
    // antiguos tras reiniciar el servidor
    const storage = new SimpleFsStorageProvider(
      path.join(config.root, 'data', 'matrix-storage.json')
    );
    client = new MatrixClient(config.matrixHomeserver, config.matrixAccessToken, storage);

    // Autojoin SELECTIVO: solo acepta invitaciones de usuarios autorizados
    // (con block_non_admin_invites del Synapse, solo admins pueden invitar)
    client.on('room.invite', async (roomId, event) => {
      if (!allowed().has(event.sender)) {
        console.warn(`Matrix: invitación ignorada de ${event.sender} (no autorizado)`);
        return;
      }
      try {
        await client.joinRoom(roomId);
        console.log(`Matrix: unido a ${roomId} por invitación de ${event.sender}`);
      } catch (err) {
        console.warn(`Matrix: no se pudo unir a ${roomId}: ${err.message}`);
      }
    });

    client.on('room.message', (roomId, event) => {
      if (event.sender === config.matrixUser) return; // eco propio
      if (!allowed().has(event.sender)) return; // ignorar en silencio
      if (event.content?.msgtype !== 'm.text') return;
      const body = event.content?.body;
      if (typeof body !== 'string' || body.trim() === '') return;
      enqueue(roomId, body.trim());
    });

    await client.start();
    console.log(`Matrix: bot conectado como ${config.matrixUser} en ${config.matrixHomeserver}`);
    return true;
  } catch (err) {
    client = null;
    console.warn(`Matrix: el bot no arrancó: ${err.message}`);
    return false;
  }
}
