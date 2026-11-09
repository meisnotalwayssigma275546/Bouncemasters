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
hud: true, keys: true, fab: true, accent: "#34c759", ui: 100, ov: {}, tab: 0
};
const S = Object.assign({}, DEF, saved.s || {});
S.fx = Object.assign({}, DEF.fx, (saved.s && saved.s.fx) || {});
S.ov = Object.assign({}, (saved.s && saved.s.ov) || {});
const M = () => B.meta;
const VIEW = () => B.pixiApp.view || B.pixiApp.canvas;
let status;
const say = (s) => { if (status) status.textContent = s; };
const LBL = { floor: "Bouncy floor", phase: "Phase", hover: "Hover", fly: "Fly mode", cruise: "Cruise", rec: "Recording", recFrames: "Frame capture", autoRew: "Second chance", hud: "HUD", keys: "Hotkeys", fab: "Rewind button" };
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
const MAXREC = 1800; // 3 minutes of state at 10/s
const MAXFR = 3600; // 3 minutes of video at 20/s
let snaps = [], frames = [], lastS = 0, lastF = 0, skew = 0, rw = null;
const clk = () => performance.now() - skew; // timeline clock: skips over the time that was rewound
const bsearch = (arr, t) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
const snapAt = (t) => snaps[Math.max(0, bsearch(snaps, t))];
const frameAt = (t) => frames[bsearch(frames, t)] || null;
const fc = document.createElement("canvas"), fctx = fc.getContext("2d");
const pin = (ch, s) => { ch.x = s.x; ch.y = s.y; ch.flyingVelocity.x = s.vx; ch.flyingVelocity.y = s.vy; ch.timeBeforeNextGroundCollisionSec = 0.3; };
const restoreState = (ch, s) => { pin(ch, s); if (ch.state !== "flying") ch.state = "flying"; ch.isNeedRecalculatePredictions = true; };

// ================= run stats =================
let lastCh = null, runs = 0, st = { x0: 0, t0: 0, bestY: 0, bestV: 0 }, cur = { y: 0, sp: 0 };
let prevState = null, offCount = 0, autoCool = 0, fno = 0, fpsN = 0, fpsT = performance.now(), fps = 0;
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
if (ch.state === "flying" && now - lastS >= 100) {
lastS = now;
snaps.push({ t: now, x: ch.x, y: ch.y, vx: v.x, vy: v.y });
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
fc.toBlob((b) => { if (b) { frames.push({ t: now, b }); if (frames.length > MAXFR) frames.shift(); } }, "image/webp", 0.6);
} catch (e) {}
};
tk.add(grabFrame, null, -50);
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
"@keyframes bmfx-bl{0%{opacity:1}50%{opacity:.1}}"
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
if (ch && s) restoreState(ch, s);
if (s) {
snaps = snaps.filter((x) => x.t <= s.t); frames = frames.filter((f) => f.t <= s.t);
skew = performance.now() - s.t; lastS = lastF = s.t;
}
const back = Math.round((r.from - r.t) / 100) / 10;
rw = null; prevState = "flying"; offCount = 0;
fxHide(); sndStop();
say("rewound " + back + "s");
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

// ================= flags (switches and hotkeys share this) =================
let hudEl, fab;
const setFlag = (n, v) => {
S[n] = v;
if (n === "hover" && v) { const c = findChar(); S.holdY = c ? Math.round(c.y) : 0; }
if (n === "rec" && !v) { snaps = []; frames = []; }
if (n === "hud" && hudEl) hudEl.style.display = v ? "" : "none";
if (n === "fab" && fab) fab.style.display = v ? "" : "none";
say((LBL[n] || n) + (v ? " ON" : " OFF"));
};

// ================= UI =================
const spring = "cubic-bezier(.34,1.56,.64,1)", MONO = "ui-monospace,Menlo,Consolas,monospace";
const css = `
.p{position:relative;width:350px;color:#000;font:13px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;border-radius:34px;
background:linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.04));-webkit-backdrop-filter:blur(14px) saturate(190%) brightness(1.08);backdrop-filter:blur(14px) saturate(190%) brightness(1.08);
box-shadow:0 18px 50px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.1),inset 0 1px 1px rgba(255,255,255,.55);
transition:transform .6s ${spring};user-select:none;overflow:hidden}
.h,.b{position:relative;z-index:1}
.h{padding:15px 18px 9px;display:flex;justify-content:space-between;align-items:center;cursor:grab;touch-action:none;font-weight:700;font-size:15px}
.min{width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:linear-gradient(160deg,rgba(255,255,255,.35),rgba(255,255,255,.1));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:#000;font-size:15px;cursor:pointer;padding:0}
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
.btn{border:0;border-radius:16px;padding:0 13px;height:30px;background:linear-gradient(160deg,rgba(255,255,255,.34),rgba(255,255,255,.12));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:#000;font:600 12px -apple-system,system-ui,sans-serif;cursor:pointer;flex:none;transition:transform .4s ${spring}}
.btn:active,.min:active{transform:scale(.88)}
.btn.hot{background:var(--ac,#34c759);color:#fff}
.btn.big{height:46px;border-radius:23px;font-size:14px;width:100%}
.btns{display:flex;gap:6px;flex-wrap:wrap}.btns .btn{flex:1;padding:0 8px}
.num{width:104px;box-sizing:border-box;height:30px;background:rgba(0,0,0,.22);border:0;border-radius:15px;padding:0 11px;color:#000;font:700 12.5px ${MONO};outline:none;text-align:right;box-shadow:inset 0 1px 3px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.2);user-select:text}
.num.s{width:70px}
.sw{width:50px;height:30px;border-radius:15px;background:rgba(255,255,255,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.25);position:relative;cursor:pointer;transition:background .3s;flex:none}
.sw i{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:transform .45s ${spring}}
.sw.on{background:var(--ac,#34c759)}.sw.on i{transform:translateX(20px)}
.srch{display:flex;gap:8px}.srch .num{flex:1;width:auto;text-align:left;font:12.5px -apple-system,system-ui,sans-serif}
.tbl{height:260px;overflow-y:auto;border-radius:20px;background:rgba(0,0,0,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28)}
.tbl::-webkit-scrollbar{width:6px}.tbl::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);border-radius:3px}
.tr{height:30px;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:0 8px 0 10px;border-bottom:1px solid rgba(255,255,255,.07)}
.nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px ${MONO}}
.tr input{width:84px;flex:none;box-sizing:border-box;background:rgba(255,255,255,.12);border:0;border-radius:9px;padding:4px 8px;color:#000;font:600 11.5px ${MONO};outline:none;text-align:right;user-select:text}
.lk{flex:none;width:24px;height:22px;border:0;border-radius:8px;background:rgba(255,255,255,.14);font-size:11px;cursor:pointer;padding:0;opacity:.6}.lk.on{background:var(--ac,#34c759);opacity:1}
.empty{padding:22px;text-align:center;opacity:.6;font-size:12px}
.status{display:none;position:sticky;bottom:0;font:11px ${MONO};min-height:13px;padding:5px 9px;border-radius:12px;background:rgba(0,0,0,.28);color:#000;word-break:break-word;flex:none}
.meter{height:8px;border-radius:4px;background:rgba(0,0,0,.25);overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--ac,#34c759);transition:width .25s}
.keys{font:11px/1.55 ${MONO};opacity:.85;white-space:pre-wrap}
textarea.num{width:100%;height:64px;padding:8px 10px;border-radius:14px;text-align:left;resize:none;font:11px ${MONO}}
.hud{position:fixed;top:10px;right:10px;padding:8px 11px;border-radius:14px;background:rgba(0,0,0,.42);color:#fff;font:11px/1.5 ${MONO};pointer-events:none;white-space:pre;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.hud b{color:var(--ac,#34c759);font-weight:700}
.fab{position:fixed;left:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);width:54px;height:54px;border-radius:50%;border:1px solid rgba(255,255,255,.45);background:linear-gradient(160deg,rgba(255,255,255,.45),rgba(255,255,255,.15));box-shadow:0 6px 20px rgba(0,0,0,.35),inset 0 1px 1px rgba(255,255,255,.7);color:#000;font:700 15px system-ui,sans-serif;cursor:pointer;touch-action:none;opacity:.8;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:transform .35s ${spring}}
.fab.hot{background:var(--ac,#34c759);color:#fff;transform:scale(1.15);opacity:1}
`;

const el = (tag, props, kids) => { const n = document.createElement(tag); if (props) Object.assign(n, props); (kids || []).forEach((k) => n.appendChild(k)); return n; };
const host = el("div");
host.style.cssText = "position:fixed;top:50px;left:12px;z-index:2147483647;";
["mousedown", "mouseup", "mousemove", "click", "dblclick", "touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu", "keydown", "keyup", "keypress", "input", "change"]
.forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
const root = host.attachShadow({ mode: "open" });
status = el("div", { className: "status" });
const minBtn = el("button", { className: "min", textContent: "\u2013" });
const head = el("div", { className: "h" }, [el("span", { textContent: "Bouncemasters Mod" }), minBtn]);

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
const btn = (t, fn, cls) => { const b = el("button", { className: "btn" + (cls ? " " + cls : ""), textContent: t }); b.onclick = fn; return b; };
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
const page1 = el("div", { className: "pg hide" }, [phys, flight, pos, launch, card("CHECKPOINTS", slotRows)]);

// ===== TAB: Rewind =====
const meterI = el("i"), meterT = el("div", { className: "note", textContent: "buffer empty" });
const rsec = el("input", { type: "text", className: "num s", value: String(S.rewSec) });
rsec.onchange = () => { const n = Number(rsec.value); if (n >= 1) S.rewSec = Math.floor(n); };
const rbtn = btn("Rewind", () => { const n = Number(rsec.value); if (!(n >= 1)) { say("seconds must be 1 or more"); return; } S.rewSec = Math.floor(n); startRewind({ sec: n }); });
const bigHold = holdBtn(el("button", { className: "btn big", textContent: "\u25C4\u25C4  HOLD TO REWIND" }));
const asec = box(() => S.autoSec, (v) => { S.autoSec = Math.max(1, Math.floor(v)); }, true);
const rec = card("RECORDER", [
R(lbl("Record state", "state 10/s, video 20/s, 3 min"), flag("rec")),
R(lbl("Record video frames", "needed for the reversed footage"), flag("recFrames")),
el("div", { className: "meter" }, [meterI]), meterT,
btn("Clear buffer", () => { snaps = []; frames = []; say("buffer cleared"); })
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
const page2 = el("div", { className: "pg hide" }, [rec, rew, fxCard]);

// ===== TAB: Stats =====
const gc = el("canvas", { width: 600, height: 180 });
gc.style.cssText = "width:100%;height:90px;border-radius:14px;background:rgba(0,0,0,.25)";
const hist = [];
const statLine = (name) => { const v = el("div", { className: "nm", textContent: "-" }); v.style.cssText = "flex:none;text-align:right;font-weight:700"; return [R(lbl(name), v), v]; };
const [sRunsR, sRuns] = statLine("Runs this session"), [sHR, sH] = statLine("Best height"), [sVR, sV] = statLine("Best speed"), [sCR, sC] = statLine("Coins gained (net)"), [sFR, sF] = statLine("FPS");
recBtn = btn("\u25CF Record clip", toggleClip);
const page3 = el("div", { className: "pg hide" }, [
card("LIVE GRAPH (60s)", [gc, el("div", { className: "note", textContent: "accent line = height, white line = speed" })]),
card("SESSION", [sRunsR, sHR, sVR, sCR, sFR]),
card("CAPTURE", [el("div", { className: "btns" }, [btn("Screenshot (J)", shot), recBtn]), el("div", { className: "note", textContent: "Downloads can be blocked inside some embedded players." })]),
card("HUD", [R(lbl("On-screen stats", "V key"), flag("hud"))])
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
const applyTheme = () => { host.style.setProperty("--ac", S.accent); host.style.opacity = S.ui / 100; };
accent.oninput = () => { S.accent = accent.value; applyTheme(); };
const ta = el("textarea", { className: "num", spellcheck: false, placeholder: "settings JSON" });
const persist = (force) => {
try {
const json = JSON.stringify({ s: S, pos: { l: host.offsetLeft, t: host.offsetTop }, min: body.classList.contains("hide") });
if (force || json !== persist.last) { localStorage.setItem(KEY, json); persist.last = json; }
} catch (e) {}
};
const page5 = el("div", { className: "pg hide" }, [
card("APPEARANCE", [
R(lbl("Accent color"), accent),
R(lbl("Panel opacity"), slid(30, 100, () => S.ui, (v) => { S.ui = v; applyTheme(); }, "%")),
R(lbl("Hotkeys", "keyboard shortcuts"), flag("keys")),
R(lbl("Round rewind button", "hold it on screen"), flag("fab"))
]),
card("HOTKEYS", [el("div", { className: "keys", textContent:
"R hold    rewind\nShift+R   timed rewind\nQ / E     save / load slot 1\nB         bouncy floor\nP         phase\nO         hover\nF         fly (WASD, arrows)\nC         cruise control\nM         slow-mo toggle\nV         stats HUD\nJ         screenshot\nH         hide or show this panel" })]),
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
const TABS = [["Main", page0], ["Cheats", page1], ["Rewind", page2], ["Stats", page3], ["Vars", page4], ["Prefs", page5]];
const tabEls = TABS.map(([name], i) => { const t = el("div", { className: "tab", textContent: name }); t.onclick = () => setTab(i); return t; });
let scanned = false;
const setTab = (i) => {
S.tab = i;
tabEls.forEach((t, j) => t.classList.toggle("on", j === i));
TABS.forEach(([, p], j) => p.classList.toggle("hide", j !== i));
if (i === 4 && !scanned) { scanned = true; rescan.onclick(); }
};

const body = el("div", { className: "b" }, [el("div", { className: "tabs" }, tabEls)].concat(TABS.map((t) => t[1]), [status]));
const panel = el("div", { className: "p" }, [head, body]);
hudEl = el("div", { className: "hud" });
fab = holdBtn(el("button", { className: "fab", textContent: "\u25C4\u25C4", title: "hold to rewind" }));
root.appendChild(el("style", { textContent: css }));
root.appendChild(panel); root.appendChild(hudEl); root.appendChild(fab);
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
const have = snaps.length ? (clk() - snaps[0].t) / 1000 : 0;
meterI.style.width = Math.min(100, have / (MAXREC / 10) * 100) + "%";
meterT.textContent = "buffer " + have.toFixed(1) + "s of " + (MAXREC / 10) + "s, " + frames.length + " frames";
// fps + stats
const now = performance.now(); fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now;
sRuns.textContent = String(runs); sH.textContent = Math.round(st.bestY).toLocaleString(); sV.textContent = Math.round(st.bestV).toLocaleString();
try { sC.textContent = Math.round(M().coins.value - coins0).toLocaleString(); } catch (e) {}
sF.textContent = String(fps);
// hud
if (S.hud) {
const c = CH && CH.parent ? CH : null;
if (c) {
const dist = Math.abs(c.x - st.x0), t = (now - st.t0) / 1000;
hudEl.innerHTML = "<b>DIST</b>  " + Math.round(dist).toLocaleString() + "\n<b>HEIGHT</b> " + Math.round(c.y).toLocaleString() + "\n<b>SPEED</b>  " + Math.round(cur.sp).toLocaleString() + "\n<b>TIME</b>   " + t.toFixed(1) + "s\n<b>FPS</b>    " + fps + (rw ? "\n<b>\u25C4\u25C4 REWINDING</b>" : "");
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
minBtn.onclick = () => body.classList.toggle("hide");

setInterval(persist, 2000);

setTab(S.tab >= 0 && S.tab < TABS.length ? S.tab : 0);
say("ready");
console.log("bouncemasters mod v3 loaded. game: window.__bm, state: __bm.meta");
}
})();