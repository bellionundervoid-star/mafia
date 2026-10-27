// Mafia client: renders whatever the server says is true for this player.
(() => {
  const socket = io();
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const EMOJI = {
    civilian: '🧑', mafia: '🔫', don: '🎩', doctor: '💉', detective: '🔎',
    bodyguard: '🛡️', escort: '💋', sheriff: '⭐', maniac: '🔪', jester: '🃏',
  };
  const ACTION_TEXT = {
    kill: 'Who should die tonight?', check: 'Who do you investigate?', heal: 'Who do you save?',
    guard: 'Who do you protect?', block: 'Who do you distract?', shoot: 'Use your bullet? (only one per game)',
  };
  const TEAM_NAMES = { town: 'The Town', mafia: 'The Mafia', maniac: 'The Maniac', jester: 'The Jester', draw: 'Nobody' };
  const CHAT_NAMES = { public: 'Town', mafia: 'Family', ghost: 'Graveyard' };

  // ---- session (per tab, survives refresh) ----
  const store = {
    get(k, s = sessionStorage) { try { return s.getItem(k); } catch { return null; } },
    set(k, v, s = sessionStorage) { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch {} },
  };
  const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  let token = store.get('mafia.token') || randomToken();
  store.set('mafia.token', token);
  const savedName = store.get('mafia.name', localStorage);
  if (savedName) $('#nameInput').value = savedName;

  const urlCode = (location.pathname.match(/^\/r\/([A-Za-z]{5})/) || [])[1];
  if (urlCode) $('#codeInput').value = urlCode.toUpperCase();

  // ---- client state ----
  let S = null;
  let clockOffset = 0;
  let chatTab = 'public';
  const seen = { public: 0, mafia: 0, ghost: 0 };
  let prevPhase = null;
  let prevAlive = null;
  let lastEventAt = null;
  let roleHidden = false;
  let lastTickSecond = null;

  // ---- helpers ----
  function setHtml(el, html) {
    if (el._html === html) return;
    el._html = html;
    el.innerHTML = html;
  }
  function toast(text, ms = 3000) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function emit(event, data) {
    return new Promise((resolve) => socket.emit(event, data, (res) => {
      if (res?.error) toast(res.error);
      resolve(res || {});
    }));
  }
  const player = (id) => S.players.find((p) => p.id === id);
  const roleName = (r) => (r ? S.roles[r].name : '');
  const teamOf = (r) => (r ? S.roles[r].team : null);
  const initials = (n) => n.trim().slice(0, 1).toUpperCase();

  function showScreen(which) {
    $('#home').classList.toggle('hidden', which !== 'home');
    $('#room').classList.toggle('hidden', which !== 'room');
  }

  function enterRoom(code) {
    store.set('mafia.room', code);
    store.set('mafia.last', JSON.stringify({ code, token }), localStorage);
    history.replaceState(null, '', `/r/${code}`);
    showScreen('room');
  }

  function backHome(message) {
    store.set('mafia.room', null);
    S = null;
    prevPhase = null;
    prevAlive = null;
    lastEventAt = null;
    for (const k of Object.keys(seen)) seen[k] = 0;
    history.replaceState(null, '', '/');
    document.body.className = 'phase-lobby';
    showScreen('home');
    $('#homeError').textContent = message || '';
    updateRejoin();
  }

  function updateRejoin() {
    let last = null;
    try { last = JSON.parse(store.get('mafia.last', localStorage) || 'null'); } catch {}
    const btn = $('#rejoinBtn');
    if (last && last.code && !store.get('mafia.room')) {
      btn.textContent = `Rejoin room ${last.code}`;
      btn.classList.remove('hidden');
      btn.onclick = async () => {
        token = last.token;
        store.set('mafia.token', token);
        const res = await new Promise((r) => socket.emit('resume', { code: last.code, token }, r));
        if (res?.ok) enterRoom(res.code);
        else {
          store.set('mafia.last', null, localStorage);
          token = randomToken();
          store.set('mafia.token', token);
          btn.classList.add('hidden');
          $('#homeError').textContent = 'That game is no longer available.';
        }
      };
    } else btn.classList.add('hidden');
  }

  // ---- home ----
  function nameOrError() {
    const name = $('#nameInput').value.trim();
    if (!name) { $('#homeError').textContent = 'Enter a nickname first.'; $('#nameInput').focus(); return null; }
    store.set('mafia.name', name, localStorage);
    return name;
  }
  $('#createBtn').onclick = async () => {
    const name = nameOrError();
    if (!name) return;
    const res = await new Promise((r) => socket.emit('create', { name, token }, r));
    if (res.error) $('#homeError').textContent = res.error;
    else enterRoom(res.code);
  };
  const join = async () => {
    const name = nameOrError();
    if (!name) return;
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code.length !== 5) { $('#homeError').textContent = 'Room codes have 5 letters.'; return; }
    const res = await new Promise((r) => socket.emit('join', { code, name, token }, r));
    if (res.error) $('#homeError').textContent = res.error;
    else enterRoom(res.code);
  };
  $('#joinBtn').onclick = join;
  $('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('#codeInput').value ? join() : $('#createBtn').click()); });

  // ---- top bar ----
  $('#muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
  $('#muteBtn').onclick = () => { $('#muteBtn').textContent = Sound.toggle() ? '🔇' : '🔊'; };
  $('#leaveBtn').onclick = async () => {
    const inGame = S && S.phase !== 'lobby' && S.phase !== 'ended';
    if (!confirm(inGame ? 'Leave this game? You will count as dead.' : 'Leave this room?')) return;
    await emit('leave');
    store.set('mafia.last', null, localStorage);
    backHome();
  };

  // ---- socket ----
  socket.on('connect', async () => {
    const code = store.get('mafia.room');
    if (!code) { updateRejoin(); return; }
    const res = await new Promise((r) => socket.emit('resume', { code, token }, r));
    if (res?.ok) showScreen('room');
    else backHome('That room has closed.');
  });
  socket.on('disconnect', () => { if (S) toast('Connection lost — reconnecting…', 10000); });
  socket.on('kicked', (msg) => { store.set('mafia.last', null, localStorage); backHome(msg); });
  socket.on('state', (state) => {
    const first = !S;
    S = state;
    clockOffset = state.now - Date.now();
    if (first) $('#toast').classList.add('hidden');
    handleTransitions(first);
    render();
  });

  // ---- transitions: sounds + overlays ----
  function handleTransitions(first) {
    const phase = S.phase;
    const ev = S.lastEvent;
    if (first) {
      prevPhase = phase;
      prevAlive = S.me.alive;
      lastEventAt = ev?.at ?? null;
      if (phase !== 'lobby' && phase !== 'ended') chatTab = S.me.alive ? (phase === 'night' && S.chats.mafia ? 'mafia' : 'public') : 'ghost';
      for (const k of Object.keys(S.chats)) seen[k] = S.chats[k].length;
      return;
    }
    if (phase !== prevPhase) {
      if (prevPhase === 'lobby' && phase === 'night') {
        showRoleReveal();
        roleHidden = false;
        chatTab = S.chats.mafia ? 'mafia' : 'public';
      } else if (phase === 'night') {
        Sound.play('night');
        if (S.me.alive && S.chats.mafia && teamOf(S.me.role) === 'mafia') chatTab = 'mafia';
      } else if (phase === 'day') {
        if (S.me.alive) chatTab = 'public';
      } else if (phase === 'vote') {
        Sound.play('vote');
      } else if (phase === 'ended') {
        setTimeout(() => Sound.play('win'), 600);
        chatTab = 'public';
      } else if (phase === 'lobby') {
        chatTab = 'public';
      }
    }
    if (ev && ev.at !== lastEventAt) {
      lastEventAt = ev.at;
      const names = ev.deaths.map((id) => player(id)).filter(Boolean);
      if (ev.type === 'dawn') showDawn(names);
      else if (names.length) { Sound.play('death'); toast(`${names[0].name} was voted out — the ${roleName(names[0].role)}.`, 4500); }
      else toast('Nobody was voted out.');
      animateDeaths(ev.deaths);
    }
    if (prevAlive && !S.me.alive && phase !== 'ended') {
      chatTab = 'ghost';
      setTimeout(() => toast('You died. You can now see every role and talk in the Graveyard.', 5000), 2500);
    }
    prevPhase = phase;
    prevAlive = S.me.alive;
  }

  function closeOverlay() { $('#overlay').classList.add('hidden'); $('#overlay').innerHTML = ''; }
  $('#overlay').addEventListener('click', closeOverlay);

  function showRoleReveal() {
    const r = S.me.role;
    const o = $('#overlay');
    o.innerHTML = `
      <div class="reveal">
        <div class="flip" id="flip"><div class="flip-inner">
          <div class="face back">MAFIA</div>
          <div class="face front">
            <div class="emoji">${EMOJI[r]}</div>
            <div class="role-name">${esc(roleName(r))}</div>
            <div class="role-desc">${esc(S.roles[r].desc)}</div>
          </div>
        </div></div>
        <p class="muted">Keep it secret. Tap anywhere to continue.</p>
      </div>`;
    o.classList.remove('hidden');
    setTimeout(() => { $('#flip')?.classList.add('flipped'); Sound.play('reveal'); }, 700);
    clearTimeout(showRoleReveal.t);
    showRoleReveal.t = setTimeout(closeOverlay, 7000);
  }

  function showDawn(victims) {
    const o = $('#overlay');
    o.innerHTML = `
      <div class="dawn">
        <div class="big">☀️ Day ${S.day}</div>
        <div class="victims">${victims.length
          ? victims.map((p, i) => `<div style="animation-delay:${0.6 + i * 0.5}s">💀 <b>${esc(p.name)}</b> was found dead — the ${esc(roleName(p.role))}.</div>`).join('')
          : '<div style="animation-delay:.6s">Everyone woke up. Nobody died tonight.</div>'}</div>
      </div>`;
    o.classList.remove('hidden');
    Sound.play(victims.length ? 'death' : 'day');
    clearTimeout(showRoleReveal.t);
    showRoleReveal.t = setTimeout(closeOverlay, 3800);
  }

  function animateDeaths(ids) {
    setTimeout(() => {
      for (const id of ids) document.querySelector(`.pcard[data-id="${id}"]`)?.classList.add('dying');
    }, 50);
  }

  // ---- render ----
  function render() {
    if (!S) return;
    document.body.className = `phase-${S.phase}`;
    const labels = { lobby: 'Lobby', night: `🌙 Night ${S.day}`, day: `☀️ Day ${S.day}`, vote: `🗳️ Vote · Day ${S.day}`, ended: '🏁 Game over' };
    $('#phaseLabel').textContent = labels[S.phase];
    $('#lobbyView').classList.toggle('hidden', S.phase !== 'lobby');
    $('#gameView').classList.toggle('hidden', S.phase === 'lobby' || S.phase === 'ended');
    $('#endView').classList.toggle('hidden', S.phase !== 'ended');
    if (S.phase === 'lobby') renderLobby();
    else if (S.phase === 'ended') renderEnd();
    else renderGame();
    renderChat();
    updateTimer();
  }

  // Lobby
  function renderLobby() {
    const isHost = S.hostId === S.me.id;
    const st = S.settings;
    const auto = !st.roles;
    const mix = S.roleMix;
    const n = S.players.length;
    const special = Object.values(mix).reduce((a, b) => a + b, 0);
    const civilians = Math.max(0, n - special);
    const roleKeys = Object.keys(S.roles).filter((r) => r !== 'civilian');

    const players = S.players.map((p) => `
      <div class="player-row">
        <span class="dot ${p.connected ? '' : 'off'}"></span>
        <span class="name">${esc(p.name)}${p.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</span>
        ${p.isHost ? '<span title="Host">👑</span>' : ''}
        ${isHost && p.id !== S.me.id ? `<button class="btn small ghost" data-kick="${p.id}">Remove</button>` : ''}
      </div>`).join('');

    const roleToggles = roleKeys.map((r) => {
      const c = mix[r] || 0;
      const control = !isHost || auto
        ? `<span class="muted">${c ? (c > 1 ? `×${c}` : 'On') : 'Off'}</span>`
        : r === 'mafia'
          ? `<span class="stepper"><button data-role="${r}" data-delta="-1">−</button><b>${c}</b><button data-role="${r}" data-delta="1">+</button></span>`
          : `<button class="btn small" data-role="${r}" data-toggle="1">${c ? 'On' : 'Off'}</button>`;
      return `<div class="role-toggle ${c ? 'on' : ''}" title="${esc(S.roles[r].desc)}"><span>${EMOJI[r]} ${esc(S.roles[r].name)}</span>${control}</div>`;
    }).join('');

    const num = (key, label, val, min, max) => isHost
      ? `<label>${label}<input type="number" data-set="${key}" min="${min}" max="${max}" value="${val}"></label>`
      : `<label>${label}<b style="color:var(--text);font-size:15px">${val}</b></label>`;

    const enough = n >= st.minPlayers;
    setHtml($('#lobbyView'), `
      <div class="panel">
        <div class="room-code">
          <div><div class="muted">Room code</div><div class="code">${esc(S.code)}</div></div>
          <button class="btn" id="copyLink">🔗 Copy invite link</button>
        </div>
      </div>
      <div class="panel">
        <h3>Players · ${n}/${st.maxPlayers}</h3>
        <div class="player-list">${players}</div>
      </div>
      <div class="panel">
        <h3>Game settings ${isHost ? '' : '<span class="muted" style="font-size:13px;font-family:var(--sans)">· set by the host</span>'}</h3>
        <div class="settings-grid">
          ${num('minPlayers', 'Min players', st.minPlayers, 4, 20)}
          ${num('maxPlayers', 'Max players', st.maxPlayers, 4, 20)}
          ${num('timers.night', 'Night (sec)', st.timers.night, 10, 600)}
          ${num('timers.day', 'Discussion (sec)', st.timers.day, 10, 900)}
          ${num('timers.vote', 'Voting (sec)', st.timers.vote, 10, 300)}
        </div>
        <h4>Roles</h4>
        ${isHost ? `<label class="switch"><input type="checkbox" id="autoRoles" ${auto ? 'checked' : ''}> Automatic mix for the player count</label><div style="height:10px"></div>` : ''}
        <div class="role-toggles">${roleToggles}</div>
        <p class="muted" style="margin:10px 0 0;font-size:13px">+ ${civilians} Civilian${civilians === 1 ? '' : 's'} · ${special} special role${special === 1 ? '' : 's'} for ${n} player${n === 1 ? '' : 's'}</p>
      </div>
      <div class="panel start-row">
        ${isHost
          ? `<button class="btn primary" id="startBtn" ${enough ? '' : 'disabled'}>Start game</button>
             <span class="muted">${enough ? 'Everyone in? Let the night begin.' : `Waiting for ${st.minPlayers - n} more player${st.minPlayers - n === 1 ? '' : 's'}…`}</span>`
          : `<span class="waiting">Waiting for the host to start the game…</span>`}
      </div>`);
  }

  $('#lobbyView').addEventListener('click', (e) => {
    const t = e.target.closest('button, input');
    if (!t || !S) return;
    if (t.id === 'copyLink') {
      const link = `${location.origin}/r/${S.code}`;
      (navigator.clipboard?.writeText(link) || Promise.reject()).then(() => toast('Invite link copied!'), () => prompt('Copy this link:', link));
    } else if (t.id === 'startBtn') emit('start');
    else if (t.dataset.kick) emit('kick', { target: t.dataset.kick });
    else if (t.dataset.role) {
      const roles = { ...S.roleMix };
      const r = t.dataset.role;
      if (t.dataset.toggle) roles[r] = roles[r] ? 0 : 1;
      else roles[r] = Math.max(0, Math.min(6, (roles[r] || 0) + Number(t.dataset.delta)));
      emit('settings', { roles });
    }
  });
  $('#lobbyView').addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'autoRoles') emit('settings', { roles: t.checked ? null : { ...S.roleMix } });
    else if (t.dataset.set) {
      const [a, b] = t.dataset.set.split('.');
      emit('settings', b ? { [a]: { [b]: Number(t.value) } } : { [a]: Number(t.value) });
    }
  });

  // Game
  function renderGame() {
    const me = S.me;
    const r = me.role;
    const team = teamOf(r);
    setHtml($('#myRole'), `
      <div class="role-card ${team} ${roleHidden ? 'hidden-role' : ''} ${me.alive ? '' : 'dead'}" id="roleCard" title="Tap to hide/show">
        <div class="emoji">${me.alive ? EMOJI[r] : '💀'}</div>
        <div class="role-body">
          <div class="role-name">${esc(roleName(r))}${me.alive ? '' : ' · dead'}</div>
          <div class="role-desc">${esc(S.roles[r].desc)}${r === 'sheriff' ? ` Bullets left: ${me.bullets}.` : ''}</div>
        </div>
      </div>`);

    setHtml($('#actionPanel'), actionPanelHtml());

    const voteCounts = {};
    if (S.votes) for (const t of Object.values(S.votes)) if (t !== 'skip') voteCounts[t] = (voteCounts[t] || 0) + 1;
    setHtml($('#playerGrid'), S.players.map((p) => {
      const mate = p.role && teamOf(p.role) === 'mafia' && team === 'mafia' && p.id !== me.id;
      const badges = [p.isHost ? '👑' : '', p.ready ? '✋' : '', p.voted ? '🗳️' : ''].join('');
      return `<div class="pcard ${p.id === me.id ? 'me' : ''} ${p.alive ? '' : 'dead'} ${mate ? 'mafia-mate' : ''} ${p.connected ? '' : 'offline'}" data-id="${p.id}">
        ${voteCounts[p.id] ? `<span class="vote-count">${voteCounts[p.id]}</span>` : ''}
        <span class="badges">${badges}</span>
        <div class="avatar">${p.alive ? esc(initials(p.name)) : '💀'}</div>
        <div class="pname">${esc(p.name)}</div>
        <div class="prole">${p.role ? `${EMOJI[p.role]} ${esc(roleName(p.role))}` : p.alive ? '' : '?'}</div>
      </div>`;
    }).join(''));

    const notes = [...me.notes].reverse();
    setHtml($('#notesPanel'), `
      <h3>📓 Your notebook</h3>
      <div class="notes">${notes.map((n) => `<div class="note"><div class="when">${n.day ? `Night ${n.day}` : 'Start'}</div>${esc(n.text)}</div>`).join('')}</div>`);
  }

  function targetButtons(list, chosen, attr) {
    return list.map((id) => {
      const p = player(id);
      return `<button class="target ${chosen === id ? 'chosen' : ''}" ${attr}="${id}">${esc(p?.name)}</button>`;
    }).join('') + `<button class="target skip ${chosen === 'skip' ? 'chosen' : ''}" ${attr}="skip">Skip</button>`;
  }

  function actionPanelHtml() {
    const me = S.me;
    if (!me.alive) {
      return `<h3>👻 You are dead</h3><p class="muted" style="margin:0">You can see everyone's role now. Chat with the other dead in the Graveyard — the living can't hear you.</p>`;
    }
    if (S.phase === 'night') {
      if (!S.actions.length) return `<h3>🌙 Night ${S.day}</h3><p class="waiting" style="margin:0">You are asleep. Wait for dawn…</p>`;
      let html = `<h3>🌙 Night ${S.day} — make your move</h3>`;
      for (const a of S.actions) {
        html += `<div class="action-block"><h4>${EMOJI[a.key === 'check' && me.role === 'don' ? 'detective' : me.role]} ${esc(a.label)} · ${me.role === 'don' && a.key === 'check' ? 'Is someone the Detective?' : ACTION_TEXT[a.key]}</h4>
          <div class="targets">${targetButtons(a.targets, a.choice, `data-action="${a.key}" data-target`)}</div></div>`;
      }
      if (S.mafiaPicks && S.mafiaPicks.length > 1) {
        html += `<div class="picks">Family picks: ${S.mafiaPicks.map((m) => {
          const who = player(m.id);
          const t = m.target === 'skip' ? 'skip' : m.target ? esc(player(m.target)?.name) : '<i>thinking…</i>';
          return `<b>${esc(who?.name)}</b> → ${t}`;
        }).join(' · ')}${S.mafiaPicks.some((m) => player(m.id)?.role === 'don') ? '<br>Tie? The Don decides.' : ''}</div>`;
      }
      return html;
    }
    if (S.phase === 'day') {
      const alive = S.players.filter((p) => p.alive);
      const ready = alive.filter((p) => p.ready).length;
      const amReady = S.players.find((p) => p.id === me.id)?.ready;
      return `<h3>☀️ Day ${S.day} — discussion</h3>
        <p class="muted" style="margin:0 0 12px">Talk in the Town chat. Accuse, defend, bluff. Voting starts when the timer runs out or everyone is ready.</p>
        <button class="btn ${amReady ? '' : 'primary'}" id="readyBtn">${amReady ? '✋ Ready (tap to undo)' : 'Ready to vote'}</button>
        <span class="muted" style="margin-left:10px">${ready}/${alive.length} ready</span>`;
    }
    if (S.phase === 'vote') {
      const others = S.players.filter((p) => p.alive && p.id !== me.id).map((p) => p.id);
      const mine = S.votes?.[me.id] ?? null;
      const lines = Object.entries(S.votes || {}).map(([v, t]) => `<b>${esc(player(v)?.name)}</b> → ${t === 'skip' ? 'skip' : esc(player(t)?.name)}`);
      return `<h3>🗳️ Vote — who leaves town?</h3>
        <div class="targets">${targetButtons(others, mine, 'data-vote')}</div>
        <div class="picks">${lines.length ? lines.join(' · ') : 'No votes yet.'}</div>`;
    }
    return '';
  }

  $('#gameView').addEventListener('click', (e) => {
    const t = e.target.closest('button, #roleCard');
    if (!t || !S) return;
    if (t.id === 'roleCard') { roleHidden = !roleHidden; render(); }
    else if (t.id === 'readyBtn') emit('ready');
    else if (t.dataset.action) emit('action', { action: t.dataset.action, target: t.dataset.target });
    else if (t.dataset.vote) emit('vote', { target: t.dataset.vote });
  });

  // End
  function renderEnd() {
    const w = S.winner || { team: 'draw', text: '' };
    const isHost = S.hostId === S.me.id;
    const won = (p) => p.role && (S.roles[p.role].team === w.team);
    const meWon = won({ role: S.me.role });
    setHtml($('#endView'), `
      <div class="panel winner-banner ${w.team}">
        <div class="muted">${w.team === 'draw' ? 'Draw' : 'Victory'}</div>
        <div class="big">${esc(TEAM_NAMES[w.team])} ${w.team === 'draw' ? 'wins' : w.team === 'mafia' || w.team === 'town' ? 'win' : 'wins'}</div>
        <p>${esc(w.text)}</p>
        <p><b>${S.me.role ? (meWon ? '🏆 You won!' : 'You lost this one.') : ''}</b></p>
        ${isHost ? '<button class="btn primary" id="againBtn">Play again</button>' : '<p class="waiting">The host can start a new game.</p>'}
      </div>
      <div class="panel">
        <h3>Who was who</h3>
        <div class="reveal-list">${S.players.map((p) => `
          <div class="reveal-item ${won(p) ? 'winner' : ''}">
            ${p.role ? EMOJI[p.role] : '❔'} <b>${esc(p.name)}</b> ${p.alive ? '' : '💀'}
            <div class="r">${esc(roleName(p.role) || 'Joined late')}</div>
          </div>`).join('')}</div>
      </div>
      <div class="panel">
        <h3>What happened</h3>
        ${(S.history || []).map((h) => `<div class="recap-night"><h4>${esc(h.title)}</h4><ul>${h.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`).join('') || '<p class="muted">The game ended before anything happened.</p>'}
      </div>`);
  }
  $('#endView').addEventListener('click', (e) => { if (e.target.id === 'againBtn') emit('restart'); });

  // Chat
  function renderChat() {
    const tabs = Object.keys(S.chats);
    if (!tabs.includes(chatTab)) chatTab = 'public';
    const list = S.chats[chatTab];
    for (const k of tabs) {
      if (k === chatTab) seen[k] = S.chats[k].length;
      else if (seen[k] > S.chats[k].length) seen[k] = S.chats[k].length;
    }
    setHtml($('#chatTabs'), tabs.length > 1 ? tabs.map((k) => {
      const unread = S.chats[k].length - seen[k];
      return `<button class="chat-tab ${k} ${k === chatTab ? 'active' : ''}" data-tab="${k}">${CHAT_NAMES[k]}${unread > 0 ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : ''}</button>`;
    }).join('') : `<div class="chat-tab active" style="cursor:default">Town chat</div>`);

    const log = $('#chatLog');
    log.className = `chat-log ${chatTab}`;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const key = `${chatTab}:${list.length}:${list[list.length - 1]?.id}`;
    if (log._key !== key) {
      const grew = log._key && log._key.startsWith(`${chatTab}:`) && list.length;
      log._key = key;
      log.innerHTML = list.map((m) => m.system
        ? `<div class="msg system">${esc(m.text)}</div>`
        : `<div class="msg ${m.from === S.me.id ? 'mine' : ''}"><span class="who">${esc(m.name)}</span>${esc(m.text)}</div>`).join('')
        || `<div class="muted" style="text-align:center;margin-top:20px">${chatTab === 'mafia' ? 'Only the family can read this. Plan your next move.' : chatTab === 'ghost' ? 'Only the dead can read this.' : 'No messages yet.'}</div>`;
      if (nearBottom || !grew) log.scrollTop = log.scrollHeight;
      const lastMsg = list[list.length - 1];
      if (grew && lastMsg && !lastMsg.system && lastMsg.from !== S.me.id) Sound.play('message');
    }

    const canSend = S.canSend[chatTab];
    const input = $('#chatInput');
    input.disabled = !canSend;
    $('#chatForm button').disabled = !canSend;
    input.placeholder = canSend
      ? chatTab === 'mafia' ? 'Whisper to the family…' : chatTab === 'ghost' ? 'Speak from beyond…' : 'Say something…'
      : S.phase === 'night' && chatTab === 'public' ? 'The town is asleep — no talking at night.' : 'You cannot talk here right now.';
  }
  $('#chatTabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { chatTab = t.dataset.tab; renderChat(); $('#chatInput').focus(); }
  });
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    const res = await emit('chat', { channel: chatTab, text });
    if (!res.error) input.value = '';
  });

  // Timer
  function updateTimer() {
    const el = $('#timer');
    if (!S || !S.endsAt || S.phase === 'lobby' || S.phase === 'ended') { el.textContent = ''; return; }
    const left = Math.max(0, Math.ceil((S.endsAt - (Date.now() + clockOffset)) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', left <= 10);
    if (left <= 5 && left > 0 && left !== lastTickSecond) { lastTickSecond = left; Sound.play('tick'); }
  }
  setInterval(updateTimer, 250);
})();
