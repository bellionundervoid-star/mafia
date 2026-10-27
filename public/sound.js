// Tiny synthesized sound effects — no audio files needed.
window.Sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('mafia.muted') === '1'; } catch {}

  const unlock = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
  };
  ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, unlock, { passive: true }));

  function tone(freq, start, dur, { type = 'sine', vol = 0.15, slideTo = null } = {}) {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const sounds = {
    night() { // low descending drone
      tone(220, 0, 1.6, { type: 'triangle', vol: 0.12, slideTo: 110 });
      tone(165, 0.2, 1.8, { type: 'sine', vol: 0.1, slideTo: 82 });
      tone(330, 0.9, 1.2, { type: 'sine', vol: 0.05, slideTo: 300 });
    },
    day() { // bright rising arpeggio
      [392, 494, 587, 784].forEach((f, i) => tone(f, i * 0.12, 0.6, { type: 'triangle', vol: 0.1 }));
    },
    vote() {
      tone(523, 0, 0.18, { type: 'square', vol: 0.06 });
      tone(523, 0.22, 0.18, { type: 'square', vol: 0.06 });
    },
    death() { // heavy hit + dissonance
      tone(90, 0, 1.2, { type: 'sawtooth', vol: 0.18, slideTo: 40 });
      tone(311, 0.05, 1.0, { type: 'sine', vol: 0.07 });
      tone(330, 0.05, 1.0, { type: 'sine', vol: 0.07 });
    },
    reveal() { // shimmer
      [660, 880, 990, 1320].forEach((f, i) => tone(f, i * 0.08, 0.9, { type: 'sine', vol: 0.06 }));
      tone(110, 0, 1.4, { type: 'triangle', vol: 0.12 });
    },
    tick() { tone(1200, 0, 0.05, { type: 'square', vol: 0.03 }); },
    message() { tone(880, 0, 0.08, { type: 'sine', vol: 0.04 }); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.15, 0.8, { type: 'triangle', vol: 0.1 })); },
  };

  return {
    play(name) {
      if (muted || !ctx || !sounds[name]) return;
      try { sounds[name](); } catch {}
    },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('mafia.muted', muted ? '1' : '0'); } catch {}
      return muted;
    },
  };
})();
