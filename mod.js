(function () {

// ===== saving shim: gives the game the YouTube save API when the page has none =====
// (runs immediately, so load this file BEFORE the game starts: before window.runGame())
if (!window.ytgame) {
const SK = "bm_ytgame_save";
window.ytgame = {
game: {
loadData: () => Promise.resolve(localStorage.getItem(SK) || ""),
saveData: (s) => { try { localStorage.setItem(SK, s); } catch (e) {} return Promise.resolve(); },
firstFrameReady() {}, gameReady() {}
},
system: { getLanguage: () => Promise.resolve(navigator.language || "en"), isAudioEnabled: () => true, onAudioEnabledChange() {}, onPause() {}, onResume() {} },
engagement: { sendScore: () => Promise.resolve() }
};
}

// needs the patched game.js (adds window.__bm)
const wait = setInterval(function () {
const b = window.__bm;
if (b && b.meta && b.meta.coins && b.pixiApp) { clearInterval(wait); start(b); }
}, 500);

function start(B) {
if (window.__bmMod) return;
window.__bmMod = true;

// ================= settings =================
const KEY = "bmmod_v3";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY)) || JSON.parse(localStorage.getItem("bmmod_v2")) || {}; } catch (e) {}
const DEF = {
grav: 100, speed: 100, floor: false, bounce: 1, minBounce: 1200, phase: false,
hover: false, holdY: 0, fly: false, flySpeed: 1800, cruise: false, cruiseVx: -1500,
cm: 1, gm: 1,
rec: true, recFrames: true, rewSec: 5, rewRate: 3, autoRew: false, autoSec: 3,
fx: { gray: 100, vhs: true, sound: true, flash: true },
hud: true, keys: true, fab: true, accent: "#34c759", ui: 100, ov: {}, tab: 0,
worldRec: true, logicRec: true, keepDead: true, worldFull: false, memMB: 160, toasts: true, confetti: true, theme: "Mint",
ach: {}, bestH: 0, bestV: 0, totalRew: 0, bounces: 0
};
const S = Object.assign({}, DEF, saved.s || {});
S.fx = Object.assign({}, DEF.fx, (saved.s && saved.s.fx) || {});
S.ov = Object.assign({}, (saved.s && saved.s.ov) || {});
S.ach = Object.assign({}, (saved.s && saved.s.ach) || {});
const M = () => B.meta;
const VIEW = () => B.pixiApp.view || B.pixiApp.canvas;
let status;
let toast = null;
const say = (s) => { if (status) status.textContent = s; if (toast) toast(s); };
const LBL = { floor: "Bouncy floor", phase: "Phase", hover: "Hover", fly: "Fly mode", cruise: "Cruise", rec: "Recording", recFrames: "Frame capture", autoRew: "Second chance", hud: "HUD", keys: "Hotkeys", fab: "Rewind button", worldRec: "World recording", logicRec: "Game logic recording", keepDead: "Keep destroyed objects", worldFull: "Full world rewind", toasts: "Toasts", confetti: "Confetti" };
const swDraws = [];

// ================= the live flying character =================
let CH = null;
const isChar = (o) => o && typeof o === "object" && o.flyingVelocity && "timeBeforeNextGroundCollisionSec" in o && "state" in o;
const findChar = () => {
if (CH && CH.parent) return CH;
CH = null;
const st = B.pixiApp && B.pixiApp.stage;
if (!st) return null;
const q = [st];
for (let n = 0; q.length && n < 6000; n++) {
const o = q.shift();
if (isChar(o)) { CH = o; break; }
if (o && o.children) for (const c of o.children) q.push(c);
}
return CH;
};

// wraps the character's collide(): perfect bouncy floor and phase-through obstacles
const patch = (ch) => {
if (ch.__bmPatched) return;
ch.__bmPatched = true;
const orig = ch.collide;
ch.collide = function (t) {
try {
const c = t && t.collider && t.collider.collidable;
if (c) {
if (S.floor && c.type === "ground") {
const v = this.flyingVelocity;
v.y = Math.max(Math.abs(v.y) * S.bounce, S.minBounce);
this.y = Math.max(this.y, 2);
this.timeBeforeNextGroundCollisionSec = 0.1;
return { isNextCollideAvailable: false, isCollidePerformed: true };
}
if (S.phase && c.type !== "ground" && c.type !== "coin" && c.type !== "gem") {
return { isNextCollideAvailable: false, isCollidePerformed: false };
}
}
} catch (e) {}
return orig.apply(this, arguments);
};
};

// ================= timeline: state snapshots + video frames, 10 per second =================
const GK = ["gravityAccelerationUpMoving", "gravityAccelerationDownMoving", "gravityCosmosAccelerationUpMoving", "gravityCosmosAccelerationDownMoving"];
const MAXREC = 9000; // 15 minutes of state at 10/s (the memory cap below is what really limits it)
const MAXFR = 18000;
let snaps = [], frames = [], lastS = 0, lastF = 0, skew = 0, rw = null;
const clk = () => performance.now() - skew; // timeline clock: skips over the time that was rewound
const bsearch = (arr, t) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const snapAt = (t) => snaps[Math.max(0, bsearch(snaps, t))];
const frameAt = (t) => frames[bsearch(frames, t)] || null;
const fc = document.createElement("canvas"), fctx = fc.getContext("2d");
const pin = (ch, s) => { ch.x = s.x; ch.y = s.y; ch.flyingVelocity.x = s.vx; ch.flyingVelocity.y = s.vy; ch.timeBeforeNextGroundCollisionSec = 0.3; };
const restoreState = (ch, s) => {
pin(ch, s);
if (s.st) { if (ch.state !== s.st) ch.state = s.st; } else if (ch.state !== "flying") ch.state = "flying";
ch.isNeedRecalculatePredictions = true;
};

// ================= world recorder: scene graph + game lists, so a rewind brings trees, coins and walruses back =================
const NP = 8;
const W = { samples: [], last: new Map(), watch: [], watchT: 0, bytes: 0, nodes: [], int: 100 };
const grave = [], graveSet = new Map(), patched = new Set();
let passThrough = false, frameBytes = 0, lastW = 0, rp = null;
const isDisp = (o) => o && typeof o === "object" && o.children && o.transform !== undefined && "alpha" in o;

// destroy() is deferred (object just leaves the scene) until its footage falls out of the buffer, so it can come back
const patchDestroy = (o) => {
let p = Object.getPrototypeOf(o);
while (p && p !== Object.prototype) {
if (!patched.has(p)) {
patched.add(p);
if (Object.prototype.hasOwnProperty.call(p, "destroy") && typeof p.destroy === "function") {
const orig = p.destroy;
p.destroy = function () {
if (graveSet.has(this)) return;
if (passThrough || !S.keepDead || !S.worldRec || !S.rec) return orig.apply(this, arguments);
try { if (this.parent) this.parent.removeChild(this); } catch (e) {}
const g = { t: clk(), o: this, a: Array.prototype.slice.call(arguments) };
grave.push(g); graveSet.set(this, g);
};
}
}
p = Object.getPrototypeOf(p);
}
};
const flushGrave = (all) => {
const lim = (all || !snaps.length) ? Infinity : snaps[0].t;
while (grave.length && grave[0].t < lim) {
const g = grave.shift();
if (graveSet.get(g.o) !== g) continue;
graveSet.delete(g.o);
passThrough = true;
try { g.o.destroy.apply(g.o, g.a); } catch (e) {}
passThrough = false;
}
};
const readProps = (o, out) => {
out[0] = o.x; out[1] = o.y;
const sc = o.scale; out[2] = sc ? sc.x : 1; out[3] = sc ? sc.y : 1;
out[4] = o.rotation; out[5] = o.alpha;
out[6] = (o.visible ? 1 : 0) | (o.renderable ? 2 : 0);
out[7] = typeof o.currentFrame === "number" ? o.currentFrame : -1;
};
const setProps = (o, p) => {
o.x = p[0]; o.y = p[1];
if (o.scale) { o.scale.x = p[2]; o.scale.y = p[3]; }
o.rotation = p[4]; o.alpha = p[5];
o.visible = !!(p[6] & 1); o.renderable = !!(p[6] & 2);
if (p[7] >= 0 && "currentFrame" in o) { try { o.currentFrame = p[7]; } catch (e) {} }
};
const readEx = (o) => {
let e = null, ks;
try { ks = Object.keys(o); } catch (x) { return null; }
for (let i = 0; i < ks.length && i < 160; i++) {
const k = ks[i]; if (k.charCodeAt(0) === 95) continue;
let v; try { v = o[k]; } catch (x) { continue; }
const t = typeof v;
if (t === "number" || t === "boolean" || (t === "string" && v.length < 32)) { if (!e) e = {}; e[k] = v; }
}
const sp = o.state;
if (sp && typeof sp === "object" && sp.tracks) {
for (let i = 0; i < 2; i++) { const tr = sp.tracks[i]; if (tr && typeof tr.trackTime === "number") { if (!e) e = {}; e["#t" + i] = tr.trackTime; } }
}
return e;
};
const sameEx = (a, b) => {
if (a === b) return true;
if (!a || !b) return false;
for (const k in a) if (a[k] !== b[k]) return false;
for (const k in b) if (!(k in a)) return false;
return true;
};
const applyEx = (o, e) => {
for (const k in e) {
try {
if (k.charCodeAt(0) === 35) { const tr = o.state && o.state.tracks && o.state.tracks[+k[2]]; if (tr) tr.trackTime = e[k]; }
else if (o[k] !== e[k]) o[k] = e[k];
} catch (x) {}
}
};
const restoreList = (w, old) => {
if (w.set) { for (let i = 0; i < old.length; i++) w.a.add(old[i]); return; }
const cur = new Set(w.a);
for (let i = 0; i < old.length; i++) { const x = old[i]; if (!cur.has(x)) { w.a.splice(Math.min(i, w.a.length), 0, x); cur.add(x); } }
};
// finds arrays/sets of objects (spawn lists, collision lists, pools) in the game state and watches them
const discoverLists = () => {
const have = new Set(W.watch.map((w) => w.a));
const consider = (a) => {
if (W.watch.length >= 120 || have.has(a)) return;
const set = a instanceof Set, n = set ? a.size : a.length;
if (!n || n > 4000) return;
const f = set ? a.values().next().value : a[0];
if (!f || typeof f !== "object" || f instanceof Node) return;
have.add(a); W.watch.push({ a, set, last: set ? Array.from(a) : a.slice() });
};
const seen = new WeakSet(); let budget = 6000;
const walk = (o, d, skipUs) => {
if (!o || typeof o !== "object" || seen.has(o) || budget-- <= 0 || d > 4) return;
seen.add(o);
if (o instanceof Node || o === B.pixiApp) return;
if (isDisp(o) && d > 0) return;
let ks; try { ks = Object.keys(o); } catch (e) { return; }
for (const k of ks) {
if (k === "pixiApp" || k === "meta" || k === "children" || k === "parent" || (skipUs && k.charCodeAt(0) === 95)) continue;
let v; try { v = o[k]; } catch (e) { continue; }
if (v && typeof v === "object") { if (Array.isArray(v) || v instanceof Set) consider(v); else walk(v, d + 1, skipUs); }
}
};
walk(B, 0, false);
const nd = W.nodes;
for (let i = 0; i < nd.length && i < 600; i++) walk(nd[i], 1, true);
};
const sampleWorld = (t) => {
const root = B.pixiApp.stage; if (!root) return;
const nodes = [], idx = new Map(), seen = new Set(), stack = [root];
while (stack.length && nodes.length < 14000) {
const o = stack.pop(); if (!o || seen.has(o)) continue;
seen.add(o); nodes.push(o);
const c = o.children;
if (c) for (let i = c.length - 1; i >= 0; i--) { const k = c[i]; if (k) { idx.set(k, i); stack.push(k); } }
}
W.nodes = nodes;
const tmp = new Float32Array(NP), chO = [], chD = [], txL = [], exL = [], rem = [], mv = [], ar = [];
const full = S.worldFull;
let bytes = 0;
for (let n = 0; n < nodes.length; n++) {
const o = nodes[n];
try { readProps(o, tmp); } catch (e) { continue; }
const L = W.last.get(o);
const par = o.parent || null, ix = idx.has(o) ? idx.get(o) : -1;
const tex = o.texture, ex = (S.logicRec && n < 2500) ? readEx(o) : null;
if (!L) {
W.last.set(o, { p: Float32Array.from(tmp), tx: tex, ex, par, idx: ix });
if (!patched.has(Object.getPrototypeOf(o))) patchDestroy(o);
continue;
}
if (full) {
let d = false;
for (let i = 0; i < NP; i++) if (!Object.is(L.p[i], tmp[i])) { d = true; break; }
if (d) { chO.push(o); for (let i = 0; i < NP; i++) chD.push(L.p[i]); }
if (tex !== L.tx) txL.push(o, L.tx);
if (ex !== null && !sameEx(ex, L.ex)) exL.push(o, L.ex);
if (par !== L.par) mv.push(o, L.par, L.idx);
}
L.p.set(tmp); L.tx = tex; if (n < 2500 && S.logicRec) L.ex = ex; L.par = par; L.idx = ix;
}
// objects that left the scene: remember where they were, with their last state
for (const [o, L] of W.last) {
if (seen.has(o)) continue;
W.last.delete(o);
if (o.parent !== L.par) rem.push(o, L.par, L.idx, L.p, L.tx, L.ex);
}
if (S.logicRec) {
for (let i = 0; i < W.watch.length; i++) {
const w = W.watch[i], cur = w.set ? Array.from(w.a) : w.a, old = w.last;
let d = cur.length !== old.length;
if (!d) for (let j = 0; j < cur.length; j++) if (cur[j] !== old[j]) { d = true; break; }
if (d) { ar.push(w, old); w.last = w.set ? cur : cur.slice(); bytes += old.length * 8; }
}
const nw = performance.now();
if (nw - W.watchT > 3000) { W.watchT = nw; discoverLists(); }
}
bytes += chO.length * 40 + txL.length * 8 + exL.length * 64 + mv.length * 8 + (rem.length / 6) * 90;
if (chO.length || txL.length || exL.length || rem.length || mv.length || ar.length) {
bytes += 100;
W.samples.push({ t, o: chO, d: new Float32Array(chD), tx: txL, ex: exL, rem, mv, ar, b: bytes });
W.bytes += bytes;
}
};
// rewinds the world to time T: brings back everything that left the scene since then (and, in full mode, undoes moves and animations)
const applyWorld = (T) => {
const sm = W.samples;
let k = sm.length - 1, nRem = 0;
for (; k >= 0 && sm[k].t > T; k--) {
const s = sm[k];
for (let i = 0; i < s.rem.length; i += 6) {
const o = s.rem[i], par = s.rem[i + 1], ix = s.rem[i + 2];
try {
if (par && !o.parent) { if (ix >= 0 && ix <= par.children.length) par.addChildAt(o, ix); else par.addChild(o); nRem++; }
graveSet.delete(o);
setProps(o, s.rem[i + 3]);
const tx = s.rem[i + 4];
if (tx && o.texture !== tx) o.texture = tx;
if (s.rem[i + 5]) applyEx(o, s.rem[i + 5]);
} catch (e) {}
}
if (S.worldFull) {
for (let i = 0; i < s.mv.length; i += 3) {
const o = s.mv[i], par = s.mv[i + 1], ix = s.mv[i + 2];
try { if (par && o.parent !== par) { if (ix >= 0 && ix <= par.children.length) par.addChildAt(o, ix); else par.addChild(o); } } catch (e) {}
}
for (let i = 0; i < s.o.length; i++) { try { setProps(s.o[i], s.d.subarray(i * NP, i * NP + NP)); } catch (e) {} }
for (let i = 0; i < s.tx.length; i += 2) { try { if (s.tx[i + 1]) s.tx[i].texture = s.tx[i + 1]; } catch (e) {} }
for (let i = 0; i < s.ex.length; i += 2) { try { if (s.ex[i + 1]) applyEx(s.ex[i], s.ex[i + 1]); } catch (e) {} }
}
for (let i = 0; i < s.ar.length; i += 2) { try { restoreList(s.ar[i], s.ar[i + 1]); } catch (e) {} }
}
let drop = 0;
for (let i = sm.length - 1; i >= 0 && sm[i].t > T; i--) { W.bytes -= sm[i].b; drop++; }
sm.length = sm.length - drop;
return nRem;
};
const rebaseWorld = () => {
W.last.clear();
W.watch.forEach((w) => { w.last = w.set ? Array.from(w.a) : w.a.slice(); });
try { sampleWorld(clk()); } catch (e) {}
};
// memory budget: oldest footage is dropped first, so a school Chromebook never runs out
const dropBefore = (cut) => {
let i = 0;
while (i < snaps.length && snaps[i].t < cut) i++;
if (i) snaps.splice(0, i);
i = 0;
while (i < frames.length && frames[i].t < cut) { frameBytes -= frames[i].b.size; i++; }
if (i) frames.splice(0, i);
i = 0;
while (i < W.samples.length && W.samples[i].t < cut) { W.bytes -= W.samples[i].b; i++; }
if (i) W.samples.splice(0, i);
};
const trim = () => {
if (!snaps.length) { flushGrave(); return; }
dropBefore(snaps[0].t);
const cap = S.memMB * 1048576;
let g = 0;
while (W.bytes + frameBytes > cap && snaps.length > 30 && g++ < 300) dropBefore(snaps[Math.min(snaps.length - 1, 20)].t);
const m = performance.memory;
if (m && m.jsHeapSizeLimit && m.usedJSHeapSize / m.jsHeapSizeLimit > 0.72 && snaps.length > 60) dropBefore(snaps[Math.floor(snaps.length * 0.2)].t);
flushGrave();
};
const clearBuf = () => { snaps = []; frames = []; frameBytes = 0; W.samples = []; W.bytes = 0; flushGrave(true); };

// ================= run stats =================
let lastCh = null, runs = 0, st = { x0: 0, t0: 0, bestY: 0, bestV: 0 }, cur = { y: 0, sp: 0 };
let prevState = null, offCount = 0, autoCool = 0, fno = 0, fpsN = 0, fpsT = performance.now(), fps = 0, prevVy = 0, combo = 0, comboT = 0, bestCombo = 0;
const coins0 = (() => { try { return M().coins.value; } catch (e) { return 0; } })();
const locks = new Map(); // variable explorer freezes: path -> { r, v }
const held = {}; // keys currently held
const slots = [null, null, null];
let tkOrig = null;
const tk = B.pixiApp.ticker;

// ================= per-frame work =================
tk.add(() => {
fpsN++; fno++;
try {
if (tkOrig !== null || S.speed !== 100) {
if (tkOrig === null) tkOrig = tk.speed;
tk.speed = (rw || S.speed === 100) ? tkOrig : tkOrig * S.speed / 100;
}
} catch (e) {}
if (locks.size) locks.forEach((L) => { try { const p = resolve(L.r); if (p) p[0][p[1]] = L.v; } catch (e) {} });
const ch = findChar();
if (!ch) { prevState = null; return; }
if (ch !== lastCh) { lastCh = ch; runs++; st = { x0: ch.x, t0: performance.now(), bestY: ch.y, bestV: 0 }; }
patch(ch);
if (!ch.__g0) ch.__g0 = GK.map((k) => ch[k]);
GK.forEach((k, i) => { ch[k] = ch.__g0[i] * S.grav / 100; });
const v = ch.flyingVelocity;
if (rw) { if (rw.snap) pin(ch, rw.snap); return; }

// stats
const sp = Math.hypot(v.x, v.y);
cur.y = ch.y; cur.sp = sp;
if (prevVy < -300 && v.y > 300) { combo++; S.bounces++; comboT = performance.now(); if (combo > bestCombo) bestCombo = combo; if (combo % 10 === 0) { popup("x" + combo + " COMBO"); if (combo % 50 === 0) confetti(70); } }
prevVy = v.y;
if (sp > S.bestV) S.bestV = sp;
if (S.bestH > 0 && ch.y > S.bestH && !st.broke) { st.broke = true; popup("NEW HEIGHT RECORD"); confetti(110); }
if (ch.y > S.bestH) S.bestH = ch.y;
if (ch.y > st.bestY) st.bestY = ch.y;
if (sp > st.bestV) st.bestV = sp;

// second chance: rewind automatically when the run stops flying
if (ch.state === "flying") { prevState = "flying"; offCount = 0; }
else if (prevState === "flying" && ++offCount >= 3) {
prevState = ch.state;
if (S.autoRew && snaps.length > 5 && performance.now() > autoCool) {
autoCool = performance.now() + 2500;
startRewind({ sec: S.autoSec, base: snaps[snaps.length - 1].t });
return;
}
}

// flight, hover, cruise
let moved = false;
if (S.fly && ch.state === "flying") {
const fx = ((held.d || held.arrowright) ? 1 : 0) - ((held.a || held.arrowleft) ? 1 : 0);
const fy = ((held.w || held.arrowup) ? 1 : 0) - ((held.s || held.arrowdown) ? 1 : 0);
v.y = fy * S.flySpeed;
if (fx) v.x = -fx * S.flySpeed; // forward is negative X
if (ch.y < 2) ch.y = 2;
moved = true;
} else if (S.hover && ch.state === "flying") {
ch.y = S.holdY; v.y = 0; moved = true;
}
if (S.cruise && ch.state === "flying") { v.x = S.cruiseVx; moved = true; }
if (moved && (fno & 3) === 0) ch.isNeedRecalculatePredictions = true;

// recording
if (!S.rec) return;
const now = clk();
if (now - lastS >= 100) {
lastS = now;
snaps.push({ t: now, x: ch.x, y: ch.y, vx: v.x, vy: v.y, st: ch.state });
if (snaps.length > MAXREC) snaps.shift();
}
});

// video frames: captured AFTER the game has rendered (lowest priority), otherwise a WebGL canvas reads back black
const grabFrame = () => {
if (!S.rec || !S.recFrames || rw) return;
const now = clk();
if (now - lastF < 50) return;
lastF = now;
const vw = VIEW();
if (!vw || !vw.width) return;
const w = Math.max(160, Math.round(vw.width / 3)), h = Math.round(vw.height * w / vw.width);
if (fc.width !== w) { fc.width = w; fc.height = h; }
try {
fctx.drawImage(vw, 0, 0, w, h);
fc.toBlob((b) => { if (b) { frames.push({ t: now, b }); frameBytes += b.size; if (frames.length > MAXFR) frameBytes -= frames.shift().b.size; } }, "image/webp", 0.6);
} catch (e) {}
};
tk.add(grabFrame, null, -50);
const grabWorld = () => {
if (!S.rec || !S.worldRec || rw || !CH || !CH.parent) return;
const np = performance.now();
if (np - lastW < W.int) return;
lastW = np;
try { sampleWorld(clk()); } catch (e) {}
W.int = Math.min(500, Math.max(100, (performance.now() - np) * 14));
};
tk.add(grabWorld, null, -49);
try { B.pixiApp.renderer.on("postrender", grabFrame); } catch (e) {}

// ================= rewind sound (synthesized tape whirr) =================
let ac = null, snd = null;
const sndStart = () => {
if (!S.fx.sound) return;
try {
ac = ac || new (window.AudioContext || window.webkitAudioContext)();
if (ac.state === "suspended") ac.resume();
const T = ac.currentTime;
const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
o.type = "sawtooth"; o2.type = "square";
o.frequency.setValueAtTime(160, T); o.frequency.exponentialRampToValueAtTime(1100, T + 2.6);
o2.frequency.setValueAtTime(321, T); o2.frequency.exponentialRampToValueAtTime(2200, T + 2.6);
g.gain.setValueAtTime(0, T); g.gain.linearRampToValueAtTime(0.035, T + 0.1);
const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = buf.getChannelData(0);
for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
const ns = ac.createBufferSource(); ns.buffer = buf; ns.loop = true;
const bp = ac.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 0.6;
const ng = ac.createGain(); ng.gain.value = 0.06;
o.connect(g); o2.connect(g); g.connect(ac.destination);
ns.connect(bp); bp.connect(ng); ng.connect(ac.destination);
o.start(); o2.start(); ns.start();
snd = { o, o2, ns, g, ng };
} catch (e) { snd = null; }
};
const sndStop = () => {
const s = snd; snd = null;
if (!s || !ac) return;
try {
const T = ac.currentTime;
s.g.gain.cancelScheduledValues(T); s.g.gain.setTargetAtTime(0, T, 0.03);
s.ng.gain.cancelScheduledValues(T); s.ng.gain.setTargetAtTime(0, T, 0.03);
// short mechanical clunk
const c = ac.createOscillator(), cg = ac.createGain();
c.type = "square"; c.frequency.setValueAtTime(110, T); c.frequency.exponentialRampToValueAtTime(40, T + 0.12);
cg.gain.setValueAtTime(0.08, T); cg.gain.exponentialRampToValueAtTime(0.001, T + 0.14);
c.connect(cg); cg.connect(ac.destination); c.start(T); c.stop(T + 0.16);
setTimeout(() => { try { s.o.stop(); s.o2.stop(); s.ns.stop(); } catch (e) {} }, 300);
} catch (e) {}
};

// ================= rewind visuals: grayscale reversed video, VHS glitch, REW label =================
const noise = document.createElement("canvas"); noise.width = noise.height = 128;
(() => { const c = noise.getContext("2d"), im = c.createImageData(128, 128); for (let i = 0; i < im.data.length; i += 4) { const g = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = g; im.data[i + 3] = 255; } c.putImageData(im, 0, 0); })();
const fxStyle = document.createElement("style");
fxStyle.textContent = [
"#bmfx{position:fixed;inset:0;z-index:2147483000;display:none;pointer-events:none}",
"#bmfx .st{position:absolute;background:#000;overflow:hidden;font-size:16px}",
"#bmfx.live .st{background:transparent}",
"#bmfx canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}",
"#bmfx.vhs canvas{animation:bmfx-jit .14s steps(2) infinite}",
"#bmfx .gr,#bmfx .tr,#bmfx .t2,#bmfx .sl{display:none;position:absolute}",
"#bmfx.vhs .gr,#bmfx.vhs .tr,#bmfx.vhs .t2,#bmfx.vhs .sl{display:block}",
"#bmfx .gr{inset:-50%;opacity:.17;background-size:128px 128px;animation:bmfx-gr .4s steps(6) infinite}",
"#bmfx .tr{left:0;right:0;height:16%;top:-20%;background:linear-gradient(180deg,transparent,rgba(255,255,255,.26) 45%,rgba(255,255,255,.07) 70%,transparent);animation:bmfx-tr 1.7s linear infinite}",
"#bmfx .t2{left:0;right:0;height:2.5%;top:-10%;background:rgba(255,255,255,.35);mix-blend-mode:overlay;animation:bmfx-tr .9s linear infinite .35s}",
"#bmfx .sl{inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.3) 0 1px,transparent 1px 3px)}",
"#bmfx .vg{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.7) 100%)}",
"#bmfx .lb,#bmfx .tc{position:absolute;top:.9em;font:700 2em ui-monospace,Menlo,Consolas,monospace;color:#fff;letter-spacing:.08em;text-shadow:.07em 0 rgba(255,40,40,.6),-.07em 0 rgba(40,255,255,.6),0 0 .35em rgba(255,255,255,.7)}",
"#bmfx .lb{left:.8em}#bmfx .lb b{animation:bmfx-bl .8s steps(2) infinite}",
"#bmfx .tc{right:.8em;font-size:1.5em;top:1.15em}",
"#bmfx .bar{position:absolute;left:1.2em;right:1.2em;bottom:1.1em;height:.35em;background:rgba(255,255,255,.2);border-radius:.2em;overflow:hidden}",
"#bmfx .bar i{display:block;height:100%;width:100%;background:#fff;box-shadow:0 0 .6em #fff}",
"#bmflash{position:fixed;inset:0;z-index:2147483001;background:#fff;opacity:0;pointer-events:none}",
"@keyframes bmfx-jit{0%{transform:translateX(0)}50%{transform:translateX(.35%)}100%{transform:translateX(-.25%)}}",
"@keyframes bmfx-gr{0%{transform:translate(0,0)}20%{transform:translate(-9%,6%)}40%{transform:translate(7%,-11%)}60%{transform:translate(-5%,-4%)}80%{transform:translate(10%,8%)}100%{transform:translate(0,0)}}",
"@keyframes bmfx-tr{0%{top:-20%}100%{top:110%}}",
"@keyframes bmfx-bl{0%{opacity:1}50%{opacity:.1}}",
"@property --bmang{syntax:'<angle>';inherits:false;initial-value:0deg}"
].join("");
document.head.appendChild(fxStyle);
const fxEl = document.createElement("div"); fxEl.id = "bmfx";
fxEl.innerHTML = '<div class="st"><canvas></canvas><div class="gr"></div><div class="tr"></div><div class="t2"></div><div class="sl"></div><div class="vg"></div><div class="lb"><b>\u25C4\u25C4</b> REW</div><div class="tc">-00:00.0</div><div class="bar"><i></i></div></div>';
const fxStage = fxEl.firstChild, fxCanvas = fxStage.querySelector("canvas"), fxCtx = fxCanvas.getContext("2d");
const fxTc = fxStage.querySelector(".tc"), fxBar = fxStage.querySelector(".bar i");
fxStage.querySelector(".gr").style.backgroundImage = "url(" + noise.toDataURL() + ")";
const flashEl = document.createElement("div"); flashEl.id = "bmflash";
document.body.appendChild(fxEl); document.body.appendChild(flashEl);
const flash = (a) => {
if (!S.fx.flash) return;
flashEl.style.transition = "none"; flashEl.style.opacity = a;
requestAnimationFrame(() => requestAnimationFrame(() => { flashEl.style.transition = "opacity .45s ease-out"; flashEl.style.opacity = 0; }));
};
const grayCss = () => "grayscale(" + (S.fx.gray / 100) + ") contrast(1.15) brightness(1.08)";
let viewFilter = null;
const place = () => {
const vw = VIEW(), b = vw && vw.getBoundingClientRect();
let l = 0, t = 0, w = innerWidth, h = innerHeight;
if (b && b.width > 10 && b.height > 10) { l = b.left; t = b.top; w = b.width; h = b.height; }
fxStage.style.left = l + "px"; fxStage.style.top = t + "px"; fxStage.style.width = w + "px"; fxStage.style.height = h + "px";
fxStage.style.fontSize = Math.max(11, Math.min(w, h) * 0.03) + "px";
};
const fxShow = () => {
place();
fxEl.classList.toggle("vhs", !!S.fx.vhs);
rw.live = !frames.length;
fxEl.classList.toggle("live", rw.live);
fxCanvas.style.display = rw.live ? "none" : "block";
if (rw.live) { const vw = VIEW(); viewFilter = vw.style.filter; vw.style.filter = grayCss(); }
else {
fxCanvas.width = fc.width || 320; fxCanvas.height = fc.height || 180;
fxCanvas.style.filter = grayCss();
}
fxEl.style.display = "block";
flash(0.6);
};
const fxHide = () => {
fxEl.style.display = "none";
if (viewFilter !== null) { VIEW().style.filter = viewFilter; viewFilter = null; }
flash(0.85);
};
const pad = (n) => (n < 10 ? "0" : "") + n;
const fxUpdate = (r) => {
place();
if (!r.live) {
const f = frameAt(r.t);
if (f && f !== r.lastF && !r.busy) {
r.busy = true; r.lastF = f;
createImageBitmap(f.b).then((bm) => { fxCtx.drawImage(bm, 0, 0, fxCanvas.width, fxCanvas.height); bm.close(); r.busy = false; }, () => { r.busy = false; });
}
}
const back = Math.max(0, (r.from - r.t) / 1000);
fxTc.textContent = "-" + pad(Math.floor(back / 60)) + ":" + pad(Math.floor(back % 60)) + "." + Math.floor((back % 1) * 10);
const total = Math.max(1, snaps[snaps.length - 1].t - r.floor);
fxBar.style.width = Math.max(0, Math.min(100, (r.t - r.floor) / total * 100)) + "%";
};

// ================= rewind engine =================
// hold mode: scrubs backward at S.rewRate x until released. Timed mode: smooth ride back N seconds.
const ease = (p) => p * p * (3 - 2 * p);
const startRewind = (o) => {
if (rw) return false;
if (rp) stopReplay();
const ch = findChar();
if (!ch || snaps.length < 2) { say("nothing recorded yet (start a run first)"); return false; }
const floor = snaps[0].t, from = o.base !== undefined ? o.base : clk();
const r = { floor, from, t: from, started: performance.now(), last: performance.now(), snap: snaps[snaps.length - 1], hold: !!o.hold, rate: o.rate || 1, to: null, dur: 0, busy: false, lastF: null, raf: 0, live: false };
if (!r.hold) {
r.to = Math.max(floor, from - o.sec * 1000);
const span = from - r.to;
if (span < 100) { say("not enough history yet"); return false; }
r.dur = Math.min(2500, Math.max(700, span / 4));
}
rw = r;
fxShow(); sndStart();
fxUpdate(r);
r.raf = requestAnimationFrame(rwStep);
return true;
};
const rwStep = () => {
const r = rw; if (!r) return;
const n = performance.now(), dt = n - r.last; r.last = n;
if (r.to !== null) {
const p = Math.min(1, (n - r.started) / r.dur);
r.t = r.from + (r.to - r.from) * ease(p);
if (p >= 1) { r.t = r.to; r.snap = snapAt(r.t); endRewind(); return; }
} else {
r.t = Math.max(r.floor, r.t - dt * r.rate);
}
r.snap = snapAt(r.t);
fxUpdate(r);
r.raf = requestAnimationFrame(rwStep);
};
const endRewind = () => {
const r = rw; if (!r) return;
cancelAnimationFrame(r.raf);
const ch = findChar(), s = r.snap || snaps[0];
let nRest = 0;
if (s && S.worldRec && W.samples.length) { try { nRest = applyWorld(s.t); } catch (e) { console.log("bm world restore", e); } }
if (ch && s) restoreState(ch, s);
if (s) {
snaps = snaps.filter((x) => x.t <= s.t); frames = frames.filter((f) => f.t <= s.t);
frameBytes = frames.reduce((a, f) => a + f.b.size, 0);
skew = performance.now() - s.t; lastS = lastF = s.t; lastW = 0;
}
const back = Math.round((r.from - r.t) / 100) / 10;
S.totalRew += Math.max(0, back);
if (S.worldRec) rebaseWorld();
rw = null; prevState = "flying"; offCount = 0;
fxHide(); sndStop();
say("rewound " + back + "s" + (nRest ? ", brought back " + nRest + " objects" : ""));
};

// ================= helpers: save slots, screenshot, clip =================
const saveSlot = (i) => { const c = findChar(); if (!c) { say("no run active"); return; } slots[i] = { x: c.x, y: c.y, vx: c.flyingVelocity.x, vy: c.flyingVelocity.y }; say("saved slot " + (i + 1)); };
const loadSlot = (i) => { const c = findChar(); if (!c) { say("no run active"); return; } if (!slots[i]) { say("slot " + (i + 1) + " is empty"); return; } restoreState(c, slots[i]); say("loaded slot " + (i + 1)); };
const dl = (href, name) => { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
const shot = () => {
try {
const app = B.pixiApp;
try { app.renderer.render(app.stage); } catch (e) { try { app.render(); } catch (e2) {} }
dl(VIEW().toDataURL("image/png"), "bouncemasters_" + Date.now() + ".png");
say("screenshot saved"); unlock("director");
} catch (e) { say("screenshot ERR: " + e); }
};
let mr = null, chunks = [], recBtn;
const toggleClip = () => {
if (mr) { mr.stop(); return; }
try {
const stream = VIEW().captureStream(60);
const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : {});
chunks = [];
mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
mr.onstop = () => {
const u = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
dl(u, "bouncemasters_" + Date.now() + ".webm");
setTimeout(() => URL.revokeObjectURL(u), 10000);
mr = null; recBtn.textContent = "\u25CF Record clip"; say("clip saved"); unlock("director");
};
mr.start(1000); recBtn.textContent = "\u25A0 Stop and save"; say("recording...");
} catch (e) { mr = null; say("record ERR: " + e); }
};

// ================= flags (switches and hotkeys share this) =================
let hudEl, fab;
const setFlag = (n, v) => {
S[n] = v;
if (n === "hover" && v) { const c = findChar(); S.holdY = c ? Math.round(c.y) : 0; }
if (n === "rec" && !v) clearBuf();
if (n === "keepDead" && !v) flushGrave(true);
if (n === "hud" && hudEl) hudEl.style.display = v ? "" : "none";
if (n === "fab" && fab) fab.style.display = v ? "" : "none";
say((LBL[n] || n) + (v ? " ON" : " OFF"));
};

// ================= UI =================
const spring = "cubic-bezier(.34,1.56,.64,1)", MONO = "ui-monospace,Menlo,Consolas,monospace";
const css = `
.p{position:relative;width:350px;color:var(--tx,#000);font:13px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;border-radius:34px;
background:var(--tint,linear-gradient(transparent,transparent)),linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.04));-webkit-backdrop-filter:blur(14px) saturate(190%) brightness(1.08);backdrop-filter:blur(14px) saturate(190%) brightness(1.08);
box-shadow:0 18px 50px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.1),inset 0 1px 1px rgba(255,255,255,.55);
transition:transform .6s ${spring};user-select:none;overflow:hidden}
.h,.b{position:relative;z-index:1}
.h{padding:15px 18px 9px;display:flex;justify-content:space-between;align-items:center;cursor:grab;touch-action:none;font-weight:700;font-size:15px}
.min{width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:linear-gradient(160deg,rgba(255,255,255,.35),rgba(255,255,255,.1));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:var(--tx,#000);font-size:15px;cursor:pointer;padding:0}
.b{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;max-height:78vh;overflow-y:auto}.b.hide{display:none}
.b::-webkit-scrollbar{width:6px}.b::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);border-radius:3px}
.tabs{display:flex;padding:3px;border-radius:18px;background:rgba(0,0,0,.22);box-shadow:inset 0 1px 3px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.2);flex:none}
.tab{flex:1;text-align:center;padding:8px 0;font-weight:600;font-size:11px;cursor:pointer;border-radius:15px;opacity:.7;transition:all .3s}
.tab.on{opacity:1;background:linear-gradient(160deg,rgba(255,255,255,.42),rgba(255,255,255,.14));box-shadow:inset 0 1px 1px rgba(255,255,255,.7),0 2px 8px rgba(0,0,0,.2)}
.pg{display:flex;flex-direction:column;gap:10px}.pg.hide{display:none}
.card{background:linear-gradient(160deg,rgba(255,255,255,.2),rgba(255,255,255,.06));border-radius:24px;padding:11px 13px;box-shadow:inset 0 1px 1px rgba(255,255,255,.5),inset 0 0 0 1px rgba(255,255,255,.12),0 4px 14px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:9px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.lbl{font-weight:600}.lbl small{display:block;opacity:.7;font-size:11px;font-weight:400;margin-top:1px}
.ttl{font-weight:700;font-size:11px;letter-spacing:.5px;opacity:.65}
.note{font-size:11px;opacity:.7;line-height:1.35}
.btn{border:0;border-radius:16px;padding:0 13px;height:30px;background:linear-gradient(160deg,rgba(255,255,255,.34),rgba(255,255,255,.12));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:var(--tx,#000);font:600 12px -apple-system,system-ui,sans-serif;cursor:pointer;flex:none;transition:transform .4s ${spring}}
.btn:active,.min:active{transform:scale(.88)}
.btn.hot{background:var(--ac,#34c759);color:#fff}
.btn.big{height:46px;border-radius:23px;font-size:14px;width:100%}
.btns{display:flex;gap:6px;flex-wrap:wrap}.btns .btn{flex:1;padding:0 8px}
.num{width:104px;box-sizing:border-box;height:30px;background:rgba(0,0,0,.22);border:0;border-radius:15px;padding:0 11px;color:var(--tx,#000);font:700 12.5px ${MONO};outline:none;text-align:right;box-shadow:inset 0 1px 3px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.2);user-select:text}
.num.s{width:70px}
.sw{width:50px;height:30px;border-radius:15px;background:rgba(255,255,255,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.25);position:relative;cursor:pointer;transition:background .3s;flex:none}
.sw i{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:transform .45s ${spring}}
.sw.on{background:var(--ac,#34c759)}.sw.on i{transform:translateX(20px)}
.srch{display:flex;gap:8px}.srch .num{flex:1;width:auto;text-align:left;font:12.5px -apple-system,system-ui,sans-serif}
.tbl{height:260px;overflow-y:auto;border-radius:20px;background:rgba(0,0,0,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28)}
.tbl::-webkit-scrollbar{width:6px}.tbl::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);border-radius:3px}
.tr{height:30px;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:0 8px 0 10px;border-bottom:1px solid rgba(255,255,255,.07)}
.nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px ${MONO}}
.tr input{width:84px;flex:none;box-sizing:border-box;background:rgba(255,255,255,.12);border:0;border-radius:9px;padding:4px 8px;color:var(--tx,#000);font:600 11.5px ${MONO};outline:none;text-align:right;user-select:text}
.lk{flex:none;width:24px;height:22px;border:0;border-radius:8px;background:rgba(255,255,255,.14);font-size:11px;cursor:pointer;padding:0;opacity:.6}.lk.on{background:var(--ac,#34c759);opacity:1}
.empty{padding:22px;text-align:center;opacity:.6;font-size:12px}
.status{display:none;position:sticky;bottom:0;font:11px ${MONO};min-height:13px;padding:5px 9px;border-radius:12px;background:rgba(0,0,0,.28);color:var(--tx,#000);word-break:break-word;flex:none}
.meter{height:8px;border-radius:4px;background:rgba(0,0,0,.25);overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--ac,#34c759);transition:width .25s}
.keys{font:11px/1.55 ${MONO};opacity:.85;white-space:pre-wrap}
textarea.num{width:100%;height:64px;padding:8px 10px;border-radius:14px;text-align:left;resize:none;font:11px ${MONO}}
.hud{position:fixed;top:10px;right:10px;padding:8px 11px;border-radius:14px;background:rgba(0,0,0,.42);color:#fff;font:11px/1.5 ${MONO};pointer-events:none;white-space:pre;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.hud b{color:var(--ac,#34c759);font-weight:700}
.fab{position:fixed;left:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);width:54px;height:54px;border-radius:50%;border:1px solid rgba(255,255,255,.45);background:linear-gradient(160deg,rgba(255,255,255,.45),rgba(255,255,255,.15));box-shadow:0 6px 20px rgba(0,0,0,.35),inset 0 1px 1px rgba(255,255,255,.7);color:var(--tx,#000);font:700 15px system-ui,sans-serif;cursor:pointer;touch-action:none;opacity:.8;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:transform .35s ${spring}}
.fab.hot{background:var(--ac,#34c759);color:#fff;transform:scale(1.15);opacity:1}
.tabs{position:relative}.tab{position:relative;z-index:1}.tab.on{background:none;box-shadow:none}
.pill{position:absolute;top:3px;bottom:3px;left:3px;border-radius:15px;background:linear-gradient(160deg,rgba(255,255,255,.45),rgba(255,255,255,.16));box-shadow:inset 0 1px 1px rgba(255,255,255,.7),0 2px 8px rgba(0,0,0,.2);transition:transform .5s ${spring}}
.p{animation:pin .8s cubic-bezier(.2,.9,.3,1.2)}.p.bounce{animation:pbounce .5s ease}
.p::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:2px;background:conic-gradient(from var(--bmang),transparent 55%,var(--ac,#34c759) 85%,transparent);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:bmang 5s linear infinite;pointer-events:none;z-index:3}
.pro{font-size:9px;letter-spacing:1px;padding:2px 6px;border-radius:8px;margin-left:8px;color:#000;vertical-align:middle;background:linear-gradient(90deg,#ffd60a,#fff4b0,#ffd60a);background-size:200% 100%;animation:shine 2.4s linear infinite}
.pg:not(.hide)>.card{animation:cardin .5s cubic-bezier(.2,.9,.3,1.2) both}
.pg:not(.hide)>.card:nth-child(2){animation-delay:.05s}.pg:not(.hide)>.card:nth-child(3){animation-delay:.1s}.pg:not(.hide)>.card:nth-child(4){animation-delay:.15s}.pg:not(.hide)>.card:nth-child(5){animation-delay:.2s}.pg:not(.hide)>.card:nth-child(6){animation-delay:.25s}
.btn{position:relative;overflow:hidden}
.rip{position:absolute;border-radius:50%;background:rgba(255,255,255,.6);transform:scale(0);animation:rip .6s ease-out forwards;pointer-events:none}
.toasts{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.toast{padding:8px 16px;border-radius:18px;background:rgba(20,20,26,.78);color:#fff;font:600 12px system-ui,sans-serif;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 0 0 1px rgba(255,255,255,.12);opacity:0;transform:translateY(-14px) scale(.9);transition:all .4s ${spring}}
.toast.in{opacity:1;transform:none}
.pop{position:fixed;left:50%;top:22%;font:900 clamp(24px,5vw,46px) system-ui,sans-serif;font-style:italic;color:#fff;text-shadow:0 0 20px var(--ac,#34c759),0 4px 0 rgba(0,0,0,.4);pointer-events:none;white-space:nowrap;animation:popk 1.4s cubic-bezier(.2,.9,.3,1.3) forwards}
.cf{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.agrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ach{padding:8px 10px;border-radius:14px;background:rgba(0,0,0,.18);opacity:.45;transition:all .4s}.ach b{display:block;font-size:11px}.ach small{font-size:10px;opacity:.8}
.ach.on{opacity:1;background:linear-gradient(160deg,var(--ac,#34c759),rgba(255,255,255,.12));color:#fff;box-shadow:0 0 14px var(--ac,#34c759)}
.pal{position:fixed;left:50%;top:16%;width:min(460px,92vw);transform:translateX(-50%) scale(.95);opacity:0;pointer-events:none;border-radius:22px;background:rgba(18,18,24,.84);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:0 24px 70px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.12);overflow:hidden;transition:all .3s ${spring}}
.pal.open{opacity:1;transform:translateX(-50%) scale(1);pointer-events:auto}
.palin{width:100%;box-sizing:border-box;border:0;background:transparent;color:#fff;padding:16px 18px;font:600 15px system-ui,sans-serif;outline:none}
.pall{border-top:1px solid rgba(255,255,255,.08)}
.pi{padding:10px 18px;font:500 13px system-ui,sans-serif;cursor:pointer;color:#fff}.pi.on{background:var(--ac,#34c759)}
@keyframes pin{0%{transform:scale(.8) translateY(20px);opacity:0}100%{transform:none;opacity:1}}
@keyframes pbounce{0%{transform:scale(1)}40%{transform:scale(.96)}75%{transform:scale(1.02)}100%{transform:scale(1)}}
@keyframes bmang{to{--bmang:360deg}}
@keyframes shine{to{background-position:-200% 0}}
@keyframes cardin{0%{opacity:0;transform:translateY(14px) scale(.96)}100%{opacity:1;transform:none}}
@keyframes rip{to{transform:scale(4);opacity:0}}
@keyframes popk{0%{opacity:0;transform:translateX(-50%) scale(.3) rotate(-6deg)}15%{opacity:1;transform:translateX(-50%) scale(1.15) rotate(2deg)}30%{transform:translateX(-50%) scale(1)}80%{opacity:1}100%{opacity:0;transform:translateX(-50%) translateY(-40px) scale(1)}}
`;

const el = (tag, props, kids) => { const n = document.createElement(tag); if (props) Object.assign(n, props); (kids || []).forEach((k) => n.appendChild(k)); return n; };
const host = el("div");
host.style.cssText = "position:fixed;top:50px;left:12px;z-index:2147483647;";
["mousedown", "mouseup", "mousemove", "click", "dblclick", "touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu", "keydown", "keyup", "keypress", "input", "change"]
.forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
const root = host.attachShadow({ mode: "open" });
status = el("div", { className: "status" });
const minBtn = el("button", { className: "min", textContent: "\u2013" });
const head = el("div", { className: "h" }, [el("span", { innerHTML: 'Bouncemasters Mod <span class="pro">PRO</span>' }), minBtn]);

// ---- helpers ----
const fmt = (v) => (typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v));
const lbl = (t, s) => el("div", { className: "lbl" }, [document.createTextNode(t), el("small", { textContent: s || "" })]);
const live = []; // [input, getter] pairs refreshed every second
const box = (get, set, small) => {
const input = el("input", { type: "text", className: "num" + (small ? " s" : ""), spellcheck: false });
input.onchange = () => {
const v = Number(input.value.trim());
if (input.value.trim() === "" || !isFinite(v)) { say("not a number"); input.value = fmt(get()); return; }
try { set(v); say("set to " + v); } catch (e) { say("set ERR: " + e); }
};
input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };
live.push([input, get]);
return input;
};
const sw = (get, set) => {
const n = el("div", { className: "sw" }, [el("i")]);
const draw = () => n.classList.toggle("on", !!get());
n.onclick = () => { set(!get()); draw(); };
swDraws.push(draw);
draw(); return n;
};
const flag = (n) => sw(() => S[n], (v) => setFlag(n, v));
const btn = (t, fn, cls) => {
const b = el("button", { className: "btn" + (cls ? " " + cls : ""), textContent: t }); b.onclick = fn;
b.addEventListener("pointerdown", (e) => { const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) / 4; const n = el("span", { className: "rip" }); n.style.cssText = "width:" + d + "px;height:" + d + "px;left:" + (e.clientX - r.left - d / 2) + "px;top:" + (e.clientY - r.top - d / 2) + "px"; b.appendChild(n); setTimeout(() => n.remove(), 650); });
return b;
};
const slid = (min, max, get, set, suf) => {
const i = el("input", { type: "range", min, max, value: get() });
i.style.cssText = "width:112px;accent-color:var(--ac,#34c759)";
const t = el("span", { className: "nm", textContent: get() + suf });
t.style.cssText = "flex:none;width:46px;text-align:right";
i.oninput = () => { set(+i.value); t.textContent = get() + suf; };
swDraws.push(() => { if (+i.value !== get() && root.activeElement !== i) { i.value = get(); t.textContent = get() + suf; } });
return el("div", { className: "row", style: "gap:6px" }, [i, t]);
};
const R = (a, b) => el("div", { className: "row" }, [a, b]);
const RR = (...k) => el("div", { className: "row", style: "gap:6px" }, k);
const card = (title, kids) => el("div", { className: "card" }, (title ? [el("div", { className: "ttl", textContent: title })] : []).concat(kids));
const holdBtn = (b) => {
b.style.touchAction = "none";
b.addEventListener("contextmenu", (e) => e.preventDefault());
b.addEventListener("pointerdown", (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (x) {} if (startRewind({ hold: true, rate: S.rewRate })) b.classList.add("hot"); });
const up = () => { b.classList.remove("hot"); if (rw && rw.hold) endRewind(); };
["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => b.addEventListener(ev, up));
return b;
};
const setMoneyBase = {}; // last known coin/gem values for multipliers
const setMoney = (k, v) => { M()[k].value = v; setMoneyBase[k] = v; };
const addMoney = (k, d) => { try { setMoney(k, (Number(M()[k].value) || 0) + d); say("+" + d.toLocaleString() + " " + k); } catch (e) { say("ERR: " + e); } };

// ================= flex layer: toasts, popups, confetti, achievements, replay, flex card =================
const toastBox = el("div", { className: "toasts" });
let lastToast = 0;
toast = (msg) => {
if (!S.toasts) return;
const nw = performance.now(); if (nw - lastToast < 280) return; lastToast = nw;
const n = el("div", { className: "toast", textContent: msg });
toastBox.appendChild(n);
requestAnimationFrame(() => requestAnimationFrame(() => n.classList.add("in")));
setTimeout(() => { n.classList.remove("in"); setTimeout(() => n.remove(), 450); }, 2300);
while (toastBox.children.length > 3) toastBox.firstChild.remove();
};
const popup = (txt) => { const n = el("div", { className: "pop", textContent: txt }); root.appendChild(n); setTimeout(() => n.remove(), 1500); };
const cf = el("canvas", { className: "cf" });
let parts = [], cfRun = false;
const cfStep = () => {
const c = cf.getContext("2d"); c.clearRect(0, 0, cf.width, cf.height);
parts = parts.filter((p) => p.life > 0);
parts.forEach((p) => { p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.a += p.va; p.life -= 0.012; c.save(); c.globalAlpha = Math.max(0, p.life); c.translate(p.x, p.y); c.rotate(p.a); c.fillStyle = p.c; c.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); c.restore(); });
if (parts.length) requestAnimationFrame(cfStep); else { cfRun = false; c.clearRect(0, 0, cf.width, cf.height); }
};
const confetti = (n) => {
if (!S.confetti) return;
cf.width = innerWidth; cf.height = innerHeight;
const cols = [S.accent, "#ffffff", "#ffd60a", "#ff375f", "#64d2ff", "#bf5af2"];
for (let i = 0; i < (n || 90); i++) parts.push({ x: innerWidth / 2, y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 3, r: Math.random() * 6 + 3, c: cols[i % cols.length], a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4, life: 1 });
if (!cfRun) { cfRun = true; requestAnimationFrame(cfStep); }
};
const coinsNow = () => { try { return Number(M().coins.value) || 0; } catch (e) { return 0; } };
const ACH = [
["rew1", "Time Traveler", "Rewind for the first time", () => S.totalRew >= 1],
["rew60", "Chrono Lord", "Rewind 60 seconds in total", () => S.totalRew >= 60],
["sky", "Sky High", "Reach a height of 50,000", () => st.bestY >= 50000],
["mach", "Speed Demon", "Hit a speed of 15,000", () => S.bestV >= 15000],
["combo25", "Combo Breaker", "Land a x25 combo", () => bestCombo >= 25],
["bounce500", "Pogo Master", "500 bounces in total", () => S.bounces >= 500],
["mil", "Millionaire", "Own 1,000,000 coins", () => coinsNow() >= 1e6],
["bil", "Billionaire", "Own 1,000,000,000 coins", () => coinsNow() >= 1e9],
["ghost", "Ghost", "Phase through obstacles", () => S.phase],
["hack", "Hacker", "Freeze 3 variables", () => locks.size >= 3],
["marathon", "Marathon", "Play 10 runs in a session", () => runs >= 10],
["director", "Director", "Capture a screenshot, clip or flex card", () => false],
["nostalgia", "Instant Replay", "Watch a replay", () => false]
];
const achGrid = el("div", { className: "agrid" }), achCount = el("div", { className: "note" });
const achEls = ACH.map((a) => { const d = el("div", { className: "ach", title: a[2] }, [el("b", { textContent: a[1] }), el("small", { textContent: a[2] })]); achGrid.appendChild(d); return d; });
const drawAch = () => { let n = 0; ACH.forEach((a, i) => { const on = !!S.ach[a[0]]; if (on) n++; achEls[i].classList.toggle("on", on); }); achCount.textContent = n + " of " + ACH.length + " unlocked"; };
const unlock = (id) => {
if (S.ach[id]) return;
const a = ACH.find((x) => x[0] === id); if (!a) return;
S.ach[id] = Date.now(); popup("\u{1F3C6} " + a[1]); say("Achievement: " + a[1]); confetti(80); drawAch();
};
drawAch();

// instant replay: plays the buffered footage forward (optionally saves it as a clip)
const fxLb = fxStage.querySelector(".lb");
const stopReplay = () => {
const r = rp; if (!r) return;
rp = null; cancelAnimationFrame(r.raf);
if (r.mr && r.mr.state !== "inactive") setTimeout(() => { try { r.mr.stop(); } catch (e) {} }, 400);
fxEl.style.display = "none"; fxEl.className = ""; fxLb.innerHTML = "<b>\u25C4\u25C4</b> REW"; flash(0.3);
};
const replay = (sec, spd, save) => {
if (rw || rp) return;
if (frames.length < 5) { say("no footage yet, play a bit first"); return; }
const end = frames[frames.length - 1].t, from = Math.max(frames[0].t, end - sec * 1000);
place(); fxEl.className = "rp"; fxEl.style.display = "block";
fxCanvas.style.display = "block"; fxCanvas.width = fc.width || 320; fxCanvas.height = fc.height || 180; fxCanvas.style.filter = "none";
fxLb.innerHTML = "\u25B6 REPLAY";
const r = rp = { from, end, spd, started: performance.now(), busy: false, lastF: null, mr: null, ch: [], raf: 0 };
if (save) {
try {
const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
r.mr = new MediaRecorder(fxCanvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : {});
r.mr.ondataavailable = (e) => { if (e.data && e.data.size) r.ch.push(e.data); };
r.mr.onstop = () => { const u = URL.createObjectURL(new Blob(r.ch, { type: "video/webm" })); dl(u, "bouncemasters_replay_" + Date.now() + ".webm"); setTimeout(() => URL.revokeObjectURL(u), 10000); say("replay clip saved"); };
r.mr.start(500);
} catch (e) { r.mr = null; }
}
flash(0.4); unlock("nostalgia");
const step = () => {
if (rp !== r) return;
const t = r.from + (performance.now() - r.started) * r.spd;
if (t >= r.end) { stopReplay(); return; }
place();
const f = frameAt(t);
if (f && f !== r.lastF && !r.busy) { r.busy = true; r.lastF = f; createImageBitmap(f.b).then((bm) => { fxCtx.drawImage(bm, 0, 0, fxCanvas.width, fxCanvas.height); bm.close(); r.busy = false; }, () => { r.busy = false; }); }
const el2 = (t - r.from) / 1000;
fxTc.textContent = "+" + pad(Math.floor(el2 / 60)) + ":" + pad(Math.floor(el2 % 60)) + "." + Math.floor((el2 % 1) * 10);
fxBar.style.width = ((t - r.from) / Math.max(1, r.end - r.from) * 100) + "%";
r.raf = requestAnimationFrame(step);
};
r.raf = requestAnimationFrame(step);
};

// flex card: shareable image of your stats
const flexCard = () => {
const c = document.createElement("canvas"); c.width = 1080; c.height = 1350;
const g = c.getContext("2d");
const bg = g.createLinearGradient(0, 0, 1080, 1350); bg.addColorStop(0, "#0b0b14"); bg.addColorStop(1, "#1a1030");
g.fillStyle = bg; g.fillRect(0, 0, 1080, 1350);
const gl = g.createRadialGradient(540, 380, 40, 540, 380, 760); gl.addColorStop(0, S.accent + "77"); gl.addColorStop(1, "rgba(0,0,0,0)");
g.fillStyle = gl; g.fillRect(0, 0, 1080, 1350);
g.textAlign = "center"; g.fillStyle = "#fff";
g.font = "900 84px system-ui,sans-serif"; g.fillText("BOUNCEMASTERS", 540, 190);
g.font = "700 34px system-ui,sans-serif"; g.fillStyle = S.accent; g.fillText("SESSION FLEX CARD", 540, 250);
const rows = [["HEIGHT RECORD", Math.round(S.bestH)], ["TOP SPEED", Math.round(S.bestV)], ["BEST COMBO", bestCombo], ["TOTAL BOUNCES", S.bounces], ["COINS GAINED", Math.round(coinsNow() - coins0)], ["TIME REWOUND", Math.round(S.totalRew) + "s"]];
rows.forEach((r, i) => {
const y = 420 + i * 140;
g.fillStyle = "rgba(255,255,255,.08)"; g.beginPath(); g.roundRect ? g.roundRect(90, y - 70, 900, 118, 30) : g.rect(90, y - 70, 900, 118); g.fill();
g.textAlign = "left"; g.fillStyle = "rgba(255,255,255,.65)"; g.font = "700 28px system-ui,sans-serif"; g.fillText(r[0], 130, y - 8);
g.textAlign = "right"; g.fillStyle = "#fff"; g.font = "900 62px ui-monospace,Menlo,monospace"; g.fillText(typeof r[1] === "number" ? r[1].toLocaleString() : r[1], 950, y + 24);
});
g.textAlign = "center"; g.fillStyle = "rgba(255,255,255,.5)"; g.font = "600 28px system-ui,sans-serif";
g.fillText(new Date().toLocaleDateString() + "   \u2022   " + Object.keys(S.ach).length + " achievements   \u2022   modded", 540, 1290);
dl(c.toDataURL("image/png"), "bouncemasters_flex_" + Date.now() + ".png");
unlock("director"); confetti(100); say("flex card saved");
};

// command palette (/ or Ctrl+K)
const pal = el("div", { className: "pal" }), palIn = el("input", { type: "text", className: "palin", placeholder: "Type a command...  (Esc to close)", spellcheck: false }), palList = el("div", { className: "pall" });
pal.appendChild(palIn); pal.appendChild(palList);
let palSel = 0, palItems = [];
const CMDS = [];
const palRender = () => {
const q = palIn.value.toLowerCase().split(/\s+/).filter(Boolean);
palItems = CMDS.filter((c) => q.every((w) => c[0].toLowerCase().indexOf(w) >= 0)).slice(0, 9);
palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
palList.innerHTML = "";
palItems.forEach((c, i) => { const d = el("div", { className: "pi" + (i === palSel ? " on" : ""), textContent: c[0] }); d.onclick = () => palRun(i); palList.appendChild(d); });
};
const togglePal = (v) => {
const open = v === undefined ? !pal.classList.contains("open") : v;
pal.classList.toggle("open", open);
if (open) { palIn.value = ""; palSel = 0; palRender(); setTimeout(() => palIn.focus(), 30); } else palIn.blur();
};
const palRun = (i) => { const c = palItems[i]; if (!c) return; togglePal(false); try { c[1](); } catch (e) { say("ERR " + e); } };
palIn.addEventListener("input", () => { palSel = 0; palRender(); });
palIn.addEventListener("keydown", (e) => {
if (e.key === "Escape") togglePal(false);
else if (e.key === "ArrowDown") { palSel = Math.min(palItems.length - 1, palSel + 1); palRender(); e.preventDefault(); }
else if (e.key === "ArrowUp") { palSel = Math.max(0, palSel - 1); palRender(); e.preventDefault(); }
else if (e.key === "Enter") palRun(palSel);
});

// ===== TAB: Main =====
const money = card(null, [
R(lbl("Coins", "saved by the game"), box(() => M().coins.value, (v) => setMoney("coins", v))),
el("div", { className: "btns" }, [btn("+1K", () => addMoney("coins", 1e3)), btn("+100K", () => addMoney("coins", 1e5)), btn("+10M", () => addMoney("coins", 1e7)), btn("+1B", () => addMoney("coins", 1e9))]),
R(lbl("Gems"), box(() => M().gems.value, (v) => setMoney("gems", v))),
el("div", { className: "btns" }, [btn("+100", () => addMoney("gems", 100)), btn("+10K", () => addMoney("gems", 1e4)), btn("+1M", () => addMoney("gems", 1e6))]),
R(lbl("Best distance", "your record"), box(() => M().maxDistance.value, (v) => { M().maxDistance.value = v; }))
]);
const mult = card("EARNINGS MULTIPLIER", [
R(lbl("Coins x", "every coin you pick up"), box(() => S.cm, (v) => { S.cm = Math.max(1, v); }, true)),
R(lbl("Gems x", "every gem you pick up"), box(() => S.gm, (v) => { S.gm = Math.max(1, v); }, true))
]);

// upgrades: level box + value override (empty = game's own value). Overrides skip the max cap.
const UP = [["ability", "Ability"], ["beatForce", "Power (beat force)"], ["groundCollision", "Ground collision"], ["maxVelocity", "Max velocity"]];
const applyOv = (name) => {
const u = M().upgrades[name], v = S.ov[name];
if (v === undefined || v === null) { try { delete u.value; } catch (e) {} return; }
Object.defineProperty(u, "value", { configurable: true, enumerable: true, get: () => S.ov[name] });
};
const upCard = card("UPGRADES: LEVEL | VALUE OVERRIDE", []);
UP.forEach(([name, title]) => {
const lv = box(() => M().upgrades[name].level.value, (v) => { M().upgrades[name].level.value = v; }, true);
const vo = el("input", { type: "text", className: "num s", spellcheck: false, placeholder: "game" });
vo.value = S.ov[name] === undefined ? "" : String(S.ov[name]);
vo.onchange = () => {
const t = vo.value.trim();
try {
if (t === "") { delete S.ov[name]; applyOv(name); say(title + " back to normal"); }
else { const v = Number(t); if (!isFinite(v)) { say("not a number"); return; } S.ov[name] = v; applyOv(name); say(title + " value = " + v + " (applies from the next launch)"); }
} catch (e) { say("override ERR: " + e); }
};
vo.onkeydown = (e) => { if (e.key === "Enter") vo.blur(); };
upCard.appendChild(R(lbl(title), RR(lv, vo)));
try { applyOv(name); } catch (e) {}
});
const page0 = el("div", { className: "pg" }, [money, mult, upCard]);

// ===== TAB: Cheats =====
const L = { vx: -3000, vy: 3000 };
const phys = card("PHYSICS", [
R(lbl("Gravity", "1% is almost none"), slid(1, 300, () => S.grav, (v) => { S.grav = v; }, "%")),
R(lbl("Game speed", "slow-mo / fast (M key)"), slid(10, 300, () => S.speed, (v) => { S.speed = v; }, "%")),
R(lbl("Bouncy floor", "ground always bounces you"), flag("floor")),
R(lbl("Bounce strength", "x of impact speed"), box(() => S.bounce, (v) => { S.bounce = Math.max(0, v); }, true)),
R(lbl("Min bounce speed", "keeps you from settling"), box(() => S.minBounce, (v) => { S.minBounce = Math.max(0, v); }, true)),
R(lbl("Phase through obstacles", "coins and gems still collect"), flag("phase"))
]);
const flight = card("FLIGHT", [
R(lbl("Hover", "freeze height (O key)"), flag("hover")),
R(lbl("Hover height"), box(() => S.holdY, (v) => { S.holdY = v; }, true)),
R(lbl("Fly mode", "WASD / arrows (F key)"), flag("fly")),
R(lbl("Fly speed"), box(() => S.flySpeed, (v) => { S.flySpeed = Math.abs(v); }, true)),
R(lbl("Cruise control", "locks forward speed (C key)"), flag("cruise")),
R(lbl("Cruise X speed", "negative = forward"), box(() => S.cruiseVx, (v) => { S.cruiseVx = v; }, true))
]);
const pos = card("POSITION (during a run)", [
R(lbl("X", "you move toward negative X"), box(() => { const c = findChar(); return c ? c.x : 0; }, (v) => { const c = findChar(); if (!c) throw "no run active"; c.x = v; }, false)),
R(lbl("Height (Y)"), box(() => { const c = findChar(); return c ? c.y : 0; }, (v) => { const c = findChar(); if (!c) throw "no run active"; c.y = v; }, false))
]);
const setVel = (vx, vy) => { const c = findChar(); if (!c) { say("no run active"); return; } if (vx !== null) c.flyingVelocity.x = vx; if (vy !== null) c.flyingVelocity.y = vy; c.isNeedRecalculatePredictions = true; say("velocity set"); };
const launch = card("LAUNCHER", [
R(lbl("Velocity X"), box(() => L.vx, (v) => { L.vx = v; }, true)),
R(lbl("Velocity Y"), box(() => L.vy, (v) => { L.vy = v; }, true)),
el("div", { className: "btns" }, [btn("Launch", () => setVel(L.vx, L.vy)), btn("Stop X", () => setVel(0, null)), btn("Stop Y", () => setVel(null, 0)), btn("Stop all", () => setVel(0, 0))])
]);
const slotRows = [0, 1, 2].map((i) => R(lbl("Slot " + (i + 1), i === 0 ? "Q saves, E loads" : ""), RR(btn("Save", () => saveSlot(i)), btn("Load", () => loadSlot(i)))));
const CHEAT0 = { grav: 100, speed: 100, floor: false, bounce: 1, minBounce: 1200, phase: false, hover: false, fly: false, cruise: false, cruiseVx: -1500 };
const MODES = [["Moon", { grav: 22 }], ["Pinball", { floor: true, bounce: 1.15, minBounce: 2500 }], ["Rocket", { grav: 15, cruise: true, cruiseVx: -6000 }], ["Ghost", { phase: true, floor: true }], ["Bullet time", { speed: 35 }], ["Chaos", { grav: 280, speed: 140, floor: true, bounce: 1.35 }], ["Reset", {}]];
const applyMode = (name, o) => { Object.assign(S, CHEAT0, o); swDraws.forEach((f) => { try { f(); } catch (e) {} }); say("mode: " + name); popup(name.toUpperCase()); };
const modes = card("ONE-TAP MODES", [el("div", { className: "btns" }, MODES.map(([n, o]) => btn(n, () => applyMode(n, o))))]);
const page1 = el("div", { className: "pg hide" }, [modes, phys, flight, pos, launch, card("CHECKPOINTS", slotRows)]);

// ===== TAB: Rewind =====
const meterI = el("i"), meterT = el("div", { className: "note", textContent: "buffer empty" });
const rsec = el("input", { type: "text", className: "num s", value: String(S.rewSec) });
rsec.onchange = () => { const n = Number(rsec.value); if (n >= 1) S.rewSec = Math.floor(n); };
const rbtn = btn("Rewind", () => { const n = Number(rsec.value); if (!(n >= 1)) { say("seconds must be 1 or more"); return; } S.rewSec = Math.floor(n); startRewind({ sec: n }); });
const bigHold = holdBtn(el("button", { className: "btn big", textContent: "\u25C4\u25C4  HOLD TO REWIND" }));
const asec = box(() => S.autoSec, (v) => { S.autoSec = Math.max(1, Math.floor(v)); }, true);
const rec = card("RECORDER", [
R(lbl("Record state", "10/s, video 20/s, memory capped"), flag("rec")),
R(lbl("Record video frames", "needed for the reversed footage"), flag("recFrames")),
el("div", { className: "meter" }, [meterI]), meterT,
btn("Clear buffer", () => { clearBuf(); say("buffer cleared"); })
]);
const rew = card("REWIND", [
bigHold,
el("div", { className: "note", textContent: "Hold R on keyboard, the button above, or the round button on screen. Release to resume from that moment. Shift+R rewinds the seconds below." }),
R(lbl("Seconds back", "smooth ride back"), RR(rsec, rbtn)),
R(lbl("Hold speed", "x real time"), slid(1, 10, () => S.rewRate, (v) => { S.rewRate = v; }, "x")),
R(lbl("Second chance", "auto rewind when the run ends"), flag("autoRew")),
R(lbl("Second chance seconds"), asec),
el("div", { className: "note", textContent: "Second chance only works if the game keeps the character around after the run ends. Turn it off if it triggers when it shouldn't." })
]);
const fxCard = card("EFFECTS", [
R(lbl("Black and white", "0 = color, 100 = full"), slid(0, 100, () => S.fx.gray, (v) => { S.fx.gray = v; }, "%")),
R(lbl("VHS glitch", "tracking bar, grain, scanlines"), sw(() => S.fx.vhs, (v) => { S.fx.vhs = v; })),
R(lbl("Rewind sound", "tape whirr"), sw(() => S.fx.sound, (v) => { S.fx.sound = v; })),
R(lbl("White flash", "on start and stop"), sw(() => S.fx.flash, (v) => { S.fx.flash = v; }))
]);
const world = card("WORLD REWIND", [
R(lbl("Record the world", "trees, coins, walruses"), flag("worldRec")),
R(lbl("Game logic lists", "spawn and collision lists"), flag("logicRec")),
R(lbl("Keep destroyed objects", "nothing is gone for good"), flag("keepDead")),
R(lbl("Full world rewind", "also moves and animations"), flag("worldFull")),
R(lbl("Memory cap", "oldest footage dropped first"), slid(32, 768, () => S.memMB, (v) => { S.memMB = v; }, "MB")),
el("div", { className: "note", textContent: "Anything that left the screen (trees, coins, walruses) comes back when you rewind, and your coin balance never rolls back. Full mode also reverses moving objects and animations, but is more experimental. The cap keeps school Chromebooks from running out of memory." })
]);
const page2 = el("div", { className: "pg hide" }, [rec, world, rew, fxCard]);

// ===== TAB: Stats =====
const gc = el("canvas", { width: 600, height: 180 });
gc.style.cssText = "width:100%;height:90px;border-radius:14px;background:rgba(0,0,0,.25)";
const hist = [];
const statLine = (name) => { const v = el("div", { className: "nm", textContent: "-" }); v.style.cssText = "flex:none;text-align:right;font-weight:700"; return [R(lbl(name), v), v]; };
const [sRunsR, sRuns] = statLine("Runs this session"), [sHR, sH] = statLine("Best height"), [sVR, sV] = statLine("Best speed"), [sCR, sC] = statLine("Coins gained (net)"), [sFR, sF] = statLine("FPS");
recBtn = btn("\u25CF Record clip", toggleClip);
const [sBCR, sBC] = statLine("Best combo"), [sBoR, sBo] = statLine("Bounces (total)"), [sTR, sTm] = statLine("Time rewound");
const page3 = el("div", { className: "pg hide" }, [
card("LIVE GRAPH (60s)", [gc, el("div", { className: "note", textContent: "accent line = height, white line = speed" })]),
card("SESSION", [sRunsR, sHR, sVR, sBCR, sBoR, sCR, sTR, sFR]),
card("ACHIEVEMENTS", [achCount, achGrid]),
card("INSTANT REPLAY", [
el("div", { className: "btns" }, [btn("Last 10s", () => replay(10, 1, false)), btn("30s at 2x", () => replay(30, 2, false)), btn("Slow-mo", () => replay(10, 0.4, false))]),
el("div", { className: "btns" }, [btn("Save a 10s clip", () => replay(10, 1, true))]),
el("div", { className: "note", textContent: "Esc stops a replay." })
]),
card("SHARE", [el("div", { className: "btns" }, [btn("Flex card", flexCard), btn("Screenshot", shot), recBtn]), el("div", { className: "note", textContent: "Downloads can be blocked inside some embedded players." })]),
card("EXTRAS", [R(lbl("On-screen stats", "V key"), flag("hud")), R(lbl("Toasts", "little notifications"), flag("toasts")), R(lbl("Confetti", "records and combos"), flag("confetti"))])
]);
const drawGraph = () => {
const c = gc.getContext("2d"); c.clearRect(0, 0, 600, 180);
if (hist.length < 2) return;
let my = 1, ms = 1;
hist.forEach((h) => { if (h.y > my) my = h.y; if (h.sp > ms) ms = h.sp; });
const line = (key, mx, col) => { c.beginPath(); hist.forEach((h, i) => { const x = i * 600 / 599, y = 172 - Math.max(0, h[key]) / mx * 160; if (i) c.lineTo(x, y); else c.moveTo(x, y); }); c.strokeStyle = col; c.lineWidth = 3; c.lineJoin = "round"; c.stroke(); };
line("sp", ms, "#ffffff"); line("y", my, S.accent);
};

// ===== TAB: Vars (variable explorer: read, write, freeze any value) =====
const ROOTS = [["meta", () => M()], ["char", () => findChar()], ["game", () => B]];
let allRows = [], rows = [], pool = null, snapVals = null, mode = null;
const resolve = (r) => {
let o = ROOTS.find((x) => x[0] === r.root)[1]();
for (let i = 0; i < r.keys.length - 1; i++) { if (o == null) return null; o = o[r.keys[i]]; }
return o == null ? null : [o, r.keys[r.keys.length - 1]];
};
const readRow = (r) => { try { const p = resolve(r); return p ? p[0][p[1]] : undefined; } catch (e) { return undefined; } };
const scan = () => {
const out = [], seen = new WeakSet();
const walk = (o, rootName, keys, path, depth) => {
if (depth > 5 || out.length >= 4000) return;
let ks; try { ks = Object.keys(o); } catch (e) { return; }
if (Array.isArray(o) && ks.length > 100) ks = ks.slice(0, 100);
if ("_key" in o && "value" in o) { out.push({ root: rootName, keys: keys.concat("value"), path: path + ".value" }); return; }
for (const k of ks) {
if (out.length >= 4000) return;
if (k[0] === "_" || k === "parent" || k === "children" || k === "transform" || k === "sprite") continue;
let v; try { v = o[k]; } catch (e) { continue; }
const t = typeof v, p = path + (Array.isArray(o) ? "[" + k + "]" : "." + k);
if (t === "number" || t === "boolean" || t === "string") out.push({ root: rootName, keys: keys.concat(k), path: p });
else if (v && t === "object" && !seen.has(v) && !(v instanceof Node)) { seen.add(v); walk(v, rootName, keys.concat(k), p, depth + 1); }
}
};
ROOTS.forEach(([name, get]) => { let o; try { o = get(); } catch (e) {} if (o && typeof o === "object") { seen.add(o); walk(o, name, [], name, 0); } });
return out;
};
const search = el("input", { type: "text", className: "num", placeholder: "Search name or value..." });
const rescan = btn("Rescan", null);
const tbl = el("div", { className: "tbl" });
let shown = [];
const source = () => pool || allRows;
const render = () => {
tbl.innerHTML = ""; shown = [];
if (!rows.length) { tbl.appendChild(el("div", { className: "empty", textContent: source().length ? "no matches" : "press Rescan (the char root needs a run to be active)" })); return; }
rows.slice(0, 150).forEach((r) => {
const cur2 = readRow(r);
const input = el("input", { type: "text", value: cur2 === undefined ? "" : String(cur2), spellcheck: false });
input.onchange = () => {
const t = input.value, p = resolve(r);
if (!p) { say("path gone, rescan"); return; }
const old = p[0][p[1]];
let v = t;
if (typeof old === "number") { v = Number(t); if (!isFinite(v)) { say("not a number"); input.value = String(old); return; } }
else if (typeof old === "boolean") v = t === "true" || t === "1";
try { p[0][p[1]] = v; if (locks.has(r.path)) locks.get(r.path).v = v; say(r.path + " = " + v); } catch (e) { say("set ERR: " + e); }
};
input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };
const lk = el("button", { className: "lk" + (locks.has(r.path) ? " on" : ""), textContent: "\u{1F512}", title: "freeze this value" });
lk.onclick = () => {
if (locks.has(r.path)) locks.delete(r.path); else locks.set(r.path, { r, v: readRow(r) });
lk.classList.toggle("on", locks.has(r.path)); say(locks.size + " frozen");
};
const nm = el("div", { className: "nm", textContent: r.path, title: r.path });
nm.style.cursor = "pointer";
nm.onclick = () => { try { navigator.clipboard.writeText(r.path); say("copied " + r.path); } catch (e) {} };
tbl.appendChild(el("div", { className: "tr" }, [nm, input, lk]));
shown.push([r, input]);
});
};
const diff = (r) => {
if (!snapVals || !mode) return true;
const a = snapVals.get(r.path), b = readRow(r);
if (mode === "chg") return a !== b;
if (mode === "same") return a === b;
if (mode === "up") return typeof b === "number" && b > a;
if (mode === "down") return typeof b === "number" && b < a;
return true;
};
const filter = () => {
const q = search.value.trim().toLowerCase();
rows = source().filter((r) => {
if (!diff(r)) return false;
if (!q) return true;
if (r.path.toLowerCase().indexOf(q) >= 0) return true;
const v = readRow(r);
return v !== undefined && String(v).toLowerCase() === q;
});
render(); say(rows.length + " of " + source().length + " variables");
};
let ft; search.addEventListener("input", () => { clearTimeout(ft); ft = setTimeout(filter, 200); });
rescan.onclick = () => { say("scanning..."); setTimeout(() => { try { allRows = scan(); pool = null; snapVals = null; mode = null; filter(); } catch (e) { say("scan ERR: " + e); } }, 20); };
const setMode = (m) => { if (!snapVals) { say("press Snapshot first"); return; } mode = m; filter(); };
const diffBar = el("div", { className: "btns" }, [
btn("Snapshot", () => { pool = rows.slice(); snapVals = new Map(); pool.forEach((r) => snapVals.set(r.path, readRow(r))); mode = null; filter(); say("snapshot of " + pool.length + ", now do something in game"); }),
btn("Changed", () => setMode("chg")), btn("Same", () => setMode("same")), btn("Up", () => setMode("up")), btn("Down", () => setMode("down")),
btn("Reset", () => { pool = null; snapVals = null; mode = null; filter(); }),
btn("Unfreeze all", () => { locks.clear(); render(); say("all unfrozen"); })
]);
const page4 = el("div", { className: "pg hide" }, [
el("div", { className: "srch" }, [search, rescan]), diffBar, tbl,
el("div", { className: "note", textContent: "Find an unknown value: Snapshot, change it in the game, press Changed (or Up/Down), repeat. Tap a name to copy its path, tap the lock to freeze a value." })
]);

// ===== TAB: Prefs =====
const accent = el("input", { type: "color", value: S.accent });
accent.style.cssText = "width:50px;height:30px;border:0;padding:0;background:none;cursor:pointer";
const THEMES = {
Mint: ["#34c759", "#000", ""],
Aurora: ["#64d2ff", "#fff", "linear-gradient(135deg,rgba(88,86,214,.5),rgba(0,0,0,.5))"],
Sunset: ["#ff9f0a", "#fff", "linear-gradient(135deg,rgba(255,55,95,.5),rgba(255,159,10,.3))"],
Neon: ["#ff2d95", "#fff", "linear-gradient(135deg,rgba(20,0,40,.75),rgba(90,0,100,.5))"],
Matrix: ["#00ff66", "#b6ffd0", "linear-gradient(135deg,rgba(0,20,0,.85),rgba(0,45,10,.6))"],
Gold: ["#ffd60a", "#fff", "linear-gradient(135deg,rgba(40,30,0,.8),rgba(100,70,0,.5))"],
Ice: ["#5ac8fa", "#000", "linear-gradient(135deg,rgba(255,255,255,.4),rgba(120,200,255,.25))"]
};
const applyTheme = () => {
const t = THEMES[S.theme] || THEMES.Mint;
host.style.setProperty("--ac", S.accent); host.style.setProperty("--tx", t[1]);
host.style.setProperty("--tint", t[2] || "linear-gradient(transparent,transparent)");
host.style.opacity = S.ui / 100;
};
const setTheme = (name) => { const t = THEMES[name]; if (!t) return; S.theme = name; S.accent = t[0]; accent.value = t[0]; applyTheme(); say("theme: " + name); };
accent.oninput = () => { S.accent = accent.value; applyTheme(); };
const ta = el("textarea", { className: "num", spellcheck: false, placeholder: "settings JSON" });
const persist = (force) => {
try {
const json = JSON.stringify({ s: S, pos: { l: host.offsetLeft, t: host.offsetTop }, min: body.classList.contains("hide") });
if (force || json !== persist.last) { localStorage.setItem(KEY, json); persist.last = json; }
} catch (e) {}
};
const page5 = el("div", { className: "pg hide" }, [
card("THEME", [el("div", { className: "btns" }, Object.keys(THEMES).map((n) => { const b = btn(n, () => setTheme(n)); b.style.boxShadow = "inset 0 -3px 0 " + THEMES[n][0]; return b; }))]),
card("APPEARANCE", [
R(lbl("Accent color"), accent),
R(lbl("Panel opacity"), slid(30, 100, () => S.ui, (v) => { S.ui = v; applyTheme(); }, "%")),
R(lbl("Hotkeys", "keyboard shortcuts"), flag("keys")),
R(lbl("Round rewind button", "hold it on screen"), flag("fab"))
]),
card("HOTKEYS", [el("div", { className: "keys", textContent:
"R hold    rewind\nShift+R   timed rewind\nQ / E     save / load slot 1\nB         bouncy floor\nP         phase\nO         hover\nF         fly (WASD, arrows)\nC         cruise control\nM         slow-mo toggle\nV         stats HUD\nJ         screenshot\nH         hide or show this panel\n/  Ctrl+K  command palette\nEsc       stop a replay" })]),
card("DATA", [
ta,
el("div", { className: "btns" }, [
btn("Export", () => { ta.value = JSON.stringify(S); try { navigator.clipboard.writeText(ta.value); } catch (e) {} say("settings exported (copied if allowed)"); }),
btn("Import", () => { try { const o = JSON.parse(ta.value); localStorage.setItem(KEY, JSON.stringify({ s: o.s || o })); say("imported, reloading..."); setTimeout(() => location.reload(), 400); } catch (e) { say("bad JSON"); } }),
btn("Reset all", () => { try { localStorage.removeItem(KEY); localStorage.removeItem("bmmod_v2"); } catch (e) {} location.reload(); })
])
])
]);

// ===== tabs =====
const TABS = [["Main", page0], ["Cheats", page1], ["Rewind", page2], ["Flex", page3], ["Vars", page4], ["Prefs", page5]];
const pill = el("div", { className: "pill" }); pill.style.width = "calc((100% - 6px) / " + TABS.length + ")";
const tabEls = TABS.map(([name], i) => { const t = el("div", { className: "tab", textContent: name }); t.onclick = () => setTab(i); return t; });
let scanned = false;
const setTab = (i) => {
S.tab = i;
pill.style.transform = "translateX(" + (i * 100) + "%)";
tabEls.forEach((t, j) => t.classList.toggle("on", j === i));
TABS.forEach(([, p], j) => p.classList.toggle("hide", j !== i));
if (i === 4 && !scanned) { scanned = true; rescan.onclick(); }
};

const body = el("div", { className: "b" }, [el("div", { className: "tabs" }, [pill].concat(tabEls))].concat(TABS.map((t) => t[1]), [status]));
const panel = el("div", { className: "p" }, [head, body]);
hudEl = el("div", { className: "hud" });
fab = holdBtn(el("button", { className: "fab", textContent: "\u25C4\u25C4", title: "hold to rewind" }));
root.appendChild(el("style", { textContent: css }));
root.appendChild(panel); root.appendChild(hudEl); root.appendChild(fab); root.appendChild(cf); root.appendChild(toastBox); root.appendChild(pal);
document.body.appendChild(host);
hudEl.style.display = S.hud ? "" : "none";
fab.style.display = S.fab ? "" : "none";
applyTheme();

// ---- periodic refresh ----
let tickN = 0;
setInterval(() => {
tickN++;
swDraws.forEach((f) => { try { f(); } catch (e) {} });
// buffer meter
trim();
const have = snaps.length ? (clk() - snaps[0].t) / 1000 : 0, used = W.bytes + frameBytes;
meterI.style.width = Math.min(100, used / (S.memMB * 1048576) * 100) + "%";
meterT.textContent = have.toFixed(0) + "s buffered, " + (used / 1048576).toFixed(0) + " of " + S.memMB + " MB, " + W.samples.length + " world steps, " + W.watch.length + " lists, " + frames.length + " frames";
if (combo && performance.now() - comboT > 4000) combo = 0;
for (let i = 0; i < ACH.length; i++) { const a = ACH[i]; if (!S.ach[a[0]]) { let ok = false; try { ok = a[3](); } catch (e) {} if (ok) { unlock(a[0]); break; } } }
// fps + stats
const now = performance.now(); fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now;
sRuns.textContent = String(runs); sH.textContent = Math.round(st.bestY).toLocaleString(); sV.textContent = Math.round(st.bestV).toLocaleString();
try { sC.textContent = Math.round(M().coins.value - coins0).toLocaleString(); } catch (e) {}
sF.textContent = String(fps);
sBC.textContent = String(bestCombo); sBo.textContent = S.bounces.toLocaleString(); sTm.textContent = Math.round(S.totalRew) + "s";
// hud
if (S.hud) {
const c = CH && CH.parent ? CH : null;
if (c) {
const dist = Math.abs(c.x - st.x0), t = (now - st.t0) / 1000;
hudEl.innerHTML = "<b>DIST</b>  " + Math.round(dist).toLocaleString() + "\n<b>HEIGHT</b> " + Math.round(c.y).toLocaleString() + "\n<b>SPEED</b>  " + Math.round(cur.sp).toLocaleString() + "\n<b>TIME</b>   " + t.toFixed(1) + "s\n<b>COMBO</b>  " + combo + "\n<b>FPS</b>    " + fps + (rw ? "\n<b>\u25C4\u25C4 REWINDING</b>" : "");
} else hudEl.textContent = "no run active";
}
if (S.tab === 3 && !body.classList.contains("hide")) drawGraph();
// inputs refresh once a second (skips the box you are typing in)
if (tickN % 4 === 0) {
live.forEach(([input, get]) => {
if (root.activeElement === input) return;
let s = ""; try { s = fmt(get()); } catch (e) {}
if (input.value !== s) input.value = s;
});
shown.forEach(([r, input]) => {
if (root.activeElement === input) return;
const v = readRow(r), s = v === undefined ? "" : String(v);
if (input.value !== s) input.value = s;
});
}
}, 250);
setInterval(() => { if (CH && CH.parent && !rw) { hist.push({ y: cur.y, sp: cur.sp }); if (hist.length > 600) hist.shift(); } }, 100);

// earnings multipliers: a gain is multiplied the moment it appears
setInterval(() => {
try {
[["coins", "cm"], ["gems", "gm"]].forEach(([k, mk]) => {
const o = M()[k]; if (!o) return;
const c = o.value;
if (setMoneyBase[k] === undefined) { setMoneyBase[k] = c; return; }
if (c > setMoneyBase[k] && S[mk] > 1) { const nv = Math.round(setMoneyBase[k] + (c - setMoneyBase[k]) * S[mk]); o.value = nv; setMoneyBase[k] = nv; }
else setMoneyBase[k] = c;
});
} catch (e) {}
}, 150);

// ---- hotkeys ----
const typing = (e) => { const t = (e.composedPath && e.composedPath()[0]) || e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
addEventListener("keydown", (e) => {
const k = (e.key || "").toLowerCase();
if (!typing(e)) held[k] = true;
if (k === "k" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); togglePal(); return; }
if (k === "escape") { stopReplay(); return; }
if (!S.keys || typing(e) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
if (k === "r") { if (e.shiftKey) startRewind({ sec: S.rewSec }); else startRewind({ hold: true, rate: S.rewRate }); }
else if (k === "q") saveSlot(0);
else if (k === "e") loadSlot(0);
else if (k === "b") setFlag("floor", !S.floor);
else if (k === "p") setFlag("phase", !S.phase);
else if (k === "o") setFlag("hover", !S.hover);
else if (k === "f") setFlag("fly", !S.fly);
else if (k === "c") setFlag("cruise", !S.cruise);
else if (k === "v") setFlag("hud", !S.hud);
else if (k === "m") { S.speed = S.speed === 100 ? 30 : 100; say("game speed " + S.speed + "%"); }
else if (k === "j") shot();
else if (k === "/") { e.preventDefault(); togglePal(true); }
else if (k === "h") host.style.display = host.style.display === "none" ? "" : "none";
else return;
swDraws.forEach((f) => { try { f(); } catch (x) {} });
});
addEventListener("keyup", (e) => {
const k = (e.key || "").toLowerCase();
held[k] = false;
if (k === "r" && rw && rw.hold) endRewind();
});
const dropKeys = () => { Object.keys(held).forEach((k) => { held[k] = false; }); if (rw && rw.hold) endRewind(); };
addEventListener("blur", dropKeys);
document.addEventListener("visibilitychange", () => { if (document.hidden) dropKeys(); });

// ---- drag, minimize, position ----
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const keep = () => {
host.style.left = clamp(host.offsetLeft, 0, Math.max(0, innerWidth - host.offsetWidth)) + "px";
host.style.top = clamp(host.offsetTop, 0, Math.max(0, innerHeight - host.offsetHeight)) + "px";
};
if (saved.pos) { host.style.left = saved.pos.l + "px"; host.style.top = saved.pos.t + "px"; }
if (saved.min) body.classList.add("hide");
keep(); addEventListener("resize", keep);
let dx = 0, dy = 0, drag = false;
head.addEventListener("pointerdown", (e) => { if (e.target === minBtn) return; drag = true; dx = e.clientX - host.offsetLeft; dy = e.clientY - host.offsetTop; head.setPointerCapture(e.pointerId); panel.style.transform = "scale(1.03)"; });
head.addEventListener("pointermove", (e) => {
if (!drag) return;
host.style.left = clamp(e.clientX - dx, 0, Math.max(0, innerWidth - host.offsetWidth)) + "px";
host.style.top = clamp(e.clientY - dy, 0, Math.max(0, innerHeight - host.offsetHeight)) + "px";
});
const end = () => { drag = false; panel.style.transform = ""; };
head.addEventListener("pointerup", end); head.addEventListener("pointercancel", end);
minBtn.onclick = () => { body.classList.toggle("hide"); panel.classList.remove("bounce"); void panel.offsetWidth; panel.classList.add("bounce"); };

const addC = (n, f) => CMDS.push([n, f]);
[3, 5, 10, 15, 30, 60].forEach((n) => addC("Rewind " + n + " seconds", () => startRewind({ sec: n })));
Object.keys(LBL).forEach((k) => addC("Toggle " + LBL[k], () => setFlag(k, !S[k])));
MODES.forEach(([n, o]) => addC("Mode: " + n, () => applyMode(n, o)));
Object.keys(THEMES).forEach((n) => addC("Theme: " + n, () => setTheme(n)));
TABS.forEach(([n], i) => addC("Go to " + n + " tab", () => { body.classList.remove("hide"); setTab(i); }));
addC("Add 1,000,000 coins", () => addMoney("coins", 1e6)); addC("Add 1,000,000,000 coins", () => addMoney("coins", 1e9)); addC("Add 10,000 gems", () => addMoney("gems", 1e4));
addC("Screenshot", shot); addC("Make flex card", flexCard); addC("Record gameplay clip", toggleClip);
addC("Replay last 10 seconds", () => replay(10, 1, false)); addC("Slow-mo replay", () => replay(10, 0.4, false)); addC("Save replay clip", () => replay(10, 1, true));
addC("Confetti", () => confetti(120)); addC("Clear rewind buffer", () => { clearBuf(); say("buffer cleared"); });
addC("Save checkpoint 1", () => saveSlot(0)); addC("Load checkpoint 1", () => loadSlot(0)); addC("Stop moving (zero velocity)", () => setVel(0, 0));
addC("Hide panel", () => { host.style.display = "none"; });

setInterval(persist, 2000);

setTab(S.tab >= 0 && S.tab < TABS.length ? S.tab : 0);
say("ready");
console.log("bouncemasters mod v4 loaded. game: window.__bm, state: __bm.meta");
}
})();