// HTTP + Socket.IO server. Every change sends each player their own view of the room.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const LOBBY_DROP_MS = 60 * 1000; // a player who vanishes from the lobby is removed after this
const ROOM_IDLE_MS = 15 * 60 * 1000; // a room with nobody connected is deleted after this

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/r/:code', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> Room
const sockets = new Map(); // socket.id -> { code, pid }

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 5 }, () => letters[crypto.randomInt(letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

function broadcast(room) {
  for (const [sid, ref] of sockets) {
    if (ref.code !== room.code) continue;
    const s = io.sockets.sockets.get(sid);
    if (s && room.players.has(ref.pid)) s.emit('state', room.viewFor(ref.pid));
  }
}

function createRoom() {
  const code = newCode();
  const room = new Room(code, () => broadcast(room));
  rooms.set(code, room);
  return room;
}

function attach(socket, room, player) {
  // Only one live socket per player; an older tab gets disconnected.
  for (const [sid, ref] of sockets) {
    if (ref.pid === player.id && sid !== socket.id) {
      sockets.delete(sid);
      io.sockets.sockets.get(sid)?.emit('kicked', 'You opened this game in another tab.');
    }
  }
  sockets.set(socket.id, { code: room.code, pid: player.id });
  player.connected = true;
  player.disconnectedAt = null;
  if (!room.hostId || !room.players.get(room.hostId)) room.hostId = player.id;
  socket.join(room.code);
}

const validToken = (t) => typeof t === 'string' && /^[a-f0-9]{16,64}$/.test(t);

io.on('connection', (socket) => {
  const ctx = () => {
    const ref = sockets.get(socket.id);
    const room = ref && rooms.get(ref.code);
    return room && room.players.has(ref.pid) ? { room, pid: ref.pid } : null;
  };

  // Wraps a handler: runs it, reports errors via ack, then pushes fresh state.
  const on = (event, fn) => socket.on(event, (data = {}, ack = () => {}) => {
    if (typeof ack !== 'function') ack = () => {};
    const c = ctx();
    if (!c) return ack({ error: 'You are not in a room.' });
    const error = fn(c, data || {});
    ack(error ? { error } : { ok: true });
    broadcast(c.room);
  });

  socket.on('create', ({ name, token } = {}, ack = () => {}) => {
    if (!validToken(token)) return ack({ error: 'Bad session, refresh the page.' });
    const room = createRoom();
    const { player, error } = room.addPlayer(name, token);
    if (error) { rooms.delete(room.code); return ack({ error }); }
    attach(socket, room, player);
    ack({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('join', ({ code, name, token } = {}, ack = () => {}) => {
    if (!validToken(token)) return ack({ error: 'Bad session, refresh the page.' });
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return ack({ error: 'Room not found. Check the code.' });
    const { player, error } = room.addPlayer(name, token);
    if (error) return ack({ error });
    attach(socket, room, player);
    ack({ ok: true, code: room.code });
    broadcast(room);
  });

  // Silent rejoin after a refresh / lost connection. Never creates a new player.
  socket.on('resume', ({ code, token } = {}, ack = () => {}) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && [...room.players.values()].find((p) => p.token === token && !p.left);
    if (!player) return ack({ error: 'gone' });
    attach(socket, room, player);
    ack({ ok: true, code: room.code });
    broadcast(room);
  });

  on('settings', ({ room, pid }, s) => room.updateSettings(pid, s));
  on('start', ({ room, pid }) => room.start(pid));
  on('action', ({ room, pid }, { action, target }) => room.submitAction(pid, action, target));
  on('ready', ({ room, pid }) => room.setReady(pid));
  on('vote', ({ room, pid }, { target }) => room.vote(pid, target));
  on('chat', ({ room, pid }, { channel, text }) => room.chat(pid, channel, text));
  on('restart', ({ room, pid }) => room.restart(pid));
  on('kick', ({ room, pid }, { target }) => {
    if (pid !== room.hostId || room.phase !== 'lobby' || target === pid) return 'Only the host can remove players in the lobby.';
    room.removePlayer(target);
    for (const [sid, ref] of sockets) {
      if (ref.pid === target) { sockets.delete(sid); io.sockets.sockets.get(sid)?.emit('kicked', 'The host removed you from the room.'); }
    }
    return null;
  });
  on('leave', ({ room, pid }) => {
    sockets.delete(socket.id);
    room.removePlayer(pid);
    if (room.players.size === 0) { room.resetGame(); rooms.delete(room.code); }
    return null;
  });

  socket.on('disconnect', () => {
    const c = ctx();
    sockets.delete(socket.id);
    if (!c) return;
    const p = c.room.players.get(c.pid);
    const stillHere = [...sockets.values()].some((r) => r.pid === c.pid);
    if (p && !stillHere) {
      p.connected = false;
      p.disconnectedAt = Date.now();
      c.room.maybeEndEarly();
    }
    broadcast(c.room);
  });
});

// Housekeeping: drop vanished lobby players, hand off host, delete idle rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    let changed = false;
    for (const p of [...room.players.values()]) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > LOBBY_DROP_MS && (room.phase === 'lobby' || room.phase === 'ended')) {
        room.removePlayer(p.id);
        changed = true;
      }
    }
    const host = room.players.get(room.hostId);
    if (host && !host.connected && host.disconnectedAt && now - host.disconnectedAt > 30 * 1000) {
      const before = room.hostId;
      room.pickNewHost();
      if (!room.hostId) room.hostId = before;
      changed = changed || room.hostId !== before;
    }
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone) {
      room.idleSince = room.idleSince || now;
      if (now - room.idleSince > ROOM_IDLE_MS || room.players.size === 0) { room.resetGame(); rooms.delete(code); continue; }
    } else room.idleSince = null;
    if (changed) broadcast(room);
  }
}, 5000).unref();

server.listen(PORT, () => console.log(`Mafia is running on http://localhost:${PORT}`));

module.exports = { server };
