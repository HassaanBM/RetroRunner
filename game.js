'use strict';

/* ============================================================
   DODGE THE CHAOS — GAME LOGIC 
   ------------------------------------------------------------
   JS = positions, physics, collisions, state, class toggling.
   CSS = every visual: themes, scenery, poses, animations.
   ============================================================ */

/* ============================================================
   ⚙️ CONFIG — YOUR CONTROL PANEL
   ------------------------------------------------------------
   GAME_SPEED is the single speed knob. Movement is computed as
   a FRACTION OF SCREEN WIDTH per frame, so the game feels the
   same on a phone, tablet or desktop. Raise it → faster
   everywhere; lower it → slower everywhere. One variable,
   consistent across every screen size.
   MAX_PNG_BYTES caps how big a custom character upload can be.
   ============================================================ */
const CONFIG = {
  GAME_SPEED: 6.5,          /* base speed — screens/sec, device-independent */
  SPEED_RAMP: 0.004,        /* difficulty ramp rate per score point */
  JUMP_V: -18,              /* jump impulse (negative = up) */
  GRAVITY: 0.85,            /* gravity acceleration per frame */
  MAX_PNG_BYTES: 10 * 1024 * 1024,  /* 10 MB limit for custom PNG characters */

  /* ---- Sprite sheet grid — measured directly from res/sprite-sheet-game.png.
     This sheet is ONLY chroma-keyed to transparency — cells are the raw,
     untouched, evenly-spaced grid from the original artwork (no recrop).
     That's deliberate: every character silhouette sits comfortably inside
     its own cell with margin to spare, so showing the FULL cell can never
     clip/chop any part of the character (a tighter recrop was tried and
     reverted for exactly this reason — see game.css §9 for the full
     writeup). If you ever swap in a different sheet, update these four
     numbers to match its actual pixel grid; everything else derives from
     them. ---- */
  SPRITE_SHEET_W: 1312,     /* full sheet width in px */
  SPRITE_SHEET_H: 816,      /* full sheet height in px */
  SPRITE_COLS: 6,           /* frames per row */
  SPRITE_ROWS: 2,           /* row 0 = run cycle, row 1 = jump sequence */

  RUN_FPS: 12,              /* leg-cycle speed — independent of the 60fps game loop */
  LANDING_FRAMES: 5,        /* ticks to hold the landing-crouch pose after touchdown */

  /* Running frames (row 0) are top-aligned in their cell (see game.css
     §9), which leaves a large gap of empty space below the character's
     feet — since the sprite BOX's bottom edge is what lines up with the
     ground, that gap made the character look like it was floating above
     the sidewalk instead of standing on it. Nudging the sprite DOWN by
     this many px (a positive background-position-y) crops that empty
     gap out of view instead of the character itself — the character's
     head end still starts from the sheet's real top, nothing is
     clipped. Tuned by eye at the default 86px --player-size; scales
     proportionally with it via RUN_Y_OFFSET_REF_PSIZE below. Only
     applies to row 0 (running) — jump poses (row 1) are intentionally
     left alone since being elevated off the ground is the whole point
     of a jump pose. */
  RUN_Y_OFFSET: 54,             /* px, tuned at the reference size below */
  RUN_Y_OFFSET_REF_PSIZE: 86,   /* --player-size the 54px value was tuned at */
};

/* ---------- Tiny DOM helper ---------- */
const $ = id => document.getElementById(id);

const gameEl = $('game'), world = $('world');
const playerEl = $('player'), shadowEl = $('playerShadow');
const entities = $('entities'), npcLayer = $('npcLayer');
const cityStrip = $('cityStrip'), sidewalkEl = $('sidewalk');

/* ---------- Device detection: copy changes for touch screens ---------- */
/* Starting a fresh run from the intro screen still works via
   tap/spacebar anywhere (see jump()) — only RESTART (game-over) and
   RESUME (paused) are button-only, so this CTA is the only one that
   still needs device-aware copy. The game-over screen now has its
   own dedicated "🔄 Play Again" button instead of a CTA line — see
   index.html. */
const isTouch = window.matchMedia('(pointer: coarse)').matches;
$('introCta').textContent = isTouch ? '▶ TAP to play!' : '▶ Press SPACEBAR to play!';

/* ============================================================
   SCOREBOARD — cookie consent, name capture, mini-leaderboard
   ============================================================
   Entirely client-side, opt-in, and disclosed up front (see
   FEATURE_CHECKLIST.md for the full spec + product decisions this
   was built against). Three small cookies, nothing sent anywhere:

     rr_consent  'in' | 'out'         — has the player made a choice?
     rr_name     their chosen name    — only meaningful if consent='in'
     rr_scores   JSON [{name,score}]  — up to 5 entries, newest first

   Design decisions locked in for this build (see FEATURE_CHECKLIST.md
   "Points to address" for the reasoning):
     - Asked ONCE ever, not before every run. Changeable anytime after
       via the pause panel's "🏆" row, which reopens this same overlay.
     - Opting out does NOT clear previously saved entries — they just
       stop growing. (No separate "clear my data" UI was built; the
       cookies simply expire on their own after COOKIE_DAYS, or can be
       cleared through the browser like any other cookie.)
     - 90-day cookie expiry (the "3 months at max" call).
     - Every completed run while opted in adds its OWN row — the same
       name can occupy more than one of the 5 slots.
   ============================================================ */
const SCOREBOARD = {
  COOKIE_CONSENT: 'rr_consent',
  COOKIE_NAME: 'rr_name',
  COOKIE_SCORES: 'rr_scores',
  COOKIE_DAYS: 90,          /* "3 months at max" */
  MAX_ROWS: 5,               /* "5 most recent players" */
  MAX_NAME_LEN: 14,          /* keeps the name tag + table tidy */
};

/* ---------- Tiny cookie helpers (get/set only — no library needed) ---------- */
function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = name + '=' + encodeURIComponent(value) +
    '; expires=' + expires + '; path=/; SameSite=Lax';
}
function getCookie(name) {
  const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

/* ---------- Scoreboard state (loaded from cookies at boot) ---------- */
let consent = null;          /* 'in' | 'out' | null (undecided — first visit) */
let playerName = '';         /* only meaningful when consent === 'in' */
let scoreHistory = [];       /* [{name, score}, ...] newest first, max MAX_ROWS */
let consentPending = false;  /* true while the FIRST-TIME consent card is blocking play */
let consentFromPause = false; /* true when the overlay was reopened via the pause panel */

/* Read all three cookies into the state above. Parses defensively —
   a corrupted/hand-edited cookie just falls back to "no history"
   rather than throwing. */
function loadScoreboardState() {
  const c = getCookie(SCOREBOARD.COOKIE_CONSENT);
  consent = (c === 'in' || c === 'out') ? c : null;
  playerName = getCookie(SCOREBOARD.COOKIE_NAME) || '';
  try {
    const parsed = JSON.parse(getCookie(SCOREBOARD.COOKIE_SCORES) || '[]');
    scoreHistory = Array.isArray(parsed) ? parsed.slice(0, SCOREBOARD.MAX_ROWS) : [];
  } catch (e) {
    scoreHistory = [];
  }
}

/* Persist the player's choice. Called by both the accept and decline
   buttons — declining still writes 'out' so we never ask again. */
function saveConsent(choice, name) {
  consent = choice;
  playerName = name || '';
  setCookie(SCOREBOARD.COOKIE_CONSENT, consent, SCOREBOARD.COOKIE_DAYS);
  setCookie(SCOREBOARD.COOKIE_NAME, playerName, SCOREBOARD.COOKIE_DAYS);
}

/* Add this run's result to the history (newest first) and persist it.
   Only ever called when consent === 'in'. */
function pushScoreEntry(name, score) {
  scoreHistory.unshift({ name: name, score: score });
  scoreHistory = scoreHistory.slice(0, SCOREBOARD.MAX_ROWS);
  setCookie(SCOREBOARD.COOKIE_SCORES, JSON.stringify(scoreHistory), SCOREBOARD.COOKIE_DAYS);
}

/* ─────────────────────────────────────────────────────────────────
   Open the consent/name card. `fromPause` distinguishes "editing an
   existing choice from the pause panel" (pre-fills the current name,
   returns to Paused when closed) from "the mandatory first-visit
   prompt" (blocks play via consentPending until resolved).
   ───────────────────────────────────────────────────────────────── */
function openConsentOverlay(fromPause) {
  consentFromPause = fromPause;
  consentPending = !fromPause;
  $('consentNameInput').value = consent === 'in' ? playerName : '';
  if (fromPause) $('pausePanel').hidden = true;
  $('consentOverlay').hidden = false;
}

/* Closes the card and routes back to wherever it was opened from. */
function closeConsentOverlay() {
  $('consentOverlay').hidden = true;
  consentPending = false;
  updateScoreboardSettingsBtn();
  if (consentFromPause) {
    $('pausePanel').hidden = false;   /* back to Paused — NOT auto-resumed */
  } else {
    $('introOverlay').hidden = false; /* first-time flow → reveal the normal intro card */
  }
}

/* Keeps the pause panel's row honest about the current opt-in state. */
function updateScoreboardSettingsBtn() {
  $('scoreboardSettingsBtn').textContent =
    consent === 'in' ? '🏆 Playing as ' + playerName + ' · Edit' : '🏆 Join the scoreboard';
}

/* ─────────────────────────────────────────────────────────────────
   Floating name tag above the player — ONLY while actively playing
   (see renderSprite()'s neighbor calls in update()). Positioned in
   world space exactly like the shadow/player transforms; the `- 22`
   is just a fixed px gap above the sprite box's top edge — nudge it
   if the tag ever looks too close to (or far from) the character's
   head once you're looking at it live.
   ───────────────────────────────────────────────────────────────── */
const nameTagEl = $('playerNameTag');
function renderNameTag(bob) {
  if (consent !== 'in') { nameTagEl.hidden = true; return; }
  nameTagEl.hidden = false;
  nameTagEl.textContent = playerName;
  nameTagEl.style.transform =
    'translate3d(' + (px + PSIZE / 2) + 'px,' + (playerVisualY(py + bob) - 22) + 'px,0) translateX(-50%)';
}

/* ─────────────────────────────────────────────────────────────────
   Render the up-to-5-row table on the game-over screen. `highlightIdx`
   marks the row this run's own result landed in (always 0, since a
   new entry is unshifted to the front) — pass -1 when this run didn't
   add anything (player is opted out) so nothing gets highlighted.
   Hides the whole section when there's no history to show at all.
   ───────────────────────────────────────────────────────────────── */
function renderScoreboard(highlightIdx) {
  const section = $('scoreboardSection'), rows = $('scoreboardRows');
  if (scoreHistory.length === 0) { section.hidden = true; return; }

  section.hidden = false;
  rows.innerHTML = '';
  scoreHistory.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'scoreboard__row' + (i === highlightIdx ? ' scoreboard__row--new' : '');

    const rank = document.createElement('span');
    rank.className = 'scoreboard__rank';
    rank.textContent = (i + 1) + '.';

    const name = document.createElement('span');
    name.className = 'scoreboard__name';
    name.textContent = entry.name;   /* textContent only — never innerHTML */

    const scoreEl = document.createElement('span');
    scoreEl.className = 'scoreboard__score';
    scoreEl.textContent = pad(entry.score);

    row.appendChild(rank);
    row.appendChild(name);
    row.appendChild(scoreEl);
    rows.appendChild(row);
  });
}

/* ============================================================
   CHARACTER ROSTER — SPRITE SHEET HEROES
   ============================================================
   All three heroes currently share the SAME sprite sheet and frames.
   What makes them distinct hooks for later customization is the
   dedicated CSS class each one carries (.char-sunny / .char-maya /
   .char-andre, defined in game.css §9) — swap in a different sheet,
   a different frame timing, or a CSS filter per class whenever you're
   ready, with zero changes needed here.

   `emoji` is used only for the small picker buttons / game-over
   portrait — it has no bearing on the in-game sprite rendering.

   Custom PNG: uploaded images replace the sprite sheet and render
   statically (no frame cycling).
   ============================================================ */
const CHARACTERS = [
  { name: 'Sunny', cssClass: 'char-sunny', emoji: '🏃🏻‍➡️' },
  { name: 'Maya',  cssClass: 'char-maya',  emoji: '🏃🏽‍♀️‍➡️' },
  { name: 'Andre', cssClass: 'char-andre', emoji: '🏃🏿‍➡️' },
];

let charIndex = 0;
let customPNG = null;          /* data-URL of uploaded image, if any */
let usingCustom = false;       /* true when custom PNG is active */

/* ============================================================
   SPRITE FRAME ENGINE
   ============================================================
   Everything below computes WHICH cell of the sprite sheet to show
   and WHERE to draw it, then writes that straight onto the player
   element every game tick (60 FPS, ridden on the same rAF loop that
   already drives physics). See game.css §9 for why this is JS-driven
   rather than a CSS @keyframes animation.
   ============================================================ */

/* Raw source-sheet cell size (derived once from CONFIG, in px) */
const CELL_W = CONFIG.SPRITE_SHEET_W / CONFIG.SPRITE_COLS;   /* 218.67px */
const CELL_H = CONFIG.SPRITE_SHEET_H / CONFIG.SPRITE_ROWS;   /* 408px    */

/* Filled in by measureSpriteMetrics() whenever PSIZE changes
   (boot + resize). frameW always equals PSIZE (no horizontal
   distortion); frameH is taller than PSIZE since the sprite's source
   art is portrait — it overflows above the hitbox, which is normal
   and desired for character art. */
let frameW = 0, frameH = 0;

/* Ticks-per-frame for the run cycle, derived from CONFIG.RUN_FPS
   against the 60 FPS game loop (e.g. 60/12 = 5 ticks per frame). */
const RUN_TICKS_PER_FRAME = Math.max(1, Math.round(60 / CONFIG.RUN_FPS));

/* Counts down after landing so the crouch pose (row 1, last column)
   holds briefly before the run cycle resumes — a small "impact"
   beat that sells the landing. */
let landingTimer = 0;

/* How much taller the sprite element is than the physics hitbox
   (frameH - PSIZE). update()/idleRender() shift the element up by
   exactly this much so its bottom edge — the feet — still lands on
   the same ground line a plain --player-size box would. Recomputed
   alongside frameH in measureSpriteMetrics(). */
let visualOverflow = 0;

/* The actual (scaled) running-frame ground-alignment nudge — see
   CONFIG.RUN_Y_OFFSET above for what this fixes. Recomputed alongside
   frameH so it stays correct if --player-size ever changes. */
let runYOffset = 0;

/* Recompute the displayed frame size + background-size whenever the
   player's hitbox (--player-size) changes. Scaling is uniform on
   both axes (scale = PSIZE / CELL_W) so the character never stretches.
   The element is sized to frameH (NOT PSIZE) because a CSS
   background-image is always clipped to its own box — there is no
   way to let it paint outside a shorter box, so the box itself has
   to be the full frame height. */
function measureSpriteMetrics() {
  const scale = PSIZE / CELL_W;
  frameW = PSIZE;
  frameH = CELL_H * scale;
  visualOverflow = frameH - PSIZE;
  runYOffset = CONFIG.RUN_Y_OFFSET * (PSIZE / CONFIG.RUN_Y_OFFSET_REF_PSIZE);

  playerEl.style.setProperty('--sprite-bg-w', (CELL_W * CONFIG.SPRITE_COLS * scale) + 'px');
  playerEl.style.setProperty('--sprite-bg-h', (CELL_H * CONFIG.SPRITE_ROWS * scale) + 'px');
  playerEl.style.setProperty('--sprite-frame-h', frameH + 'px');
}

/* Write the background-position for a given (column, row) cell.
   Column offsets are always whole multiples of the frame width.
   Row 0 (running) additionally gets +runYOffset — see CONFIG.RUN_Y_OFFSET
   — to crop the dead space below the feet instead of showing it; every
   other row uses the plain top-aligned row offset. */
function setSpriteFrame(col, row) {
  const y = -(row * frameH) + (row === 0 ? runYOffset : 0);
  playerEl.style.setProperty('--sprite-x', (-(col * frameW)) + 'px');
  playerEl.style.setProperty('--sprite-y', y + 'px');
}

/* ─────────────────────────────────────────────────────────────────
   Jump pose selection — driven by actual vertical velocity (vy)
   rather than elapsed time, so it always matches what the character
   is really doing whether it's a quick hop or an extended double
   jump. Row 1 layout: 0 crouch/launch, 1 rising, 2 near apex,
   3 falling (apex-spread), 4 falling fast (tucked), 5 landing crouch
   (reserved for the post-landing beat, see landingTimer).
   ───────────────────────────────────────────────────────────────── */
function pickJumpFrame(velocityY) {
  if (velocityY < -12) return 0;   /* explosive launch off the ground   */
  if (velocityY < -4)  return 1;   /* still rising quickly              */
  if (velocityY < 4)   return 2;   /* near the top of the arc           */
  if (velocityY < 12)  return 3;   /* starting to fall                  */
  return 4;                        /* falling fast, coming in to land   */
}

/* ─────────────────────────────────────────────────────────────────
   The element's own top-left Y position needs to shift up by
   `visualOverflow` in sprite mode (since the box is taller than the
   PSIZE hitbox) so the character's FEET still land on the same
   ground line as a plain --player-size box would. Custom PNG mode
   uses the plain hitbox-sized box, so no correction is needed there.
   Call this instead of using `py` directly wherever the player's
   transform is written.
   ───────────────────────────────────────────────────────────────── */
function playerVisualY(y) {
  return usingCustom ? y : y - visualOverflow;
}

/* ─────────────────────────────────────────────────────────────────
   Called once per game tick (from update() and idleRender()) to pick
   and draw the correct sprite frame for the current physics state.
   No-op for custom PNG characters, which render statically via CSS.
   ───────────────────────────────────────────────────────────────── */
function renderSprite() {
  if (usingCustom) return;

  if (landingTimer > 0) {
    landingTimer--;
    setSpriteFrame(5, 1);                       /* landing crouch beat */
  } else if (jumping) {
    setSpriteFrame(pickJumpFrame(vy), 1);        /* physics-synced jump pose */
  } else {
    const frame = Math.floor(runF / RUN_TICKS_PER_FRAME) % CONFIG.SPRITE_COLS;
    setSpriteFrame(frame, 0);                    /* running cycle */
  }
}

/* ─────────────────────────────────────────────────────────────────
   Apply the correct character CSS class (sprite-sheet mode only —
   custom PNG mode doesn't need one).
   ───────────────────────────────────────────────────────────────── */
function applyCharacterClass() {
  CHARACTERS.forEach(c => playerEl.classList.remove(c.cssClass));
  if (!usingCustom) playerEl.classList.add(CHARACTERS[charIndex].cssClass);
}

/* ─────────────────────────────────────────────────────────────────
   Switch between a sprite-sheet hero and the custom PNG, toggling
   the CSS classes that control which background image is shown.
   ───────────────────────────────────────────────────────────────── */
function applyCharacter() {
  if (usingCustom && customPNG) {
    /* Custom PNG mode: static image, no sprite animation */
    playerEl.classList.remove('player--sprite');
    playerEl.classList.add('player--custom');
    playerEl.style.setProperty('--player-image', 'url("' + customPNG + '")');
  } else {
    /* Sprite sheet mode */
    playerEl.classList.remove('player--custom');
    playerEl.classList.add('player--sprite');
    applyCharacterClass();
    measureSpriteMetrics();
    renderSprite();
  }
  buildCharPickers();
}

/* ============================================================
   RESPONSIVE LAYOUT METRICS
   ============================================================
   Recalculate screen dimensions and game boundaries on resize.
   W: viewport width, H: viewport height
   GY: ground line Y position (78% of screen height)
   PSIZE: player sprite size (used for collision detection)
   ============================================================ */
let W = 0, H = 0, GY = 0, PSIZE = 86;

function measure() {
  W = window.innerWidth;
  H = window.innerHeight;
  GY = H * (parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--ground-line')) / 100);
  PSIZE = playerEl.offsetWidth || 86;
  measureSpriteMetrics();   /* keep sprite scale in sync with hitbox size */
}

window.addEventListener('resize', () => { measure(); buildCity(); });
window.addEventListener('orientationchange',
  () => setTimeout(() => { measure(); buildCity(); }, 200));

/* ============================================================
   AUDIO SYSTEM (Web Audio API)
   ============================================================
   Procedurally generated sound effects using oscillators.
   Each SFX is defined as a sweep from one frequency to another.
   All audio respects the muted flag.
   ============================================================ */
let AC = null, muted = false;

/* Lazy-load Audio Context (required by browsers) */
const audio = () => AC || (AC = new (window.AudioContext || window.webkitAudioContext)());

/* Beep generator: sweeps frequency f1 → f2 over duration dur */
function beep(f1, f2, type, vol, dur) {
  if (muted) return;
  try {
    const a = audio(), o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination);
    o.type = type;
    o.frequency.setValueAtTime(f1, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(f2, a.currentTime + dur * 0.6);
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    o.start(); o.stop(a.currentTime + dur + 0.05);
  } catch (e) {}
}

/* Sound effect library */
const sJump = () => beep(300, 720, 'square', 0.12, 0.16);      /* jump takeoff */
const sJump2 = () => beep(480, 1100, 'square', 0.12, 0.14);    /* double jump */
const sHit  = () => beep(380, 70, 'sawtooth', 0.15, 0.28);     /* collision */
const sCoin = () => beep(900, 1400, 'sine', 0.11, 0.18);       /* pickup collected */
const sOver = () => beep(440, 110, 'square', 0.12, 0.5);       /* game over */
const sGo   = () => {                                            /* game start */
  beep(520, 780, 'sine', 0.1, 0.15);
  setTimeout(() => beep(780, 1040, 'sine', 0.1, 0.2), 130);
};

/* ============================================================
   PROCEDURAL GENERATION (Seeded RNG)
   ============================================================
   Mulberry32: deterministic random number generator.
   Using seed=4242 ensures consistent city layouts.
   ============================================================ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   CITY BUILDER
   ============================================================
   Generates a scrolling city skyline with random buildings.
   Two strips of buildings loop infinitely as the camera moves.
   Each building has random width, height, and color.
   ============================================================ */
const BLD_CLASSES = [
  'building--peach', 'building--mint',  'building--butter',
  'building--lilac', 'building--rose',  'building--ice'
];
let stripW = 0, cityX = 0;

function buildCity() {
  cityStrip.innerHTML = '';
  stripW = Math.max(1600, W * 2);

  /* Generate two strips (for seamless looping) */
  for (let half = 0; half < 2; half++) {
    const rnd = mulberry32(4242);  /* deterministic seed */
    let x = half * stripW;

    /* Fill strip with random buildings */
    while (x < (half + 1) * stripW - 60) {
      const w = 36 + rnd() * 50;
      const h = 50 + rnd() * 105;
      const b = document.createElement('div');
      b.className = 'building ' +
        BLD_CLASSES[(rnd() * BLD_CLASSES.length) | 0] +
        (rnd() > 0.6 ? ' building--roofed' : '');
      b.style.left = x + 'px';
      b.style.width = w + 'px';
      b.style.height = h + 'px';
      cityStrip.appendChild(b);
      x += w + 10 + rnd() * 18;
    }
  }
  cityStrip.style.width = stripW * 2 + 'px';
}

/* ============================================================
   NPCs (Non-Player Characters)
   ============================================================
   Background characters walking/playing in the city.
   Spawned randomly during intro, provide visual life to scene.
   ============================================================ */
const NPC_TYPES = [
  '🧒', '👧', '⚽', '🐕', '🚶', '🚴', '🛴', '👵', '🎈', '🐈'
];
let npcs = [];

function spawnNPC(startX) {
  const dir = Math.random() > 0.5 ? 1 : -1;  /* random direction */
  const el = document.createElement('div');
  el.className = 'npc';
  el.textContent = NPC_TYPES[(Math.random() * NPC_TYPES.length) | 0];
  npcLayer.appendChild(el);
  npcs.push({
    el, dir,
    x: startX !== undefined ? startX : (dir > 0 ? -40 : W + 40),
    sp: 0.4 + Math.random() * 0.8,  /* random walk speed */
    bobSeed: Math.random() * Math.PI * 2
  });
}

function renderNPC(n, f) {
  /* Gentle up-down bobbing motion */
  const bob = Math.sin(f * 0.15 + n.bobSeed) * 2;
  n.el.style.transform =
    'translate3d(' + n.x + 'px,' + (GY - 28 + bob) + 'px,0)' +
    (n.dir < 0 ? ' scaleX(-1)' : '');  /* flip horizontally if moving left */
}

/* ============================================================
   OBSTACLE CATALOGUE
   ============================================================
   Hazards: ground-level (duck, taco, cart, etc.) and flying (fish, drink).
   Flying obstacles require a double jump to avoid.
   Ground obstacles can be jumped over with a single jump.
   ============================================================ */
const OBSTACLE_TYPES = [
  /* Ground obstacles (avoid with single jump) */
  { e: '🦆', cls: 'obstacle--duck',  fly: false },
  { e: '🌮', cls: 'obstacle--taco',  fly: false },
  { e: '🛒', cls: 'obstacle--cart',  fly: false },
  { e: '🧀', cls: 'obstacle--nacho', fly: false },
  { e: '🎳', cls: 'obstacle--bowl',  fly: false },
  { e: '🍕', cls: 'obstacle--pizza', fly: false },
  { e: '🌯', cls: 'obstacle--wrap',  fly: false },
  /* Flying obstacles (require double jump to avoid) */
  { e: '🦆', cls: 'obstacle--fish',  fly: true  },
  { e: '🐟', cls: 'obstacle--fish',  fly: true  },
  { e: '🥤', cls: 'obstacle--drink', fly: true  },
];

/* ============================================================
   GAME STATE VARIABLES
   ============================================================
   Tracks all runtime state: physics, collisions, scoring, etc.
   ============================================================ */

/* ─────────────────────────────────────────────────────────────────
   GAME STATE MACHINE — single source of truth.

   `state` is one of: 'intro' | 'playing' | 'paused' | 'over'.

   NEVER assign `state = '...'` directly anywhere else in this file —
   always go through setGameState(). It keeps a matching body class
   (game-intro / game-playing / game-paused / game-over, see game.css
   §13) permanently in sync with `state`, so there's exactly ONE place
   that can ever get this wrong instead of it being scattered across
   every screen transition. This is also what CSS hooks into if you
   want to style the intro screen, pause screen, etc. independently —
   e.g. `body.game-intro .player { ... }`.
   ───────────────────────────────────────────────────────────────── */
let state;
const STATE_BODY_CLASSES = ['game-intro', 'game-playing', 'game-paused', 'game-over'];

function setGameState(next) {
  state = next;
  document.body.classList.remove(...STATE_BODY_CLASSES);
  document.body.classList.add('game-' + next);
  /* Name tag is only ever drawn by renderNameTag() during update()
     (i.e. while 'playing'); explicitly hide it on every other
     transition so it doesn't linger on screen from the last frame
     before, say, a collision paused updates. */
  if (next !== 'playing') nameTagEl.hidden = true;
}

setGameState('intro');   /* boot into the intro screen */

/* Dynamic entity lists */
let obstacles = [], pickups = [];

/* Player physics: position (px, py), velocity (vy) */
let px = 0, py = 0, vy = 0;

/* Jump state: jumping flag, jump count (0-2), running frame counter */
let jumping = false, jumps = 0, runF = 0;

/* Game progression: score, best score, lives remaining */
let score = 0, best = 0, lives = 3;

/* Timing & speed: frame counter, current game speed, spawn timer, invincibility timer */
let frame = 0, speed = 5, spawnT = 0, invinc = 0;

/* Ground scrolling (used for parallax effect) */
let groundX = 0;

function pad(n) { return String(Math.floor(n)).padStart(5, '0'); }

/* Device-independent speed: fraction of screen width per frame.
   CONFIG.GAME_SPEED is YOUR knob — same feel on every screen size. */
function currentSpeed() {
  return (CONFIG.GAME_SPEED + score * CONFIG.SPEED_RAMP) * (W / 1000);
}

/* ─────────────────────────────────────────────────────────────────
   Reset player to starting state
   Called at game start and on game over.
   ───────────────────────────────────────────────────────────────── */
function resetPlayer() {
  px = W * 0.18;
  py = GY - PSIZE;
  vy = 0; jumping = false; jumps = 0; runF = 0; landingTimer = 0;
  renderSprite();  /* draw the first running frame immediately */
}

/* ─────────────────────────────────────────────────────────────────
   START / RESTART
   Called from: the intro tap/spacebar (fresh start), the "🔄 Play
   Again" button (game-over), and the "🔄 Restart" button (pause
   panel). Resets the pause panel too — restarting FROM the pause
   panel needs to close it and put the pause button back, since
   normally that only happens via togglePause().
   ───────────────────────────────────────────────────────────────── */
function init() {
  obstacles.forEach(o => o.el.remove());
  pickups.forEach(p => p.el.remove());
  obstacles = []; pickups = [];
  score = 0; lives = 3; frame = 0; spawnT = 60; invinc = 0;
  playerEl.classList.remove('player--blink');
  resetPlayer();
  setGameState('playing');
  $('introOverlay').hidden = true;
  $('overOverlay').hidden = true;
  $('parade').hidden = true;
  $('pausePanel').hidden = true;      /* in case restart was triggered from pause */
  $('pauseBtn').textContent = '⏸';
  world.classList.remove('zoom-in', 'zoom-mid');
  sGo();
}

/* ─────────────────────────────────────────────────────────────────
   JUMP HANDLER — fires on any tap/click or Space/ArrowUp press.

   RESTART (game-over) and RESUME (paused) are deliberately BUTTON-ONLY
   — see the "🔄 Play Again" / "🔄 Restart" / "▶ Resume" buttons — so a
   stray tap or an accidental space press can never wipe a run the
   player wanted to keep looking at, or silently unpause. Only
   starting a brand-new run from the INTRO screen still works via a
   plain tap/space, matching the on-screen CTA there — but ONLY once
   the first-visit scoreboard consent card (if any) has been resolved;
   see consentPending in the SCOREBOARD section above.
   ───────────────────────────────────────────────────────────────── */
function jump() {
  if (consentPending) return;       /* consent card is up — buttons only, see openConsentOverlay() */
  if (state === 'paused') return;   /* resume is button-only — see resumeBtn */
  if (state === 'over') return;     /* restart is button-only — see restartOverBtn */
  if (state === 'intro') { init(); return; }   /* tap/space to start a fresh run */

  if (jumps < 2) {
    jumps++;
    vy = CONFIG.JUMP_V;
    jumping = true;
    landingTimer = 0;   /* cancel any pending landing-crouch beat */

    /* Play jump SFX and particle effects */
    if (jumps === 1) {
      sJump();
      burstFX(px + PSIZE / 2, GY, '#ff8a65');  /* orange ground burst */
    } else {
      sJump2();
      burstFX(px + PSIZE / 2, py + PSIZE, '#4fc3f7');  /* blue mid-air burst */
    }
  }
}

/* ---------- FX ---------- */
function burstFX(x, y, color) {
  for (let i = 0; i < 7; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.background = color;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.setProperty('--px', (Math.random() * 80 - 40) + 'px');
    p.style.setProperty('--py', (-34 - Math.random() * 56) + 'px');
    entities.appendChild(p);
    p.addEventListener('animationend', () => p.remove());
  }
}
function popupFX(x, y, text, color) {
  const el = document.createElement('div');
  el.className = 'popup';
  el.textContent = text;
  el.style.color = color;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  entities.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ============================================================
   ENTITY SPAWNERS
   ============================================================
   Creates obstacles and pickups that scroll toward the player.
   ============================================================ */

/* Spawn a random obstacle from OBSTACLE_TYPES catalog */
function spawnObstacle() {
  const t = OBSTACLE_TYPES[(Math.random() * OBSTACLE_TYPES.length) | 0];
  const el = document.createElement('div');
  el.className = 'obstacle ' + t.cls;
  el.textContent = t.e;
  entities.appendChild(el);
  const size = el.offsetWidth;
  obstacles.push({
    el, size, fly: t.fly,
    x: W + 80,
    y: t.fly ? GY - 130 - Math.random() * 55 : GY - size,
    wob: Math.random() * Math.PI * 2  /* wave offset for bobbing */
  });
}

/* Spawn a pickup (star ⭐ or gem 💎) */
function spawnPickup(gem) {
  const el = document.createElement('div');
  el.className = gem ? 'pickup pickup--gem' : 'pickup';
  el.textContent = gem ? '💎' : '⭐';
  entities.appendChild(el);
  const size = el.offsetWidth;
  pickups.push({
    el, size, gem,
    x: W + 50,
    y: gem ? GY - 300 - Math.random() * 70 : GY - 80 - Math.random() * 100,
    wob: 0
  });
}
/* NOTE: Stars (⭐) are reachable with a single jump.
         Gems (💎) float high and require a double jump. */

/* ============================================================
   MAIN GAME LOOP UPDATE
   ============================================================
   Called every frame (60 FPS) when game is playing.
   Handles: physics, collisions, spawning, scoring, rendering.
   ============================================================ */
function update() {
  frame++;
  speed = currentSpeed();

  /* Invincibility countdown: blink out when it expires */
  if (invinc > 0) {
    invinc--;
    if (invinc === 0) playerEl.classList.remove('player--blink');
  }

  groundX += speed;
  sidewalkEl.style.backgroundPosition = (-groundX) + 'px 0, 0 0';
  cityX = (cityX + speed * 0.45) % stripW;
  cityStrip.style.transform = 'translate3d(' + (-cityX) + 'px,0,0)';

  /* ─────────────────────────────────────────────────────────────
     PHYSICS: Apply gravity and update position
     ───────────────────────────────────────────────────────────── */
  vy += CONFIG.GRAVITY;
  py += vy;

  /* ─────────────────────────────────────────────────────────────
     LANDING DETECTION: When player reaches ground level
     ───────────────────────────────────────────────────────────── */
  const groundTop = GY - PSIZE;
  if (py >= groundTop) {
    py = groundTop; vy = 0;
    if (jumping) {
      jumping = false;
      jumps = 0;
      landingTimer = CONFIG.LANDING_FRAMES;  /* brief landing-crouch beat */
    }
  }

  /* Running frame counter (used for bob animation when grounded) */
  if (!jumping) runF++;

  renderSprite();  /* pick + draw this tick's sprite frame (see engine above) */

  if (frame % 130 === 0 && npcs.length < 6) spawnNPC();
  npcs = npcs.filter(n => {
    n.x += n.dir * n.sp - speed * 0.3;
    if (n.x < -80 || n.x > W + 80) { n.el.remove(); return false; }
    renderNPC(n, frame);
    return true;
  });

  spawnT++;
  const rate = Math.max(48, 105 - score * 0.1);
  if (spawnT >= rate) { spawnObstacle(); spawnT = 0; }
  if (frame % 100 === 0) spawnPickup(frame % 300 === 0);  /* every 3rd is a gem */

  /* ─────────────────────────────────────────────────────────────
     PLAYER COLLISION RADIUS
     Used for all circular collision detection against obstacles/pickups
     ───────────────────────────────────────────────────────────────── */
  const pcx = px + PSIZE / 2, pcy = py + PSIZE * 0.55, pr = PSIZE * 0.3;

  /* ─────────────────────────────────────────────────────────────
     OBSTACLE COLLISION DETECTION
     Check each obstacle against player. Remove on screen exit.
     On collision: lose life, trigger invincibility, play SFX/FX.
     ───────────────────────────────────────────────────────────────── */
  obstacles = obstacles.filter(o => {
    o.x -= speed;  /* scroll toward player */
    o.wob += o.fly ? 0.1 : 0.07;  /* wave animation offset */

    /* Remove off-screen */
    if (o.x < -110) { o.el.remove(); return false; }

    /* Apply bobbing motion (more for flying obstacles) */
    const bob = Math.sin(o.wob) * (o.fly ? 8 : 3);
    o.el.style.transform = 'translate3d(' + o.x + 'px,' + (o.y + bob) + 'px,0)';

    /* Collision check (only if not invincible) */
    if (invinc === 0) {
      const ocx = o.x + o.size / 2, ocy = o.y + o.size / 2;
      const rr = pr + o.size * 0.34;  /* collision radius */
      const dx = ocx - pcx, dy = ocy - pcy;

      /* Circle-to-circle collision */
      if (dx * dx + dy * dy < rr * rr) {
        lives--;
        invinc = 90;  /* 90 frames of invincibility (1.5 seconds @ 60fps) */
        playerEl.classList.add('player--blink');
        sHit();
        burstFX(pcx, pcy, '#e53935');  /* red burst */
        popupFX(pcx - 24, py - 34, 'OUCH!', '#c62828');
        o.el.remove();
        if (lives <= 0) gameOver();
        return false;
      }
    }
    return true;
  });

  /* ─────────────────────────────────────────────────────────────
     PICKUP COLLECTION
     Stars (⭐) = +15pts, Gems (💎) = +40pts.
     Gems float higher and require double jump strategy.
     ───────────────────────────────────────────────────────────────── */
  pickups = pickups.filter(s => {
    s.x -= speed * 0.85;  /* slightly slower scroll (more generous) */
    s.wob += 0.09;  /* bobbing animation */

    /* Remove off-screen */
    if (s.x < -70) { s.el.remove(); return false; }

    /* Apply bobbing vertical motion */
    s.el.style.transform =
      'translate3d(' + s.x + 'px,' + (s.y + Math.sin(s.wob) * 5) + 'px,0)';

    /* Collision check */
    const scx = s.x + s.size / 2, scy = s.y + s.size / 2;
    const rr = pr + s.size * 0.5;
    const dx = scx - pcx, dy = scy - pcy;

    if (dx * dx + dy * dy < rr * rr) {
      /* Award points based on pickup type */
      score += s.gem ? 40 : 15;
      sCoin();
      burstFX(scx, scy, s.gem ? '#4fc3f7' : '#ffb300');
      popupFX(scx - 16, scy - 24, s.gem ? '+40' : '+15',
              s.gem ? '#0277bd' : '#ef6c00');
      s.el.remove();
      return false;
    }
    return true;
  });

  /* Score increases passively while playing (1 point per 15 frames) */
  if (frame % 15 === 0) score++;

  /* ─────────────────────────────────────────────────────────────
     RENDER PLAYER
     Position sprite and shadow. Apply running bob when grounded.
     ───────────────────────────────────────────────────────────────── */
  const bob = jumping ? 0 : Math.sin(runF * 0.3) * 3;  /* running bounce */
  playerEl.style.transform =
    'translate3d(' + px + 'px,' + playerVisualY(py + bob) + 'px,0)';
  shadowEl.style.transform =
    'translate3d(' + (px + PSIZE * 0.19) + 'px,' + (GY + 4) + 'px,0)';
  renderNameTag(bob);  /* scoreboard opt-in name label — only visible while playing, bobs with the character */

  /* Update HUD (score, best, lives) */
  $('hudScore').textContent = 'SCORE ' + pad(score);
  $('hudBest').textContent = 'BEST ' + pad(best);
  $('hudLives').textContent =
    '❤️'.repeat(Math.max(0, lives)) + '🤍'.repeat(Math.max(0, 3 - lives));
}

/* ─────────────────────────────────────────────────────────────────
   GAME OVER HANDLER
   Displays final score, best score, character portrait, and — if the
   player is opted into the scoreboard — records this run and shows
   the updated 5-most-recent table.
   ───────────────────────────────────────────────────────────────── */
function gameOver() {
  best = Math.max(best, score);
  setGameState('over');
  world.classList.add('zoom-mid');

  /* Display character portrait: custom PNG or sprite sheet emoji */
  const c = $('overChar');
  if (usingCustom && customPNG) {
    c.innerHTML = '';
    const img = document.createElement('img');
    img.src = customPNG;
    c.appendChild(img);
  } else {
    /* Display emoji representation of the sprite character */
    c.textContent = CHARACTERS[charIndex].emoji;
  }

  $('overScore').textContent = pad(score);
  $('overBest').textContent = pad(best);

  /* Scoreboard: only ADD an entry if opted in, but always re-render —
     history from past opted-in runs (this player's or a previous
     player's on this browser) should keep showing even if the
     CURRENT player is opted out. */
  if (consent === 'in') {
    pushScoreEntry(playerName, score);
    renderScoreboard(0);   /* the entry we just unshifted is always at index 0 */
  } else {
    renderScoreboard(-1);  /* no new entry — nothing to highlight */
  }

  $('overOverlay').hidden = false;
  sOver();
}

/* ─────────────────────────────────────────────────────────────────
   Idle render — runs on the intro screen and the game-over screen ONLY.
   Keeps the hero's run cycle playing softly (with a gentle bob) so
   the character never looks frozen between rounds. loop() below never
   calls this while paused, so there's no separate paused-guard needed
   in here — see loop()'s comment for why the freeze lives there.
   ───────────────────────────────────────────────────────────────── */
function idleRender() {
  frame++;
  runF++;
  renderSprite();  /* keep the idle run-cycle animating at RUN_FPS */

  const bob = Math.sin(frame * 0.06) * 2.5;
  playerEl.style.transform =
    'translate3d(' + px + 'px,' + playerVisualY(py + bob) + 'px,0)';
  shadowEl.style.transform =
    'translate3d(' + (px + PSIZE * 0.19) + 'px,' + (GY + 4) + 'px,0)';

  if (state === 'intro') {
    npcs.forEach(n => {
      n.x += n.dir * n.sp;
      if (n.x < -80) n.x = W + 60;
      if (n.x > W + 80) n.x = -60;
      renderNPC(n, frame);
    });
  }
}

/* ─────────────────────────────────────────────────────────────────
   MAIN LOOP — the single requestAnimationFrame driver for the whole
   game. `state` decides which (if any) render function runs:
     'playing'          → update()      (full physics + world sim)
     'intro' / 'over'   → idleRender()  (soft idle animation)
     'paused'           → NOTHING — this is the freeze.
   Pausing is handled HERE, at the very top of the dispatch, rather
   than as a guard buried inside a render function — so it's
   immediately obvious, reading this one function, that literally
   nothing on screen (sprite, world, HUD) is touched while paused.
   ───────────────────────────────────────────────────────────────── */
function loop() {
  if (state === 'playing') update();
  else if (state !== 'paused') idleRender();
  requestAnimationFrame(loop);
}

/* ============================================================
   SETTINGS — pause, mute, theme, scenery
   All visuals are CSS classes; JS only toggles them.
   ============================================================ */
/* Body class (game-paused / game-playing) is handled automatically by
   setGameState() — see the STATE MACHINE block near the top of the
   file. This function only needs to worry about the pause PANEL and
   button; the CSS hook and the sprite/world freeze in idleRender()
   both key off `state` directly, so they can never drift out of sync
   with what's on screen. */
function togglePause() {
  if (state === 'playing') {
    setGameState('paused');
    $('pausePanel').hidden = false;
    $('pauseBtn').textContent = '▶';
  } else if (state === 'paused') {
    setGameState('playing');
    $('pausePanel').hidden = true;
    $('pauseBtn').textContent = '⏸';
  }
}

/* Day / night: swap .theme-night on #game — CSS does the rest */
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    gameEl.classList.toggle('theme-night', btn.dataset.theme === 'night');
    document.querySelectorAll('.theme-btn').forEach(b =>
      b.classList.toggle('p-btn--active', b === btn));
  });
});

/* Scenery: swap .scene-* on #game — palettes handled by CSS variables */
document.querySelectorAll('.scene-btn').forEach(btn => {
  btn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    gameEl.classList.remove('scene-desert', 'scene-snow');
    if (btn.dataset.scene !== 'city') gameEl.classList.add('scene-' + btn.dataset.scene);
    document.querySelectorAll('.scene-btn').forEach(b =>
      b.classList.toggle('p-btn--active', b === btn));
  });
});

/* ─────────────────────────────────────────────────────────────────
   CHARACTER PICKERS
   Renders sprite sheet character buttons on both intro & pause screens.
   Shows an emoji representation and the character name.
   ───────────────────────────────────────────────────────────────── */
function buildCharPickers() {
  ['introCharRow', 'pauseCharRow'].forEach(rowId => {
    const row = $(rowId);
    row.innerHTML = '';

    /* Sprite sheet characters: display emoji + highlight active character */
    CHARACTERS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'char-btn' +
        (!usingCustom && i === charIndex ? ' char-btn--active' : '');
      b.textContent = c.emoji;  /* use emoji as visual representation */
      b.title = c.name;
      b.addEventListener('pointerdown', e => {
        e.stopPropagation();
        usingCustom = false;
        charIndex = i;
        applyCharacter();
      });
      row.appendChild(b);
    });

    /* Custom PNG character slot: only appears after user uploads an image */
    if (customPNG) {
      const b = document.createElement('button');
      b.className = 'char-btn' + (usingCustom ? ' char-btn--active' : '');
      b.title = 'Your character';
      const img = document.createElement('img');
      img.src = customPNG;
      b.appendChild(img);
      b.addEventListener('pointerdown', e => {
        e.stopPropagation();
        usingCustom = true;
        applyCharacter();
      });
      row.appendChild(b);
    }
  });
}

/* ─────────────────────────────────────────────────────────────────
   CUSTOM PNG UPLOAD HANDLER
   Allows players to upload custom character images (up to 10 MB).
   Validates file type and size before processing.
   ───────────────────────────────────────────────────────────────── */
$('uploadBtn').addEventListener('pointerdown', e => {
  e.stopPropagation();
  $('pngInput').click();
});

$('pngInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  /* Validate file type: must be PNG */
  if (file.type !== 'image/png') {
    alert('Please choose a PNG image.');
    e.target.value = '';
    return;
  }

  /* Validate file size: must be under 10 MB */
  if (file.size > CONFIG.MAX_PNG_BYTES) {
    alert('That PNG is too big — the limit is 10 MB.');
    e.target.value = '';
    return;
  }

  /* Convert file to data URL and apply as character */
  const reader = new FileReader();
  reader.onload = ev => {
    customPNG = ev.target.result;  /* store data URL */
    usingCustom = true;
    applyCharacter();
  };
  reader.readAsDataURL(file);
});

/* ---------- Panel wiring ---------- */
$('pauseBtn').addEventListener('pointerdown', e => { e.stopPropagation(); togglePause(); });
$('resumeBtn').addEventListener('pointerdown', e => { e.stopPropagation(); togglePause(); });
$('muteBtn').addEventListener('pointerdown', e => {
  e.stopPropagation();
  muted = !muted;
  $('muteBtn').textContent = muted ? '🔇 Sound off' : '🔊 Sound on';
});
$('pausePanel').addEventListener('pointerdown', e => e.stopPropagation());

/* Restart — the ONLY way to restart from pause or game-over (see
   jump()'s comment above for why tap/space no longer do this).
   Both buttons just call init() directly; init() itself takes care
   of closing the pause panel if that's where the request came from. */
$('restartBtn').addEventListener('pointerdown', e => { e.stopPropagation(); init(); });
$('restartOverBtn').addEventListener('pointerdown', e => { e.stopPropagation(); init(); });

/* ---------- Scoreboard consent card wiring ---------- */
$('consentAcceptBtn').addEventListener('pointerdown', e => {
  e.stopPropagation();
  const name = $('consentNameInput').value.trim().slice(0, SCOREBOARD.MAX_NAME_LEN);
  if (!name) { alert('Please enter a name to join the scoreboard.'); return; }
  saveConsent('in', name);
  closeConsentOverlay();
});
$('consentDeclineBtn').addEventListener('pointerdown', e => {
  e.stopPropagation();
  saveConsent('out', '');   /* still written, so we never ask again unrequested */
  closeConsentOverlay();
});
$('consentNameInput').addEventListener('pointerdown', e => e.stopPropagation());
/* Note: no listener on #consentOverlay itself — like every other
   .overlay, its own background has pointer-events:none (see game.css
   §13), so clicks there already pass through harmlessly rather than
   ever reaching this element; only the .interactive children above
   need stopPropagation. */

/* Reopens the consent card from the pause panel to change opt-in
   status or fix a name — see openConsentOverlay()'s fromPause branch. */
$('scoreboardSettingsBtn').addEventListener('pointerdown', e => {
  e.stopPropagation();
  openConsentOverlay(true);
});

/* ---------- Intro cast parade ---------- */
function buildParade() {
  const cast = ['🦆', '🌮', '🛒', '🧀', '🍕', '🐟', '⭐'];
  const parade = $('parade');
  cast.forEach((e, i) => {
    const s = document.createElement('span');
    s.textContent = e;
    s.style.position = 'absolute';
    s.style.fontSize = '34px';
    s.style.animation = 'parade ' + (9 + i * 1.3) + 's linear infinite';
    s.style.animationDelay = (-i * 2.2) + 's';
    parade.appendChild(s);
  });
  const style = document.createElement('style');
  style.textContent =
    '@keyframes parade { from { transform: translateX(-40px); }' +
    ' to { transform: translateX(110vw); } }';
  document.head.appendChild(style);
}

/* ============================================================
   INPUT HANDLERS
   ============================================================
   Keyboard: Space/ArrowUp to jump (or start a run from intro),
   Escape/P to PAUSE only — resuming is button-only (▶ Resume), same
   as restart, so a stray Escape/P press while reading the pause
   panel can't silently unpause the game underneath it.
   Touch/Mouse: any tap/click to jump (or start a run from intro).

   Typing into the scoreboard name field is exempted entirely — a
   player typing a space in their name shouldn't trigger a jump.
   ============================================================ */
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;   /* let normal typing happen, e.g. #consentNameInput */

  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault();
    jump();
  }
  if ((e.code === 'Escape' || e.code === 'KeyP') && state === 'playing') {
    togglePause();   /* opens the pause panel — closing it is button-only */
  }
});

gameEl.addEventListener('pointerdown', e => {
  e.preventDefault();
  jump();
});

/* ============================================================
   GAME INITIALIZATION & BOOT
   ============================================================
   Called once on page load to set up the game world.
   ============================================================ */
measure();                          /* calculate viewport metrics */
buildCity();                        /* generate procedural buildings */
buildParade();                      /* create intro parade animation */
applyCharacter();                   /* apply sprite classes + build pickers for the default hero */
resetPlayer();                      /* position player at start + draw first frame */
for (let i = 0; i < 3; i++) spawnNPC(Math.random() * W);  /* spawn intro NPCs */
world.classList.add('zoom-in');     /* zoom in on hero for intro */

/* Scoreboard: decide whether this is a first-ever visit (no consent
   cookie yet — show the consent card and block play until it's
   resolved) or a returning one (skip straight to the normal intro
   card). Either way the pause panel's "🏆" row needs to reflect the
   loaded state from the very first frame. */
loadScoreboardState();
updateScoreboardSettingsBtn();
if (consent === null) {
  openConsentOverlay(false);        /* mandatory first-visit prompt */
} else {
  $('introOverlay').hidden = false; /* returning visitor — straight to intro */
}

loop();                             /* start main game loop (60 FPS) */