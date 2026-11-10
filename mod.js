(function () {

// ================= SAVE SYSTEM =================
// The game saves through window.ytgame.game.saveData / loadData. Whatever page hosts the game may ship a stub that
// forgets everything, so this replaces both functions with versions that persist to localStorage, IndexedDB and
// window.name (the last one survives a refresh even inside sandboxed frames). Load this file BEFORE the game starts.
const SK = "bm_ytgame_save", NK = "BMSAVE:";
let lastSaved = null;
const lsGet = () => { try { return localStorage.getItem(SK); } catch (e) { return null; } };
const lsSet = (s) => { try { localStorage.setItem(SK, s); } catch (e) {} };
let idbP = null;
const idb = () => idbP || (idbP = new Promise((res) => { try { const r = indexedDB.open("bmmod", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } }));
const idbGet = () => idb().then((db) => db ? new Promise((res) => { try { const q = db.transaction("kv").objectStore("kv").get(SK); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } }) : null);
const idbSet = (s) => idb().then((db) => { if (db) { try { db.transaction("kv", "readwrite").objectStore("kv").put(s, SK); } catch (e) {} } });
const nameGet = () => { try { return window.name && window.name.indexOf(NK) === 0 ? window.name.slice(NK.length) : null; } catch (e) { return null; } };
const nameSet = (s) => { try { if (!window.name || window.name.indexOf(NK) === 0) window.name = NK + s; } catch (e) {} };
const readSave = async () => lsGet() || nameGet() || (await idbGet()) || "";
const writeSave = (s, force) => {
if (typeof s !== "string" || !s) return;
if (!force && s === "{}") return; // never overwrite a real save with an empty one by accident
lastSaved = s; lsSet(s); nameSet(s); idbSet(s);
};
const installYt = () => {
try {
if (!window.ytgame) window.ytgame = {};
const yt = window.ytgame;
const put = (o, k, v) => { try { o[k] = v; } catch (e) {} if (o[k] !== v) { try { Object.defineProperty(o, k, { value: v, configurable: true, writable: true }); } catch (e) {} } };
const sub = (k) => { if (!yt[k] || typeof yt[k] !== "object") put(yt, k, {}); return yt[k]; };
const g = sub("game"), sy = sub("system"), en = sub("engagement");
if (!g.__bm) {
put(g, "loadData", () => readSave());
put(g, "saveData", (s) => { writeSave(s); return Promise.resolve(); });
g.__bm = 1;
}
if (typeof g.firstFrameReady !== "function") put(g, "firstFrameReady", () => {});
if (typeof g.gameReady !== "function") put(g, "gameReady", () => {});
if (typeof sy.getLanguage !== "function") put(sy, "getLanguage", () => Promise.resolve(navigator.language || "en"));
if (typeof sy.isAudioEnabled !== "function") put(sy, "isAudioEnabled", () => true);
if (typeof sy.onAudioEnabledChange !== "function") put(sy, "onAudioEnabledChange", () => {});
if (typeof sy.onPause !== "function") put(sy, "onPause", () => {});
if (typeof sy.onResume !== "function") put(sy, "onResume", () => {});
if (typeof en.sendScore !== "function") put(en, "sendScore", () => Promise.resolve());
} catch (e) {}
};
installYt();
setInterval(installYt, 1500); // the YouTube SDK can load late and replace ytgame, so keep re-asserting it

// ================= wait for the game (needs the patched game.js that exposes window.__bm) =================
const wait = setInterval(function () {
try {
const b = window.__bm;
if (b && b.pixiApp && b.meta && b.meta.coins) { clearInterval(wait); start(b); }
} catch (e) {}
}, 400);

function start(B) {
if (window.__bmMod) return;
window.__bmMod = true;

// ================= settings (mod menu only; the GAME save is handled above) =================
const KEY = "bmmod_v5";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY)) || JSON.parse(localStorage.getItem("bmmod_v3")) || JSON.parse(localStorage.getItem("bmmod_v2")) || {}; } catch (e) {}
const DEF = {
grav: 100, speed: 100, floor: false, bounce: 1, minBounce: 1200, power: 1, noLimit: false,
phase: false, phaseDeadly: false, immortal: false, infAbility: false, magnet: 0,
hover: false, holdY: 0, fly: false, flySpeed: 1800, cruise: false, cruiseVx: -1500, cm: 1, gm: 1,
rec: true, recFrames: true, keepWorld: true, respawn: true, keepObs: 80, memMB: 96,
rewSec: 5, rewRate: 3, autoRew: false, autoSec: 3,
fx: { gray: 100, vhs: true, sound: true, flash: true },
hud: true, keys: true, fab: true, toasts: true, lite: true,
accent: "#34c759", theme: "Mint", ui: 100, w: 350, bh: 0, zoom: 100, ov: {}, tab: 0
};
const S = Object.assign({}, DEF, saved.s || {});
S.fx = Object.assign({}, DEF.fx, (saved.s && saved.s.fx) || {});
S.ov = Object.assign({}, (saved.s && saved.s.ov) || {});
const M = () => B.meta;
const VIEW = () => B.pixiApp.view || B.pixiApp.canvas;
let status, toast = null;
const say = (s) => { if (status) status.textContent = s; if (toast) toast(s); };
const LBL = { floor: "Bouncy floor", noLimit: "No speed limit", phase: "Phase through all obstacles", phaseDeadly: "Ignore deadly obstacles", immortal: "Immortal", infAbility: "Infinite ability", hover: "Hover", fly: "Fly mode", cruise: "Cruise control", rec: "Recording", recFrames: "Video capture", keepWorld: "Keep world for rewind", respawn: "Coins respawn on rewind", autoRew: "Second chance", hud: "HUD", keys: "Hotkeys", fab: "Rewind button", toasts: "Toasts", lite: "Lite mode" };
const swDraws = [];

// ================= timeline and state =================
const MAXREC = 6000;
let snaps = [], frames = [], frameBytes = 0, lastS = 0, lastF = 0, skew = 0, rw = null;
const clk = () => performance.now() - skew; // timeline clock: skips the time that was rewound
const bsearch = (arr, t) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const snapAt = (t) => snaps[Math.max(0, bsearch(snaps, t))];
const frameAt = (t) => frames[bsearch(frames, t)] || null;
const fc = document.createElement("canvas"), fctx = fc.getContext("2d");
const keptO = [], keptM = [], collected = []; // passed obstacles / coins that are kept for rewind, collected coins log
const locks = new Map(), held = {}, slots = [null, null, null];
const GK = ["gravityAccelerationUpMoving", "gravityAccelerationDownMoving", "gravityCosmosAccelerationUpMoving", "gravityCosmosAccelerationDownMoving"];
const DEATH = { deathSliding: 1, deathFalling: 1, deathSwimmingSliding: 1, deathSwimming: 1 };
let lastLv = null, runs = 0, st = { bestY: 0, bestV: 0, t0: 0, x0: 0 }, cur = { y: 0, sp: 0 };
let prevVy = 0, bounces = 0, autoCool = 0, fno = 0, fpsN = 0, fpsT = performance.now(), fps = 0, tkOrig = 0;
const coins0 = (() => { try { return Number(M().coins.value) || 0; } catch (e) { return 0; } })();
const tk = B.pixiApp.ticker;

// ================= finding the game objects =================
let LV = null, lastFind = 0;
const dead = (o) => !o || o._destroyed || o.destroyed;
const findLevel = () => {
if (LV && LV.parent && LV.flyingCharacter && !dead(LV)) return LV;
LV = null;
const nw = performance.now();
if (nw - lastFind < 400) return null;
lastFind = nw;
const q = [B.pixiApp.stage];
for (let n = 0; q.length && n < 6000; n++) {
const o = q.shift();
if (o && o.isLevel === true && o.flyingCharacter) { LV = o; break; }
if (o && o.children) for (const c of o.children) q.push(c);
}
return LV;
};
const findChar = () => { const l = findLevel(); return l ? l.flyingCharacter : null; };
const destroyKept = (k) => { try { k.o.destroy({ children: true }); } catch (e) {} };
const flushKept = () => { while (keptO.length) destroyKept(keptO.pop()); while (keptM.length) destroyKept(keptM.pop()); collected.length = 0; };
const keepIt = (list, o) => { o.renderable = false; list.push({ o, t: clk() }); };

// the character: bouncy floor, phase, immortal, power; wrapped once
const patchChar = (ch) => {
if (ch.__bmPatched) return;
ch.__bmPatched = true;
const orig = ch.collide;
ch.collide = function (t) {
let c = null;
try {
c = t && t.collider && t.collider.collidable;
if (c) {
if (S.floor && c.type === "ground") {
const v = this.flyingVelocity;
v.y = Math.max(Math.abs(v.y) * S.bounce, S.minBounce);
this.y = Math.max(this.y, 2);
this.timeBeforeNextGroundCollisionSec = 0.1;
return { isNextCollideAvailable: false, isCollidePerformed: true };
}
if (S.phase && c.type !== "ground" && c.type !== "coin" && c.type !== "gem") return { isNextCollideAvailable: false, isCollidePerformed: false };
if ((S.phaseDeadly || S.immortal) && c.collisionAction === "reset") return { isNextCollideAvailable: false, isCollidePerformed: false };
}
} catch (e) {}
const r = orig.apply(this, arguments);
try {
if (c && S.power !== 1 && r && r.isCollidePerformed && (c.type === "ground" || c.collisionAction === "add")) {
this.flyingVelocity.x *= S.power; this.flyingVelocity.y *= S.power; this.isNeedRecalculatePredictions = true;
}
} catch (e) {}
return r;
};
const proto = Object.getPrototypeOf(ch);
if (proto && !proto.__bmSt) {
proto.__bmSt = true;
const d = Object.getOwnPropertyDescriptor(proto, "state");
if (d && d.set) {
Object.defineProperty(proto, "state", { configurable: true, enumerable: d.enumerable, get: d.get, set(v) {
if (S.immortal && !rw && (DEATH[v] || v === "finish")) return; // immortal: death states are ignored
d.set.call(this, v);
} });
}
const sdf = proto.startDeathFalling;
if (typeof sdf === "function") proto.startDeathFalling = function () { if (S.immortal && !rw) return; return sdf.apply(this, arguments); };
}
};

// coins and gems: multiplier and a log of what was collected (so rewind can respawn them)
const patchedP = new Set();
const logCollect = (m) => {
collected.push({ t: clk(), C: m.constructor, x: m.x, y: m.y, gem: m.type === "gem", ch: !!(m.body0 && m.body0.render && m.body0.render.strokeStyle === "#00ff00") });
if (collected.length > 300) collected.shift();
};
const patchMoney = (m) => {
let p = Object.getPrototypeOf(m);
while (p && p !== Object.prototype) {
if (!patchedP.has(p) && Object.prototype.hasOwnProperty.call(p, "collidePostBegin")) {
patchedP.add(p);
const orig = p.collidePostBegin;
p.collidePostBegin = function () {
if (this.__bmIn) return orig.apply(this, arguments); // nested super call
if (this.__bmGot) return;
this.__bmGot = true; this.__bmIn = true;
try {
if (S.keepWorld && S.respawn && !rw) logCollect(this);
const r = orig.apply(this, arguments);
try {
if (this.type === "coin" && S.cm > 1) M().coins.value += S.cm - 1;
else if (this.type === "gem" && S.gm > 1) M().gems.value += S.gm - 1;
} catch (e) {}
return r;
} finally { this.__bmIn = false; }
};
}
p = Object.getPrototypeOf(p);
}
};

// the game destroys obstacles and coins once the camera has passed them. Instead they are hidden and kept, then
// switched back on when the camera comes back in range, which is what makes a rewind restore the world.
const patchLevel = (l) => {
if (l.__bmP) return;
l.__bmP = true;
const om = l.obstacleManager, mm = l.moneyManager;
if (om && typeof om.removePassedObstacles === "function") {
const oo = om.removePassedObstacles;
om.removePassedObstacles = function () {
if (!S.keepWorld) return oo.apply(this, arguments);
const lim = this.level.camera.rightBorderInWorldX + 500, a = this.obstacles;
for (let i = a.length - 1; i >= 0; i--) { const r = a[i]; if (r.x - r.leftBorderOffset > lim) { a.splice(i, 1); keepIt(keptO, r); } }
for (let i = keptO.length - 1; i >= 0; i--) {
const r = keptO[i].o;
if (dead(r)) { keptO.splice(i, 1); continue; }
if (r.x - r.leftBorderOffset <= lim - 200) { keptO.splice(i, 1); r.renderable = true; a.push(r); }
}
};
}
if (mm && typeof mm.removePassedMoney === "function") {
const om2 = mm.removePassedMoney;
mm.removePassedMoney = function () {
const a = this.money;
for (let i = a.length - 1; i >= 0; i--) if (dead(a[i])) a.splice(i, 1);
if (!S.keepWorld) return om2.apply(this, arguments);
const lim = this.level.camera.rightBorderInWorldX + 500;
for (let i = a.length - 1; i >= 0; i--) { const r = a[i]; if (r.x > lim) { a.splice(i, 1); keepIt(keptM, r); } }
for (let i = keptM.length - 1; i >= 0; i--) {
const r = keptM[i].o;
if (dead(r)) { keptM.splice(i, 1); continue; }
if (r.x <= lim - 200) { keptM.splice(i, 1); r.renderable = true; a.push(r); }
}
};
}
};
const respawnCollected = (T) => {
const l = findLevel(); if (!l) return 0;
let n = 0;
for (let i = collected.length - 1; i >= 0; i--) {
const e = collected[i];
if (e.t <= T) continue;
collected.splice(i, 1);
try {
const m = e.gem ? new e.C({ isCheated: e.ch }) : new e.C();
m.x = e.x; m.y = e.y;
l.moneyManager.money.push(m); l.addMoneyIntoWorld(m);
n++;
} catch (x) {}
}
return n;
};

// ================= memory budget =================
const dropBefore = (cut) => {
let i = 0;
while (i < snaps.length && snaps[i].t < cut) i++;
if (i) snaps.splice(0, i);
i = 0;
while (i < frames.length && frames[i].t < cut) { frameBytes -= frames[i].b.size; i++; }
if (i) frames.splice(0, i);
};
const trim = () => {
const oldest = snaps.length ? snaps[0].t : Infinity;
if (snaps.length) dropBefore(oldest);
const cap = S.memMB * 1048576;
let g = 0;
while (frameBytes + snaps.length * 90 > cap && snaps.length > 30 && g++ < 200) dropBefore(snaps[Math.min(20, snaps.length - 1)].t);
const m = performance.memory;
if (m && m.jsHeapSizeLimit && m.usedJSHeapSize / m.jsHeapSizeLimit > 0.72 && snaps.length > 60) dropBefore(snaps[Math.floor(snaps.length * 0.2)].t);
const o2 = snaps.length ? snaps[0].t : -Infinity;
while (keptO.length > S.keepObs || (keptO.length && snaps.length && keptO[0].t < o2)) destroyKept(keptO.shift());
const capM = Math.round(S.keepObs * 1.5);
while (keptM.length > capM || (keptM.length && snaps.length && keptM[0].t < o2)) destroyKept(keptM.shift());
while (collected.length && snaps.length && collected[0].t < o2) collected.shift();
};
const clearBuf = () => { snaps = []; frames = []; frameBytes = 0; flushKept(); };

// ================= restoring the character =================
const pin = (ch, s) => { ch.x = s.x; ch.y = s.y; ch.flyingVelocity.x = s.vx; ch.flyingVelocity.y = s.vy; ch.timeBeforeNextGroundCollisionSec = 0.3; };
const restoreState = (ch, s) => {
pin(ch, s);
if (typeof s.rot === "number") ch.rotation = s.rot;
const want = s.st || "flying";
if (ch.state !== want) { ch.deathType = "none"; ch.isFlipped = false; ch.state = want; }
ch.isMaxVelocityCrossed = false;
ch.isNeedRecalculatePredictions = true;
};

// ================= per-frame work =================
tk.add(() => {
fpsN++; fno++;
const ts = B.timeScalers;
try {
if (rw) ts.bmrew = 0; else if ("bmrew" in ts) delete ts.bmrew;
if (S.speed !== 100 && !rw) ts.bmmod = S.speed / 100; else if ("bmmod" in ts) delete ts.bmmod;
} catch (e) {}
if (locks.size) locks.forEach((L) => { try { const p = resolve(L.r); if (p) p[0][p[1]] = L.v; } catch (e) {} });
const l = findLevel();
if (!l) return;
const ch = l.flyingCharacter;
if (l !== lastLv) { lastLv = l; runs++; st = { bestY: ch.y, bestV: 0, t0: performance.now(), x0: ch.x }; clearBuf(); patchLevel(l); }
patchChar(ch);
if (!ch.__g0) ch.__g0 = GK.map((k) => ch[k]);
GK.forEach((k, i) => { ch[k] = ch.__g0[i] * S.grav / 100; });
const v = ch.flyingVelocity;
if (rw) {
if (rw.snap) { pin(ch, rw.snap); if (DEATH[ch.state]) { ch.deathType = "none"; ch.state = rw.snap.st || "flying"; } }
return;
}
const mm = l.moneyManager && l.moneyManager.money;
if (mm) {
for (let i = 0; i < mm.length; i++) {
const m = mm[i];
if (!m.__bmP) { m.__bmP = true; patchMoney(m); }
if (S.magnet > 0 && !m.__bmGot && m.body0 && Math.hypot(m.x - ch.x, m.y - ch.y) < S.magnet) { try { ch.collide({ collider: m.body0, point: { x: m.x, y: m.y } }); } catch (e) {} }
}
}
const sp = Math.hypot(v.x, v.y);
cur.y = ch.y; cur.sp = sp;
if (ch.y > st.bestY) st.bestY = ch.y;
if (sp > st.bestV) st.bestV = sp;
if (prevVy < -300 && v.y > 300) bounces++;
prevVy = v.y;
if (S.noLimit) ch.isMaxVelocityCrossed = false;
if (S.infAbility && ch.ability) ch.ability.part = 1;

// second chance: rewind automatically when the character starts to die
if (S.autoRew && DEATH[ch.state] && l.state === "flying" && snaps.length > 5 && performance.now() > autoCool) {
autoCool = performance.now() + 2500;
startRewind({ sec: S.autoSec, base: snaps[snaps.length - 1].t });
return;
}

// flight, hover, cruise
const flying = ch.state === "flying" && l.state === "flying";
let moved = false;
if (S.fly && flying) {
const fx = ((held.d || held.arrowright) ? 1 : 0) - ((held.a || held.arrowleft) ? 1 : 0);
const fy = ((held.w || held.arrowup) ? 1 : 0) - ((held.s || held.arrowdown) ? 1 : 0);
v.y = fy * S.flySpeed;
if (fx) v.x = -fx * S.flySpeed; // forward is negative X
if (ch.y < 2) ch.y = 2;
moved = true;
} else if (S.hover && flying) { ch.y = S.holdY; v.y = 0; moved = true; }
if (S.cruise && flying) { v.x = S.cruiseVx; moved = true; }
if (moved && (fno & 3) === 0) ch.isNeedRecalculatePredictions = true;

// recording (state only; video frames are captured after the game has rendered)
if (!S.rec || l.state !== "flying") return;
const now = clk();
if ((ch.state === "flying" || ch.state === "spaceLaunch") && now - lastS >= 100) {
lastS = now;
snaps.push({ t: now, x: ch.x, y: ch.y, vx: v.x, vy: v.y, rot: ch.rotation, st: ch.state });
if (snaps.length > MAXREC) snaps.shift();
}
});

// video frames: captured AFTER the game has rendered (lowest priority), otherwise a WebGL canvas reads back black
tk.add(() => {
if (!S.rec || !S.recFrames || rw || !LV || LV.state !== "flying") return;
const now = clk();
if (now - lastF < 100) return;
lastF = now;
const vw = VIEW();
if (!vw || !vw.width) return;
const w = Math.max(160, Math.round(vw.width / 4)), h = Math.round(vw.height * w / vw.width);
if (fc.width !== w) { fc.width = w; fc.height = h; }
try {
fctx.drawImage(vw, 0, 0, w, h);
fc.toBlob((b) => { if (b) { frames.push({ t: now, b }); frameBytes += b.size; if (frames.length > MAXREC) frameBytes -= frames.shift().b.size; } }, "image/webp", 0.5);
} catch (e) {}
}, null, -50);

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
const c = ac.createOscillator(), cg = ac.createGain();
c.type = "square"; c.frequency.setValueAtTime(110, T); c.frequency.exponentialRampToValueAtTime(40, T + 0.12);
cg.gain.setValueAtTime(0.08, T); cg.gain.exponentialRampToValueAtTime(0.001, T + 0.14);
c.connect(cg); cg.connect(ac.destination); c.start(T); c.stop(T + 0.16);
setTimeout(() => { try { s.o.stop(); s.o2.stop(); s.ns.stop(); } catch (e) {} }, 300);
} catch (e) {}
};

// ================= rewind visuals: grayscale reversed video, VHS glitch, REW label =================
const noise = document.createElement("canvas"); noise.width = noise.height = 96;
(() => { const c = noise.getContext("2d"), im = c.createImageData(96, 96); for (let i = 0; i < im.data.length; i += 4) { const g = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = g; im.data[i + 3] = 255; } c.putImageData(im, 0, 0); })();
const fxStyle = document.createElement("style");
fxStyle.textContent = [
"#bmfx{position:fixed;inset:0;z-index:2147483000;display:none;pointer-events:none}",
"#bmfx .st{position:absolute;background:#000;overflow:hidden;font-size:16px}",
"#bmfx.live .st{background:transparent}",
"#bmfx canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}",
"#bmfx.vhs canvas{animation:bmfx-jit .14s steps(2) infinite}",
"#bmfx .gr,#bmfx .tr,#bmfx .sl{display:none;position:absolute}",
"#bmfx.vhs .gr,#bmfx.vhs .tr,#bmfx.vhs .sl{display:block}",
"#bmfx .gr{inset:-50%;opacity:.16;background-size:96px 96px;animation:bmfx-gr .4s steps(5) infinite}",
"#bmfx .tr{left:0;right:0;height:16%;top:-20%;background:linear-gradient(180deg,transparent,rgba(255,255,255,.24) 45%,rgba(255,255,255,.06) 70%,transparent);animation:bmfx-tr 1.7s linear infinite}",
"#bmfx .sl{inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.28) 0 1px,transparent 1px 3px)}",
"#bmfx .vg{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.65) 100%)}",
"#bmfx .lb,#bmfx .tc{position:absolute;top:.9em;font:700 2em ui-monospace,Menlo,Consolas,monospace;color:#fff;letter-spacing:.08em;text-shadow:.07em 0 rgba(255,40,40,.6),-.07em 0 rgba(40,255,255,.6),0 0 .35em rgba(255,255,255,.7)}",
"#bmfx .lb{left:.8em}#bmfx .lb b{animation:bmfx-bl .8s steps(2) infinite}",
"#bmfx .tc{right:.8em;font-size:1.5em;top:1.15em}",
"#bmfx .bar{position:absolute;left:1.2em;right:1.2em;bottom:1.1em;height:.35em;background:rgba(255,255,255,.2);border-radius:.2em;overflow:hidden}",
"#bmfx .bar i{display:block;height:100%;width:100%;background:#fff}",
"#bmflash{position:fixed;inset:0;z-index:2147483001;background:#fff;opacity:0;pointer-events:none}",
"@keyframes bmfx-jit{0%{transform:translateX(0)}50%{transform:translateX(.35%)}100%{transform:translateX(-.25%)}}",
"@keyframes bmfx-gr{0%{transform:translate(0,0)}25%{transform:translate(-9%,6%)}50%{transform:translate(7%,-11%)}75%{transform:translate(-5%,-4%)}100%{transform:translate(0,0)}}",
"@keyframes bmfx-tr{0%{top:-20%}100%{top:110%}}",
"@keyframes bmfx-bl{0%{opacity:1}50%{opacity:.1}}"
].join("");
document.head.appendChild(fxStyle);
const fxEl = document.createElement("div"); fxEl.id = "bmfx";
fxEl.innerHTML = '<div class="st"><canvas></canvas><div class="gr"></div><div class="tr"></div><div class="sl"></div><div class="vg"></div><div class="lb"><b>\u25C4\u25C4</b> REW</div><div class="tc">-00:00.0</div><div class="bar"><i></i></div></div>';
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
else { fxCanvas.width = fc.width || 320; fxCanvas.height = fc.height || 180; fxCanvas.style.filter = grayCss(); }
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
// While rewinding the game's own time is frozen (time scale 0), so nothing can collide, spawn or die underneath.
const ease = (p) => p * p * (3 - 2 * p);
const startRewind = (o) => {
if (rw) return false;
const l = findLevel();
if (!l || l.state !== "flying" || snaps.length < 2) { say("nothing to rewind yet (be in a run first)"); return false; }
const floor = snaps[0].t, from = o.base !== undefined ? o.base : clk();
const r = { floor, from, t: from, started: performance.now(), last: performance.now(), snap: snaps[snaps.length - 1], hold: !!o.hold, rate: o.rate || 1, to: null, dur: 0, busy: false, lastF: null, raf: 0, live: false };
if (!r.hold) {
r.to = Math.max(floor, from - o.sec * 1000);
const span = from - r.to;
if (span < 100) { say("not enough history yet"); return false; }
r.dur = Math.min(2500, Math.max(700, span / 4));
}
rw = r;
try { B.timeScalers.bmrew = 0; } catch (e) {}
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
let nResp = 0;
if (ch && s) restoreState(ch, s);
if (s) {
if (S.keepWorld && S.respawn) nResp = respawnCollected(s.t);
snaps = snaps.filter((x) => x.t <= s.t); frames = frames.filter((f) => f.t <= s.t);
frameBytes = frames.reduce((a, f) => a + f.b.size, 0);
skew = performance.now() - s.t; lastS = lastF = s.t;
}
const back = Math.round((r.from - r.t) / 100) / 10;
rw = null;
try { delete B.timeScalers.bmrew; } catch (e) {}
fxHide(); sndStop();
say("rewound " + back + "s" + (nResp ? ", " + nResp + " coins respawned" : ""));
};

// ================= helpers: abilities, collecting, slots, screenshot, clip =================
const useAbility = () => { const c = findChar(); if (!c || typeof c.startAbility !== "function") { say("no run active"); return; } try { c.startAbility(); say("ability!"); } catch (e) { say("ability ERR: " + e); } };
const collectAll = () => {
const l = findLevel(); if (!l) { say("no run active"); return; }
const ch = l.flyingCharacter; let n = 0;
(l.moneyManager.money || []).slice().forEach((m) => { if (!m.__bmGot && m.body0) { try { ch.collide({ collider: m.body0, point: { x: m.x, y: m.y } }); n++; } catch (e) {} } });
say("collected " + n);
};
const saveSlot = (i) => { const c = findChar(); if (!c) { say("no run active"); return; } slots[i] = { x: c.x, y: c.y, vx: c.flyingVelocity.x, vy: c.flyingVelocity.y, rot: c.rotation, st: "flying" }; say("saved slot " + (i + 1)); };
const loadSlot = (i) => { const c = findChar(); if (!c) { say("no run active"); return; } if (!slots[i]) { say("slot " + (i + 1) + " is empty"); return; } restoreState(c, slots[i]); say("loaded slot " + (i + 1)); };
const dl = (href, name) => { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
const shot = () => {
try {
const app = B.pixiApp;
try { app.renderer.render(app.stage); } catch (e) { try { app.render(); } catch (e2) {} }
dl(VIEW().toDataURL("image/png"), "bouncemasters_" + Date.now() + ".png");
say("screenshot saved");
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
mr = null; recBtn.textContent = "\u25CF Record clip"; say("clip saved");
};
mr.start(1000); recBtn.textContent = "\u25A0 Stop and save"; say("recording...");
} catch (e) { mr = null; say("record ERR: " + e); }
};
const unlockBats = () => {
try {
const b = M().bats; let n = 0;
const mark = (x) => { if (x && typeof x === "object" && x.purchased && typeof x.purchased === "object" && "value" in x.purchased && !x.purchased.value) { x.purchased.value = true; n++; } };
for (const k of Object.keys(b)) {
const v = b[k];
if (Array.isArray(v)) v.forEach(mark);
else if (v && typeof v === "object") { mark(v); if (!v.purchased) for (const k2 of Object.keys(v)) mark(v[k2]); }
}
say("unlocked " + n + " bats");
} catch (e) { say("bats ERR: " + e); }
};
const claimDaily = () => { try { const d = M().dailyGift; if (d.canClaim) { d.claim(); say("daily gift claimed"); } else say("daily gift not ready yet"); } catch (e) { say("daily ERR: " + e); } };

// ================= flags (switches and hotkeys share this) =================
let hudEl, fab, panel, applyLook = () => {};
const setFlag = (n, v) => {
S[n] = v;
if (n === "hover" && v) { const c = findChar(); S.holdY = c ? Math.round(c.y) : 0; }
if (n === "rec" && !v) clearBuf();
if (n === "keepWorld" && !v) flushKept();
if (n === "hud" && hudEl) hudEl.style.display = v ? "" : "none";
if (n === "fab" && fab) fab.style.display = v ? "" : "none";
if (n === "lite") applyLook();
say((LBL[n] || n) + (v ? " ON" : " OFF"));
};

// ================= UI =================
const spring = "cubic-bezier(.34,1.56,.64,1)", MONO = "ui-monospace,Menlo,Consolas,monospace";
const css = `
.p{position:relative;width:var(--w,350px);max-width:96vw;color:var(--tx,#000);font:13px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;border-radius:30px;
background:var(--tint,linear-gradient(transparent,transparent)),linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.04));-webkit-backdrop-filter:blur(10px) saturate(160%);backdrop-filter:blur(10px) saturate(160%);
box-shadow:0 14px 40px rgba(0,0,0,.35),inset 0 0 0 1px var(--ac,#34c759),inset 0 1px 1px rgba(255,255,255,.5);
user-select:none;overflow:hidden}
.p.lite{background:var(--tint,linear-gradient(transparent,transparent)),var(--base,rgba(236,242,248,.93));-webkit-backdrop-filter:none;backdrop-filter:none}
.h,.b{position:relative;z-index:1}
.h{padding:14px 18px 8px;display:flex;justify-content:space-between;align-items:center;cursor:grab;touch-action:none;font-weight:700;font-size:15px}
.pro{font-size:9px;letter-spacing:1px;padding:2px 6px;border-radius:8px;margin-left:8px;color:#000;vertical-align:middle;background:linear-gradient(90deg,#ffd60a,#fff4b0)}
.min{width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:linear-gradient(160deg,rgba(255,255,255,.35),rgba(255,255,255,.1));color:var(--tx,#000);font-size:15px;cursor:pointer;padding:0}
.b{padding:2px 14px 22px;display:flex;flex-direction:column;gap:10px;max-height:var(--bh,78vh);overflow-y:auto}.b.hide{display:none}
.b::-webkit-scrollbar{width:6px}.b::-webkit-scrollbar-thumb{background:rgba(120,120,120,.4);border-radius:3px}
.rs{position:absolute;right:6px;bottom:6px;width:22px;height:22px;z-index:5;cursor:nwse-resize;touch-action:none;opacity:.7;
background:linear-gradient(135deg,transparent 0 50%,var(--ac,#34c759) 50% 58%,transparent 58% 70%,var(--ac,#34c759) 70% 78%,transparent 78%);border-bottom-right-radius:24px}
.rs:hover{opacity:1}
.tabs{display:flex;position:relative;padding:3px;border-radius:18px;background:rgba(0,0,0,.2);flex:none}
.tab{flex:1;position:relative;z-index:1;text-align:center;padding:8px 0;font-weight:600;font-size:11px;cursor:pointer;opacity:.7}
.tab.on{opacity:1}
.pill{position:absolute;top:3px;bottom:3px;left:3px;border-radius:15px;background:linear-gradient(160deg,rgba(255,255,255,.5),rgba(255,255,255,.2));box-shadow:inset 0 1px 1px rgba(255,255,255,.7),0 2px 6px rgba(0,0,0,.18);transition:transform .35s ${spring}}
.pg{display:flex;flex-direction:column;gap:10px}.pg.hide{display:none}
.card{background:linear-gradient(160deg,rgba(255,255,255,.22),rgba(255,255,255,.07));border-radius:22px;padding:11px 13px;box-shadow:inset 0 1px 1px rgba(255,255,255,.5),inset 0 0 0 1px rgba(255,255,255,.12);display:flex;flex-direction:column;gap:9px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.lbl{font-weight:600}.lbl small{display:block;opacity:.7;font-size:11px;font-weight:400;margin-top:1px}
.ttl{font-weight:700;font-size:11px;letter-spacing:.5px;opacity:.65}
.note{font-size:11px;opacity:.7;line-height:1.35}
.btn{border:0;border-radius:16px;padding:0 13px;height:30px;background:linear-gradient(160deg,rgba(255,255,255,.4),rgba(255,255,255,.14));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:var(--tx,#000);font:600 12px -apple-system,system-ui,sans-serif;cursor:pointer;flex:none}
.btn:active,.min:active{transform:scale(.92)}
.btn.hot{background:var(--ac,#34c759);color:#fff}
.btn.big{height:46px;border-radius:23px;font-size:14px;width:100%}
.btns{display:flex;gap:6px;flex-wrap:wrap}.btns .btn{flex:1;padding:0 8px}
.num{width:104px;box-sizing:border-box;height:30px;background:rgba(0,0,0,.2);border:0;border-radius:15px;padding:0 11px;color:var(--tx,#000);font:700 12.5px ${MONO};outline:none;text-align:right;user-select:text}
.num.s{width:70px}
.sw{width:50px;height:30px;border-radius:15px;background:rgba(120,120,120,.35);position:relative;cursor:pointer;transition:background .25s;flex:none}
.sw i{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:12px;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.4);transition:transform .35s ${spring}}
.sw.on{background:var(--ac,#34c759)}.sw.on i{transform:translateX(20px)}
.srch{display:flex;gap:8px}.srch .num{flex:1;width:auto;text-align:left;font:12.5px -apple-system,system-ui,sans-serif}
.tbl{height:260px;overflow-y:auto;border-radius:20px;background:rgba(0,0,0,.18)}
.tr{height:30px;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:0 8px 0 10px;border-bottom:1px solid rgba(255,255,255,.07)}
.nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px ${MONO}}
.tr input{width:84px;flex:none;box-sizing:border-box;background:rgba(255,255,255,.14);border:0;border-radius:9px;padding:4px 8px;color:var(--tx,#000);font:600 11.5px ${MONO};outline:none;text-align:right;user-select:text}
.lk{flex:none;width:24px;height:22px;border:0;border-radius:8px;background:rgba(255,255,255,.18);font-size:11px;cursor:pointer;padding:0;opacity:.6}.lk.on{background:var(--ac,#34c759);opacity:1}
.empty{padding:22px;text-align:center;opacity:.6;font-size:12px}
.status{display:none}
.meter{height:8px;border-radius:4px;background:rgba(0,0,0,.22);overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--ac,#34c759);transition:width .25s}
.keys{font:11px/1.55 ${MONO};opacity:.85;white-space:pre-wrap}
textarea.num{width:100%;height:64px;padding:8px 10px;border-radius:14px;text-align:left;resize:none;font:11px ${MONO}}
.hud{position:fixed;top:10px;right:10px;padding:8px 11px;border-radius:14px;background:rgba(0,0,0,.45);color:#fff;font:11px/1.5 ${MONO};pointer-events:none;white-space:pre}
.hud b{color:var(--ac,#34c759);font-weight:700}
.fab{position:fixed;left:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);width:54px;height:54px;border-radius:50%;border:1px solid rgba(255,255,255,.5);background:linear-gradient(160deg,rgba(255,255,255,.55),rgba(255,255,255,.2));box-shadow:0 6px 18px rgba(0,0,0,.35);color:#000;font:700 15px system-ui,sans-serif;cursor:pointer;touch-action:none;opacity:.8}
.fab.hot{background:var(--ac,#34c759);color:#fff;transform:scale(1.15);opacity:1}
.toasts{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.toast{padding:8px 16px;border-radius:18px;background:rgba(20,20,26,.82);color:#fff;font:600 12px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.35);opacity:0;transform:translateY(-12px);transition:opacity .3s,transform .3s}
.toast.in{opacity:1;transform:none}
.pal{position:fixed;left:50%;top:16%;width:min(460px,92vw);transform:translateX(-50%);opacity:0;pointer-events:none;border-radius:20px;background:rgba(18,18,24,.92);box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.12);overflow:hidden;transition:opacity .2s}
.pal.open{opacity:1;pointer-events:auto}
.palin{width:100%;box-sizing:border-box;border:0;background:transparent;color:#fff;padding:16px 18px;font:600 15px system-ui,sans-serif;outline:none}
.pall{border-top:1px solid rgba(255,255,255,.08)}
.pi{padding:10px 18px;font:500 13px system-ui,sans-serif;cursor:pointer;color:#fff}.pi.on{background:var(--ac,#34c759)}
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
const live = [];
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
const btn = (t, fn, cls) => { const b = el("button", { className: "btn" + (cls ? " " + cls : ""), textContent: t }); b.onclick = fn; return b; };
const slid = (min, max, get, set, suf) => {
const i = el("input", { type: "range", min, max, value: get() });
i.style.cssText = "width:112px;accent-color:var(--ac,#34c759)";
const t = el("span", { className: "nm", textContent: get() + suf });
t.style.cssText = "flex:none;width:50px;text-align:right";
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
const addMoney = (k, d) => { try { M()[k].value = (Number(M()[k].value) || 0) + d; say("+" + d.toLocaleString() + " " + k); } catch (e) { say("ERR: " + e); } };
const statLine = (name) => { const v = el("div", { className: "nm", textContent: "-" }); v.style.cssText = "flex:none;text-align:right;font-weight:700"; return [R(lbl(name), v), v]; };

// ===== TAB: Main =====
const money = card(null, [
R(lbl("Coins", "saved by the game"), box(() => M().coins.value, (v) => { M().coins.value = v; })),
el("div", { className: "btns" }, [btn("+1K", () => addMoney("coins", 1e3)), btn("+100K", () => addMoney("coins", 1e5)), btn("+10M", () => addMoney("coins", 1e7)), btn("+1B", () => addMoney("coins", 1e9))]),
R(lbl("Gems"), box(() => M().gems.value, (v) => { M().gems.value = v; })),
el("div", { className: "btns" }, [btn("+100", () => addMoney("gems", 100)), btn("+10K", () => addMoney("gems", 1e4)), btn("+1M", () => addMoney("gems", 1e6))]),
R(lbl("Best distance", "your record"), box(() => M().maxDistance.value, (v) => { M().maxDistance.value = v; }))
]);
const mult = card("EARNINGS MULTIPLIER", [
R(lbl("Coins x", "added the instant you pick one up"), box(() => S.cm, (v) => { S.cm = Math.max(1, Math.floor(v)); }, true)),
R(lbl("Gems x", "same for gems"), box(() => S.gm, (v) => { S.gm = Math.max(1, Math.floor(v)); }, true))
]);
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
const gameCard = card("GAME", [el("div", { className: "btns" }, [btn("Unlock all bats", unlockBats), btn("Claim daily gift", claimDaily)])]);
const [sRunsR, sRuns] = statLine("Runs this session"), [sHR, sH] = statLine("Best height (run)"), [sVR, sV] = statLine("Best speed (run)"), [sBoR, sBo] = statLine("Bounces (run)"), [sCR, sC] = statLine("Coins gained"), [sFR, sF] = statLine("FPS");
const page0 = el("div", { className: "pg" }, [money, mult, upCard, gameCard, card("SESSION", [sRunsR, sHR, sVR, sBoR, sCR, sFR])]);

// ===== TAB: Cheats =====
const L = { vx: -3000, vy: 3000 };
const phys = card("PHYSICS", [
R(lbl("Gravity", "1% is almost none"), slid(1, 300, () => S.grav, (v) => { S.grav = v; }, "%")),
R(lbl("Game speed", "slow-mo or fast (M key)"), slid(10, 300, () => S.speed, (v) => { S.speed = v; }, "%")),
R(lbl("Bouncy floor", "ground always bounces you"), flag("floor")),
R(lbl("Bounce strength", "x of impact speed"), box(() => S.bounce, (v) => { S.bounce = Math.max(0, v); }, true)),
R(lbl("Min bounce speed", "keeps you from settling"), box(() => S.minBounce, (v) => { S.minBounce = Math.max(0, v); }, true)),
R(lbl("Bounce power x", "multiplies every bounce"), box(() => S.power, (v) => { S.power = Math.max(0.1, v); }, true)),
R(lbl("No speed limit", "never slowed to the max velocity"), flag("noLimit"))
]);
const surv = card("SURVIVAL", [
R(lbl("Immortal", "death never happens (I key)"), flag("immortal")),
R(lbl("Ignore deadly obstacles", "trees, stones, archers"), flag("phaseDeadly")),
R(lbl("Phase through everything", "walruses too; coins still collect"), flag("phase")),
R(lbl("Infinite ability", "always ready"), flag("infAbility")),
el("div", { className: "btns" }, [btn("Use ability (X)", useAbility)])
]);
const coll = card("COLLECTING", [
R(lbl("Magnet radius", "0 = off"), box(() => S.magnet, (v) => { S.magnet = Math.max(0, v); }, true)),
el("div", { className: "btns" }, [btn("Collect everything now", collectAll)])
]);
const flight = card("FLIGHT", [
R(lbl("Hover", "freeze height (O key)"), flag("hover")),
R(lbl("Hover height"), box(() => S.holdY, (v) => { S.holdY = v; }, true)),
R(lbl("Fly mode", "WASD or arrows (F key)"), flag("fly")),
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
const page1 = el("div", { className: "pg hide" }, [phys, surv, coll, flight, pos, launch, card("CHECKPOINTS", slotRows)]);

// ===== TAB: Rewind =====
const meterI = el("i"), meterT = el("div", { className: "note", textContent: "buffer empty" });
const rsec = el("input", { type: "text", className: "num s", value: String(S.rewSec) });
rsec.onchange = () => { const n = Number(rsec.value); if (n >= 1) S.rewSec = Math.floor(n); };
const rbtn = btn("Rewind", () => { const n = Number(rsec.value); if (!(n >= 1)) { say("seconds must be 1 or more"); return; } S.rewSec = Math.floor(n); startRewind({ sec: n }); });
const bigHold = holdBtn(el("button", { className: "btn big", textContent: "\u25C4\u25C4  HOLD TO REWIND" }));
const rec = card("RECORDER", [
R(lbl("Record the run", "10 snapshots a second"), flag("rec")),
R(lbl("Record video", "the footage you see rewinding"), flag("recFrames")),
R(lbl("Memory cap", "oldest footage dropped first"), slid(16, 512, () => S.memMB, (v) => { S.memMB = v; }, "MB")),
el("div", { className: "meter" }, [meterI]), meterT,
btn("Clear buffer", () => { clearBuf(); say("buffer cleared"); })
]);
const world = card("WORLD", [
R(lbl("Keep the world", "obstacles and coins stay for rewind"), flag("keepWorld")),
R(lbl("Coins respawn", "coins you grabbed come back"), flag("respawn")),
R(lbl("Objects kept behind", "more = longer rewind, more load"), slid(20, 300, () => S.keepObs, (v) => { S.keepObs = v; }, "")),
el("div", { className: "note", textContent: "The game normally deletes obstacles and coins once the camera passes them. With this on they are hidden and kept, and come back when you rewind. Your coin total is never rolled back." })
]);
const rew = card("REWIND", [
bigHold,
el("div", { className: "note", textContent: "Hold R, the button above, or the round button on screen. Release to carry on from that moment. Shift+R rewinds the seconds below. The game is frozen while you rewind." }),
R(lbl("Seconds back", "smooth ride back"), RR(rsec, rbtn)),
R(lbl("Hold speed", "x real time"), slid(1, 10, () => S.rewRate, (v) => { S.rewRate = v; }, "x")),
R(lbl("Second chance", "auto rewind when you start to die"), flag("autoRew")),
R(lbl("Second chance seconds"), box(() => S.autoSec, (v) => { S.autoSec = Math.max(1, Math.floor(v)); }, true))
]);
const fxCard = card("EFFECTS", [
R(lbl("Black and white", "0 = color, 100 = full"), slid(0, 100, () => S.fx.gray, (v) => { S.fx.gray = v; }, "%")),
R(lbl("VHS glitch", "tracking bar, grain, scanlines"), sw(() => S.fx.vhs, (v) => { S.fx.vhs = v; })),
R(lbl("Rewind sound", "tape whirr"), sw(() => S.fx.sound, (v) => { S.fx.sound = v; })),
R(lbl("White flash", "on start and stop"), sw(() => S.fx.flash, (v) => { S.fx.flash = v; }))
]);
const page2 = el("div", { className: "pg hide" }, [rec, rew, world, fxCard]);

// ===== TAB: Vars (variable explorer: read, write, freeze any value) =====
const ROOTS = [["meta", () => M()], ["char", () => findChar()], ["level", () => findLevel()], ["game", () => B]];
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
if (k[0] === "_" || k === "parent" || k === "children" || k === "transform" || k === "sprite" || k === "pixiApp") continue;
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
if (!rows.length) { tbl.appendChild(el("div", { className: "empty", textContent: source().length ? "no matches" : "press Rescan (char and level need a run to be active)" })); return; }
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
const page3 = el("div", { className: "pg hide" }, [
el("div", { className: "srch" }, [search, rescan]), diffBar, tbl,
el("div", { className: "note", textContent: "Find an unknown value: Snapshot, change it in the game, press Changed (or Up/Down), repeat. Tap a name to copy its path, tap the lock to freeze a value." })
]);

// ===== TAB: Prefs =====
const THEMES = {
Mint: ["#34c759", "#000", "", "rgba(236,242,248,.93)"],
Aurora: ["#64d2ff", "#fff", "linear-gradient(135deg,rgba(88,86,214,.5),rgba(0,0,0,.4))", "rgba(18,22,44,.93)"],
Sunset: ["#ff9f0a", "#fff", "linear-gradient(135deg,rgba(255,55,95,.45),rgba(255,159,10,.25))", "rgba(40,18,24,.93)"],
Neon: ["#ff2d95", "#fff", "linear-gradient(135deg,rgba(20,0,40,.6),rgba(90,0,100,.4))", "rgba(24,8,36,.94)"],
Matrix: ["#00ff66", "#b6ffd0", "linear-gradient(135deg,rgba(0,20,0,.5),rgba(0,45,10,.4))", "rgba(4,18,8,.95)"],
Gold: ["#ffd60a", "#fff", "linear-gradient(135deg,rgba(40,30,0,.5),rgba(100,70,0,.35))", "rgba(30,24,8,.94)"],
Ice: ["#5ac8fa", "#000", "linear-gradient(135deg,rgba(255,255,255,.4),rgba(120,200,255,.25))", "rgba(232,244,252,.94)"]
};
const accent = el("input", { type: "color", value: S.accent });
accent.style.cssText = "width:50px;height:30px;border:0;padding:0;background:none;cursor:pointer";
applyLook = () => {
const t = THEMES[S.theme] || THEMES.Mint;
host.style.setProperty("--ac", S.accent); host.style.setProperty("--tx", t[1]);
host.style.setProperty("--tint", t[2] || "linear-gradient(transparent,transparent)");
host.style.setProperty("--base", t[3]);
host.style.setProperty("--w", S.w + "px");
host.style.setProperty("--bh", S.bh ? S.bh + "px" : "78vh");
host.style.opacity = S.ui / 100;
if (panel) { panel.classList.toggle("lite", !!S.lite); panel.style.zoom = S.zoom / 100; }
};
accent.oninput = () => { S.accent = accent.value; applyLook(); };
const setTheme = (name) => { const t = THEMES[name]; if (!t) return; S.theme = name; S.accent = t[0]; accent.value = t[0]; applyLook(); say("theme: " + name); };
const persist = (force) => {
try {
const json = JSON.stringify({ s: S, pos: { l: host.offsetLeft, t: host.offsetTop }, min: body.classList.contains("hide") });
if (force || json !== persist.last) { localStorage.setItem(KEY, json); persist.last = json; }
} catch (e) {}
};
const gameStore = () => { try { return B.platformApi.storage; } catch (e) { return null; } };
const saveNow = () => { const g = gameStore(); if (!g) { say("game storage not ready"); return; } writeSave(JSON.stringify(g.data), true); say("game saved"); };
const ta = el("textarea", { className: "num", spellcheck: false, placeholder: "game save / settings JSON" });
let wipeArmed = 0;
const saveCard = card("GAME SAVE", [
el("div", { className: "note", textContent: "Your whole game (coins, gems, upgrades, bats, records) is saved to this browser automatically, a few seconds after every change and when you leave the page." }),
el("div", { className: "btns" }, [
btn("Save now", saveNow),
btn("Export save", () => { const g = gameStore(); if (!g) return; ta.value = JSON.stringify(g.data); try { navigator.clipboard.writeText(ta.value); } catch (e) {} say("save exported (copied if allowed)"); }),
btn("Import save", () => { try { const o = JSON.parse(ta.value); const g = gameStore(); const s = JSON.stringify(o); writeSave(s, true); if (g) { g.data = o; g.save(); } say("imported, reloading..."); setTimeout(() => location.reload(), 500); } catch (e) { say("bad JSON"); } })
]),
btn("Wipe game save", function () {
if (performance.now() - wipeArmed > 3000) { wipeArmed = performance.now(); this.textContent = "Tap again to wipe"; setTimeout(() => { this.textContent = "Wipe game save"; }, 3000); return; }
try { localStorage.removeItem(SK); window.name = ""; } catch (e) {}
writeSave("{}", true); const g = gameStore(); if (g) { g.data = {}; g.save(); }
say("wiped, reloading..."); setTimeout(() => location.reload(), 500);
}),
ta
]);
const page4 = el("div", { className: "pg hide" }, [
saveCard,
card("THEME", [el("div", { className: "btns" }, Object.keys(THEMES).map((n) => { const b = btn(n, () => setTheme(n)); b.style.boxShadow = "inset 0 -3px 0 " + THEMES[n][0]; return b; }))]),
card("APPEARANCE", [
R(lbl("Accent color"), accent),
R(lbl("Panel opacity"), slid(30, 100, () => S.ui, (v) => { S.ui = v; applyLook(); }, "%")),
R(lbl("Text size", "scales the whole panel"), slid(60, 160, () => S.zoom, (v) => { S.zoom = v; applyLook(); }, "%")),
R(lbl("Lite mode", "no blur, much smoother"), flag("lite")),
R(lbl("Reset panel size"), btn("Reset", () => { S.w = 350; S.bh = 0; S.zoom = 100; applyLook(); say("panel size reset"); })),
el("div", { className: "note", textContent: "Drag the corner handle at the bottom right of the panel to resize it." })
]),
card("OTHER", [
R(lbl("Hotkeys", "keyboard shortcuts"), flag("keys")),
R(lbl("Round rewind button", "hold it on screen"), flag("fab")),
R(lbl("On-screen stats", "V key"), flag("hud")),
R(lbl("Toasts", "little notifications"), flag("toasts")),
el("div", { className: "btns" }, [btn("Screenshot", shot)]), el("div", { className: "btns" }, [recBtn = btn("\u25CF Record clip", toggleClip)])
]),
card("HOTKEYS", [el("div", { className: "keys", textContent:
"R hold    rewind\nShift+R   timed rewind\nQ / E     save / load slot 1\nB         bouncy floor\nP         phase\nI         immortal\nO         hover\nF         fly (WASD, arrows)\nC         cruise control\nX         use ability\nM         slow-mo toggle\nV         stats HUD\nJ         screenshot\nH         hide or show this panel\n/  Ctrl+K  command palette" })])
]);

// command palette (/ or Ctrl+K)
const toastBox = el("div", { className: "toasts" });
let lastToast = 0;
toast = (msg) => {
if (!S.toasts) return;
const nw = performance.now(); if (nw - lastToast < 280) return; lastToast = nw;
const n = el("div", { className: "toast", textContent: msg });
toastBox.appendChild(n);
requestAnimationFrame(() => requestAnimationFrame(() => n.classList.add("in")));
setTimeout(() => { n.classList.remove("in"); setTimeout(() => n.remove(), 350); }, 2200);
while (toastBox.children.length > 3) toastBox.firstChild.remove();
};
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

// ===== tabs =====
const TABS = [["Main", page0], ["Cheats", page1], ["Rewind", page2], ["Vars", page3], ["Prefs", page4]];
const pill = el("div", { className: "pill" }); pill.style.width = "calc((100% - 6px) / " + TABS.length + ")";
const tabEls = TABS.map(([name], i) => { const t = el("div", { className: "tab", textContent: name }); t.onclick = () => setTab(i); return t; });
let scanned = false;
const setTab = (i) => {
S.tab = i;
pill.style.transform = "translateX(" + (i * 100) + "%)";
tabEls.forEach((t, j) => t.classList.toggle("on", j === i));
TABS.forEach(([, p], j) => p.classList.toggle("hide", j !== i));
if (i === 3 && !scanned) { scanned = true; rescan.onclick(); }
};
const body = el("div", { className: "b" }, [el("div", { className: "tabs" }, [pill].concat(tabEls))].concat(TABS.map((t) => t[1]), [status]));
const rs = el("div", { className: "rs", title: "drag to resize" });
panel = el("div", { className: "p" }, [head, body, rs]);
hudEl = el("div", { className: "hud" });
fab = holdBtn(el("button", { className: "fab", textContent: "\u25C4\u25C4", title: "hold to rewind" }));
root.appendChild(el("style", { textContent: css }));
root.appendChild(panel); root.appendChild(hudEl); root.appendChild(fab); root.appendChild(toastBox); root.appendChild(pal);
document.body.appendChild(host);
hudEl.style.display = S.hud ? "" : "none";
fab.style.display = S.fab ? "" : "none";
applyLook();

// ---- periodic refresh (one light timer; panel work is skipped while minimized) ----
let tickN = 0;
setInterval(() => {
tickN++;
trim();
const open = !body.classList.contains("hide");
if (open) {
swDraws.forEach((f) => { try { f(); } catch (e) {} });
const have = snaps.length ? (clk() - snaps[0].t) / 1000 : 0, used = frameBytes + snaps.length * 90;
meterI.style.width = Math.min(100, used / (S.memMB * 1048576) * 100) + "%";
meterT.textContent = have.toFixed(0) + "s buffered, " + (used / 1048576).toFixed(1) + " of " + S.memMB + " MB, " + keptO.length + " obstacles and " + keptM.length + " coins kept";
const now = performance.now(); fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now;
sRuns.textContent = String(runs); sH.textContent = Math.round(st.bestY).toLocaleString(); sV.textContent = Math.round(st.bestV).toLocaleString(); sBo.textContent = String(bounces);
try { sC.textContent = Math.round(Number(M().coins.value) - coins0).toLocaleString(); } catch (e) {}
sF.textContent = String(fps);
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
} else { fpsN = 0; fpsT = performance.now(); }
if (S.hud) {
const c = LV && LV.parent && LV.flyingCharacter;
if (c) {
const t = (performance.now() - st.t0) / 1000;
hudEl.innerHTML = "<b>DIST</b>  " + Math.round(Math.abs(c.x - st.x0)).toLocaleString() + "\n<b>HEIGHT</b> " + Math.round(c.y).toLocaleString() + "\n<b>SPEED</b>  " + Math.round(cur.sp).toLocaleString() + "\n<b>TIME</b>   " + t.toFixed(1) + "s" + (rw ? "\n<b>\u25C4\u25C4 REWINDING</b>" : "");
} else hudEl.textContent = "no run active";
}
}, 250);

// ---- save system: autosave of the whole game ----
const autosave = () => { const g = gameStore(); if (!g || !g.data) return; try { const s = JSON.stringify(g.data); if (s !== lastSaved) writeSave(s); } catch (e) {} };
setInterval(autosave, 3000);
addEventListener("pagehide", autosave); addEventListener("beforeunload", autosave);
document.addEventListener("visibilitychange", () => { if (document.hidden) { autosave(); persist(true); } });
// if the mod loaded after the game had already read an empty save, pull the stored save in with one reload
(async () => {
try {
const g = gameStore(), raw = await readSave();
if (!g || !raw || raw === "{}") return;
const snap = JSON.parse(raw);
if (Object.keys(snap).length > Object.keys(g.data || {}).length + 2 && !sessionStorage.getItem("bm_sync")) {
sessionStorage.setItem("bm_sync", "1");
say("restoring your saved game...");
setTimeout(() => location.reload(), 600);
}
} catch (e) {}
})();

// ---- hotkeys ----
const typing = (e) => { const t = (e.composedPath && e.composedPath()[0]) || e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
addEventListener("keydown", (e) => {
const k = (e.key || "").toLowerCase();
if (!typing(e)) held[k] = true;
if (k === "k" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); togglePal(); return; }
if (!S.keys || typing(e) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
if (k === "r") { if (e.shiftKey) startRewind({ sec: S.rewSec }); else startRewind({ hold: true, rate: S.rewRate }); }
else if (k === "q") saveSlot(0);
else if (k === "e") loadSlot(0);
else if (k === "b") setFlag("floor", !S.floor);
else if (k === "p") setFlag("phase", !S.phase);
else if (k === "i") setFlag("immortal", !S.immortal);
else if (k === "o") setFlag("hover", !S.hover);
else if (k === "f") setFlag("fly", !S.fly);
else if (k === "c") setFlag("cruise", !S.cruise);
else if (k === "x") useAbility();
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

// ---- command list ----
const addC = (n, f) => CMDS.push([n, f]);
[3, 5, 10, 15, 30, 60].forEach((n) => addC("Rewind " + n + " seconds", () => startRewind({ sec: n })));
Object.keys(LBL).forEach((k) => addC("Toggle " + LBL[k], () => setFlag(k, !S[k])));
Object.keys(THEMES).forEach((n) => addC("Theme: " + n, () => setTheme(n)));
TABS.forEach(([n], i) => addC("Go to " + n + " tab", () => { body.classList.remove("hide"); setTab(i); }));
addC("Add 1,000,000 coins", () => addMoney("coins", 1e6)); addC("Add 1,000,000,000 coins", () => addMoney("coins", 1e9)); addC("Add 10,000 gems", () => addMoney("gems", 1e4));
addC("Collect everything now", collectAll); addC("Use ability", useAbility); addC("Unlock all bats", unlockBats); addC("Claim daily gift", claimDaily);
addC("Save game now", saveNow); addC("Screenshot", shot); addC("Record gameplay clip", toggleClip);
addC("Clear rewind buffer", () => { clearBuf(); say("buffer cleared"); });
addC("Save checkpoint 1", () => saveSlot(0)); addC("Load checkpoint 1", () => loadSlot(0)); addC("Stop moving (zero velocity)", () => setVel(0, 0));
addC("Hide panel", () => { host.style.display = "none"; });

// ---- drag, resize, minimize, position ----
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const keep = () => {
host.style.left = clamp(host.offsetLeft, 0, Math.max(0, innerWidth - host.offsetWidth)) + "px";
host.style.top = clamp(host.offsetTop, 0, Math.max(0, innerHeight - host.offsetHeight)) + "px";
};
if (saved.pos) { host.style.left = saved.pos.l + "px"; host.style.top = saved.pos.t + "px"; }
if (saved.min) body.classList.add("hide");
keep(); addEventListener("resize", keep);
let dx = 0, dy = 0, drag = false;
head.addEventListener("pointerdown", (e) => { if (e.target === minBtn) return; drag = true; dx = e.clientX - host.offsetLeft; dy = e.clientY - host.offsetTop; head.setPointerCapture(e.pointerId); });
head.addEventListener("pointermove", (e) => {
if (!drag) return;
host.style.left = clamp(e.clientX - dx, 0, Math.max(0, innerWidth - host.offsetWidth)) + "px";
host.style.top = clamp(e.clientY - dy, 0, Math.max(0, innerHeight - host.offsetHeight)) + "px";
});
const end = () => { drag = false; };
head.addEventListener("pointerup", end); head.addEventListener("pointercancel", end);
minBtn.onclick = () => { body.classList.toggle("hide"); };
// corner handle: resizes width and height of the panel
let rsd = null;
rs.addEventListener("pointerdown", (e) => { e.preventDefault(); rsd = { x: e.clientX, y: e.clientY, w: S.w, h: body.offsetHeight }; try { rs.setPointerCapture(e.pointerId); } catch (x) {} });
rs.addEventListener("pointermove", (e) => {
if (!rsd) return;
const z = S.zoom / 100;
S.w = clamp(Math.round(rsd.w + (e.clientX - rsd.x) / z), 260, 760);
S.bh = clamp(Math.round(rsd.h + (e.clientY - rsd.y) / z), 140, 1400);
applyLook();
});
const rsEnd = () => { rsd = null; keep(); persist(true); };
rs.addEventListener("pointerup", rsEnd); rs.addEventListener("pointercancel", rsEnd);
rs.addEventListener("dblclick", () => { S.w = 350; S.bh = 0; applyLook(); });

setInterval(persist, 2500);
setTab(S.tab >= 0 && S.tab < TABS.length ? S.tab : 0);
say("ready");
console.log("bouncemasters mod v5 loaded. game: window.__bm, state: __bm.meta");
}
})();