// Original interactive hand + face smoke demo.
// MediaPipe Tasks Vision (Apache 2.0, Google) via CDN.
// All game logic + artwork below is original — not copied from Hookah Baar.

// NOTE: no static import — vision code loads lazily with CDN fallback
// (jsdelivr -> unpkg) inside initTracking, so one blocked CDN isn't fatal.
let FilesetResolver = null, HandLandmarker = null, FaceLandmarker = null;
let activeWasmUrl = "";

const video = document.getElementById("cam");
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: false });
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");

// --- mobile perf mode: phones can't do 1280p ML + 1200 gradients at 60fps ---
const IS_MOBILE =
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") ||
  Math.min(screen.width || 999, screen.height || 999) < 500 ||
  (navigator.hardwareConcurrency || 8) <= 4;
const PERF = {
  mobile: IS_MOBILE,
  maxParticles: IS_MOBILE ? 320 : 1200,
  detectInterval: IS_MOBILE ? 110 : 0, // ms between ML passes (0 = every frame)
  alternateML: IS_MOBILE,              // hand one tick, face next tick
  particleMult: IS_MOBILE ? 0.4 : 1,   // spawn fewer puffs
  ringLumpDiv: IS_MOBILE ? 2.4 : 1,    // fewer ring lumps
  shadows: !IS_MOBILE,                 // shadowBlur is brutal on mobile GPUs
};
// Pre-rendered smoke sprites: one gradient baked ONCE, then drawImage per
// particle. Creating 300+ radial gradients per frame was the main mobile killer.
function makePuffSprite(kind) {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  if (kind === "halo") {
    grad.addColorStop(0, "rgba(225,225,220,0)");
    grad.addColorStop(0.55, "rgba(225,225,220,0.55)");
    grad.addColorStop(1, "rgba(225,225,220,0)");
  } else {
    grad.addColorStop(0, "rgba(230,230,225,0.9)");
    grad.addColorStop(0.35, "rgba(230,230,225,0.45)");
    grad.addColorStop(1, "rgba(230,230,225,0)");
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}
const blobSprite = makePuffSprite("blob");
const haloSprite = makePuffSprite("halo");
// adaptive: if frames stay slow, shed more particles automatically
let avgFrameMs = 16, slowFrames = 0;

const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const VISION_CDNS = [
  {
    js: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs",
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm",
  },
  {
    js: "https://unpkg.com/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs",
    wasm: "https://unpkg.com/@mediapipe/tasks-vision@0.10.21/wasm",
  },
];

async function loadVisionCode(onProgress) {
  if (FilesetResolver) return;
  let lastErr = null;
  for (const cdn of VISION_CDNS) {
    try {
      onProgress?.("loading vision code… (joke buffering)");
      const m = await import(/* @vite-ignore */cdn.js);
      FilesetResolver = m.FilesetResolver;
      HandLandmarker = m.HandLandmarker;
      FaceLandmarker = m.FaceLandmarker;
      activeWasmUrl = cdn.wasm;
      return;
    } catch (e) { lastErr = e; console.warn("CDN failed (joke blocked?):", cdn.js, e); }
  }
  throw new Error("Vision CDN unreachable — tried jsdelivr + unpkg. Need internet. " + (lastErr?.message || lastErr));
}

let hands = null;
let face = null;
let running = false;
let lastVideoTime = -1;

const state = {
  // hand
  fistPos: null,      // smoothed, mirrored 0..1
  rawFist: null,
  isFist: false,
  pickedUp: false,    // latched after fist on pipe
  // face
  mouthPos: null,
  mouthOpen: 0,       // 0 closed .. 1 wide
  mouthPucker: 0,     // 0..1 O-shape
  cheekPuff: 0,
  facePresent: false,
  // smoke
  nearMouth: false,
  inhaling: false,    // camera-driven
  charge: 0,
  particles: [],
  rings: [],
  lastBlowAt: 0,
  nearMouthSince: 0,
  // long exhale: streams smoke while the mouth stays open (joke)
  exhaling: false,
  exhaleBig: false,
  exhaleStart: 0,
  mouthClosedSince: 0,
  // sticky holding (joke glue): don't drop the pipe on brief tracking flicker
  fistLostSince: 0,
  openSince: 0,
  // hookah life — built-in default hookah (joke): coals glow, water gurgles
  coalHeat: 0,        // 0..1 smoothed glow (joke fire)
  bubbles: [],        // water bubbles in base (joke gurgle)
  embers: [],         // sparks above coals (joke sparks)
};

// Built-in default hookah (joke) — drawn with canvas, no photo needed.
const PIPE_HOME = { x: 0.78, y: 0.62, r: 0.09 };
const PICK_RADIUS = 0.23; // big forgiving grab ring (joke) — works from farther back
const NEAR_MOUTH = 0.27;   // generous: just bringing the pipe toward the mouth counts (joke)
const AWAY_MOUTH = 0.33;   // hysteresis so it doesn't flicker
const MAX_CHARGE = 150;    // bigger inhale tank (joke lungs)
// ring shape (joke): a decent O does it — friendly thresholds on purpose.
const RING_PUCKER = 0.45, RING_OPEN_MIN = 0.12, RING_OPEN_MAX = 0.68;
function isRingShape() {
  return state.mouthPucker > RING_PUCKER &&
    state.mouthOpen > RING_OPEN_MIN && state.mouthOpen < RING_OPEN_MAX;
}

function say(m) { statusEl.textContent = m; }
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function isFist(lm, wasFist) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wrist = lm[0];
  const tips = [8, 12, 16, 20].map(i => lm[i]);
  const pips = [6, 10, 14, 18].map(i => lm[i]);
  const tipD = tips.reduce((s, p) => s + d(p, wrist), 0) / 4;
  const pipD = pips.reduce((s, p) => s + d(p, wrist), 0) / 4;
  const ratio = tipD / (pipD || 1e-6);
  // hysteresis: easy to latch a fist, hard to lose it (joke grip vs flicker)
  return wasFist ? ratio < 0.95 : ratio < 0.85;
}

function getBlend(cats, name) {
  if (!cats) return 0;
  for (const c of cats) if (c.categoryName === name) return c.score;
  return 0;
}

// geometric mouth fallback from landmarks 13,14,78,308
function mouthFromGeometry(lm) {
  try {
    const up = lm[13], low = lm[14], left = lm[78], right = lm[308];
    const openDist = Math.hypot(up.x - low.x, up.y - low.y);
    const widthDist = Math.hypot(left.x - right.x, left.y - right.y) || 1e-6;
    const ratio = openDist / widthDist; // ~0.1 closed, ~0.8 wide
    const open = clamp01((ratio - 0.15) / 0.55);
    const mx = (up.x + low.x + left.x + right.x) / 4;
    const my = (up.y + low.y + left.y + right.y) / 4;
    // narrow width + medium open ~= O shape
    const faceW = Math.hypot(lm[33].x - lm[263].x, lm[33].y - lm[263].y) || 1e-6;
    const narrow = clamp01(1 - (widthDist / faceW) * 2.2); // 1 = very pursed
    const pucker = clamp01(narrow * 0.7 + (ratio > 0.25 && ratio < 0.7 ? 0.4 : 0));
    return { open, pucker, x: 1 - mx, y: my };
  } catch { return null; }
}

async function initTracking(onProgress) {
  await loadVisionCode(onProgress);
  const vision = await FilesetResolver.forVisionTasks(activeWasmUrl);
  onProgress?.("loading hands…");
  const hP = HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: HAND_MODEL },
    runningMode: "VIDEO", numHands: 1,
    // lowered so small/far hands still track (joke sees you back there)
    minHandDetectionConfidence: 0.3, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
  });
  onProgress?.("loading face…");
  const fP = FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: FACE_MODEL },
    runningMode: "VIDEO", numFaces: 1,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
  });
  [hands, face] = await Promise.all([hP, fP]);
}

async function startCamera() {
  // mobile: 640x480 is plenty for hand/face at arm's length, ~3x cheaper to decode + infer
  const idealW = PERF.mobile ? 640 : 1280, idealH = PERF.mobile ? 480 : 720;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: idealW }, height: { ideal: idealH }, facingMode: "user" }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
  resize();
}

function resize() {
  const r = video.getBoundingClientRect();
  let w = Math.max(320, Math.floor(r.width || 640));
  let h = Math.max(240, Math.floor(r.height || 480));
  // cap backing store on phones: CSS is ~350px wide anyway, never need >640
  if (PERF.mobile && w > 640) { h = Math.floor(h * 640 / w); w = 640; }
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
window.addEventListener("resize", resize);

// --- keyboard fallback (kept for testing) ---
let spaceHeld = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") { spaceHeld = true; e.preventDefault(); }
  if (e.code === "KeyR") blowRing(state.mouthPos?.x ?? 0.35, state.mouthPos?.y ?? 0.38);
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spaceHeld = false;
    if (state.inhaling && state.charge > 5 && !state.facePresent) startExhale(false);
    if (!state.facePresent) state.inhaling = false;
  }
});

// Long exhale (joke): one trigger starts a stream — smoke keeps pouring out
// for as long as the mouth stays open, charge drains gradually (~3s for full).
function startExhale(big) {
  const now = performance.now();
  if (!state.exhaling) {
    state.exhaling = true;
    state.exhaleStart = now;
    state.mouthClosedSince = 0;
  }
  state.exhaleBig = state.exhaleBig || big; // big sticks for this whole exhale
  state.lastBlowAt = now;
  // instant starter puff so smoke shows on the very first frame (joke jump-start)
  const mp0 = state.mouthPos;
  const ox0 = mp0?.x ?? 0.35, oy0 = mp0?.y ?? 0.4;
  const juice0 = state.charge / MAX_CHARGE;
  const starterN = Math.round(30 * PERF.particleMult) || 8;
  for (let i = 0; i < starterN; i++) spawnPuff(ox0, oy0, state.exhaleBig, juice0, 1, 0.1, 0.3);
  if (state.particles.length > PERF.maxParticles) state.particles.splice(0, state.particles.length - PERF.maxParticles);
}

// one smoke puff (joke): textured kinds + shading so the cloud has pattern,
// not plain blobs. juice = how deep the inhale was (0..1).
function spawnPuff(ox, oy, big, juice, open, spread, alpha = 0.26) {
  // explosive bloom at high charge (joke): puffs launch outward in all
  // directions so a full tank becomes a big spreading cloud, not one hot pile
  const boom = 0.5 + juice * 2.2;
  const ang = Math.random() * Math.PI * 2;
  const rad = Math.random() * 0.004 * boom;
  state.particles.push({
    x: ox + (Math.random() - 0.5) * spread,
    y: oy + (Math.random() - 0.5) * spread,
    vx: (-0.0035 - Math.random() * (big ? 0.007 : 0.005)) * (0.6 + open * 0.6) + Math.cos(ang) * rad - 0.001 * juice,
    vy: -0.0012 - Math.random() * 0.004 - open * 0.0015 + Math.sin(ang) * rad * 0.7,
    r: (big ? 6 : 4) + Math.random() * 12 + juice * 12,
    a: alpha,
    wob: Math.random() * 6.28,
    life: 0,
    seed: Math.random() * 100,
    kind: Math.random() < 0.45 ? "halo" : "blob", // halo = wispy ring-textured puff
    tone: 0.55 + Math.random() * 0.15,            // gray smoke shading (joke): visible, not white-hot
  });
}

// called every frame from draw(): emits + ends the exhale stream
function emitExhaleTick(W, H, now) {
  if (!state.exhaling) return;
  const mp = state.mouthPos;
  const ox = mp?.x ?? 0.35, oy = mp?.y ?? 0.4;
  const open = state.facePresent ? state.mouthOpen : 1;

  if (state.facePresent) {
    if (open < 0.22) {
      if (!state.mouthClosedSince) state.mouthClosedSince = now;
      // mouth shut: smoke stops soon, exhale ends after a beat
      if (now - state.mouthClosedSince > 450) { state.exhaling = false; state.exhaleBig = false; return; }
      return; // brief pause, keep the exhale alive
    }
    state.mouthClosedSince = 0;
  }
  // out of juice (after a minimum puff) or safety cap: end
  if ((state.charge <= 0 && now - state.exhaleStart > 900) || now - state.exhaleStart > 6000) {
    state.exhaling = false; state.exhaleBig = false; return;
  }

  const big = state.exhaleBig;
  // smoke according to inhaling (joke): near-full tank = dramatically thicker stream
  const juice = state.charge / MAX_CHARGE; // 1 = deep inhale, 0 = nearly empty
  const n = Math.max(2, Math.round((big ? 8 : 6) * (0.5 + open) * (0.4 + juice * 1.4) * PERF.particleMult));
  const spread = (0.09 + (1 - open) * 0.04) * (0.7 + juice * 0.9); // full tank = born as a wide cloud (joke)
  for (let i = 0; i < n; i++) spawnPuff(ox, oy, big, juice, open, spread);
  if (state.particles.length > PERF.maxParticles) state.particles.splice(0, state.particles.length - PERF.maxParticles);
  state.charge = Math.max(0, state.charge - (big ? 2.8 : 2.2));
}

function blowRing(ox, oy) {
  if (state.charge < 8 && state.particles.length === 0) return;
  state.rings.push({ x: ox, y: oy, r: 12, vx: -0.0045, a: 0.9, seed: Math.random() * 100, wob: Math.random() * 6 });
  state.charge = Math.max(0, state.charge - 15);
  state.lastBlowAt = performance.now();
}

function updateInteraction(now) {
  const { fistPos, mouthPos, pickedUp, facePresent } = state;

  if (!fistPos) {
    // sticky hold: brief tracking flicker must not drop the pipe (joke glue)
    const keepHolding = state.pickedUp && state.fistLostSince && now - state.fistLostSince < 800;
    if (!keepHolding) { state.pickedUp = false; state.nearMouth = false; }
    state.inhaling = spaceHeld;
    // hand left the frame: if already inhaled, the mouth alone can exhale (joke)
    if (facePresent && mouthPos && state.charge > 12 && now - state.lastBlowAt > 500) {
      if (isRingShape()) blowRing(mouthPos.x, mouthPos.y);
      else if (state.mouthOpen > 0.55) startExhale(state.cheekPuff > 0.5);
    }
    return;
  }

  // 1. pick up: fist near the default hookah's base (joke)
  const home = PIPE_HOME;
  if (!pickedUp) {
    const dHome = dist2d(fistPos, home);
    // fist anywhere in the ring grabs; open palm dead-center grabs too
    // (far fists read noisy, so proximity gets the benefit of the doubt — joke)
    if ((state.isFist && dHome < PICK_RADIUS) || dHome < PICK_RADIUS * 0.55) state.pickedUp = true;
    state.nearMouth = false;
    state.inhaling = spaceHeld && state.pickedUp;
    return;
  }

  // 2. drop only on a SUSTAINED open hand far from everything (joke glue:
  //    a flickering fist misread must not drop the pipe)
  const farFromBoth = mouthPos && dist2d(fistPos, mouthPos) > 0.35 && dist2d(fistPos, home) > 0.38;
  if (!state.isFist && farFromBoth) {
    if (!state.openSince) state.openSince = now;
    state.inhaling = false;
    state.nearMouth = false;
    if (now - state.openSince > 500) {
      state.pickedUp = false;
      state.nearMouth = false;
      state.inhaling = false;
      state.openSince = 0;
    }
    return;
  }
  state.openSince = 0;

  // 3. near mouth?
  if (mouthPos) {
    const d = dist2d(fistPos, mouthPos);
    if (!state.nearMouth && d < NEAR_MOUTH) { state.nearMouth = true; state.nearMouthSince = now; }
    else if (state.nearMouth && d > AWAY_MOUTH) {
      // pulled away — if charged and mouth open, blow!
      const wasCharged = state.charge > 12;
      state.nearMouth = false;
      state.inhaling = false;
      if (wasCharged && facePresent) {
        if (now - state.lastBlowAt > 350) {
          if (isRingShape()) blowRing(mouthPos.x, mouthPos.y);
          else if (state.mouthOpen > 0.35) startExhale(state.cheekPuff > 0.5);
        }
      } else if (wasCharged && !facePresent && !spaceHeld) {
        startExhale(false);
      }
    }
  }

  // 4. inhaling while held at mouth
  if (state.nearMouth) {
    if (facePresent) {
      // mouth mostly closed around pipe = drawing in. Require dwell 300ms.
      const sucking = state.mouthOpen < 0.35 && now - state.nearMouthSince > 250;
      state.inhaling = sucking || spaceHeld;
      // mouth falls open AT the pipe = exhale RIGHT NOW, hand can stay (joke).
      // (this was the "hand near mouth, can't exhale" bug — fixed)
      if (mouthPos && state.charge > 12 && state.mouthOpen > 0.55 && now - state.lastBlowAt > 350) {
        if (isRingShape()) blowRing(mouthPos.x, mouthPos.y);
        else startExhale(state.cheekPuff > 0.5);
        state.nearMouth = false;
        state.inhaling = false;
      }
    } else {
      state.inhaling = spaceHeld;
    }
    if (state.inhaling) state.charge = Math.min(MAX_CHARGE, state.charge + 3.0);
  } else {
    // not at mouth: live blow if mouth opens wide with charge (even without pull-away event)
    if (facePresent && state.charge > 15 && state.mouthOpen > 0.5 && now - state.lastBlowAt > 500) {
      if (isRingShape()) blowRing(mouthPos.x, mouthPos.y);
      else startExhale(state.cheekPuff > 0.5);
    }
    if (!spaceHeld) state.inhaling = false;
    else if (state.pickedUp) { state.inhaling = true; state.charge = Math.min(MAX_CHARGE, state.charge + 3.0); }
  }
}

let lastDetectAt = 0, mlTurn = false;

async function loop(prevT) {
  if (!running) return;
  const now = performance.now();
  // adaptive perf: track frame cost, shed particles if sustained slow
  if (prevT) {
    const dt = now - prevT;
    avgFrameMs = avgFrameMs * 0.95 + Math.min(dt, 100) * 0.05;
    if (avgFrameMs > 34 && PERF.maxParticles > 150) {
      if (++slowFrames > 90) { slowFrames = 0; PERF.maxParticles = Math.max(150, Math.floor(PERF.maxParticles * 0.75)); }
    } else slowFrames = 0;
  }

  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    const timeForML = !PERF.detectInterval || now - lastDetectAt > PERF.detectInterval;
    if (timeForML) {
      lastDetectAt = now;
      mlTurn = !mlTurn;
      // mobile: alternate hand / face each pass = ~half the inference cost,
      // tracking smoothing hides the 1-tick staleness
      const doHands = !PERF.alternateML || !mlTurn;
      const doFace = !PERF.alternateML || mlTurn;
      // hands
      if (doHands) {
      try {
        const hr = hands.detectForVideo(video, now);
        const lm = hr?.landmarks?.[0];
        if (lm) {
          const c = lm[9];
          const raw = { x: 1 - c.x, y: c.y };
          state.rawFist = raw;
          state.fistPos = state.fistPos
            ? { x: lerp(state.fistPos.x, raw.x, 0.45), y: lerp(state.fistPos.y, raw.y, 0.45) }
            : raw;
          state.isFist = isFist(lm, state.isFist);
          state.fistLostSince = 0;
        } else {
          state.rawFist = null; state.fistPos = null; state.isFist = false;
          if (!state.fistLostSince) state.fistLostSince = now;
        }
      } catch {}
      }
      // face
      if (doFace) {
      try {
        const fr = face.detectForVideo(video, now);
        const flm = fr?.faceLandmarks?.[0];
        if (flm) {
          state.facePresent = true;
          const geo = mouthFromGeometry(flm);
          const cats = fr?.faceBlendshapes?.[0]?.categories;
          const bOpen = getBlend(cats, "mouthOpen");
          const bPucker = getBlend(cats, "mouthPucker") || getBlend(cats, "mouthFunnel");
          const bPuff = getBlend(cats, "cheekPuff");
          const gOpen = geo?.open ?? 0;
          // blendshapes if available, else geometry
          state.mouthOpen = cats ? clamp01(Math.max(bOpen, gOpen * 0.9)) : gOpen;
          state.mouthPucker = cats ? Math.max(bPucker, geo?.pucker ?? 0) : (geo?.pucker ?? 0);
          state.cheekPuff = bPuff || 0;
          if (geo) {
            state.mouthPos = state.mouthPos
              ? { x: lerp(state.mouthPos.x, geo.x, 0.5), y: lerp(state.mouthPos.y, geo.y, 0.5) }
              : { x: geo.x, y: geo.y };
          }
        } else { state.facePresent = false; state.mouthPos = null; state.mouthOpen = 0; state.mouthPucker = 0; }
      } catch {}
      }
    }
    lastVideoTime = video.currentTime;
  }

  // one bad frame must never freeze the loop (that looks like a dead button)
  try {
    updateInteraction(now);
    draw(now);
    updateStatus();
  } catch (err) {
    console.error(err);
    say("Render hiccup (not a joke): " + (err?.message || err));
  }
  requestAnimationFrame((t) => loop(now));
}

function drawPipe(W, H, now = performance.now()) {
  drawHookah(W, H, now);
}

function drawHookah(W, H, now) {
  const bx = PIPE_HOME.x * W, by = PIPE_HOME.y * H, br = PIPE_HOME.r * W;
  const s = br / 55; // scale factor (~1 at default size)
  const t = now / 1000;

  // joke coal heat (totally real fire, joke): smooth toward inhaling target
  const target = state.inhaling ? 1 : 0.18;
  state.coalHeat = lerp(state.coalHeat || 0, target, state.inhaling ? 0.12 : 0.04);
  const flick = 0.82 + 0.18 * Math.sin(t * 23) * Math.sin(t * 11.7 + 1.3) + (state.inhaling ? Math.random() * 0.12 : 0);
  const heat = Math.max(0, Math.min(1.2, state.coalHeat * flick));

  // geometry: default hookah (joke) sits on base point (bx,by), extends upward
  const baseW = br * 1.5, baseH = br * 1.35;
  const stemX = bx, stemTop = by - H * 0.42; // long pipe (joke, extra tall)
  const vaseTop = by - baseH * 0.55, vaseBot = by + baseH * 0.55;
  const bowlY = stemTop - 14 * s;

  // --- shadow (joke shadow, very realistic joke) ---
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath(); ctx.ellipse(bx, by + baseH * 0.62, baseW * 0.95, 10 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // --- default hookah body (joke): glass vase, gold stem, tray, bowl, coals ---
  drawHookahBody(W, H, now, { bx, by, br, s, baseW, baseH, stemX, stemTop, vaseTop, vaseBot, bowlY, heat });

  // --- water bubbles (joke gurgle while inhaling, like a totally real hookah joke) ---
  if (state.inhaling) {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      state.bubbles.push({
        x: bx + (Math.random() - 0.5) * baseW * 0.9,
        y: vaseBot - 6 - Math.random() * 8,
        r: (1.2 + Math.random() * 3.2) * s,
        vy: (0.6 + Math.random() * 1.6) * s,
        wob: Math.random() * 6.28,
      });
    }
    // ember sparks above the joke coals while inhaling
    if (Math.random() < (PERF.mobile ? 0.3 : 0.7)) {
      state.embers.push({
        x: bx + (Math.random() - 0.5) * 26 * s,
        y: bowlY - 14 * s,
        vx: (Math.random() - 0.5) * 0.5,
        vy: -(0.8 + Math.random() * 1.8),
        life: 1,
        r: (1 + Math.random() * 2.2) * s,
      });
    }
  }
  // idle tiny bubble now and then so the joke base looks alive
  if (!state.inhaling && Math.random() < 0.03) {
    state.bubbles.push({
      x: bx + (Math.random() - 0.5) * baseW * 0.7,
      y: vaseBot - 6, r: 1.4 * s, vy: 0.7 * s, wob: Math.random() * 6.28,
    });
  }

  // water surface line inside vase (recompute same as body)
  const waterY = vaseTop + (vaseBot - vaseTop) * 0.42;
  state.bubbles = state.bubbles.filter(b => b.y > waterY - 4 && b.r < 12);
  for (const b of state.bubbles) {
    b.wob += 0.15; b.y -= b.vy; b.x += Math.sin(b.wob) * 0.4;
    ctx.save();
    ctx.strokeStyle = "rgba(200,235,255,0.85)";
    ctx.fillStyle = "rgba(200,235,255,0.25)";
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath(); ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.32, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // --- embers / joke coal fire ---
  // mobile: cap ember count + skip shadowBlur (huge GPU cost)
  if (state.embers.length > (PERF.mobile ? 20 : 80)) state.embers.splice(0, state.embers.length - (PERF.mobile ? 20 : 80));
  state.embers = state.embers.filter(e => e.life > 0.05 && e.y > bowlY - 90 * s);
  for (const e of state.embers) {
    e.x += e.vx; e.y += e.vy; e.vy *= 0.985; e.life *= 0.96;
    ctx.save();
    ctx.globalAlpha = Math.max(0, e.life);
    ctx.fillStyle = e.life > 0.6 ? "#ffd23c" : "#ff5a1f";
    if (PERF.shadows) { ctx.shadowColor = "#ff3d00"; ctx.shadowBlur = 10; }
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r * e.life, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.restore();

  // --- hose: from vase side to hand when picked up (joke hose, very grabbable joke) ---
  if (state.pickedUp && state.fistPos) {
    const hx = state.fistPos.x * W, hy = state.fistPos.y * H;
    const px = bx - baseW * 0.55, py = vaseTop + 12 * s; // hose port
    ctx.save();
    ctx.lineCap = "round";
    // hose shadow / body
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 9 * s;
    ctx.beginPath(); ctx.moveTo(px, py + 2);
    ctx.bezierCurveTo((px + hx) / 2, (py + hy) / 2 + 60, (px + hx) / 2 + 20, (py + hy) / 2 + 30, hx, hy + 2);
    ctx.stroke();
    ctx.strokeStyle = state.inhaling ? "#8a4b1f" : "#5c3a22"; ctx.lineWidth = 6.5 * s;
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.bezierCurveTo((px + hx) / 2, (py + hy) / 2 + 60, (px + hx) / 2 + 20, (py + hy) / 2 + 30, hx, hy);
    ctx.stroke();
    // hose ribs
    ctx.strokeStyle = "rgba(255,200,140,0.25)"; ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 7]);
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.bezierCurveTo((px + hx) / 2, (py + hy) / 2 + 60, (px + hx) / 2 + 20, (py + hy) / 2 + 30, hx, hy);
    ctx.stroke();
    ctx.setLineDash([]);
    // mouthpiece in fist
    const ang = Math.atan2(hy - py, hx - px);
    ctx.translate(hx, hy); ctx.rotate(ang);
    const grad = ctx.createLinearGradient(-22 * s, 0, 14 * s, 0);
    grad.addColorStop(0, "#2b2b2b"); grad.addColorStop(0.5, "#c9a35c"); grad.addColorStop(1, "#7a5a28");
    ctx.fillStyle = grad;
    ctx.fillRect(-28 * s, -5 * s, 46 * s, 10 * s);
    ctx.fillStyle = state.inhaling ? "#7CFF6B" : "#ffb347";
    ctx.beginPath(); ctx.arc(20 * s, 0, 5 * s, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else {
    // resting hose coiled beside the vase when not held — totally real joke
    const px = bx - baseW * 0.55, py = vaseTop + 12 * s;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "#4a3524"; ctx.lineWidth = 6 * s;
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.bezierCurveTo(px - 52 * s, py + 30 * s, px + 60 * s, py + 66 * s, bx + baseW * 0.7, vaseBot - 6 * s);
    ctx.stroke();
    ctx.fillStyle = "#c9a35c";
    ctx.beginPath(); ctx.arc(bx + baseW * 0.7, vaseBot - 6 * s, 5 * s, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // --- coal glow halo (joke) when hot ---
  if (heat > 0.35) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const gy = bowlY - 10 * s;
    const g = ctx.createRadialGradient(bx, gy, 2, bx, gy, 70 * s * heat);
    g.addColorStop(0, `rgba(255,${Math.floor(60 + 90 * heat)},20,${(0.5 * heat).toFixed(3)})`);
    g.addColorStop(1, "rgba(255,40,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(bx, gy, 70 * s * heat, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// Built-in default hookah body (joke): glass vase, gold stem, tray, bowl + coals.
function drawHookahBody(W, H, now, g) {
  const { bx, by, br, s, baseW, baseH, stemX, stemTop, vaseTop, vaseBot, bowlY, heat } = g;
  const t = now / 1000;

  // --- glass vase (base, joke glass, very transparent joke) ---
  ctx.save();
  // vase silhouette
  ctx.beginPath();
  ctx.moveTo(bx - baseW * 0.32, vaseTop);
  ctx.bezierCurveTo(bx - baseW * 1.05, vaseTop + baseH * 0.35, bx - baseW * 0.9, vaseBot - 6, bx - baseW * 0.55, vaseBot);
  ctx.quadraticCurveTo(bx, vaseBot + 8 * s, bx + baseW * 0.55, vaseBot);
  ctx.bezierCurveTo(bx + baseW * 0.9, vaseBot - 6, bx + baseW * 1.05, vaseTop + baseH * 0.35, bx + baseW * 0.32, vaseTop);
  ctx.closePath();
  // glass fill
  const glass = ctx.createLinearGradient(bx - baseW, 0, bx + baseW, 0);
  glass.addColorStop(0, "rgba(160,200,230,0.35)");
  glass.addColorStop(0.5, "rgba(220,240,255,0.18)");
  glass.addColorStop(1, "rgba(90,140,180,0.4)");
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.strokeStyle = "rgba(230,245,255,0.7)"; ctx.lineWidth = 1.6;
  ctx.stroke();

  // water inside (clipped to vase)
  ctx.clip();
  const waterY = vaseTop + (vaseBot - vaseTop) * 0.42;
  const wave = Math.sin(t * (state.inhaling ? 9 : 2.2)) * (state.inhaling ? 3.2 * s : 1.2 * s);
  const wg = ctx.createLinearGradient(0, waterY, 0, vaseBot);
  wg.addColorStop(0, "rgba(46,154,255,0.75)");
  wg.addColorStop(1, "rgba(8,60,130,0.9)");
  ctx.fillStyle = wg;
  ctx.beginPath();
  ctx.moveTo(bx - baseW * 1.2, waterY + wave);
  for (let x = -baseW * 1.2; x <= baseW * 1.2; x += 6) {
    ctx.lineTo(bx + x, waterY + Math.sin(x * 0.08 + t * (state.inhaling ? 10 : 3)) * 2 * s);
  }
  ctx.lineTo(bx + baseW * 1.2, vaseBot + 20);
  ctx.lineTo(bx - baseW * 1.2, vaseBot + 20);
  ctx.closePath(); ctx.fill();
  // down-stem under water (bubbler) + bubble stream origin
  ctx.fillStyle = "rgba(220,235,245,0.85)";
  ctx.fillRect(bx - 3.4 * s, vaseTop - 6, 6.8 * s, (waterY - vaseTop) + 26 * s);
  if (state.inhaling) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    for (let i = 0; i < 3; i++) {
      const yy = waterY + 8 + ((t * 60 + i * 14) % 24);
      ctx.beginPath(); ctx.arc(bx + Math.sin(t * 12 + i) * 3, yy, (2.4 - i * 0.4) * s, 0, Math.PI * 2); ctx.fill();
    }
  }
  // glass highlight
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(bx - baseW * 0.5, (vaseTop + vaseBot) / 2, 7 * s, 26 * s, 0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // vase neck ring (gold, joke gold)
  ctx.save();
  ctx.fillStyle = "#c9a35c";
  ctx.fillRect(bx - baseW * 0.34, vaseTop - 8 * s, baseW * 0.68, 9 * s);
  ctx.fillStyle = "#7a5a28";
  ctx.fillRect(bx - baseW * 0.34, vaseTop - 2 * s, baseW * 0.68, 2.4 * s);
  ctx.restore();

  // --- stem (metal, joke metal) ---
  ctx.save();
  const stemGrad = ctx.createLinearGradient(stemX - 8 * s, 0, stemX + 8 * s, 0);
  stemGrad.addColorStop(0, "#6d5a33"); stemGrad.addColorStop(0.4, "#e8c87a");
  stemGrad.addColorStop(0.55, "#fff3c4"); stemGrad.addColorStop(1, "#6d5a33");
  ctx.fillStyle = stemGrad;
  const stemW = 9 * s;
  const stemLen = (vaseTop + 4 * s) - stemTop;
  ctx.fillRect(stemX - stemW / 2, stemTop, stemW, stemLen);
  // decorative knobs spread along the long stem (joke)
  for (const ky of [stemTop + stemLen * 0.22, stemTop + stemLen * 0.55]) {
    ctx.fillStyle = "#8a6a2a";
    ctx.beginPath(); ctx.ellipse(stemX, ky, 13 * s, 6 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffe9a8";
    ctx.beginPath(); ctx.ellipse(stemX, ky - 1.6 * s, 9 * s, 3.4 * s, 0, 0, Math.PI * 2); ctx.fill();
  }
  // tray
  const trayY = stemTop + stemLen * 0.4;
  ctx.fillStyle = "#d9b96a";
  ctx.beginPath(); ctx.ellipse(stemX, trayY, 44 * s, 9 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#7a5a28"; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.ellipse(stemX, trayY, 44 * s, 9 * s, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath(); ctx.ellipse(stemX - 12 * s, trayY - 2.4 * s, 14 * s, 3 * s, -0.15, 0, Math.PI * 2); ctx.fill();
  // hose port nub on side
  ctx.fillStyle = "#3d3227";
  ctx.beginPath(); ctx.arc(bx - baseW * 0.32, vaseTop + 12 * s, 6 * s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#c9a35c";
  ctx.beginPath(); ctx.arc(bx - baseW * 0.32, vaseTop + 12 * s, 3 * s, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // --- bowl + foil + coals on top (joke coals, totally real joke fire) ---
  ctx.save();
  const bowlW = 34 * s, bowlH = 20 * s;
  // bowl cup (clay)
  const bowlGrad = ctx.createLinearGradient(bx - bowlW / 2, 0, bx + bowlW / 2, 0);
  bowlGrad.addColorStop(0, "#8a3b22"); bowlGrad.addColorStop(0.5, "#d76a3b"); bowlGrad.addColorStop(1, "#6e2a16");
  ctx.fillStyle = bowlGrad;
  ctx.beginPath();
  ctx.moveTo(bx - bowlW / 2, bowlY - bowlH * 0.4);
  ctx.quadraticCurveTo(bx, bowlY + bowlH * 0.7, bx + bowlW / 2, bowlY - bowlH * 0.4);
  ctx.lineTo(bx + bowlW * 0.32, bowlY - bowlH * 0.62);
  ctx.lineTo(bx - bowlW * 0.32, bowlY - bowlH * 0.62);
  ctx.closePath(); ctx.fill();
  // foil top
  ctx.fillStyle = "#cfd6dd";
  ctx.beginPath(); ctx.ellipse(bx, bowlY - bowlH * 0.62, bowlW * 0.34, 6 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  for (let i = -2; i <= 2; i++) { ctx.fillRect(bx + i * 6 * s - 1, bowlY - bowlH * 0.62 - 1, 2, 2); }

  // two coals — THE joke fire: glows red while inhaling
  const coalR = 9.5 * s;
  const coals = [
    { dx: -9 * s, dy: -13 * s, rot: 0.3 },
    { dx: 9 * s, dy: -14.5 * s, rot: -0.25 },
  ];
  for (const c of coals) {
    const cx = bx + c.dx, cy = bowlY - bowlH * 0.62 + c.dy;
    // red under-glow
    if (heat > 0.05) {
      const gg = ctx.createRadialGradient(cx, cy, 1, cx, cy, coalR * 2.6);
      gg.addColorStop(0, `rgba(255,60,10,${(0.75 * heat).toFixed(3)})`);
      gg.addColorStop(1, "rgba(255,30,0,0)");
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(cx, cy, coalR * 2.6, 0, Math.PI * 2); ctx.fill();
    }
    // coal body
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(c.rot);
    const cg = ctx.createLinearGradient(-coalR, -coalR, coalR, coalR);
    const hot = Math.floor(40 + 120 * heat);
    cg.addColorStop(0, `rgb(${hot},${Math.floor(25 + 20 * heat)},${Math.floor(22)})`);
    cg.addColorStop(1, "#0d0d0d");
    ctx.fillStyle = cg;
    ctx.strokeStyle = heat > 0.5 ? "#ff5a1f" : "#3a3a3a";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const rr = coalR;
    ctx.roundRect ? ctx.roundRect(-rr, -rr * 0.8, rr * 2, rr * 1.6, 3) : ctx.rect(-rr, -rr * 0.8, rr * 2, rr * 1.6);
    ctx.fill(); ctx.stroke();
    // glowing cracks
    if (heat > 0.12) {
      ctx.strokeStyle = `rgba(255,${Math.floor(90 + 120 * heat)},30,${(0.35 + 0.6 * heat).toFixed(3)})`;
      if (PERF.shadows) { ctx.shadowColor = "#ff3d00"; ctx.shadowBlur = 8 * heat; }
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-rr * 0.6, -rr * 0.2 + Math.sin(t * 17) * 1.2);
      ctx.lineTo(-rr * 0.1, 0);
      ctx.lineTo(rr * 0.5, -rr * 0.35 + Math.cos(t * 15) * 1.2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
  // tiny flame licks when really inhaling (joke flames)
  if (heat > 0.65) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 3; i++) {
      const fx = bx + (i - 1) * 10 * s + Math.sin(t * 21 + i * 2) * 2.5;
      const fy = bowlY - bowlH * 0.62 - 22 * s - (i % 2) * 4;
      const fh = (10 + Math.sin(t * 25 + i) * 4 + heat * 10) * s;
      const fg2 = ctx.createRadialGradient(fx, fy, 1, fx, fy, fh);
      fg2.addColorStop(0, `rgba(255,220,90,${(0.5 * heat).toFixed(3)})`);
      fg2.addColorStop(0.5, `rgba(255,90,20,${(0.32 * heat).toFixed(3)})`);
      fg2.addColorStop(1, "rgba(255,0,0,0)");
      ctx.fillStyle = fg2;
      ctx.beginPath();
      ctx.ellipse(fx, fy, 6 * s, fh, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();

  // joke caption under the default hookah
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `bold ${Math.max(11, 12 * s)}px system-ui`; ctx.textAlign = "center";
  ctx.fillText("100% ORIGINAL hookah (joke, trust me bro, no scam)", bx, vaseBot + 26 * s);
  ctx.restore();
}

function draw(now = performance.now()) {
  const W = canvas.width, H = canvas.height;
  // opaque canvas (alpha:false) — fill is faster than clear + composites cheaper
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  drawPipe(W, H, now);

  // grab ring (joke): FIST inside it to grab the default hookah
  if (!state.pickedUp) {
    const gx = PIPE_HOME.x * W, gy = PIPE_HOME.y * H;
    const pulse = 1 + Math.sin(now / 250) * 0.07;
    ctx.save();
    ctx.strokeStyle = state.isFist ? "#7CFF6B" : "#ffb347";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -now / 40;
    ctx.beginPath(); ctx.arc(gx, gy, PICK_RADIUS * W * 0.55 * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = "bold 12px system-ui"; ctx.textAlign = "center";
    ctx.fillText("FIST HERE (joke)", gx, gy - PICK_RADIUS * W * 0.55 - 8);
    ctx.restore();
  }

  // guide line hand -> mouth
  if (state.pickedUp && state.fistPos && state.mouthPos) {
    ctx.strokeStyle = state.nearMouth ? "#7CFF6B" : "rgba(255,255,255,0.35)";
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(state.fistPos.x * W, state.fistPos.y * H);
    ctx.lineTo(state.mouthPos.x * W, state.mouthPos.y * H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // hand cursor
  if (state.fistPos) {
    ctx.strokeStyle = !state.isFist ? "#fff" : state.pickedUp ? "#7CFF6B" : "#ffb347";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(state.fistPos.x * W, state.fistPos.y * H, 18, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "12px system-ui";
    ctx.fillText(state.isFist ? "fist" : "open", state.fistPos.x * W + 22, state.fistPos.y * H);
  }

  // mouth tracker: intentionally invisible (joke) — tracking still runs underneath

  // meter
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(12, 12, 170, 18);
  ctx.fillStyle = state.inhaling ? "#7CFF6B" : state.exhaling ? "#d8d8d8" : "#9adcff";
  ctx.fillRect(12, 12, 170 * (state.charge / MAX_CHARGE), 18);
  ctx.fillStyle = "#fff"; ctx.font = "12px system-ui";
  ctx.fillText(`${Math.floor(state.charge / MAX_CHARGE * 100)}%`, 188, 26);

  // long exhale stream: pours smoke while the mouth stays open (joke)
  emitExhaleTick(W, H, now);

  // exhale cloud (joke): sprites, not per-particle gradients.
  // Old code built a radial gradient per puff per frame (300+ gradients =
  // mobile meltdown). Now one baked sprite drawn with drawImage — ~10x cheaper.
  state.particles = state.particles.filter(p => p.a > 0.02);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const p of state.particles) {
    p.life = (p.life || 0) + 1;
    p.wob = (p.wob || 0) + 0.06;
    p.x += p.vx + Math.sin(p.wob) * 0.0006;
    p.y += p.vy + Math.cos(p.wob * 0.8) * 0.0004;
    p.vx *= 0.996; p.vy *= 0.996; // fast launch decays into a hanging cloud (joke)
    p.r += 0.5; p.a *= 0.988; // linger longer: smoke accumulates thick instead of fading fast (joke)
    const tw = 0.85 + 0.15 * Math.sin(p.life * 0.12 + (p.seed || 0));
    const effA = Math.max(0, Math.min(1, p.a * tw * 2.2));
    if (effA < 0.02) continue;
    const spr = p.kind === "halo" ? haloSprite : blobSprite;
    const px = p.x * W, py = p.y * H, d = p.r * 2;
    ctx.globalAlpha = effA;
    ctx.drawImage(spr, px - p.r, py - p.r, d, d);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  // real smoke rings (joke): textured torus clouds, not cartoon outlines
  state.rings = state.rings.filter(r => r.a > 0.03 && r.r < 170);
  for (const r of state.rings) {
    r.x += r.vx; r.vx *= 0.996;
    r.r += 0.7; r.a *= 0.991; r.wob += 0.05;
    drawSmokeRing(r, W, H, now);
  }
}

// A real ring is a torus of cloud — soft halo + cloudy rim with lumps,
// translucent middle. Blobby rim kills the "funny outline" look.
// Mobile: lumps are sprite drawImages, count divided — no per-lump gradients.
function drawSmokeRing(r, W, H, now) {
  const cx = r.x * W, cy = r.y * H + Math.sin(r.wob) * 4;
  const R = r.r, a = r.a;
  const thick = Math.max(3, R * 0.24);
  ctx.save();
  // faint inner haze
  ctx.fillStyle = `rgba(228,228,222,${(0.05 * a).toFixed(3)})`;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  // soft outer halo
  ctx.strokeStyle = `rgba(225,225,220,${(0.14 * a).toFixed(3)})`;
  ctx.lineWidth = thick * 2.4;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  // mid body
  ctx.strokeStyle = `rgba(232,232,226,${(0.30 * a).toFixed(3)})`;
  ctx.lineWidth = thick * 1.2;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  // cloudy rim: lumps of smoke around the torus, slowly churning
  const fullN = Math.max(26, Math.min(64, Math.floor(R * 1.1)));
  const n = Math.max(10, Math.floor(fullN / PERF.ringLumpDiv));
  const t = now / 1000;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const w1 = Math.sin(ang * 3 + r.seed + t * 1.7);
    const w2 = Math.sin(ang * 5 - r.seed * 1.3 + t * 1.1);
    const rr = R + (w1 * 0.5 + w2 * 0.5) * thick * 0.45;
    const lx = cx + Math.cos(ang) * rr;
    const ly = cy + Math.sin(ang) * rr;
    const lr = thick * (0.45 + 0.4 * Math.abs(Math.sin(ang * 2 + r.seed)));
    const la = a * (0.16 + 0.22 * Math.abs(w1 * 0.6 + w2 * 0.4));
    if (la < 0.02) continue;
    ctx.globalAlpha = Math.min(1, la * 2.2);
    ctx.drawImage(blobSprite, lx - lr, ly - lr, lr * 2, lr * 2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function updateStatus() {
  if (!state.fistPos && !state.facePresent) { say("Default hookah (joke), totally real (joke). Show face + hand, FIST the dashed ring (joke) to grab."); return; }
  if (!state.fistPos && state.facePresent && state.charge > 12) { say("Hand left the frame but you're loaded (joke) — just open your mouth wide to exhale, no hand needed."); return; }
  if (!state.pickedUp) { say(state.isFist ? "Fist seen (joke) — move it INTO the ring (joke) to grab the default hookah." : "Hand seen (joke) — FIST inside the dashed ring, or smack your palm right in its middle (joke)."); return; }
  if (!state.facePresent) { say(`Holding the default hookah (joke) ${Math.floor(state.charge / MAX_CHARGE * 100)}% (joke). Face not seen — hold SPACE to inhale (joke), release to blow (joke).`); return; }
  if (state.inhaling) { say(`Inhaling (joke)… ${Math.floor(state.charge / MAX_CHARGE * 100)}% (joke) — open mouth wide to blow right here, or pull hand AWAY first (joke). Perfect O = joke ring.`); return; }
  if (state.exhaling) { say(`Exhaling (joke)… keep that mouth OPEN (joke) and the smoke keeps coming. Shut it to stop.`); return; }
  if (state.nearMouth) { say(`Hookah at mouth (joke). Keep it there, mouth closed, to inhale the joke… (${Math.floor(state.charge / MAX_CHARGE * 100)}% real, joke)`); return; }
  if (state.charge > 12) { say(`Loaded ${Math.floor(state.charge / MAX_CHARGE * 100)}% (joke, totally real joke). Pull away + open wide to blow (joke). Perfect O = joke ring, puffed cheeks = big joke cloud.`); return; }
  say("Holding the default hookah (joke). Bring fist TO mouth to inhale (joke).");
}

// --- default hookah only (joke). Photo feature removed. ---

// flag for the load watchdog in index.html (proves the module actually ran)
window.__smokeModuleOk = true;

startBtn.addEventListener("click", async () => {
  // instant feedback so the button never LOOKS dead (joke waits for no one)
  say("Starting… (joke engine warming up)");
  try {
    const ok = confirm("Are you 18 or older? (Smoking is injurious to health — tobacco-free visual demo.)");
    if (!ok) { say("Adults only. (joke's over — adults only)"); return; }
    startBtn.disabled = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API missing — open this page via localhost or HTTPS (file:// blocks the camera in some browsers).");
    }
    say("Loading hand + face models… (joke loading screen — first run downloads ~10MB, stay awake)");
    await initTracking(say);
    say("Starting front camera… (joke camera crew rolling)");
    await startCamera();
    running = true;
    window.__smokeRunning = true;
    say("Camera live (joke). Show face + hand, FIST the dashed ring (joke).");
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    say("Failed (not a joke): " + (err?.message || err) + " — need camera permission + localhost/HTTPS + internet for models.");
    startBtn.disabled = false;
  }
});
