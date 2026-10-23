/* かずの すごろく — app.js
 * 仕様書「数直線すごろくアプリ 仕様書」にもとづく実装。
 * 外部ライブラリなし。データは localStorage にのみ保存する。
 */
(() => {
  'use strict';

  const APP_VERSION = '1.2.0';

  // ---------- 定数 ----------
  // 数の読み方は仕様どおり統一（4=よん、7=なな、9=きゅう）
  const ONES = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
  function reading(n) {
    if (n === 0) return 'ぜろ';
    if (n === 100) return 'ひゃく';
    const t = Math.floor(n / 10), o = n % 10;
    return (t ? (t === 1 ? '' : ONES[t]) + 'じゅう' : '') + ONES[o];
  }

  // mode: step = 1マスずつタップ（3〜5歳）、jump = 行き先を当てる（6〜7歳）
  const LEVELS = {
    1: { max: 10, die: [1, 2], mode: 'step' },
    2: { max: 10, die: [1, 2, 3], mode: 'step' },
    3: { max: 20, die: [1, 2, 3], mode: 'step' },
    4: { max: 100, die: [1, 2, 3, 4, 5, 6, 7, 8, 9], mode: 'jump' },
    5: { max: 100, die: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], mode: 'jump', sparse: true },
  };
  const MAX_LEVEL = 5;

  const STEP_LOCK_MS = 800;     // 数字の読み上げ後、次の操作を受け付けるまでの待ち
  const TURTLE_STEP_MS = 950;   // かめが1マス進む間隔
  const SPIN_MS = 1000;         // ルーレットが回る時間
  const JUMP_SEG_MS = 750;      // レベル4・5で1区間（例 36→40）を跳ぶ時間
  const WIN_SPAN = 20;          // レベル4・5の拡大帯は21マス（例 30〜50）
  const CHECK_SETS = { 10: [2, 3, 5, 7, 8], 100: [6, 18, 42, 71, 89] };
  const SVGNS = 'http://www.w3.org/2000/svg';

  const $ = (sel) => document.querySelector(sel);
  const now = () => performance.now();

  // ---------- 保存 ----------
  const STORE_KEY = 'kazu-sugoroku-v1';
  const defaultData = () => ({
    settings: { level: 1, hints: true, limit: 3, guideSeen: false },
    days: {},    // 'YYYY-MM-DD' -> { games, steps, mistaps, stepMs }
    games: [],   // { ts, level, steps, mistaps, stepMs }
    checks: [],  // { ts, date, meanErr, answers: [{ target, est }] }
  });

  function loadData() {
    const def = defaultData();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return def;
      const d = JSON.parse(raw);
      return {
        settings: Object.assign(def.settings, d.settings || {}),
        days: d.days || {},
        games: Array.isArray(d.games) ? d.games : [],
        checks: Array.isArray(d.checks) ? d.checks : [],
      };
    } catch (e) {
      return def;
    }
  }
  let data = loadData();
  function saveData() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境でも遊べる */ }
  }

  function dateKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function todayRec(create) {
    const k = dateKey();
    if (!data.days[k] && create) data.days[k] = { games: 0, steps: 0, mistaps: 0, stepMs: 0 };
    return data.days[k] || { games: 0, steps: 0, mistaps: 0, stepMs: 0 };
  }
  function limitReached() {
    const L = Number(data.settings.limit);
    return L > 0 && todayRec(false).games >= L;
  }

  // ---------- 音 ----------
  const Sound = {
    ctx: null,
    buffers: {},
    voice: null,
    unlocked: false,

    // 最初のタップ（はじめる）の中で呼ぶ。iOS はここまで音が鳴らない。
    unlock() {
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch (e) { /* 対応していない端末 */ }
      }
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { this.ctx = new AC(); } catch (e) { this.ctx = null; } }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      if (this.unlocked) return;
      this.unlocked = true;
      if (this.ctx) {
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
      }
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
      this.loadRecorded();
    },

    pickVoice() {
      if (!('speechSynthesis' in window)) return;
      const vs = speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
      if (!vs.length) return;
      this.voice = vs.find((v) => v.localService && /kyoko|o-ren|hattori/i.test(v.name))
        || vs.find((v) => v.localService) || vs[0];
    },

    // audio/list.json に書かれたキーの録音ファイル（audio/<キー>.mp3）を読み込む。
    // 録音がないキーは合成音声で読み上げる。
    async loadRecorded() {
      if (!this.ctx) return;
      try {
        const res = await fetch('audio/list.json', { cache: 'no-cache' });
        if (!res.ok) return;
        const list = await res.json();
        if (!Array.isArray(list)) return;
        await Promise.all(list.map(async (key) => {
          try {
            const r = await fetch(`audio/${key}.mp3`);
            if (!r.ok) return;
            const ab = await r.arrayBuffer();
            this.buffers[key] = await new Promise((ok, ng) => this.ctx.decodeAudioData(ab, ok, ng));
          } catch (e) { /* そのキーは合成音声に任せる */ }
        }));
      } catch (e) { /* 録音なし */ }
    },

    // key の録音があれば再生、なければ text を合成音声で読む。終わったら resolve。
    say(key, text) {
      const buf = this.buffers[key];
      if (buf && this.ctx) {
        if (this.current) { try { this.current.stop(); } catch (e) { /* 既に停止 */ } }
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(0);
        this.current = src;
        return new Promise((ok) => setTimeout(ok, buf.duration * 1000));
      }
      return this.speak(text);
    },

    speak(text) {
      if (!('speechSynthesis' in window)) return Promise.resolve();
      if (!this.voice) this.pickVoice();
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      if (this.voice) u.voice = this.voice;
      u.rate = 0.85;
      u.pitch = 1.15;
      return new Promise((ok) => {
        const t = setTimeout(ok, 2500);
        u.onend = u.onerror = () => { clearTimeout(t); ok(); };
        speechSynthesis.speak(u);
      });
    },

    number(n) { return this.say(`n${n}`, reading(n)); },

    // 効果音（WebAudio で合成。ファイル不要）
    tone(freq, dur, opts = {}) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + (opts.delay || 0);
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = opts.type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
      const v = opts.vol || 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(v, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    fx(name) {
      switch (name) {
        case 'tap': this.tone(520, 0.08, { type: 'triangle', vol: 0.12 }); break;
        case 'step': this.tone(600, 0.12, { to: 900, vol: 0.14 }); break;
        case 'tstep': this.tone(420, 0.12, { to: 620, vol: 0.10 }); break;
        case 'miss': this.tone(260, 0.18, { type: 'triangle', to: 220, vol: 0.08 }); break;
        case 'tick': this.tone(1100, 0.03, { type: 'square', vol: 0.03 }); break;
        case 'land': this.tone(660, 0.12, { vol: 0.14 }); this.tone(990, 0.2, { vol: 0.12, delay: 0.1 }); break;
        case 'goal':
          [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, { type: 'triangle', vol: 0.15, delay: i * 0.12 }));
          break;
        case 'end':
          [784, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', vol: 0.13, delay: i * 0.11 }));
          break;
        default: break;
      }
    },
  };
  if ('speechSynthesis' in window) {
    Sound.pickVoice();
    speechSynthesis.onvoiceschanged = () => Sound.pickVoice();
  }

  // ---------- 画面切り替え ----------
  let currentScreen = 'title';
  let pendingReload = false;
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(`#screen-${name}`).classList.add('active');
    currentScreen = name;
    document.body.classList.toggle('no-gear', name === 'parent' || name === 'check');
    if (name === 'game') requestAnimationFrame(layoutBoard);
    if (name === 'title') {
      renderTitle();
      if (pendingReload) location.reload();
    }
  }

  function renderTitle() {
    const limited = limitReached();
    $('#start-choices').hidden = limited;
    $('#title-limit').hidden = !limited;
  }

  // ---------- ゲーム ----------
  const G = {
    level: 1, N: 10, die: [1, 2], mode: 'step', sparse: false,
    roll: 0, dest: 0, kidTurns: 0,
    oppHuman: false,     // false = かめさん（自動）、true = ふたりで（あおさん）
    turnsBy: { kid: 0, turtle: 0 },
    pos: { kid: 0, turtle: 0 },
    finished: { kid: false, turtle: false },
    turn: 'kid',
    phase: 'idle',       // idle | roll | spinning | move | busy | end
    remaining: 0,
    lockUntil: 0,
    stepStart: 0,
    missThisStep: 0,
    stats: { steps: 0, mistaps: 0, stepMs: 0 },
    timers: [],
    lastHint: '',
  };

  function later(ms, fn) {
    const id = setTimeout(() => {
      G.timers = G.timers.filter((t) => t !== id);
      fn();
    }, ms);
    G.timers.push(id);
  }
  function clearTimers() {
    G.timers.forEach(clearTimeout);
    G.timers = [];
  }

  const board = $('#board');
  const boardWrap = $('#board-wrap');
  const roulette = $('#roulette');
  const rouletteNum = $('#roulette-num');
  let cols = [];
  let pieces = {};

  // 相手の枠は内部では 'turtle'。ふたりで遊ぶときは見た目を「あおさん」(p2) にする。
  function isHuman(who) { return who === 'kid' || G.oppHuman; }
  function skin(who) { return who === 'kid' ? 'kid' : (G.oppHuman ? 'p2' : 'turtle'); }
  function oppName() { return G.oppHuman ? 'あおさん' : 'かめさん'; }

  function buildBoard() {
    board.innerHTML = '';
    board.className = '';
    cols = [];
    for (let i = 0; i <= G.N; i++) {
      const col = document.createElement('button');
      col.type = 'button';
      col.className = 'col' + (i === G.N ? ' goal' : '');
      col.dataset.n = String(i);
      col.setAttribute('aria-label', `${i}のマス`);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.textContent = String(i);
      col.appendChild(cell);
      col.addEventListener('pointerdown', onCellDown);
      board.appendChild(col);
      cols.push(col);
    }
    pieces = {};
    ['kid', 'turtle'].forEach((who) => {
      const p = document.createElement('div');
      p.className = `piece ${who}`;
      const art = document.createElement('div');
      art.className = `piece-art ${skin(who)}-art`;
      p.appendChild(art);
      board.appendChild(p);
      pieces[who] = p;
    });
  }

  let geom = { cell: 80, gap: 10, lane: 70, piece: 60 };
  function layoutBoard() {
    if (G.mode === 'jump') { layoutJump(); return; }
    if (!cols.length) return;
    const n = G.N + 1;
    const availW = boardWrap.clientWidth - 48;
    const availH = boardWrap.clientHeight;
    let per = Math.min(130, availW / n);
    let cell = per / 1.14;
    const laneRatio = 0.85;
    if (cell * (1 + 2 * laneRatio) > availH) {
      cell = availH / (1 + 2 * laneRatio);
      per = cell * 1.14;
    }
    const gap = per - cell;
    const lane = cell * laneRatio;
    const piece = Math.min(cell * 0.82, lane * 0.95, 84);
    geom = { cell, gap, lane, piece, per };
    board.style.setProperty('--cell', `${cell}px`);
    board.style.setProperty('--gap', `${gap}px`);
    board.style.setProperty('--lane', `${lane}px`);
    board.style.setProperty('--piece', `${piece}px`);
    board.style.width = `${per * n}px`;
    board.style.height = `${cell + lane * 2}px`;
    cols.forEach((c, i) => {
      c.style.left = `${i * per}px`;
      c.style.width = `${per}px`;
    });
    placePiece('kid', false);
    placePiece('turtle', false);
  }
  window.addEventListener('resize', () => { if (currentScreen === 'game') layoutBoard(); });

  function centerX(i) { return i * geom.per + geom.per / 2; }

  function placePiece(who, hop) {
    const p = pieces[who];
    if (!p) return;
    const x = centerX(G.pos[who]) - geom.piece / 2;
    p.style.transform = `translateX(${x}px)`;
    if (hop) {
      p.classList.remove('hop');
      void p.offsetWidth; // アニメーションを再始動
      p.classList.add('hop');
    }
  }

  function markVisited() {
    cols.forEach((c, i) => c.classList.toggle('visited', i > 0 && i <= G.pos.kid));
  }

  function setGlow(n) {
    cols.forEach((c, i) => c.classList.toggle('glow', i === n));
  }

  function setTurnIcon(who) {
    const el = $('#turn-icon');
    el.innerHTML = `<div class="piece-art ${skin(who)}-art"></div>`;
  }

  function hintsFor() {
    if (G.mode === 'jump') {
      return [
        'いま いくつ？',
        'つぎの 10の まとまりまで あといくつ？',
        '100まで あと いくつ？',
        `${oppName()}と いくつ ちがう？`,
        '10 すすむと どこ？',
        'じゅうの くらいは いくつ？',
      ];
    }
    return [
      'いま どこ？',
      `${G.N}まで あといくつ？`,
      `${oppName()}と どっちが まえ？`,
      'つぎは なんばん？',
      'いくつ すすむかな？',
      'いっしょに かぞえよう',
    ];
  }
  function updateHint() {
    const el = $('#hint');
    if (!data.settings.hints) { el.textContent = ''; return; }
    const list = hintsFor().filter((h) => h !== G.lastHint);
    const h = list[Math.floor(Math.random() * list.length)];
    G.lastHint = h;
    el.textContent = h;
  }

  function newGame() {
    clearTimers();
    const lv = LEVELS[data.settings.level] || LEVELS[1];
    G.level = LEVELS[data.settings.level] ? data.settings.level : 1;
    G.N = lv.max;
    G.die = lv.die;
    G.mode = lv.mode;
    G.sparse = !!lv.sparse;
    G.kidTurns = 0;
    G.turnsBy = { kid: 0, turtle: 0 };
    G.pos = { kid: 0, turtle: 0 };
    G.finished = { kid: false, turtle: false };
    G.stats = { steps: 0, mistaps: 0, stepMs: 0 };
    G.remaining = 0;
    G.lockUntil = 0;
    G.phase = 'idle';
    rouletteNum.textContent = '?';
    roulette.className = 'roulette';
    $('#hint').textContent = '';
    $('#end-overlay').hidden = true;
    setPrompt('');
    if (G.mode === 'jump') buildJumpBoard(); else buildBoard();
    show('game');
    layoutBoard();
    later(500, () => startTurn('kid'));
  }

  function startTurn(who) {
    if (G.finished[who]) who = other(who);
    G.turn = who;
    G.phase = 'roll';
    setTurnIcon(who);
    Object.keys(pieces).forEach((k) => pieces[k].classList.toggle('active', k === who));
    rouletteNum.textContent = '?';
    roulette.className = 'roulette' + (isHuman(who) ? ' ready' : '');
    if (G.mode === 'jump') {
      clearArcs();
      setJumpGlow(-1);
      setWindow(winFor(G.pos[who]));
      setPrompt(isHuman(who) ? 'ルーレットを タップ' : 'かめさんの ばん');
    }
    if (G.oppHuman) {
      // ふたりで遊ぶときは、だれの番かを声で知らせる
      Sound.say(`turn_${skin(who)}`, who === 'kid' ? 'オレンジさんの ばん' : 'あおさんの ばん');
    }
    if (who === 'kid') updateHint();
    if (!isHuman(who)) later(800, rollDie);
  }

  function other(who) { return who === 'kid' ? 'turtle' : 'kid'; }

  function onRouletteTap(e) {
    e.preventDefault();
    if (!isHuman(G.turn) || G.phase !== 'roll' || now() < G.lockUntil) return;
    rollDie();
  }

  function rollDie() {
    G.phase = 'spinning';
    roulette.className = 'roulette spinning';
    const start = now();
    let shown = 0;
    const tick = () => {
      const t = now() - start;
      if (t >= SPIN_MS) {
        land();
        return;
      }
      shown = (shown % G.die.length) + 1;
      rouletteNum.textContent = String(G.die[shown - 1]);
      Sound.fx('tick');
      // だんだん遅くなる
      later(60 + (t / SPIN_MS) * 160, tick);
    };
    tick();
  }

  function land() {
    const v = G.die[Math.floor(Math.random() * G.die.length)];
    rouletteNum.textContent = String(v);
    roulette.className = 'roulette result';
    Sound.fx('land');
    const who = G.turn;
    if (G.mode === 'jump') { landJump(v, who); return; }
    later(150, () => Sound.number(v));
    G.remaining = Math.min(v, G.N - G.pos[who]);
    later(900, () => {
      G.phase = 'move';
      if (isHuman(who)) {
        G.missThisStep = 0;
        G.lockUntil = now() + 150;
        G.stepStart = now();
      } else {
        turtleStep();
      }
    });
  }

  function onCellDown(e) {
    e.preventDefault();
    const n = Number(e.currentTarget.dataset.n);
    const who = G.turn;
    if (!isHuman(who) || G.phase !== 'move') return;
    if (now() < G.lockUntil) return;
    const target = G.pos[who] + 1;
    if (n === G.pos[who]) return; // 自分のいるマスは数えない（誤タップにもしない）
    const col = cols[n];
    col.classList.add('pressed');
    setTimeout(() => col.classList.remove('pressed'), 140);

    if (n === target) {
      const t = now();
      if (who === 'kid') {   // 記録するのは子ども（オレンジ）の手番だけ
        G.stats.steps += 1;
        G.stats.stepMs += Math.max(0, t - G.stepStart);
      }
      G.pos[who] = target;
      G.remaining -= 1;
      G.missThisStep = 0;
      setGlow(-1);
      placePiece(who, true);
      markVisited();
      Sound.fx(who === 'kid' ? 'step' : 'tstep');
      Sound.number(target);
      G.lockUntil = t + STEP_LOCK_MS;
      G.stepStart = t + STEP_LOCK_MS;
      if (G.pos[who] === G.N) {
        G.phase = 'busy';
        later(STEP_LOCK_MS, () => reachGoal(who));
      } else if (G.remaining <= 0) {
        G.phase = 'busy';
        later(STEP_LOCK_MS + 200, endMove);
      }
    } else {
      // 飛ばしたマス・戻るマス：減点や×は出さない
      if (who === 'kid') G.stats.mistaps += 1;
      G.missThisStep += 1;
      Sound.fx('miss');
      col.classList.remove('nudge');
      void col.offsetWidth;
      col.classList.add('nudge');
      if (G.missThisStep >= 2) setGlow(target);
    }
  }

  function turtleStep() {
    if (G.remaining <= 0) { endMove(); return; }
    G.pos.turtle += 1;
    G.remaining -= 1;
    placePiece('turtle', true);
    Sound.fx('tstep');
    Sound.number(G.pos.turtle);
    if (G.pos.turtle === G.N) {
      G.phase = 'busy';
      later(TURTLE_STEP_MS, () => reachGoal('turtle'));
    } else if (G.remaining <= 0) {
      later(TURTLE_STEP_MS + 200, endMove);
    } else {
      later(TURTLE_STEP_MS, turtleStep);
    }
  }

  function reachGoal(who) {
    G.finished[who] = true;
    pieces[who].classList.add('done');
    burstStars(G.N);
    Sound.fx('goal');
    later(450, () => Sound.say('goal', 'ゴール！'));
    later(1900, () => {
      pieces[who].classList.remove('done');
      endMove();
    });
  }

  function endMove() {
    if (G.finished.kid && G.finished.turtle) { endGame(); return; }
    const next = other(G.turn);
    startTurn(G.finished[next] ? G.turn : next);
  }

  function burstStars(n) {
    let x, y, host, size;
    if (G.mode === 'jump') {
      x = jx(n); y = J.geom.lane + J.geom.cell / 2; host = J.strip; size = J.geom.cell;
    } else {
      x = centerX(n); y = geom.lane + geom.cell / 2; host = board; size = geom.cell;
    }
    for (let i = 0; i < 12; i++) {
      const s = document.createElement('div');
      s.className = 'star';
      const ang = (Math.PI * 2 * i) / 12 + Math.random() * 0.3;
      const dist = size * (1.1 + Math.random() * 0.7);
      s.style.left = `${x}px`;
      s.style.top = `${y}px`;
      s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      s.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
      host.appendChild(s);
      setTimeout(() => s.remove(), 1200);
    }
  }

  // ---------- レベル4・5：0〜100、行き先を当てる ----------
  const J = { strip: null, overview: null, arcs: null, cols: [], win: -1, geom: { per: 50, cell: 44, lane: 66, piece: 40, width: 1050 } };

  function setPrompt(text) {
    const el = $('#prompt');
    if (el) el.textContent = text;
  }

  function winFor(pos) {
    return Math.max(0, Math.min(G.N - WIN_SPAN, Math.floor(pos / 10) * 10));
  }
  function jx(n) { return (n - J.win) * J.geom.per + J.geom.per / 2; }
  function inWin(n) { return n >= J.win && n <= J.win + WIN_SPAN; }

  function buildJumpBoard() {
    board.innerHTML = '';
    board.className = 'jump';
    board.style.width = '';
    board.style.height = '';
    const ov = document.createElementNS(SVGNS, 'svg');
    ov.classList.add('overview');
    ov.setAttribute('aria-hidden', 'true');
    board.appendChild(ov);
    const strip = document.createElement('div');
    strip.className = 'strip';
    board.appendChild(strip);
    const arcs = document.createElementNS(SVGNS, 'svg');
    arcs.classList.add('arcs');
    arcs.setAttribute('aria-hidden', 'true');
    strip.appendChild(arcs);
    J.cols = [];
    for (let i = 0; i <= WIN_SPAN; i++) {
      const col = document.createElement('button');
      col.type = 'button';
      col.className = 'col';
      col.dataset.i = String(i);
      const cell = document.createElement('div');
      cell.className = 'cell';
      col.appendChild(cell);
      col.addEventListener('pointerdown', onJumpCellDown);
      strip.appendChild(col);
      J.cols.push(col);
    }
    pieces = {};
    ['kid', 'turtle'].forEach((who) => {
      const p = document.createElement('div');
      p.className = `piece ${who}`;
      const art = document.createElement('div');
      art.className = `piece-art ${skin(who)}-art`;
      p.appendChild(art);
      strip.appendChild(p);
      pieces[who] = p;
    });
    J.strip = strip; J.overview = ov; J.arcs = arcs; J.win = 0;
  }

  function layoutJump() {
    if (!J.strip) return;
    const n = WIN_SPAN + 1;
    const availW = boardWrap.clientWidth - 48;
    const availH = boardWrap.clientHeight;
    const OVH = 84, GAP = 18;
    let per = Math.min(64, availW / n);
    let cell = per * 0.88;
    let lane = cell * 1.55;
    if (OVH + GAP + cell + lane * 2 > availH) {
      cell = (availH - OVH - GAP) / (1 + 2 * 1.55);
      lane = cell * 1.55;
      per = cell / 0.88;
    } else {
      // 縦に余裕があれば上の段を高くし、跳びの弧と数字がコマに隠れないようにする
      lane = Math.max(lane, Math.min(124, (availH - OVH - GAP - cell) / 2));
    }
    const piece = Math.min(cell * 0.85, lane * 0.45, 58);
    const width = per * n;
    J.geom = { per, cell, lane, piece, width, ovh: OVH };
    const s = J.strip;
    s.style.setProperty('--cell', `${cell}px`);
    s.style.setProperty('--gap', `${per - cell}px`);
    s.style.setProperty('--lane', `${lane}px`);
    s.style.setProperty('--piece', `${piece}px`);
    s.style.width = `${width}px`;
    s.style.height = `${lane + cell + piece + 16}px`;
    J.overview.setAttribute('viewBox', `0 0 ${width} ${OVH}`);
    J.overview.setAttribute('width', String(width));
    J.overview.setAttribute('height', String(OVH));
    J.arcs.setAttribute('viewBox', `0 0 ${width} ${lane}`);
    J.cols.forEach((c, i) => {
      c.style.left = `${i * per}px`;
      c.style.width = `${per}px`;
    });
    renderJump();
  }

  function setWindow(start) {
    if (start === J.win) return;
    J.win = start;
    J.strip.classList.remove('shift');
    void J.strip.offsetWidth;
    J.strip.classList.add('shift');
    renderJump();
  }

  // 拡大帯の数字・コマ・全体の線を描き直す
  function renderJump() {
    if (!J.strip) return;
    J.cols.forEach((c, i) => {
      const n = J.win + i;
      const shown = !G.sparse || n % 5 === 0 || n === G.pos.kid || n === G.pos.turtle || n === 0 || n === G.N;
      c.querySelector('.cell').textContent = shown ? String(n) : '';
      c.classList.toggle('decade', n % 10 === 0);
      c.classList.toggle('goal', n === G.N);
      c.classList.toggle('blank', !shown);
      c.setAttribute('aria-label', `${n}のマス`);
    });
    placeJumpPiece('kid');
    placeJumpPiece('turtle');
    renderOverview();
  }

  function placeJumpPiece(who, hop) {
    const p = pieces[who];
    if (!p) return;
    const n = G.pos[who];
    p.style.opacity = inWin(n) ? '1' : '0';
    p.style.transform = `translateX(${jx(n) - J.geom.piece / 2}px)`;
    if (hop) {
      p.classList.remove('hop');
      void p.offsetWidth;
      p.classList.add('hop');
    }
  }

  function renderOverview() {
    const ov = J.overview;
    const W = J.geom.width, H = J.geom.ovh, L = 16, R = 16, y = 34;
    const x = (v) => L + (v / G.N) * (W - L - R);
    let s = '';
    // 拡大帯の範囲と、帯へのつながり
    s += `<rect class="ov-band" x="${x(J.win) - 3}" y="${y - 14}" width="${x(J.win + WIN_SPAN) - x(J.win) + 6}" height="28" rx="6"/>`;
    s += `<path class="ov-zoom" d="M${x(J.win) - 3} ${y + 14} L 2 ${H - 1} M${x(J.win + WIN_SPAN) + 3} ${y + 14} L ${W - 2} ${H - 1}"/>`;
    s += `<line class="ov-line" x1="${x(0)}" x2="${x(G.N)}" y1="${y}" y2="${y}"/>`;
    for (let v = 0; v <= G.N; v++) {
      const big = v % 10 === 0, mid = v % 5 === 0;
      const h = big ? 9 : (mid ? 6 : 3.5);
      s += `<line class="ov-tick${big ? ' big' : ''}" x1="${x(v)}" x2="${x(v)}" y1="${y - h}" y2="${y + h}"/>`;
      if (big) s += `<text class="ov-label" x="${x(v)}" y="${y + 37}">${v}</text>`;
    }
    const k = x(G.pos.kid), t = x(G.pos.turtle);
    s += `<path class="ov-kid" d="M${k - 8} ${y - 26} L${k + 8} ${y - 26} L${k} ${y - 11} Z"/>`;
    s += `<path class="ov-${skin('turtle')}" d="M${t - 6} ${y + 19} L${t + 6} ${y + 19} L${t} ${y + 9} Z"/>`;
    ov.innerHTML = s;
  }

  function clearArcs() { if (J.arcs) J.arcs.innerHTML = ''; }

  // a→b の跳びを、拡大帯のマスの上に弧で描く
  function drawArc(a, b, label, who, faint) {
    if (!inWin(a) || !inWin(b)) return;
    const lane = J.geom.lane;
    const x1 = jx(a), x2 = jx(b), y0 = lane - 4;
    // 弧の頂点と数字はコマ（マスの真上）より高い位置に置く
    const h = Math.min(lane - 30, J.geom.piece + 16 + Math.abs(x2 - x1) * 0.1);
    const xm = (x1 + x2) / 2;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', `M${x1} ${y0} Q${xm} ${y0 - h * 2} ${x2} ${y0}`);
    path.setAttribute('class', `arc ${who}${faint ? ' faint' : ''}`);
    J.arcs.appendChild(path);
    const len = path.getTotalLength ? path.getTotalLength() : 200;
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    path.getBoundingClientRect();
    path.style.transition = 'stroke-dashoffset 0.45s ease-out';
    path.style.strokeDashoffset = '0';
    const text = document.createElementNS(SVGNS, 'text');
    text.setAttribute('x', String(xm));
    text.setAttribute('y', String(y0 - h - 6));
    text.setAttribute('class', `arc-label ${who}`);
    text.textContent = label;
    J.arcs.appendChild(text);
  }

  function setJumpGlow(n) {
    J.cols.forEach((c, i) => c.classList.toggle('glow', J.win + i === n));
  }

  function landJump(v, who) {
    G.roll = v;
    G.dest = Math.min(G.pos[who] + v, G.N);
    if (isHuman(who)) {
      G.turnsBy[who] += 1;
      const ask = G.turnsBy[who] <= 2;
      later(150, () => Sound.number(v).then(() => {
        if (ask && G.phase === 'guess') Sound.say('dokoni', 'どこに とまるかな？');
      }));
      later(700, () => {
        G.phase = 'guess';
        G.missThisStep = 0;
        G.lockUntil = now() + 150;
        G.stepStart = now();
        setPrompt('どこに とまる？');
      });
    } else {
      later(150, () => Sound.number(v));
      later(1000, () => animateJump('turtle', afterJump));
    }
  }

  function afterJump(who) {
    if (G.pos[who] === G.N) reachGoal(who);
    else endMove();
  }

  // 10の区切りを経由して跳ぶ（例 36→40→43）。＋10は1回で跳ぶ。
  function animateJump(who, done) {
    G.phase = 'busy';
    const from = G.pos[who], to = G.dest;
    const via = (Math.floor(from / 10) + 1) * 10;
    const segs = (G.roll !== 10 && to > via) ? [[from, via], [via, to]] : [[from, to]];
    clearArcs();
    setJumpGlow(-1);
    let t = 0;
    segs.forEach(([a, b]) => {
      later(t, () => {
        drawArc(a, b, `+${b - a}`, skin(who));
        G.pos[who] = b;
        placeJumpPiece(who, true);
        Sound.fx(who === 'kid' ? 'step' : 'tstep');
      });
      t += JUMP_SEG_MS;
    });
    later(t, () => {
      renderJump();
      Sound.number(to);
      setPrompt(`${to}！`);
    });
    later(t + 1100, () => done(who));
  }

  function onJumpCellDown(e) {
    e.preventDefault();
    const who = G.turn;
    if (!isHuman(who) || G.phase !== 'guess' || now() < G.lockUntil) return;
    const n = J.win + Number(e.currentTarget.dataset.i);
    const from = G.pos[who];
    if (n === from) return;
    const col = e.currentTarget;
    col.classList.add('pressed');
    setTimeout(() => col.classList.remove('pressed'), 140);

    if (n === G.dest) {
      const t = now();
      if (who === 'kid') {
        G.stats.steps += 1;
        G.stats.stepMs += Math.max(0, t - G.stepStart);
      }
      animateJump(who, afterJump);
      return;
    }
    // 外れ：×や減点は出さない
    if (who === 'kid') G.stats.mistaps += 1;
    G.missThisStep += 1;
    G.lockUntil = now() + 400;
    Sound.fx('miss');
    col.classList.remove('nudge');
    void col.offsetWidth;
    col.classList.add('nudge');
    if (G.missThisStep === 1) {
      const via = (Math.floor(from / 10) + 1) * 10;
      if (from + G.roll > G.N) {
        setPrompt(`${G.N}で とまるよ`);
        Sound.say('goaldetomaru', `${reading(G.N)}で とまるよ`);
      } else if (G.roll !== 10 && G.dest > via) {
        clearArcs();
        drawArc(from, via, `あと${via - from}`, skin(who), true);
        setPrompt(`${via}まで あと いくつ？`);
        Sound.say(`made${via}`, `${reading(via)}まで あと いくつ？`);
      } else {
        setPrompt(`${from}から ${G.roll} すすむと？`);
      }
    } else {
      setJumpGlow(G.dest);
    }
  }

  function endGame() {
    G.phase = 'end';
    roulette.className = 'roulette';
    // 記録（子どもの手番だけを集計）
    const rec = todayRec(true);
    rec.games += 1;
    rec.steps += G.stats.steps;
    rec.mistaps += G.stats.mistaps;
    rec.stepMs += G.stats.stepMs;
    if (G.oppHuman) rec.human = (rec.human || 0) + 1;
    data.games.push({ ts: Date.now(), level: G.level, opp: G.oppHuman ? 'human' : 'auto', ...G.stats });
    if (data.games.length > 300) data.games = data.games.slice(-300);
    saveData();

    const limited = limitReached();
    $('#btn-again').hidden = limited;
    $('#end-limit').hidden = !limited;
    $('.end-star').hidden = limited;
    $('#end-overlay').hidden = false;
    Sound.fx('end');
    later(700, () => {
      if (limited) Sound.say('mataashita', 'また あしたね');
      else Sound.say('yattane', 'やったね！');
    });
  }

  function quitToTitle() {
    clearTimers();
    G.phase = 'idle';
    $('#end-overlay').hidden = true;
    show('title');
  }

  roulette.addEventListener('pointerdown', onRouletteTap);
  $('#btn-again').addEventListener('click', () => {
    Sound.fx('tap');
    if (limitReached()) { quitToTitle(); return; }
    newGame();
  });
  $('#btn-quit').addEventListener('click', () => { Sound.fx('tap'); quitToTitle(); });

  function startFromTitle(human) {
    Sound.unlock();
    Sound.fx('tap');
    if (limitReached()) { renderTitle(); return; }
    G.oppHuman = human;
    data.settings.lastOpp = human ? 'human' : 'auto';
    saveData();
    newGame();
  }
  $('#btn-start-auto').addEventListener('click', () => startFromTitle(false));
  $('#btn-start-human').addEventListener('click', () => startFromTitle(true));

  // ---------- 保護者ゲート（歯車を2秒長押し） ----------
  const gear = $('#gear');
  let gearTimer = null;
  function gearCancel() {
    clearTimeout(gearTimer);
    gearTimer = null;
    gear.classList.remove('pressing');
  }
  gear.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    gearCancel();
    void gear.offsetWidth;
    gear.classList.add('pressing');
    gearTimer = setTimeout(() => {
      gearCancel();
      Sound.unlock();
      openParent();
    }, 2000);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => gear.addEventListener(ev, gearCancel));

  // ---------- 保護者画面 ----------
  function openParent() {
    // 途中のゲームは記録せずに終了する
    clearTimers();
    G.phase = 'idle';
    $('#end-overlay').hidden = true;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    renderParent();
    show('parent');
  }

  function renderParent() {
    const s = data.settings;
    document.querySelectorAll('#level-seg button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.level) === Number(s.level));
    });
    $('#set-hints').checked = !!s.hints;

    const sel = $('#set-limit');
    if (!sel.options.length) {
      for (let i = 1; i <= 10; i++) sel.add(new Option(`${i}ゲーム`, String(i)));
      sel.add(new Option('上限なし', '0'));
    }
    sel.value = String(s.limit);

    const t = todayRec(false);
    $('#today-count').textContent = `今日：${t.games}ゲーム` + (Number(s.limit) > 0 ? `（上限 ${s.limit}）` : '');

    // レベル提案：同じレベルの直近3ゲームで誤タップが合計1回以下
    const sug = $('#level-suggest');
    const recent = data.games.filter((g) => g.level === Number(s.level)).slice(-3);
    const ready = s.level < MAX_LEVEL && recent.length === 3 && recent.reduce((a, g) => a + g.mistaps, 0) <= 1;
    sug.hidden = !ready;
    if (ready) sug.textContent = `直近3ゲームで誤タップがほとんどありません。レベル${Number(s.level) + 1}を試してもよさそうです。`;

    renderRecords();
    renderCheckChart();
    $('#version').textContent = `バージョン ${APP_VERSION}`;
  }

  function renderRecords() {
    const body = $('#rec-body');
    body.innerHTML = '';
    const keys = Object.keys(data.days).sort().reverse().slice(0, 14);
    if (!keys.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="empty" colspan="4">まだ記録がありません</td>';
      body.appendChild(tr);
      return;
    }
    keys.forEach((k) => {
      const r = data.days[k];
      const [, m, d] = k.split('-');
      const avg = r.steps ? `${(r.stepMs / r.steps / 1000).toFixed(1)} 秒` : '—';
      const tr = document.createElement('tr');
      const games = r.human ? `${r.games}（ふたり${r.human}）` : `${r.games}`;
      tr.innerHTML = `<td>${Number(m)}/${Number(d)}</td><td>${games}</td><td>${r.mistaps}</td><td>${avg}</td>`;
      body.appendChild(tr);
    });
  }

  // ずれは線の長さに対する割合（%）で比べる。0〜10版と0〜100版を同じ目盛りに並べる。
  function checkPae(c) {
    if (typeof c.pae === 'number') return c.pae;
    return (c.meanErr / (c.range || 10)) * 100;
  }
  function renderCheckChart() {
    const box = $('#check-chart');
    const cs = data.checks.slice(-16);
    if (!cs.length) {
      box.innerHTML = '<p class="empty">まだチェックの記録がありません</p>';
      return;
    }
    const W = 520, H = 196, L = 44, R = 16, T = 40, B = 34;
    const vals = cs.map(checkPae);
    const maxY = Math.max(20, Math.ceil(Math.max(...vals) / 10) * 10);
    const x = (i) => (cs.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (cs.length - 1));
    const y = (v) => T + (1 - v / maxY) * (H - T - B);
    const color = { 10: '#FF8A65', 100: '#3D7DD8' };
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="かずの せん チェックのずれの推移">`;
    svg += `<text x="${L}" y="14" font-size="12" fill="#666">ずれ（線の長さに対する %）　小さいほど正確</text>`;
    svg += `<circle cx="${L + 5}" cy="28" r="4.5" fill="${color[10]}"/><text x="${L + 14}" y="32" font-size="11.5" fill="#444">0〜10</text>`;
    svg += `<circle cx="${L + 75}" cy="28" r="4.5" fill="${color[100]}"/><text x="${L + 84}" y="32" font-size="11.5" fill="#444">0〜100</text>`;
    const step = maxY <= 30 ? 5 : 10;
    for (let v = 0; v <= maxY; v += step) {
      svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#EEE"/>`;
      svg += `<text x="${L - 8}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="#888">${v}%</text>`;
    }
    [10, 100].forEach((r) => {
      const idx = cs.map((c, i) => ((c.range || 10) === r ? i : -1)).filter((i) => i >= 0);
      if (idx.length > 1) {
        const pts = idx.map((i) => `${x(i)},${y(vals[i])}`).join(' ');
        svg += `<polyline points="${pts}" fill="none" stroke="${color[r]}" stroke-width="2"/>`;
      }
    });
    cs.forEach((c, i) => {
      const [, m, d] = c.date.split('-');
      svg += `<circle cx="${x(i)}" cy="${y(vals[i])}" r="4.5" fill="${color[c.range || 10]}" stroke="#fff" stroke-width="1.5"/>`;
      svg += `<text x="${x(i)}" y="${y(vals[i]) - 9}" font-size="11" text-anchor="middle" fill="#333">${Math.round(vals[i])}</text>`;
      svg += `<text x="${x(i)}" y="${H - 12}" font-size="11" text-anchor="middle" fill="#888">${Number(m)}/${Number(d)}</text>`;
    });
    svg += '</svg>';
    box.innerHTML = svg;
  }

  $('#level-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-level]');
    if (!b) return;
    data.settings.level = Number(b.dataset.level);
    saveData();
    renderParent();
  });
  $('#set-hints').addEventListener('change', (e) => {
    data.settings.hints = e.target.checked;
    saveData();
  });
  $('#set-limit').addEventListener('change', (e) => {
    data.settings.limit = Number(e.target.value);
    saveData();
    renderParent();
  });
  $('#btn-reset-today').addEventListener('click', () => {
    const k = dateKey();
    if (data.days[k]) data.days[k].games = 0;
    saveData();
    renderParent();
  });
  $('#btn-clear').addEventListener('click', () => {
    if (!window.confirm('ゲームとチェックの記録をすべて消します。よろしいですか？（設定は残ります）')) return;
    data.days = {};
    data.games = [];
    data.checks = [];
    saveData();
    renderParent();
  });
  $('#btn-guide').addEventListener('click', () => { $('#guide-overlay').hidden = false; });
  $('#parent-close').addEventListener('click', () => show('title'));

  // ---------- 使い方（初回） ----------
  $('#guide-ok').addEventListener('click', () => {
    $('#guide-overlay').hidden = true;
    if (!data.settings.guideSeen) {
      data.settings.guideSeen = true;
      saveData();
    }
  });

  // ---------- かずの せん チェック ----------
  const C = { queue: [], answers: [], target: 0, accept: false, range: 10 };
  const checkArea = $('#check-area');
  const nlMark = $('#nl-mark');

  function startCheck(range) {
    C.range = range;
    $('#nl-right').textContent = String(range);
    C.queue = CHECK_SETS[range].slice().sort(() => Math.random() - 0.5);
    C.answers = [];
    show('check');
    nextCheck();
  }

  function nextCheck() {
    nlMark.hidden = true;
    $('#check-msg').textContent = '';
    if (!C.queue.length) { finishCheck(); return; }
    C.target = C.queue.shift();
    $('#check-num').textContent = String(C.target);
    C.accept = false;
    Sound.say(`q${C.target}`, `${reading(C.target)} は どこかな？`).then(() => { C.accept = true; });
    setTimeout(() => { C.accept = true; }, 2600);
  }

  checkArea.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!C.accept || currentScreen !== 'check') return;
    C.accept = false;
    const line = checkArea.querySelector('.nl').getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - line.left) / line.width));
    const est = ratio * C.range;
    C.answers.push({ target: C.target, est: Math.round(est * 100) / 100 });
    nlMark.style.left = `${ratio * 100}%`;
    nlMark.hidden = false;
    Sound.fx('tap');
    $('#check-msg').textContent = 'ありがとう！';
    Sound.say('thanks', 'ありがとう！');
    setTimeout(nextCheck, 1400);
  });

  function finishCheck() {
    const n = C.answers.length;
    if (n) {
      const meanErr = C.answers.reduce((a, r) => a + Math.abs(r.est - r.target), 0) / n;
      data.checks.push({
        ts: Date.now(), date: dateKey(), range: C.range,
        meanErr: Math.round(meanErr * 100) / 100,
        pae: Math.round((meanErr / C.range) * 1000) / 10,
        answers: C.answers,
      });
      if (data.checks.length > 100) data.checks = data.checks.slice(-100);
      saveData();
    }
    $('#check-num').textContent = '';
    $('#check-msg').textContent = 'おわり！';
    Sound.fx('end');
    setTimeout(() => { renderParent(); show('parent'); }, 1500);
  }

  $('#btn-check10').addEventListener('click', () => { Sound.unlock(); startCheck(10); });
  $('#btn-check100').addEventListener('click', () => { Sound.unlock(); startCheck(100); });
  $('#check-close').addEventListener('click', () => {
    C.queue = [];
    C.accept = false;
    renderParent();
    show('parent');
  });

  // ---------- 誤操作防止 ----------
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (currentScreen !== 'parent' && !e.target.closest('.guide-card')) e.preventDefault();
  }, { passive: false });

  // ---------- オフライン（Service Worker） ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // 初回インストール時は再読み込みしない
      if (currentScreen === 'title') location.reload();
      else pendingReload = true;  // 遊んでいる途中なら、タイトルに戻ったときに新版へ
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* オフライン化なしでも動く */ });
    });
  }

  // ---------- 起動 ----------
  show('title');
  if (!data.settings.guideSeen) $('#guide-overlay').hidden = false;
})();
