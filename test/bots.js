// Fill a room with bots for solo testing:  node test/bots.js ROOMCODE [count] [url]
const { io } = require('socket.io-client');
const crypto = require('crypto');

const [code, count = '5', url = 'http://localhost:3000'] = process.argv.slice(2);
if (!code) { console.log('Usage: node test/bots.js ROOMCODE [count] [url]'); process.exit(1); }

const NAMES = ['Vito', 'Sonny', 'Luca', 'Carla', 'Rosa', 'Tommy', 'Gina', 'Sal', 'Nico', 'Lena', 'Bruno', 'Mia'];
const LINES = ['I trust nobody.', 'It was not me!', 'Something feels off…', 'I saw nothing last night.', 'Let\'s think about this.', 'Very suspicious.'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

for (let i = 0; i < Number(count); i++) {
  const socket = io(url);
  const token = crypto.randomBytes(12).toString('hex');
  const name = `${NAMES[i % NAMES.length]} 🤖`;
  let lastKey = '';
  socket.on('connect', () => socket.emit('join', { code, name, token }, (r) => console.log(name, r.error || 'joined')));
  socket.on('state', (s) => {
    const key = `${s.phase}:${s.day}:${s.me.alive}`;
    if (key === lastKey || !s.me.alive) return;
    lastKey = key;
    const delay = 1500 + Math.random() * 3000;
    setTimeout(() => {
      if (s.phase === 'night') {
        for (const a of s.actions) socket.emit('action', { action: a.key, target: a.targets.length ? pick(a.targets) : 'skip' }, () => {});
        if (s.canSend.mafia) socket.emit('chat', { channel: 'mafia', text: 'Let\'s get them tonight.' }, () => {});
      } else if (s.phase === 'day') {
        socket.emit('chat', { channel: 'public', text: pick(LINES) }, () => {});
        setTimeout(() => socket.emit('ready', {}, () => {}), 1000);
      } else if (s.phase === 'vote') {
        const others = s.players.filter((p) => p.alive && p.id !== s.me.id);
        socket.emit('vote', { target: Math.random() < 0.15 ? 'skip' : pick(others).id }, () => {});
      }
    }, delay);
  });
}
