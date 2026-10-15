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
    const KEY = "bmmod_v2";
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    const S = Object.assign({ grav: 100, floor: false, bounce: 1, minBounce: 1200, phase: false, rec: true, ov: {}, tab: 0 }, saved.s || {});
    const M = () => B.meta;
    let status;
    const say = (s) => { if (status) status.textContent = s; };

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

    // ================= per-frame work: gravity, patching, rewind recording =================
    const GK = ["gravityAccelerationUpMoving", "gravityAccelerationDownMoving", "gravityCosmosAccelerationUpMoving", "gravityCosmosAccelerationDownMoving"];
    let snaps = [], frames = [], lastS = 0, lastF = 0, rewinding = false;
    const fc = document.createElement("canvas"), fctx = fc.getContext("2d");
    B.pixiApp.ticker.add(() => {
      const ch = findChar();
      if (!ch) return;
      patch(ch);
      if (!ch.__g0) ch.__g0 = GK.map((k) => ch[k]);
      GK.forEach((k, i) => { ch[k] = ch.__g0[i] * S.grav / 100; });
      if (!S.rec || rewinding) return;
      const now = performance.now();
      if (ch.state === "flying" && now - lastS >= 1000) {
        lastS = now;
        snaps.push({ t: now, x: ch.x, y: ch.y, vx: ch.flyingVelocity.x, vy: ch.flyingVelocity.y });
        if (snaps.length > 120) snaps.shift();
      }
      if (now - lastF >= 100) {
        lastF = now;
        const v = B.pixiApp.view;
        if (v && v.width) {
          const w = Math.max(160, Math.round(v.width / 4)), h = Math.round(v.height * w / v.width);
          if (fc.width !== w) { fc.width = w; fc.height = h; }
          try {
            fctx.drawImage(v, 0, 0, w, h);
            fc.toBlob((b) => { if (b) { frames.push({ t: now, b }); if (frames.length > 1200) frames.shift(); } }, "image/webp", 0.5);
          } catch (e) {}
        }
      }
    });

    // ================= rewind: reversed grayscale clip, then a real state restore =================
    const overlay = document.createElement("canvas");
    overlay.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:2147483000;filter:grayscale(1) contrast(1.1);pointer-events:none;display:none;background:#000;object-fit:contain";
    document.body.appendChild(overlay);
    const rewind = (sec) => {
      if (rewinding) return;
      sec = Math.max(1, Math.floor(sec));
      const ch = findChar(), now = performance.now(), target = now - sec * 1000;
      let snap = null;
      for (const s of snaps) if (s.t <= target) snap = s;
      if (!snap) snap = snaps[0];
      if (!ch || !snap) { say("nothing recorded that far back yet"); return; }
      const clip = frames.filter((f) => f.t >= snap.t);
      rewinding = true;
      const restore = () => {
        ch.x = snap.x; ch.y = snap.y;
        ch.flyingVelocity.x = snap.vx; ch.flyingVelocity.y = snap.vy;
        if (ch.state !== "flying") ch.state = "flying";
        ch.timeBeforeNextGroundCollisionSec = 0.3;
        ch.isNeedRecalculatePredictions = true;
        snaps = snaps.filter((s) => s.t <= snap.t);
        frames = frames.filter((f) => f.t <= snap.t);
        overlay.style.display = "none";
        rewinding = false;
        say("rewound " + sec + "s");
      };
      if (clip.length < 2) { restore(); return; }
      overlay.width = clip[0].b ? fc.width : 320; overlay.height = fc.height || 180;
      overlay.style.display = "block";
      const D = Math.min(2500, Math.max(700, sec * 250)), t0 = performance.now();
      const octx = overlay.getContext("2d");
      let busy = false;
      const step = () => {
        const p = (performance.now() - t0) / D;
        if (p >= 1) { restore(); return; }
        if (!busy) {
          busy = true;
          const f = clip[Math.max(0, Math.floor((1 - p) * (clip.length - 1)))];
          createImageBitmap(f.b).then((bm) => { octx.drawImage(bm, 0, 0, overlay.width, overlay.height); bm.close(); busy = false; }, () => { busy = false; });
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    // ================= UI =================
    const spring = "cubic-bezier(.34,1.56,.64,1)", MONO = "ui-monospace,Menlo,Consolas,monospace";
    const css = [
      ".p{position:relative;width:330px;color:#000;font:13px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;border-radius:34px;",
      "background:linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.04));-webkit-backdrop-filter:blur(14px) saturate(190%) brightness(1.08);backdrop-filter:blur(14px) saturate(190%) brightness(1.08);",
      "box-shadow:0 18px 50px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.1),inset 0 1px 1px rgba(255,255,255,.55);",
      "transition:transform .6s " + spring + ";user-select:none;overflow:hidden}",
      ".h,.b{position:relative;z-index:1}",
      ".h{padding:15px 18px 9px;display:flex;justify-content:space-between;align-items:center;cursor:grab;touch-action:none;font-weight:700;font-size:15px}",
      ".min{width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:linear-gradient(160deg,rgba(255,255,255,.35),rgba(255,255,255,.1));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:#000;font-size:15px;cursor:pointer;padding:0}",
      ".b{padding:2px 14px 16px;display:flex;flex-direction:column;gap:10px;max-height:78vh;overflow-y:auto}.b.hide{display:none}",
      ".b::-webkit-scrollbar{width:6px}.b::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);border-radius:3px}",
      ".tabs{display:flex;padding:3px;border-radius:18px;background:rgba(0,0,0,.22);box-shadow:inset 0 1px 3px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.2);flex:none}",
      ".tab{flex:1;text-align:center;padding:8px 0;font-weight:600;font-size:12px;cursor:pointer;border-radius:15px;opacity:.7;transition:all .3s}",
      ".tab.on{opacity:1;background:linear-gradient(160deg,rgba(255,255,255,.42),rgba(255,255,255,.14));box-shadow:inset 0 1px 1px rgba(255,255,255,.7),0 2px 8px rgba(0,0,0,.2)}",
      ".pg{display:flex;flex-direction:column;gap:10px}.pg.hide{display:none}",
      ".card{background:linear-gradient(160deg,rgba(255,255,255,.2),rgba(255,255,255,.06));border-radius:24px;padding:11px 13px;box-shadow:inset 0 1px 1px rgba(255,255,255,.5),inset 0 0 0 1px rgba(255,255,255,.12),0 4px 14px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:9px}",
      ".row{display:flex;align-items:center;justify-content:space-between;gap:10px}",
      ".lbl{font-weight:600}.lbl small{display:block;opacity:.7;font-size:11px;font-weight:400;margin-top:1px}",
      ".ttl{font-weight:700;font-size:11px;letter-spacing:.5px;opacity:.65}",
      ".btn{border:0;border-radius:16px;padding:0 13px;height:30px;background:linear-gradient(160deg,rgba(255,255,255,.34),rgba(255,255,255,.12));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:#000;font:600 12px -apple-system,system-ui,sans-serif;cursor:pointer;flex:none;transition:transform .4s " + spring + "}",
      ".btn:active,.min:active{transform:scale(.88)}",
      ".num{width:104px;box-sizing:border-box;height:30px;background:rgba(0,0,0,.22);border:0;border-radius:15px;padding:0 11px;color:#000;font:700 12.5px " + MONO + ";outline:none;text-align:right;box-shadow:inset 0 1px 3px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.2);user-select:text}",
      ".num.s{width:70px}",
      ".sw{width:50px;height:30px;border-radius:15px;background:rgba(255,255,255,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.25);position:relative;cursor:pointer;transition:background .3s;flex:none}",
      ".sw i{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:transform .45s " + spring + "}",
      ".sw.on{background:rgba(52,199,89,.9)}.sw.on i{transform:translateX(20px)}",
      ".srch{display:flex;gap:8px}.srch .num{flex:1;width:auto;text-align:left;font:12.5px -apple-system,system-ui,sans-serif}",
      ".tbl{height:260px;overflow-y:auto;border-radius:20px;background:rgba(0,0,0,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28)}",
      ".tbl::-webkit-scrollbar{width:6px}.tbl::-webkit-scrollbar-thumb{background:rgba(255,255,255,.3);border-radius:3px}",
      ".tr{height:30px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid rgba(255,255,255,.07)}",
      ".nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px " + MONO + "}",
      ".tr input{width:100px;flex:none;box-sizing:border-box;background:rgba(255,255,255,.12);border:0;border-radius:9px;padding:4px 8px;color:#000;font:600 11.5px " + MONO + ";outline:none;text-align:right;user-select:text}",
      ".empty{padding:22px;text-align:center;opacity:.6;font-size:12px}",
      ".status{font:11px " + MONO + ";opacity:.85;min-height:13px;padding:0 6px;word-break:break-word}"
    ].join("");

    const el = (tag, props, kids) => { const n = document.createElement(tag); if (props) Object.assign(n, props); (kids || []).forEach((k) => n.appendChild(k)); return n; };
    const host = el("div");
    host.style.cssText = "position:fixed;top:50px;left:12px;z-index:2147483647;";
    ["mousedown","mouseup","mousemove","click","dblclick","touchstart","touchmove","touchend","touchcancel","pointerdown","pointermove","pointerup","pointercancel","wheel","contextmenu","keydown","keyup","keypress","input","change"]
      .forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
    const root = host.attachShadow({ mode: "open" });
    status = el("div", { className: "status" });
    const minBtn = el("button", { className: "min", textContent: "–" });
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
      draw(); return n;
    };

    // ===== TAB 1: General =====
    const money = el("div", { className: "card" }, [
      el("div", { className: "row" }, [lbl("Coins", "saved by the game"), box(() => M().coins.value, (v) => { M().coins.value = v; })]),
      el("div", { className: "row" }, [lbl("Gems"), box(() => M().gems.value, (v) => { M().gems.value = v; })]),
      el("div", { className: "row" }, [lbl("Best distance", "your record"), box(() => M().maxDistance.value, (v) => { M().maxDistance.value = v; })])
    ]);

    // upgrades: level box + value override (empty = game's own value). Overrides skip the max cap.
    const UP = [["ability", "Ability"], ["beatForce", "Power (beat force)"], ["groundCollision", "Ground collision"], ["maxVelocity", "Max velocity"]];
    const applyOv = (name) => {
      const u = M().upgrades[name], v = S.ov[name];
      if (v === undefined || v === null) { try { delete u.value; } catch (e) {} return; }
      Object.defineProperty(u, "value", { configurable: true, enumerable: true, get: () => S.ov[name] });
    };
    const upCard = el("div", { className: "card" }, [el("div", { className: "ttl", textContent: "UPGRADES: LEVEL  |  VALUE OVERRIDE" })]);
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
      upCard.appendChild(el("div", { className: "row" }, [lbl(title), el("div", { className: "row", style: "gap:6px" }, [lv, vo])]));
      try { applyOv(name); } catch (e) {}
    });

    // physics
    const slider = el("input", { type: "range", min: 1, max: 300, value: S.grav });
    slider.style.cssText = "width:120px";
    const gtxt = el("span", { className: "nm", textContent: S.grav + "%", style: "flex:none;width:44px;text-align:right" });
    slider.oninput = () => { S.grav = +slider.value; gtxt.textContent = S.grav + "%"; };
    const phys = el("div", { className: "card" }, [
      el("div", { className: "ttl", textContent: "PHYSICS" }),
      el("div", { className: "row" }, [lbl("Gravity", "1% is almost none"), el("div", { className: "row", style: "gap:6px" }, [slider, gtxt])]),
      el("div", { className: "row" }, [lbl("Bouncy floor", "ground always bounces you"), sw(() => S.floor, (v) => { S.floor = v; })]),
      el("div", { className: "row" }, [lbl("Bounce strength", "x of impact speed"), box(() => S.bounce, (v) => { S.bounce = Math.max(0, v); }, true)]),
      el("div", { className: "row" }, [lbl("Min bounce speed", "keeps you from settling"), box(() => S.minBounce, (v) => { S.minBounce = Math.max(0, v); }, true)]),
      el("div", { className: "row" }, [lbl("Phase through obstacles", "coins and gems still collect"), sw(() => S.phase, (v) => { S.phase = v; })])
    ]);

    // position
    const pos = el("div", { className: "card" }, [
      el("div", { className: "ttl", textContent: "POSITION (during a run)" }),
      el("div", { className: "row" }, [lbl("X", "you move toward negative X"), box(() => { const c = findChar(); return c ? c.x : 0; }, (v) => { const c = findChar(); if (!c) throw "no run active"; c.x = v; }, false)]),
      el("div", { className: "row" }, [lbl("Height (Y)"), box(() => { const c = findChar(); return c ? c.y : 0; }, (v) => { const c = findChar(); if (!c) throw "no run active"; c.y = v; }, false)])
    ]);

    // rewind
    const rsec = el("input", { type: "text", className: "num s", value: "5" });
    const rbtn = el("button", { className: "btn", textContent: "Rewind" });
    rbtn.onclick = () => { const n = Number(rsec.value); if (!(n >= 1)) { say("seconds must be 1 or more"); return; } rewind(n); };
    const rew = el("div", { className: "card" }, [
      el("div", { className: "ttl", textContent: "REWIND" }),
      el("div", { className: "row" }, [lbl("Record", "state each second, frames 10/s"), sw(() => S.rec, (v) => { S.rec = v; if (!v) { snaps = []; frames = []; } })]),
      el("div", { className: "row" }, [lbl("Seconds back", "up to 120"), el("div", { className: "row", style: "gap:6px" }, [rsec, rbtn])])
    ]);
    const page0 = el("div", { className: "pg" }, [money, upCard, phys, pos, rew]);

    // ===== TAB 2: Advanced (variable explorer: read and write any value) =====
    const ROOTS = [["meta", () => M()], ["char", () => findChar()], ["game", () => B]];
    let allRows = [], rows = [];
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
    const rescan = el("button", { className: "btn", textContent: "Rescan" });
    const tbl = el("div", { className: "tbl" });
    let shown = [];
    const render = () => {
      tbl.innerHTML = ""; shown = [];
      if (!rows.length) { tbl.appendChild(el("div", { className: "empty", textContent: allRows.length ? "no matches" : "press Rescan (the char root needs a run to be active)" })); return; }
      rows.slice(0, 150).forEach((r) => {
        const cur = readRow(r);
        const input = el("input", { type: "text", value: cur === undefined ? "" : String(cur), spellcheck: false });
        input.onchange = () => {
          const t = input.value, p = resolve(r);
          if (!p) { say("path gone, rescan"); return; }
          const old = p[0][p[1]];
          let v = t;
          if (typeof old === "number") { v = Number(t); if (!isFinite(v)) { say("not a number"); input.value = String(old); return; } }
          else if (typeof old === "boolean") v = t === "true" || t === "1";
          try { p[0][p[1]] = v; say(r.path + " = " + v); } catch (e) { say("set ERR: " + e); }
        };
        input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };
        tbl.appendChild(el("div", { className: "tr" }, [el("div", { className: "nm", textContent: r.path, title: r.path }), input]));
        shown.push([r, input]);
      });
    };
    const filter = () => {
      const q = search.value.trim().toLowerCase();
      rows = allRows.filter((r) => {
        if (!q) return true;
        if (r.path.toLowerCase().indexOf(q) >= 0) return true;
        const v = readRow(r);
        return v !== undefined && String(v).toLowerCase() === q;
      });
      render(); say(rows.length + " of " + allRows.length + " variables");
    };
    let ft; search.addEventListener("input", () => { clearTimeout(ft); ft = setTimeout(filter, 200); });
    rescan.onclick = () => { say("scanning..."); setTimeout(() => { try { allRows = scan(); filter(); } catch (e) { say("scan ERR: " + e); } }, 20); };
    const page1 = el("div", { className: "pg hide" }, [el("div", { className: "srch" }, [search, rescan]), tbl]);

    // ===== tabs =====
    const tA = el("div", { className: "tab", textContent: "General" }), tB = el("div", { className: "tab", textContent: "Advanced" });
    let scanned = false;
    const setTab = (i) => {
      S.tab = i;
      [tA, tB].forEach((t, j) => t.classList.toggle("on", j === i));
      [page0, page1].forEach((p, j) => p.classList.toggle("hide", j !== i));
      if (i === 1 && !scanned) { scanned = true; rescan.onclick(); }
    };
    tA.onclick = () => setTab(0); tB.onclick = () => setTab(1);

    const body = el("div", { className: "b" }, [el("div", { className: "tabs" }, [tA, tB]), page0, page1, status]);
    const panel = el("div", { className: "p" }, [head, body]);
    root.appendChild(el("style", { textContent: css }));
    root.appendChild(panel);
    document.body.appendChild(host);

    // live values (skips the box you are typing in)
    setInterval(() => {
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
    }, 1000);

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

    let last = "";
    setInterval(() => {
      try {
        const json = JSON.stringify({ s: S, pos: { l: host.offsetLeft, t: host.offsetTop }, min: body.classList.contains("hide") });
        if (json !== last) { localStorage.setItem(KEY, json); last = json; }
      } catch (e) {}
    }, 2000);

    setTab(S.tab === 1 ? 1 : 0);
    say("ready");
    console.log("bouncemasters mod v2 loaded. game: window.__bm, state: __bm.meta");
  }
})();