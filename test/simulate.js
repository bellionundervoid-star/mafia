// Engine tests: hand-written night/vote scenarios plus thousands of random games.
const assert = require('assert');
const { Room, ROLES } = require('../game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n`, e); process.exitCode = 1; }
}

// Build a started room with exact roles (in seat order).
function setup(roles) {
  const room = new Room('TEST1');
  const ps = roles.map((_, i) => room.addPlayer(`P${i}`, `tok${i}`.padEnd(16, '0')).player);
  room.settings.roles = { mafia: 1 };
  assert.strictEqual(room.start(ps[0].id), null);
  ps.forEach((p, i) => { p.role = roles[i]; p.bullets = roles[i] === 'sheriff' ? 1 : 0; });
  return { room, ps };
}
const act = (room, p, a, t) => assert.strictEqual(room.submitAction(p.id, a, t === 'skip' ? 'skip' : t.id), null);
const dead = (room) => [...room.players.values()].filter((p) => !p.alive).map((p) => p.name).sort();

console.log('Scenarios');

test('mafia kill lands', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian', 'doctor']);
  act(room, ps[0], 'kill', ps[1]);
  room.resolveNight();
  assert.deepStrictEqual(dead(room), ['P1']);
  assert.strictEqual(room.phase, 'day');
});

test('doctor saves the target', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian', 'doctor']);
  act(room, ps[0], 'kill', ps[1]);
  act(room, ps[4], 'heal', ps[1]);
  room.resolveNight();
  assert.deepStrictEqual(dead(room), []);
  assert(ps[4].notes.some((n) => /saved/.test(n.text)));
});

test('doctor cannot heal same person twice in a row, self only once', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian', 'doctor']);
  act(room, ps[4], 'heal', ps[4]);
  act(room, ps[0], 'kill', 'skip');
  room.resolveNight(); room.startVote(); room.resolveVote();
  assert.strictEqual(room.phase, 'night');
  assert.notStrictEqual(room.submitAction(ps[4].id, 'heal', ps[4].id), null);
  act(room, ps[4], 'heal', ps[1]);
  room.resolveNight(); room.startVote(); room.resolveVote();
  assert.notStrictEqual(room.submitAction(ps[4].id, 'heal', ps[1].id), null);
  assert.notStrictEqual(room.submitAction(ps[4].id, 'heal', ps[4].id), null); // self already used
});

test('escort blocks the only mafia', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian', 'escort']);
  act(room, ps[0], 'kill', ps[1]);
  act(room, ps[4], 'block', ps[0]);
  room.resolveNight();
  assert.deepStrictEqual(dead(room), []);
  assert(ps[0].notes.some((n) => /distracted/.test(n.text)));
});

test('bodyguard dies instead of target', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian', 'bodyguard', 'civilian']);
  act(room, ps[0], 'kill', ps[1]);
  act(room, ps[4], 'guard', ps[1]);
  room.resolveNight();
  assert.deepStrictEqual(dead(room), ['P4']);
});

test('don breaks a kill tie', () => {
  const { room, ps } = setup(['mafia', 'don', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian']);
  act(room, ps[0], 'kill', ps[2]);
  act(room, ps[1], 'kill', ps[3]);
  room.resolveNight();
  assert.deepStrictEqual(dead(room), ['P3']);
});

test('mafia cannot target family', () => {
  const { room, ps } = setup(['mafia', 'don', 'civilian', 'civilian', 'civilian', 'civilian']);
  assert.notStrictEqual(room.submitAction(ps[0].id, 'kill', ps[1].id), null);
});

test('detective and don get correct results', () => {
  const { room, ps } = setup(['don', 'detective', 'civilian', 'civilian', 'civilian']);
  act(room, ps[1], 'check', ps[0]);
  act(room, ps[0], 'check', ps[1]);
  act(room, ps[0], 'kill', 'skip');
  room.resolveNight();
  assert(ps[1].notes.some((n) => /P0 is 🔴 MAFIA/.test(n.text)));
  assert(ps[0].notes.some((n) => /P1 is 🔎 the DETECTIVE/.test(n.text)));
});

test('sheriff has one bullet', () => {
  const { room, ps } = setup(['mafia', 'sheriff', 'civilian', 'civilian', 'civilian', 'civilian']);
  act(room, ps[1], 'shoot', ps[0]);
  act(room, ps[0], 'kill', ps[2]);
  room.resolveNight();
  assert.deepStrictEqual(dead(room), ['P0', 'P2']);
  assert.strictEqual(room.phase, 'ended');
  assert.strictEqual(room.winner.team, 'town');
});

test('jester wins when voted out', () => {
  const { room, ps } = setup(['mafia', 'jester', 'civilian', 'civilian', 'civilian', 'civilian']);
  act(room, ps[0], 'kill', 'skip');
  room.resolveNight();
  room.startVote();
  for (const p of [ps[0], ps[2], ps[3], ps[4]]) room.vote(p.id, ps[1].id);
  room.resolveVote();
  assert.strictEqual(room.winner.team, 'jester');
});

test('tie vote sends nobody away', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian']);
  act(room, ps[0], 'kill', 'skip');
  room.resolveNight(); room.startVote();
  room.vote(ps[0].id, ps[1].id); room.vote(ps[1].id, ps[0].id);
  room.resolveVote();
  assert.deepStrictEqual(dead(room), []);
});

test('mafia wins at parity', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian']);
  act(room, ps[0], 'kill', ps[1]);
  room.resolveNight(); room.startVote();
  room.vote(ps[0].id, ps[2].id); room.vote(ps[3].id, ps[2].id);
  room.resolveVote();
  assert.strictEqual(room.winner.team, 'mafia');
});

test('maniac wins last one standing', () => {
  const { room, ps } = setup(['mafia', 'maniac', 'civilian', 'civilian', 'civilian']);
  act(room, ps[0], 'kill', ps[2]);
  act(room, ps[1], 'kill', ps[0]);
  room.resolveNight();
  room.startVote(); room.vote(ps[1].id, ps[3].id); room.vote(ps[4].id, ps[3].id); room.resolveVote();
  assert.strictEqual(room.winner.team, 'maniac');
});

test('views never leak hidden roles', () => {
  const { room, ps } = setup(['mafia', 'don', 'doctor', 'civilian', 'detective', 'civilian']);
  const civView = room.viewFor(ps[3].id);
  assert(civView.players.filter((p) => p.id !== ps[3].id).every((p) => p.role === null));
  assert(!civView.chats.mafia && !civView.chats.ghost && civView.mafiaPicks === null);
  const mafView = room.viewFor(ps[0].id);
  assert.strictEqual(mafView.players[1].role, 'don');
  assert.strictEqual(mafView.players[2].role, null);
});

test('chat channels obey phase rules', () => {
  const { room, ps } = setup(['mafia', 'civilian', 'civilian', 'civilian']);
  assert.notStrictEqual(room.chat(ps[1].id, 'public', 'hi'), null); // night: town asleep
  assert.strictEqual(room.chat(ps[0].id, 'mafia', 'kill P1'), null);
  assert.notStrictEqual(room.chat(ps[1].id, 'mafia', 'sneaky'), null);
  act(room, ps[0], 'kill', ps[1]);
  room.resolveNight();
  assert.strictEqual(room.chat(ps[2].id, 'public', 'who?'), null);
  assert.notStrictEqual(room.chat(ps[1].id, 'public', 'boo'), null); // dead can't talk to town
  assert.strictEqual(room.chat(ps[1].id, 'ghost', 'boo'), null);
  assert(room.viewFor(ps[1].id).chats.mafia); // dead can read family chat
});

console.log('\nRandom games');
const roleKeys = Object.keys(ROLES).filter((r) => r !== 'civilian');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const results = {};
const GAMES = 3000;
for (let g = 0; g < GAMES; g++) {
  const n = 4 + Math.floor(Math.random() * 17);
  const room = new Room('RAND1');
  const ps = Array.from({ length: n }, (_, i) => room.addPlayer(`P${i}`, `t${g}x${i}`.padEnd(16, '0')).player);
  if (Math.random() < 0.5) {
    const roles = { mafia: 1 + Math.floor(Math.random() * Math.max(1, Math.floor((n - 1) / 3))) };
    for (const r of roleKeys) if (r !== 'mafia' && Math.random() < 0.5) roles[r] = 1;
    room.settings.roles = roles;
  }
  const err = room.start(ps[0].id);
  if (err) { room.settings.roles = null; assert.strictEqual(room.start(ps[0].id), null); }
  let cycles = 0;
  while (room.phase !== 'ended') {
    assert(++cycles < 200, 'game did not finish');
    if (room.phase === 'night') {
      for (const p of room.alivePlayers()) {
        for (const a of room.actionsFor(p)) {
          const targets = room.validTargets(p, a);
          const t = Math.random() < 0.15 || !targets.length ? 'skip' : pick(targets).id;
          assert.strictEqual(room.submitAction(p.id, a, t), null);
        }
      }
      room.resolveNight();
    } else if (room.phase === 'day') {
      room.startVote();
    } else if (room.phase === 'vote') {
      const alive = room.alivePlayers();
      for (const p of alive) {
        const others = alive.filter((x) => x !== p);
        room.vote(p.id, Math.random() < 0.1 || !others.length ? 'skip' : pick(others).id);
      }
      room.resolveVote();
    }
    for (const p of room.players.values()) {
      const v = room.viewFor(p.id);
      if (p.alive && room.phase !== 'ended' && ROLES[p.role].team !== 'mafia') {
        assert(v.players.every((q) => q.id === p.id || !q.alive || q.role === null), 'role leaked');
      }
    }
  }
  results[room.winner.team] = (results[room.winner.team] || 0) + 1;
  clearTimeout(room.timer);
}
console.log(`  ✓ ${GAMES} games finished. Winners:`, results);
console.log(`\n${passed} scenario tests passed${process.exitCode ? ', some FAILED' : ''}.`);
