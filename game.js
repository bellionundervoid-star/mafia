// Mafia game engine: rooms, roles, phases, night resolution, voting, win checks.
// Knows nothing about sockets — the server passes a `notify` callback.

const crypto = require('crypto');

const ROLES = {
  civilian:  { name: 'Civilian',  team: 'town',   actions: [],                desc: 'No night power. Find the Mafia by talking and voting.' },
  mafia:     { name: 'Mafia',     team: 'mafia',  actions: ['kill'],          desc: 'Each night, vote with your family on who to kill.' },
  don:       { name: 'Don',       team: 'mafia',  actions: ['kill', 'check'], desc: 'Head of the family. Your pick breaks kill ties, and each night you can check if someone is the Detective.' },
  doctor:    { name: 'Doctor',    team: 'town',   actions: ['heal'],          desc: 'Each night, save one person from death. Not the same person twice in a row; yourself only once.' },
  detective: { name: 'Detective', team: 'town',   actions: ['check'],         desc: 'Each night, learn whether one person is Mafia.' },
  bodyguard: { name: 'Bodyguard', team: 'town',   actions: ['guard'],         desc: 'Each night, guard one person. If they are attacked, you die in their place.' },
  escort:    { name: 'Escort',    team: 'town',   actions: ['block'],         desc: 'Each night, visit one person. Their night action is cancelled.' },
  sheriff:   { name: 'Sheriff',   team: 'town',   actions: ['shoot'],         desc: 'You have one bullet. Use it on any night to shoot someone.' },
  maniac:    { name: 'Maniac',    team: 'maniac', actions: ['kill'],          desc: 'You kill one person every night. You win if you are the last one standing.' },
  jester:    { name: 'Jester',    team: 'jester', actions: [],                desc: 'You win if the town votes you out. Act suspicious!' },
};

const ACTION_LABELS = {
  kill: 'Kill', check: 'Investigate', heal: 'Heal', guard: 'Guard', block: 'Distract', shoot: 'Shoot',
};

const DEFAULT_SETTINGS = {
  minPlayers: 4,
  maxPlayers: 12,
  timers: { night: 45, day: 120, vote: 30 },
  roles: null, // null = automatic mix based on player count
};

function recommendedRoles(n) {
  const r = { mafia: 1, doctor: 1, detective: 1 };
  if (n >= 6) r.don = 1;
  if (n >= 8) { r.escort = 1; r.jester = 1; }
  if (n >= 10) { r.mafia = 2; r.bodyguard = 1; r.sheriff = 1; }
  if (n >= 12) r.maniac = 1;
  if (n >= 14) r.mafia = 3;
  return r;
}

const id = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const MAX_CHAT = 300;

class Room {
  constructor(code, notify) {
    this.code = code;
    this.notify = notify || (() => {});
    this.players = new Map(); // id -> player
    this.order = []; // join order of player ids
    this.hostId = null;
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.timer = null;
    this.resetGame();
  }

  resetGame() {
    clearTimeout(this.timer);
    this.phase = 'lobby';
    this.day = 0;
    this.endsAt = null;
    this.nightActions = {};
    this.ready = new Set();
    this.votes = {};
    this.chats = { public: [], mafia: [], ghost: [] };
    this.history = [];
    this.winner = null;
    this.lastEvent = null;
    for (const p of this.players.values()) {
      Object.assign(p, { alive: true, role: null, notes: [], bullets: 0, lastHeal: null, selfHealUsed: false });
    }
  }

  // ---------- players ----------

  addPlayer(name, token) {
    for (const p of this.players.values()) {
      if (p.token === token) { p.connected = true; return { player: p }; }
    }
    if (this.phase !== 'lobby') return { error: 'This game has already started.' };
    if (this.players.size >= this.settings.maxPlayers) return { error: 'This room is full.' };
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) return { error: 'Enter a nickname.' };
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    let final = name;
    for (let i = 2; taken.has(final.toLowerCase()); i++) final = `${name.slice(0, 13)} ${i}`;
    const p = { id: id(), token, name: final, connected: true, disconnectedAt: null };
    this.players.set(p.id, p);
    this.order.push(p.id);
    Object.assign(p, { alive: true, role: null, notes: [], bullets: 0, lastHeal: null, selfHealUsed: false });
    if (!this.hostId) this.hostId = p.id;
    this.system(`${p.name} joined the room.`);
    return { player: p };
  }

  removePlayer(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    if (this.phase === 'lobby' || this.phase === 'ended') {
      this.players.delete(pid);
      this.order = this.order.filter((x) => x !== pid);
      this.system(`${p.name} left the room.`);
    } else {
      // Mid-game: keep their seat but treat them as gone.
      p.connected = false;
      p.left = true;
      if (p.alive) {
        this.kill(p, 'left');
        this.system(`${p.name} left the game. They were the ${ROLES[p.role].name}.`);
        if (!this.checkWin()) this.maybeEndEarly();
      }
    }
    if (this.hostId === pid) this.pickNewHost();
  }

  pickNewHost() {
    const next = this.order.map((x) => this.players.get(x)).find((p) => p && p.connected && !p.left);
    this.hostId = next ? next.id : null;
    if (next) this.system(`${next.name} is now the host.`);
  }

  // ---------- settings ----------

  updateSettings(pid, s) {
    if (pid !== this.hostId || this.phase !== 'lobby') return 'Only the host can change settings in the lobby.';
    const cur = this.settings;
    if (s.minPlayers !== undefined) cur.minPlayers = clampInt(s.minPlayers, 4, 20, cur.minPlayers);
    if (s.maxPlayers !== undefined) cur.maxPlayers = clampInt(s.maxPlayers, 4, 20, cur.maxPlayers);
    if (cur.maxPlayers < cur.minPlayers) cur.maxPlayers = cur.minPlayers;
    if (s.timers) {
      cur.timers.night = clampInt(s.timers.night ?? cur.timers.night, 10, 600, cur.timers.night);
      cur.timers.day = clampInt(s.timers.day ?? cur.timers.day, 10, 900, cur.timers.day);
      cur.timers.vote = clampInt(s.timers.vote ?? cur.timers.vote, 10, 300, cur.timers.vote);
    }
    if (s.roles === null) cur.roles = null;
    else if (s.roles && typeof s.roles === 'object') {
      const roles = {};
      for (const key of Object.keys(ROLES)) {
        if (key === 'civilian') continue;
        const max = key === 'mafia' ? 6 : 1;
        const v = clampInt(s.roles[key] ?? 0, 0, max, 0);
        if (v) roles[key] = v;
      }
      cur.roles = roles;
    }
    return null;
  }

  roleMix() {
    return this.settings.roles || recommendedRoles(this.players.size);
  }

  // ---------- game start ----------

  start(pid) {
    if (pid !== this.hostId) return 'Only the host can start the game.';
    if (this.phase !== 'lobby') return 'The game is already running.';
    const players = [...this.players.values()];
    const n = players.length;
    if (n < this.settings.minPlayers) return `Need at least ${this.settings.minPlayers} players (have ${n}).`;
    const mix = this.roleMix();
    const deck = [];
    for (const [role, count] of Object.entries(mix)) for (let i = 0; i < count; i++) deck.push(role);
    const mafiaTeam = deck.filter((r) => ROLES[r].team === 'mafia').length;
    if (mafiaTeam < 1) return 'Add at least one Mafia or Don.';
    if (deck.length > n) return `Too many roles (${deck.length}) for ${n} players.`;
    if (mafiaTeam * 2 >= n) return 'Too many Mafia for this many players.';
    while (deck.length < n) deck.push('civilian');
    shuffle(deck);

    this.resetGame();
    players.forEach((p, i) => {
      p.role = deck[i];
      p.bullets = p.role === 'sheriff' ? 1 : 0;
      p.notes.push({ day: 0, text: `You are the ${ROLES[p.role].name}. ${ROLES[p.role].desc}` });
    });
    const mafiaNames = players.filter((p) => ROLES[p.role].team === 'mafia');
    for (const p of mafiaNames) {
      const mates = mafiaNames.filter((m) => m !== p).map((m) => `${m.name} (${ROLES[m.role].name})`);
      if (mates.length) p.notes.push({ day: 0, text: `Your family: ${mates.join(', ')}.` });
    }
    this.system(`The game begins with ${n} players. Roles in play: ${this.describeMix(deck)}.`);
    this.startNight();
    return null;
  }

  describeMix(deck) {
    const counts = {};
    for (const r of deck) counts[r] = (counts[r] || 0) + 1;
    return Object.entries(counts).map(([r, c]) => (c > 1 ? `${c}× ${ROLES[r].name}` : ROLES[r].name)).join(', ');
  }

  // ---------- phases ----------

  setPhase(phase, seconds) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.endsAt = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => this.advance(), seconds * 1000);
    this.timer.unref?.();
  }

  advance() {
    if (this.phase === 'night') this.resolveNight();
    else if (this.phase === 'day') this.startVote();
    else if (this.phase === 'vote') this.resolveVote();
    this.notify();
  }

  startNight() {
    this.day += 1;
    this.nightActions = {};
    this.setPhase('night', this.settings.timers.night);
    this.system(`🌙 Night ${this.day} falls. The town sleeps…`);
  }

  startDay() {
    this.ready = new Set();
    this.setPhase('day', this.settings.timers.day);
    this.system(`☀️ Day ${this.day}. Discuss — who is lying?`);
  }

  startVote() {
    this.votes = {};
    this.setPhase('vote', this.settings.timers.vote);
    this.system('🗳️ Voting has started. Pick who to send away — or skip.');
  }

  alivePlayers() {
    return [...this.players.values()].filter((p) => p.alive);
  }

  // Which actions this player still owes tonight (empty = nothing to do).
  actionsFor(p) {
    if (!p.alive || this.phase !== 'night') return [];
    return ROLES[p.role].actions.filter((a) => !(a === 'shoot' && p.bullets < 1));
  }

  validTargets(p, action) {
    const alive = this.alivePlayers();
    switch (action) {
      case 'kill':
        if (ROLES[p.role].team === 'mafia') return alive.filter((t) => ROLES[t.role].team !== 'mafia');
        return alive.filter((t) => t !== p);
      case 'heal':
        return alive.filter((t) => t.id !== p.lastHeal && !(t === p && p.selfHealUsed));
      case 'check':
      case 'guard':
      case 'block':
      case 'shoot':
        return alive.filter((t) => t !== p);
      default:
        return [];
    }
  }

  submitAction(pid, action, targetId) {
    const p = this.players.get(pid);
    if (!p || !this.actionsFor(p).includes(action)) return 'You cannot do that now.';
    if (targetId !== 'skip' && !this.validTargets(p, action).some((t) => t.id === targetId)) return 'Invalid target.';
    this.nightActions[pid] = { ...(this.nightActions[pid] || {}), [action]: targetId };
    this.maybeEndEarly();
    return null;
  }

  nightDone() {
    return this.alivePlayers().every((p) => {
      const need = this.actionsFor(p);
      if (!need.length || !p.connected) return true;
      return need.every((a) => this.nightActions[p.id]?.[a] !== undefined);
    });
  }

  maybeEndEarly() {
    if (this.phase === 'night' && this.nightDone()) this.endPhaseSoon();
    else if (this.phase === 'day' && this.alivePlayers().filter((p) => p.connected).every((p) => this.ready.has(p.id))) this.endPhaseSoon();
    else if (this.phase === 'vote' && this.alivePlayers().filter((p) => p.connected).every((p) => this.votes[p.id] !== undefined)) this.endPhaseSoon();
  }

  // Short grace period so the last person sees their choice land.
  endPhaseSoon() {
    const soon = Date.now() + 2000;
    if (this.endsAt && this.endsAt <= soon) return;
    clearTimeout(this.timer);
    this.endsAt = soon;
    this.timer = setTimeout(() => this.advance(), 2000);
    this.timer.unref?.();
  }

  resolveNight() {
    const acts = this.nightActions;
    const alive = this.alivePlayers();
    const name = (tid) => this.players.get(tid)?.name;
    const log = []; // recap lines for history
    const blocked = new Set();

    for (const p of alive.filter((x) => x.role === 'escort')) {
      const t = acts[p.id]?.block;
      if (t && t !== 'skip') {
        blocked.add(t);
        log.push(`Escort ${p.name} distracted ${name(t)}.`);
      }
    }
    const act = (p, key) => {
      if (blocked.has(p.id) && p.role !== 'escort') return null;
      const v = acts[p.id]?.[key];
      return v && v !== 'skip' ? v : null;
    };
    for (const tid of blocked) {
      const t = this.players.get(tid);
      if (t && this.actionsFor(t).length) t.notes.push({ day: this.day, text: 'You were distracted tonight. Your action did nothing.' });
    }

    const attacks = [];

    // Mafia family: plurality of kill votes, Don breaks ties.
    const family = alive.filter((p) => ROLES[p.role].team === 'mafia');
    const tally = {};
    let donPick = null;
    for (const p of family) {
      const t = act(p, 'kill');
      if (!t) continue;
      tally[t] = (tally[t] || 0) + 1;
      if (p.role === 'don') donPick = t;
    }
    const top = Math.max(0, ...Object.values(tally));
    if (top > 0) {
      const tied = Object.keys(tally).filter((t) => tally[t] === top);
      const target = tied.includes(donPick) ? donPick : tied[crypto.randomInt(tied.length)];
      attacks.push({ target, by: 'mafia' });
      log.push(`The Mafia chose to kill ${name(target)}.`);
    } else if (family.length) log.push('The Mafia did not agree on a target.');

    for (const p of alive.filter((x) => x.role === 'maniac')) {
      const t = act(p, 'kill');
      if (t) { attacks.push({ target: t, by: 'maniac' }); log.push(`Maniac ${p.name} attacked ${name(t)}.`); }
    }
    for (const p of alive.filter((x) => x.role === 'sheriff')) {
      const t = act(p, 'shoot');
      if (t) { p.bullets -= 1; attacks.push({ target: t, by: 'sheriff' }); log.push(`Sheriff ${p.name} shot at ${name(t)}.`); }
    }

    const heals = new Map(); // target -> doctor
    for (const p of alive.filter((x) => x.role === 'doctor')) {
      const raw = acts[p.id]?.heal;
      if (raw && raw !== 'skip') {
        // Restrictions apply even if blocked, so the choice was "spent".
        p.lastHeal = raw;
        if (raw === p.id) p.selfHealUsed = true;
      } else p.lastHeal = null;
      const t = act(p, 'heal');
      if (t) { heals.set(t, p); log.push(`Doctor ${p.name} treated ${name(t)}.`); }
    }
    const guards = new Map(); // target -> bodyguard
    for (const p of alive.filter((x) => x.role === 'bodyguard')) {
      const t = act(p, 'guard');
      if (t) { guards.set(t, p); log.push(`Bodyguard ${p.name} guarded ${name(t)}.`); }
    }

    const deaths = new Set();
    for (const { target } of attacks) {
      const t = this.players.get(target);
      if (!t || !t.alive) continue;
      if (heals.has(target)) {
        heals.get(target).notes.push({ day: this.day, text: `${t.name} was attacked tonight — you saved them!` });
        log.push(`${t.name} was attacked but the Doctor saved them.`);
        continue;
      }
      const bg = guards.get(target);
      if (bg && bg.alive && !deaths.has(bg.id)) {
        log.push(`Bodyguard ${bg.name} took the hit for ${t.name}.`);
        if (heals.has(bg.id)) log.push(`…and the Doctor saved the Bodyguard.`);
        else deaths.add(bg.id);
        continue;
      }
      deaths.add(target);
    }

    // Investigations happen regardless of who dies tonight.
    for (const p of alive) {
      const t = act(p, 'check');
      if (!t) continue;
      const target = this.players.get(t);
      if (p.role === 'detective') {
        const isMafia = ROLES[target.role].team === 'mafia';
        p.notes.push({ day: this.day, text: `${target.name} is ${isMafia ? '🔴 MAFIA' : '🟢 not Mafia'}.` });
        log.push(`Detective ${p.name} investigated ${target.name}: ${isMafia ? 'Mafia' : 'not Mafia'}.`);
      } else if (p.role === 'don') {
        const isDet = target.role === 'detective';
        p.notes.push({ day: this.day, text: `${target.name} is ${isDet ? '🔎 the DETECTIVE' : 'not the Detective'}.` });
        log.push(`Don ${p.name} checked ${target.name}: ${isDet ? 'Detective' : 'not Detective'}.`);
      }
    }

    const dead = [...deaths].map((x) => this.players.get(x));
    for (const p of dead) this.kill(p, 'night');
    this.history.push({ title: `Night ${this.day}`, lines: log.length ? log : ['A quiet night. Nobody acted.'] });
    this.lastEvent = { type: 'dawn', deaths: dead.map((p) => p.id), at: Date.now() };
    if (dead.length) this.system(`At dawn, the town finds: ${dead.map((p) => `${p.name} (${ROLES[p.role].name})`).join(', ')} — dead.`);
    else this.system('At dawn, everyone is alive. Nobody died tonight.');
    if (!this.checkWin()) this.startDay();
  }

  setReady(pid) {
    const p = this.players.get(pid);
    if (this.phase !== 'day' || !p?.alive) return 'Not now.';
    if (this.ready.has(pid)) this.ready.delete(pid);
    else this.ready.add(pid);
    this.maybeEndEarly();
    return null;
  }

  vote(pid, targetId) {
    const p = this.players.get(pid);
    if (this.phase !== 'vote' || !p?.alive) return 'You cannot vote now.';
    if (targetId !== 'skip') {
      const t = this.players.get(targetId);
      if (!t || !t.alive || t === p) return 'Invalid vote.';
    }
    this.votes[pid] = targetId;
    this.maybeEndEarly();
    return null;
  }

  resolveVote() {
    const tally = {};
    let skips = 0;
    const lines = [];
    for (const [pid, t] of Object.entries(this.votes)) {
      const voter = this.players.get(pid);
      if (!voter?.alive) continue;
      if (t === 'skip') { skips++; lines.push(`${voter.name} skipped.`); continue; }
      tally[t] = (tally[t] || 0) + 1;
      lines.push(`${voter.name} voted for ${this.players.get(t).name}.`);
    }
    const top = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter((t) => tally[t] === top);
    let out = null;
    if (top > 0 && leaders.length === 1 && top > skips) out = this.players.get(leaders[0]);

    if (out) {
      this.kill(out, 'vote');
      lines.push(`${out.name} (${ROLES[out.role].name}) was voted out.`);
      this.system(`⚖️ The town has spoken: ${out.name} is out. They were the ${ROLES[out.role].name}.`);
      this.lastEvent = { type: 'lynch', deaths: [out.id], at: Date.now() };
    } else {
      lines.push('No one was voted out.');
      this.system(top > 0 && leaders.length > 1 ? '⚖️ The vote is tied. Nobody is sent away.' : '⚖️ The town could not decide. Nobody is sent away.');
      this.lastEvent = { type: 'lynch', deaths: [], at: Date.now() };
    }
    this.history.push({ title: `Day ${this.day} vote`, lines });

    if (out && out.role === 'jester') return this.endGame('jester', `${out.name} the Jester fooled you all!`);
    if (!this.checkWin()) this.startNight();
  }

  kill(p, how) {
    p.alive = false;
    p.diedHow = how;
    p.diedDay = this.day;
    this.ready.delete(p.id);
    delete this.votes[p.id];
  }

  checkWin() {
    if (this.phase === 'lobby' || this.phase === 'ended') return true;
    const alive = this.alivePlayers();
    const mafia = alive.filter((p) => ROLES[p.role].team === 'mafia').length;
    const maniac = alive.filter((p) => p.role === 'maniac').length;
    const rest = alive.length - mafia - maniac;
    if (alive.length === 0) return this.endGame('draw', 'Nobody survived.');
    if (mafia === 0 && maniac === 0) return this.endGame('town', 'The Town rooted out every threat!');
    if (maniac === 0 && mafia >= rest) return this.endGame('mafia', 'The Mafia now controls the town.');
    if (mafia === 0 && maniac > 0 && rest <= 1) return this.endGame('maniac', 'The Maniac is the last one standing.');
    return false;
  }

  endGame(winner, text) {
    clearTimeout(this.timer);
    this.phase = 'ended';
    this.endsAt = null;
    this.winner = { team: winner, text };
    this.system(`🏁 Game over. ${text}`);
    return true;
  }

  restart(pid) {
    if (pid !== this.hostId || this.phase !== 'ended') return 'Only the host can start a new game.';
    for (const [pidx, p] of this.players) {
      if (p.left || !p.connected) { this.players.delete(pidx); this.order = this.order.filter((x) => x !== pidx); }
    }
    this.resetGame();
    this.system('Back in the lobby. The host can start a new game.');
    return null;
  }

  // ---------- chat ----------

  system(text) {
    this.chats.public.push({ id: id(4), system: true, text, at: Date.now() });
    if (this.chats.public.length > MAX_CHAT) this.chats.public.shift();
  }

  canSend(p, channel) {
    const inGame = this.phase !== 'lobby' && this.phase !== 'ended';
    if (channel === 'public') return !inGame || (p.alive && this.phase !== 'night');
    if (channel === 'mafia') return inGame && p.alive && ROLES[p.role]?.team === 'mafia';
    if (channel === 'ghost') return inGame && !p.alive;
    return false;
  }

  canRead(p, channel) {
    if (channel === 'public') return true;
    if (this.phase === 'ended' || (p.role && !p.alive)) return true;
    if (channel === 'mafia') return !!p.role && ROLES[p.role].team === 'mafia';
    return false;
  }

  chat(pid, channel, text) {
    const p = this.players.get(pid);
    text = String(text || '').trim().slice(0, 400);
    if (!p || !text || !this.chats[channel]) return 'Cannot send.';
    if (!this.canSend(p, channel)) return channel === 'public' && this.phase === 'night' ? 'The town is asleep — no talking at night.' : 'You cannot talk there.';
    const now = Date.now();
    p.chatTimes = (p.chatTimes || []).filter((t) => now - t < 5000);
    if (p.chatTimes.length >= 6) return 'Slow down a little.';
    p.chatTimes.push(now);
    const list = this.chats[channel];
    list.push({ id: id(4), from: p.id, name: p.name, text, at: now });
    if (list.length > MAX_CHAT) list.shift();
    return null;
  }

  // ---------- per-player view ----------

  viewFor(pid) {
    const me = this.players.get(pid);
    const ended = this.phase === 'ended';
    const iAmMafia = me.role && ROLES[me.role].team === 'mafia';
    const seeAll = ended || (me.role && !me.alive);

    const players = this.order.map((x) => this.players.get(x)).filter(Boolean).map((p) => {
      const showRole = p.role && (p === me || seeAll || !p.alive || (iAmMafia && ROLES[p.role].team === 'mafia'));
      return {
        id: p.id,
        name: p.name,
        connected: p.connected && !p.left,
        alive: p.alive,
        isHost: p.id === this.hostId,
        role: showRole ? p.role : null,
        ready: this.phase === 'day' && this.ready.has(p.id),
        voted: this.phase === 'vote' && this.votes[p.id] !== undefined,
      };
    });

    const actions = this.actionsFor(me).map((a) => ({
      key: a,
      label: ACTION_LABELS[a],
      targets: this.validTargets(me, a).map((t) => t.id),
      choice: this.nightActions[me.id]?.[a] ?? null,
    }));

    let mafiaPicks = null;
    if (this.phase === 'night' && (iAmMafia || seeAll)) {
      mafiaPicks = this.alivePlayers()
        .filter((p) => ROLES[p.role].team === 'mafia')
        .map((p) => ({ id: p.id, target: this.nightActions[p.id]?.kill ?? null }));
    }

    const chats = {};
    for (const ch of Object.keys(this.chats)) if (this.canRead(me, ch)) chats[ch] = this.chats[ch];

    return {
      code: this.code,
      phase: this.phase,
      day: this.day,
      endsAt: this.endsAt,
      now: Date.now(),
      hostId: this.hostId,
      settings: this.settings,
      roleMix: this.roleMix(),
      roles: ROLES,
      me: { id: me.id, name: me.name, alive: me.alive, role: me.role, notes: me.notes, bullets: me.bullets },
      players,
      actions,
      mafiaPicks,
      votes: this.phase === 'vote' ? this.votes : null,
      canSend: Object.fromEntries(Object.keys(this.chats).map((ch) => [ch, this.canSend(me, ch)])),
      chats,
      history: ended ? this.history : null,
      winner: this.winner,
      lastEvent: this.lastEvent,
    };
  }
}

module.exports = { Room, ROLES, recommendedRoles };
