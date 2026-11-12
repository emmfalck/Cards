(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const FIELDS = ["firstName","lastName","company","title","mobile","phone","email","website","street","postcode","city","country","note"];
  const PIN_KEY = "cardscan.pin.v1", DATA_KEY = "cardscan.contacts.v1";

  // ---------- small helpers ----------
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  function show(id) { document.querySelectorAll(".screen").forEach(s => s.classList.toggle("on", s.id === id)); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // =====================================================================
  // PIN LOCK
  // =====================================================================
  const lockUI = { msg: $("#lockMsg"), dots: $("#dots"), title: $("#lockTitle"), forgot: $("#forgotBtn") };
  let entry = "", pinMode = "enter", firstPin = "", busy = false, forgotArmed = false, unlocked = false;

  async function hash(pin, salt) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + pin));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  const say = (t, err) => { lockUI.msg.textContent = t; lockUI.msg.className = err ? "err" : ""; };
  const paint = () => [...lockUI.dots.children].forEach((d, i) => d.classList.toggle("on", i < entry.length));
  const shake = () => { lockUI.dots.classList.remove("shake"); void lockUI.dots.offsetWidth; lockUI.dots.classList.add("shake"); };

  function lock(mode) {
    unlocked = false; stopCamera();
    entry = ""; paint(); forgotArmed = false;
    const p = ls.get(PIN_KEY, null);
    if (mode === "change") { pinMode = "set1"; lockUI.title.textContent = "New code"; say("Choose 4 new digits"); lockUI.forgot.classList.add("hidden"); }
    else if (p) { pinMode = "enter"; lockUI.title.textContent = "Card Scanner"; say("Enter your code"); lockUI.forgot.classList.remove("hidden"); lockUI.forgot.textContent = "Forgot code?"; }
    else { pinMode = "set1"; lockUI.title.textContent = "Choose a code"; say("Pick 4 digits to open the app"); lockUI.forgot.classList.add("hidden"); }
    show("lock");
  }
  function unlock() { unlocked = true; entry = ""; paint(); startScan(); }

  async function pinDone() {
    busy = true;
    try {
      if (pinMode === "enter") {
        const p = ls.get(PIN_KEY, null);
        if (p && await hash(entry, p.salt) === p.hash) unlock();
        else { shake(); say("Wrong code, try again", true); }
      } else {
        // choose the code once — no "enter it again" step
        const salt = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
        ls.set(PIN_KEY, { salt, hash: await hash(entry, salt) });
        say("Code saved");
        await sleep(500);
        unlock();
      }
    } finally { entry = ""; paint(); busy = false; }
  }
  function press(k) {
    if (busy) return;
    if (k === "del") { entry = entry.slice(0, -1); paint(); return; }
    if (entry.length >= 4) return;
    entry += k; paint();
    if (navigator.vibrate) navigator.vibrate(8);
    if (entry.length === 4) setTimeout(pinDone, 120);
  }
  $("#pad").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || b.classList.contains("blank")) return;
    press(b.dataset.k || b.textContent.trim());
  });
  document.addEventListener("keydown", e => {
    if (!$("#lock").classList.contains("on")) return;
    if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === "Backspace") press("del");
  });
  lockUI.forgot.addEventListener("click", () => {
    if (!forgotArmed) { forgotArmed = true; lockUI.forgot.textContent = "Tap again to erase the code and all saved cards"; return; }
    ls.del(PIN_KEY); ls.del(DATA_KEY); location.reload();
  });
  $("#pinBtn").addEventListener("click", () => lock("change"));
  $("#lockBtn").addEventListener("click", () => lock());

  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); stopCamera(); }
    else {
      if (unlocked && ls.get(PIN_KEY, null) && Date.now() - hiddenAt > 5 * 60 * 1000) lock();
      else if (unlocked && $("#scan").classList.contains("on")) startScan();
    }
  });

  // =====================================================================
  // OCR (on-device, Tesseract)
  // =====================================================================
  let workerP = null;
  function getWorker(onStatus) {
    if (!workerP) {
      workerP = (async () => {
        if (!window.Tesseract) throw new Error("reader-missing");
        const w = await Tesseract.createWorker(["eng", "nor"], 1, {
          logger: m => { if (onStatus && m.status) onStatus(m); }
        });
        await w.setParameters({ preserve_interword_spaces: "1" });
        return w;
      })();
      workerP.catch(() => { workerP = null; });
    }
    return workerP;
  }

  function prepCanvas(src, sx, sy, sw, sh) {
    // crop + upscale + grayscale + contrast stretch
    const targetW = Math.min(2200, Math.max(1600, sw));
    const scale = targetW / sw;
    const c = document.createElement("canvas");
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = y; hist[y]++; }
    const n = d.length / 4; let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi = i; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, (d[i] - lo) * 255 / span)); d[i] = d[i + 1] = d[i + 2] = v; }
    g.putImageData(img, 0, 0);
    return c;
  }

  async function readCard(canvas, thumbURL) {
    const rd = $("#reading"), txt = $("#readingText"), sub = $("#readingSub");
    rd.classList.remove("hidden"); txt.textContent = "Reading card…"; sub.textContent = "";
    try {
      const w = await getWorker(m => {
        if (/loading|initializ/i.test(m.status)) { txt.textContent = "Getting the reader ready…"; sub.textContent = "First time only — needs internet (about 15 MB)"; }
        else if (/recogniz/i.test(m.status)) { txt.textContent = "Reading card…"; sub.textContent = Math.round((m.progress || 0) * 100) + "%"; }
      });
      txt.textContent = "Reading card…"; sub.textContent = "";
      await w.setParameters({ tessedit_pageseg_mode: "3" });
      let { data } = await w.recognize(canvas);
      let text = data.text || "";
      let fields = parseCard(text);
      if (!fields.email && !fields.mobile && !fields.phone) {
        // try again treating the card as scattered text
        sub.textContent = "Looking more closely…";
        await w.setParameters({ tessedit_pageseg_mode: "11" });
        const r2 = await w.recognize(canvas);
        const f2 = parseCard(r2.data.text || "");
        if (f2.email || f2.mobile || f2.phone) { fields = f2; text = r2.data.text; }
      }
      openReview(fields, text, thumbURL);
    } catch (e) {
      rd.classList.add("hidden");
      $("#hint").textContent = e && e.message === "reader-missing" || !navigator.onLine
        ? "Couldn't load the reader — connect to the internet once and try again"
        : "Couldn't read that card — try again with more light";
      resumeScan();
      return;
    }
    rd.classList.add("hidden");
  }

  // =====================================================================
  // CAMERA + AUTO-CAPTURE
  // =====================================================================
  const video = $("#video"), frameEl = $("#frame"), bar = $("#bar"), hint = $("#hint");
  let stream = null, loopId = 0, prev = null, steadyCount = 0, capturing = false;
  const STEADY_NEEDED = 7;   // ~1 s at 150 ms ticks
  const small = document.createElement("canvas"); small.width = 120; small.height = 76;
  const sg = small.getContext("2d", { willReadFrequently: true });

  async function startScan() {
    show("scan");
    $("#still").style.display = "none";
    capturing = false; steadyCount = 0; prev = null; bar.style.width = "0";
    if (!hint.dataset.keep) hint.textContent = "Hold the card inside the frame";
    delete hint.dataset.keep;
    if (stream) { video.play().catch(() => {}); runLoop(); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      $("#camErr").classList.add("hidden");
      runLoop();
    } catch (e) {
      $("#camErr").classList.remove("hidden");
      $("#camErrText").textContent = (e && e.name === "NotAllowedError")
        ? "Camera access is turned off. On iPhone: Settings → Safari → Camera → Allow (or remove and re-add the app), then try again. You can also pick a photo."
        : "Couldn't start the camera. You can pick a photo instead.";
    }
  }
  function stopCamera() {
    cancelAnimationFrame(loopId); clearTimeout(loopId);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; }
  }
  $("#retryCam").addEventListener("click", startScan);

  // where the on-screen frame sits inside the video's own pixels
  function frameRectInVideo() {
    const vw = video.clientWidth, vh = video.clientHeight, VW = video.videoWidth, VH = video.videoHeight;
    if (!VW || !VH) return null;
    const s = Math.max(vw / VW, vh / VH), ox = (vw - VW * s) / 2, oy = (vh - VH * s) / 2;
    const vr = video.getBoundingClientRect(), fr = frameEl.getBoundingClientRect();
    let x = (fr.left - vr.left - ox) / s, y = (fr.top - vr.top - oy) / s, w = fr.width / s, h = fr.height / s;
    // a little margin so the card edges aren't cut off
    const mx = w * 0.04, my = h * 0.06;
    x -= mx; y -= my; w += 2 * mx; h += 2 * my;
    x = Math.max(0, x); y = Math.max(0, y); w = Math.min(VW - x, w); h = Math.min(VH - y, h);
    return { x, y, w, h };
  }

  function runLoop() {
    clearTimeout(loopId);
    const tick = () => {
      if (!stream || capturing || !$("#scan").classList.contains("on")) return;
      const r = frameRectInVideo();
      if (r) {
        sg.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
        const d = sg.getImageData(0, 0, small.width, small.height).data;
        const W = small.width, H = small.height, g = new Uint8Array(W * H);
        let bright = 0;
        for (let i = 0, j = 0; i < d.length; i += 4, j++) { g[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10; bright += g[j]; }
        bright /= g.length;
        let edges = 0;
        for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
          const k = y * W + x; edges += Math.abs(g[k] - g[k + 1]) + Math.abs(g[k] - g[k + W]);
        }
        edges /= (W - 1) * (H - 1);
        let diff = 99;
        if (prev) { diff = 0; for (let k = 0; k < g.length; k++) diff += Math.abs(g[k] - prev[k]); diff /= g.length; }
        prev = g;

        const hasCard = edges > 9 && bright > 45;
        const steady = diff < 5.5;
        if (bright <= 45) { hint.textContent = "Too dark — find more light"; steadyCount = 0; }
        else if (!hasCard) { hint.textContent = "Hold the card inside the frame"; steadyCount = 0; }
        else if (!steady) { hint.textContent = "Hold still…"; steadyCount = Math.max(0, steadyCount - 2); }
        else { steadyCount++; hint.textContent = "Hold still…"; }
        frameEl.classList.toggle("steady", steadyCount > 0);
        bar.style.width = Math.min(100, steadyCount / STEADY_NEEDED * 100) + "%";
        if (steadyCount >= STEADY_NEEDED) { capture(); return; }
      }
      loopId = setTimeout(tick, 150);
    };
    loopId = setTimeout(tick, 300);
  }

  async function capture() {
    if (capturing || !video.videoWidth) return;
    capturing = true; clearTimeout(loopId);
    if (navigator.vibrate) navigator.vibrate(30);
    const r = frameRectInVideo() || { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
    // freeze the picture on screen
    const full = document.createElement("canvas");
    full.width = video.videoWidth; full.height = video.videoHeight;
    full.getContext("2d").drawImage(video, 0, 0);
    const still = $("#still"); still.src = full.toDataURL("image/jpeg", 0.7); still.style.display = "block";
    video.pause();
    const crop = document.createElement("canvas"); crop.width = r.w; crop.height = r.h;
    crop.getContext("2d").drawImage(full, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const thumb = crop.toDataURL("image/jpeg", 0.75);
    await sleep(30);
    await readCard(prepCanvas(full, r.x, r.y, r.w, r.h), thumb);
  }
  function resumeScan() {
    capturing = false; steadyCount = 0; prev = null; bar.style.width = "0";
    $("#still").style.display = "none";
    hint.dataset.keep = "1";
    startScan();
    setTimeout(() => { delete hint.dataset.keep; }, 2500);
  }
  $("#shutter").addEventListener("click", () => { steadyCount = STEADY_NEEDED; capture(); });

  // photo from library
  $("#pick").addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
    capturing = true; clearTimeout(loopId);
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) { hint.textContent = "Couldn't open that photo"; capturing = false; runLoop(); return; }
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    const thumb = c.toDataURL("image/jpeg", 0.7);
    $("#still").src = thumb; $("#still").style.display = "block"; video.pause();
    await readCard(prepCanvas(c, 0, 0, c.width, c.height), thumb);
  });
  $("#manualBtn").addEventListener("click", () => openReview({}, "", null));

  // =====================================================================
  // REVIEW + SAVE
  // =====================================================================
  const form = $("#form");
  let current = null; // {id, t, c}
  function openReview(fields, raw, thumb) {
    stopCamera();
    FIELDS.forEach(k => form.elements[k].value = (fields[k] || "").trim());
    $("#rawText").textContent = raw || "(typed by hand)";
    const th = $("#thumb"); if (thumb) { th.src = thumb; th.classList.remove("hidden"); } else th.classList.add("hidden");
    current = { id: String(Date.now()), t: Date.now(), c: null, thumb: null };
    setMsg("");
    updateButtons();
    show("review");
    $("#review").scrollTop = 0;
  }
  const readForm = () => { const o = {}; FIELDS.forEach(k => o[k] = form.elements[k].value.trim()); return o; };
  form.addEventListener("input", updateButtons);
  function updateButtons() {
    const c = readForm();
    $("#waBtn").disabled = !waNumber(c);
    $("#addBtn").disabled = !(c.firstName || c.lastName || c.company || c.mobile || c.phone || c.email);
  }
  function setMsg(t, err) { const m = $("#msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); }

  const esc = s => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  function vcard(c, photoB64) {
    const fn = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company || "New contact";
    const L = ["BEGIN:VCARD", "VERSION:3.0", `N:${esc(c.lastName)};${esc(c.firstName)};;;`, `FN:${esc(fn)}`];
    if (c.company) L.push(`ORG:${esc(c.company)}`);
    if (c.title) L.push(`TITLE:${esc(c.title)}`);
    if (c.mobile) L.push(`TEL;TYPE=CELL,VOICE:${c.mobile}`);
    if (c.phone) L.push(`TEL;TYPE=WORK,VOICE:${c.phone}`);
    if (c.email) L.push(`EMAIL;TYPE=INTERNET,WORK:${c.email}`);
    if (c.website) L.push(`URL:${/^https?:/i.test(c.website) ? c.website : "https://" + c.website}`);
    if (c.street || c.city || c.postcode || c.country) L.push(`ADR;TYPE=WORK:;;${esc(c.street)};${esc(c.city)};;${esc(c.postcode)};${esc(c.country)}`);
    const note = [c.note, "Scanned " + new Date().toISOString().slice(0, 10)].filter(Boolean).join("\n");
    L.push(`NOTE:${esc(note)}`);
    if (photoB64) L.push(`PHOTO;ENCODING=b;TYPE=JPEG:${photoB64}`);
    L.push("END:VCARD");
    return L.join("\r\n");
  }
  const nameOf = c => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company || "contact";
  const fileSafe = s => s.replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "_") || "contact";

  function waNumber(c) {
    const n = (c.mobile || c.phone || "").replace(/[^\d+]/g, "").replace(/^00/, "+");
    if (!n) return "";
    if (n.startsWith("+")) return n.slice(1);
    if (n.length === 8 && /^[49]/.test(n)) return "47" + n;   // Norwegian mobile without +47
    return n.length >= 10 ? n : "";
  }

  function remember(c) {
    const list = ls.get(DATA_KEY, []);
    const i = list.findIndex(x => x.id === current.id);
    const item = { id: current.id, t: current.t, c };
    if (i >= 0) list[i] = item; else list.unshift(item);
    ls.set(DATA_KEY, list.slice(0, 300));
  }

  // Add to Contacts: on iPhone, opening a contact-card (.vcf) link shows the
  // "Create New Contact" sheet with everything filled in. The service worker
  // (sw.js) answers contact.vcf?d=… with the card, like a real file on a server.
  const b64url = str => { const b = new TextEncoder().encode(str); let s = ""; b.forEach(x => s += String.fromCharCode(x)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  function openVcf(text, name) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      location.href = "contact.vcf?n=" + encodeURIComponent(name) + "&d=" + b64url(text);
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/vcard;charset=utf-8" }));
    location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  $("#addBtn").addEventListener("click", () => {
    const c = readForm(); remember(c);
    openVcf(vcard(c), fileSafe(nameOf(c)));
    setMsg("Scroll down and tap “Create New Contact”. If nothing opens, use “Share contact card…”.");
    if (navigator.canShare) $("#shareBtn").classList.remove("hidden");
  });

  $("#shareBtn").addEventListener("click", async () => {
    const c = readForm(); remember(c);
    const file = new File([vcard(c)], fileSafe(nameOf(c)) + ".vcf", { type: "text/vcard" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: nameOf(c) });
      else setMsg("Sharing isn't supported here.", true);
    } catch (e) { if (e && e.name !== "AbortError") setMsg("Couldn't share the contact.", true); }
  });

  $("#waBtn").addEventListener("click", () => {
    const c = readForm(); const n = waNumber(c); if (!n) return;
    remember(c);
    location.href = "https://wa.me/" + n;
  });

  $("#backBtn").addEventListener("click", () => { const c = readForm(); if (FIELDS.some(k => c[k])) remember(c); startScan(); });
  $("#againBtn").addEventListener("click", startScan);

  // =====================================================================
  // HISTORY
  // =====================================================================
  function renderHistory() {
    const list = ls.get(DATA_KEY, []), ul = $("#list");
    ul.innerHTML = "";
    $("#empty").classList.toggle("hidden", list.length > 0);
    $("#exportBtn").disabled = !list.length;
    list.forEach(x => {
      const li = document.createElement("li");
      const who = document.createElement("div"); who.className = "who";
      const b = document.createElement("b"); b.textContent = nameOf(x.c);
      const s = document.createElement("span"); s.textContent = [x.c.company, new Date(x.t).toLocaleDateString("nb-NO")].filter(Boolean).join(" · ");
      who.append(b, s);
      const open = document.createElement("button"); open.className = "mini"; open.textContent = "Open";
      open.onclick = () => { openReview(x.c, "", null); current = { id: x.id, t: x.t }; };
      const del = document.createElement("button"); del.className = "mini"; del.textContent = "Delete";
      let armed = false;
      del.onclick = () => {
        if (!armed) { armed = true; del.textContent = "Sure?"; setTimeout(() => { armed = false; del.textContent = "Delete"; }, 3000); return; }
        ls.set(DATA_KEY, ls.get(DATA_KEY, []).filter(y => y.id !== x.id)); renderHistory();
      };
      li.append(who, open, del); ul.append(li);
    });
  }
  $("#histBtn").addEventListener("click", () => { stopCamera(); renderHistory(); show("history"); });
  $("#histBack").addEventListener("click", startScan);
  $("#exportBtn").addEventListener("click", () => {
    const list = ls.get(DATA_KEY, []); if (!list.length) return;
    openVcf(list.map(x => vcard(x.c)).join("\r\n"), "contacts_" + new Date().toISOString().slice(0, 10));
  });

  // =====================================================================
  // START
  // =====================================================================
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!window.crypto || !crypto.subtle) { $("#pinBtn").classList.add("hidden"); $("#lockBtn").classList.add("hidden"); unlock(); }
  else lock();
  // warm up the reader in the background once unlocked
  const warm = setInterval(() => { if (unlocked) { clearInterval(warm); getWorker().catch(() => {}); } }, 1000);
})();
