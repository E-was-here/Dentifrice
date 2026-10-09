"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const PORT = +process.env.PORT || 3000;
const BASE = (process.env.BASE_PATH || "").replace(/\/+$/, "");   // e.g. "/dentifrice" or ""
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (ADMIN_PASSWORD.length < 8) {
  console.error("Set ADMIN_PASSWORD (8+ characters) in .env before starting.");
  process.exit(1);
}

/* ---------- Config: the same file the browser loads ---------- */
const sandbox = { window: {} };
const CONFIG_FILE = path.join(ROOT, "config", "config.js");
vm.runInNewContext(fs.readFileSync(CONFIG_FILE, "utf8"), sandbox);
const C = sandbox.window.CONFIG;

const rows = C.map.map(l => l.trim().split(/\s+/));
const cells = [], counters = {};          // village cells only, in reading order
rows.forEach(row => row.forEach(code => {
  if (!C.villages[code]) return;
  counters[code] = (counters[code] || 0) + 1;
  cells.push({ id: code + counters[code], village: code });
}));
const byId = Object.fromEntries(cells.map(c => [c.id, c]));
const playerByName = Object.fromEntries(C.players.map(p => [p.name, p]));
const buildingById = Object.fromEntries(C.buildings.map(b => [b.id, b]));
const assetIdx = Object.fromEntries(C.assets.map((a, i) => [a.name, i]));
const recipeByFactory = Object.fromEntries((C.recipes || []).map(r => [r.factory, r]));
const factor = C.transportFactor ?? 2;
const payoutMs = (C.payoutSeconds || 60) * 1000;
const vCodes = Object.keys(C.villages);
const signature = JSON.stringify([vCodes, C.assets]);

/* ---------- Files ---------- */
const file = n => path.join(DATA, n);
function readJSON(n, fallback) { try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch (e) { return fallback; } }
function writeJSON(n, obj) { fs.writeFileSync(file(n) + ".tmp", JSON.stringify(obj)); fs.renameSync(file(n) + ".tmp", file(n)); }

/* ---------- Settings (hand-edited: epoch, balances) ---------- */
let settings = readJSON("settings.json", null);
if (!settings) {
  settings = { epoch: 1, balances: Object.fromEntries(C.players.map(p => [p.name, p.startBalance])) };
  fs.writeFileSync(file("settings.json"), JSON.stringify(settings, null, 2));
}
let settingsMtime = fs.statSync(file("settings.json")).mtimeMs;
let settingsError = false;

/* ---------- Buildings (written only through the admin API) ---------- */
let buildings = [], bMap = {}, warnings = [];
function rebuild() { bMap = Object.fromEntries(buildings.map(b => [b.cell, b])); }
function loadBuildings(list) {
  warnings = []; buildings = [];
  (list || []).forEach(x => {
    if (!x || !byId[x.cell]) { warnings.push(`Unknown cell: ${x && x.cell}`); return; }
    if (!buildingById[x.type]) { warnings.push(`Unknown building: ${x.type} (${x.cell})`); return; }
    if (!playerByName[x.owner]) { warnings.push(`Unknown team: ${x.owner} (${x.cell})`); return; }
    buildings.push({ cell: x.cell, type: x.type, owner: x.owner });
  });
  rebuild();
}
const saveBuildings = () => writeJSON("buildings.json", buildings);

/* ---------- Runtime (market, gains, links) ---------- */
function freshRuntime(epoch) {
  const history = {};
  vCodes.forEach(v => { history[v] = C.assets.map(a => [a.prices[v] ?? 100]); });
  return { sig: signature, epoch, history, seen: {}, earned: {}, links: {}, seq: 0, lastPayout: null, running: false, paused: false, remaining: null };
}
let R = readJSON("runtime.json", null);
if (!R || R.sig !== signature || R.epoch !== (settings.epoch ?? 0)) R = freshRuntime(settings.epoch ?? 0);
if (R.ended) { R.paused = true; R.remaining = payoutMs; delete R.ended; }
const saveRuntime = () => writeJSON("runtime.json", R);

const price = (v, name) => { const h = R.history[v][assetIdx[name]]; return h[h.length - 1]; };

function gauss() {   // Box-Muller
  let u = 0, w = 0;
  while (!u) u = Math.random();
  while (!w) w = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

/* ---------- Construction price shocks ---------- */
function applyConstructionEffects() {
  const fx = C.priceEffects || {};
  const now = {};
  const removed = new Set();  // Track removed buildings
  Object.keys(bMap).forEach(id => { now[id] = bMap[id].type; });
  cells.filter(c => now[c.id] && R.seen[c.id] !== now[c.id]).forEach(c => {
    const e = fx[now[c.id]];
    if (!e) return;
    const targets = (e.target === "own" ? [buildingById[now[c.id]].produces] : e.target).filter(Boolean);
    const villages = e.scope === "all" ? vCodes : [c.village];
    villages.forEach(v => targets.forEach(name => {
      const i = assetIdx[name];
      if (i === undefined) return;
      const h = R.history[v][i], cur = h[h.length - 1];
      h.push(Math.max(1, +(cur * (1 + e.change + gauss() * (e.sd || 0))).toFixed(2)));
      if (h.length > 60) h.shift();
    }));
  });

  // Check for removed buildings
  Object.keys(R.seen).forEach(id => {
    if (!now[id]) {
      removed.add(id);
      const e = fx[R.seen[id]];  // Get effects from previously existing building
      if (!e) return;
      const targets = (e.target === "own" ? [buildingById[R.seen[id]].produces] : e.target).filter(Boolean);
      const villages = e.scope === "all" ? vCodes : [byId[id].village];
      villages.forEach(v => targets.forEach(name => {
        const i = assetIdx[name];
        if (i === undefined) return;
        const h = R.history[v][i], cur = h[h.length - 1];
        // Apply inverse effect with 80% amplitude
        h.push(Math.max(1, +(cur * (1 - e.change * 0.8 + gauss() * (e.sd || 0) * 0.8)).toFixed(2)));
        if (h.length > 60) h.shift();
      }));
    }
  });

  R.seen = now;
}

/* ---------- Factory <-> producer links ---------- */
function updateLinks() {
  const L = R.links;
  const typeAt = id => bMap[id] && bMap[id].type;

  Object.keys(L).forEach(f => {                       // 1. cleanup
    const fb = bMap[f], rc = fb && recipeByFactory[fb.type];
    if (!rc) { delete L[f]; return; }
    rc.needs.forEach(t => { const sid = L[f].sup[t]; if (sid && typeAt(sid) !== t) L[f].sup[t] = null; });
  });
  cells.forEach(c => {                                // 2. new factories
    if (recipeByFactory[typeAt(c.id)] && !L[c.id]) L[c.id] = { seq: R.seq++, sup: {} };
  });
  const taken = new Set();                            // 3. find producers, oldest factory first
  Object.values(L).forEach(l => Object.values(l.sup).forEach(s => s && taken.add(s)));
  Object.keys(L).sort((a, b) => L[a].seq - L[b].seq).forEach(f => {
    const fb = bMap[f], rc = recipeByFactory[fb.type], v = byId[f].village;
    rc.needs.forEach(t => {
      if (L[f].sup[t]) return;
      const res = buildingById[t].produces;
      const free = cells.filter(c => typeAt(c.id) === t && !taken.has(c.id));
      const mine = c => bMap[c.id].owner === fb.owner ? 0 : 1;
      let pick = free.filter(c => c.village === v).sort((a, b) => mine(a) - mine(b))[0];
      if (!pick) pick = free.filter(c => c.village !== v)
        .sort((a, b) => mine(a) - mine(b) || price(a.village, res) - price(b.village, res))[0];
      if (pick) { L[f].sup[t] = pick.id; taken.add(pick.id); }
    });
  });
}

/* ---------- Production: who earns / pays what per payout ---------- */
function computeProduction() {
  const income = {}, prod = {};
  const add = (o, a) => { if (o) income[o] = (income[o] || 0) + a; };
  vCodes.forEach(v => {
    prod[v] = {};
    C.assets.forEach(a => { prod[v][a.name] = { made: 0, sold: 0, used: 0, waiting: 0 }; });
  });
  const used = new Set();

  Object.entries(R.links).forEach(([f, link]) => {
    const fb = bMap[f], rc = fb && recipeByFactory[fb.type];
    if (!rc) return;
    const v = byId[f].village;
    const sups = rc.needs.map(t => link.sup[t]);
    if (sups.some(s => !s)) { prod[v][rc.asset].waiting++; return; }
    used.add(f); sups.forEach(s => used.add(s));
    add(fb.owner, price(v, rc.asset));                         // the sale goes entirely to the factory
    prod[v][rc.asset].made++;
    rc.needs.forEach((t, i) => {
      const sc = byId[sups[i]], sb = bMap[sups[i]];
      const res = buildingById[t].produces;
      const sp = price(sc.village, res);
      add(fb.owner, -(sc.village === v ? sp : sp * factor));   // factory pays (x2 outside the village)
      add(sb.owner, sp);                                       // producer gets the market price
      prod[sc.village][res].used++;
    });
  });

  cells.forEach(c => {                                         // unlinked producers sell normally
    const b = bMap[c.id];
    if (!b || used.has(c.id)) return;
    const res = buildingById[b.type].produces;
    if (!res) return;
    add(b.owner, price(c.village, res));
    prod[c.village][res].sold++;
  });
  return { income, prod };
}

/* ---------- Timers ---------- */
let nextPayout = Date.now() + payoutMs;
function payout() {
  const { income } = computeProduction();
  Object.entries(income).forEach(([t, amt]) => { R.earned[t] = (R.earned[t] || 0) + amt; });
  R.lastPayout = Date.now();
  nextPayout = Date.now() + payoutMs;
  saveRuntime();
}
function tickMarket() {
  if (!R.running) return;
  vCodes.forEach(v => C.assets.forEach((a, i) => {
    const h = R.history[v][i], cur = h[h.length - 1];
    h.push(Math.max(1, +(cur * (1 + (Math.random() * 2 - 1) * a.vol)).toFixed(2)));
    if (h.length > 60) h.shift();
  }));
  updateLinks();
  saveRuntime();
}
function sync() {
  if (R.running) applyConstructionEffects();   // pas de chocs de prix tant que la partie n'est pas lancée
  updateLinks(); saveRuntime();
}

function checkSettings() {   // picks up manual edits of settings.json (epoch, balances)
  let m;
  try { m = fs.statSync(file("settings.json")).mtimeMs; } catch (e) { return; }
  if (m === settingsMtime) return;
  settingsMtime = m;
  const s = readJSON("settings.json", null);
  settingsError = !s;
  if (!s) return;
  settings = s;
  if (R.epoch !== (s.epoch ?? 0)) {
    R = freshRuntime(s.epoch ?? 0);
    sync();
    console.log(new Date().toISOString(), "NEW EPOCH", R.epoch);
  }
}

/* ---------- Online viewers (anonymous random IDs sent by the pages) ---------- */
const clients = new Map();   // id -> last seen (ms)
const ONLINE_MS = Math.max(15, 3 * (C.stateRefreshSeconds || 3)) * 1000;
function touchClient(id) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || "")) return;
  if (!clients.has(id) && clients.size >= 5000) return;   // memory cap against abuse
  clients.set(id, Date.now());
}
function onlineCount() {
  const limit = Date.now() - ONLINE_MS;
  let n = 0;
  for (const [id, t] of clients) { if (t < limit) clients.delete(id); else n++; }
  return n;
}

/* ---------- Public state ---------- */
function publicState() {
  const { income, prod } = computeProduction();
  const balances = {};
  C.players.forEach(p => {
    const base = settings.balances && settings.balances[p.name] != null ? settings.balances[p.name] : p.startBalance;
    balances[p.name] = base + (R.earned[p.name] || 0);
  });
  const w = warnings.slice();
  if (settingsError) w.push("settings.json has a syntax error (previous version kept)");
  return { epoch: R.epoch, online: onlineCount(), running: !!R.running, paused: !!R.paused, serverTime: Date.now(),
           nextPayout: R.running ? nextPayout : null, lastPayout: R.lastPayout, buildings, balances,
           income: R.paused ? {} : income, prod, history: R.history, links: R.links, warnings: w };
}

/* ---------- Auth (HTTP Basic, over HTTPS via your reverse proxy) ---------- */
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const failures = new Map();
// last X-Forwarded-For entry = the one added by your own proxy (the first can be forged)
const clientIp = req => (req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.socket.remoteAddress;

function checkAuth(req, res) {
  if (req.headers["x-forwarded-proto"] === "http") { send(res, 403, "Admin requires HTTPS"); return false; }
  const ip = clientIp(req), f = failures.get(ip) || { count: 0, until: 0 };
  if (f.until > Date.now()) { send(res, 429, "Too many failed attempts. Try again in a few minutes."); return false; }
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const dec = Buffer.from(h.slice(6), "base64").toString("utf8");
    const k = dec.indexOf(":");
    const okU = crypto.timingSafeEqual(sha(dec.slice(0, k)), sha(ADMIN_USER));
    const okP = crypto.timingSafeEqual(sha(dec.slice(k + 1)), sha(ADMIN_PASSWORD));
    if (okU && okP) { failures.delete(ip); return true; }
    f.count++;
    if (f.count >= 5) { f.until = Date.now() + 5 * 60000; f.count = 0; }
    failures.set(ip, f);
    console.log(new Date().toISOString(), "FAILED LOGIN", ip);
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Jeu scout admin", charset="UTF-8"', "Content-Type": "text/plain" });
  res.end("Authentication required");
  return false;
}

/* ---------- HTTP ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function send(res, code, body) {
  const isObj = typeof body === "object";
  res.writeHead(code, { "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(isObj ? JSON.stringify(body) : body);
}

function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, "Bad request"); }
  let p = path.normalize(path.join(PUBLIC, rel));
  if (p !== PUBLIC && !p.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  fs.stat(p, (err, st) => {
    if (!err && st.isDirectory()) p = path.join(p, "index.html");
    fs.readFile(p, (err2, data) => {
      if (err2) return send(res, 404, "Not found");
      const ext = path.extname(p).toLowerCase();
      const isImg = [".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": isImg ? "public, max-age=300" : "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > 10000) { reject(new Error("Body too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function commit(req, what) {
  rebuild(); saveBuildings(); sync();
  console.log(new Date().toISOString(), clientIp(req), what);
}

async function adminApi(req, res, p) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  // anti-CSRF: same origin + JSON only
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (req.headers.origin) {
    let oh = null;
    try { oh = new URL(req.headers.origin).host; } catch (e) {}
    if (oh !== host) return send(res, 403, { error: "Bad origin" });
  }
  if (!(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "JSON required" });
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }

  if (p === "/admin/api/set") {
    const cell = String(body.cell || "").toUpperCase();
    if (!byId[cell]) return send(res, 400, { error: "Unknown cell" });
    if (!buildingById[body.type]) return send(res, 400, { error: "Unknown building type" });
    if (!playerByName[body.owner]) return send(res, 400, { error: "Unknown team" });
    const entry = { cell, type: body.type, owner: body.owner };
    const i = buildings.findIndex(b => b.cell === cell);
    if (i >= 0) buildings[i] = entry; else buildings.push(entry);
    commit(req, `SET ${cell} ${entry.type} ${entry.owner}`);
    return send(res, 200, { ok: true });
  }
  if (p === "/admin/api/remove") {
    const cell = String(body.cell || "").toUpperCase();
    if (!byId[cell]) return send(res, 400, { error: "Unknown cell" });
    buildings = buildings.filter(b => b.cell !== cell);
    commit(req, `REMOVE ${cell}`);
    return send(res, 200, { ok: true });
  }
  if (p === "/admin/api/start") {
    if (R.running) return send(res, 400, { error: "Partie déjà en cours" });
    if (R.paused) return send(res, 400, { error: "Partie en pause : utilise Reprendre" });
    R.running = true;
    nextPayout = Date.now() + payoutMs;
    commit(req, "START GAME");
    return send(res, 200, { ok: true });
  }
  if (p === "/admin/api/pause") {
    if (!R.running) return send(res, 400, { error: "La partie n'est pas en cours" });
    R.remaining = Math.max(0, nextPayout - Date.now());
    R.running = false;
    R.paused = true;
    commit(req, "PAUSE GAME");
    return send(res, 200, { ok: true });
  }
  if (p === "/admin/api/resume") {
    if (!R.paused) return send(res, 400, { error: "La partie n'est pas en pause" });
    R.running = true;
    R.paused = false;
    nextPayout = Date.now() + (R.remaining ?? payoutMs);
    R.remaining = null;
    commit(req, "RESUME GAME");
    return send(res, 200, { ok: true });
  }
  if (p === "/admin/api/clear") {
    buildings = [];
    R = freshRuntime(settings.epoch ?? 0);   // cours initiaux, gains et liens effacés, partie en attente
    commit(req, "RESET: buildings cleared, prices reset, game idle");
    return send(res, 200, { ok: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    let p = u.pathname;
    if (BASE) {
      if (p === BASE) { res.writeHead(301, { Location: BASE + "/" }); return res.end(); }
      if (p.startsWith(BASE + "/")) p = p.slice(BASE.length);   // strip the prefix, the rest is unchanged
    }
    if (p === "/admin") { res.writeHead(301, { Location: BASE + "/admin/" }); return res.end(); }
    if (p.startsWith("/admin/")) {
      if (!checkAuth(req, res)) return;
      if (p.startsWith("/admin/api/")) return await adminApi(req, res, p);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      return serveStatic(res, p);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    if (p === "/api/state") { touchClient(u.searchParams.get("c")); return send(res, 200, publicState()); }
    if (p === "/config.js") {
      return fs.readFile(CONFIG_FILE, (e, d) => {
        if (e) return send(res, 404, "Not found");
        res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
        res.end(d);
      });
    }
    return serveStatic(res, p);
  } catch (e) {
    console.error(e);
    send(res, 500, "Server error");
  }
});

/* ---------- Start ---------- */
loadBuildings(readJSON("buildings.json", []));
sync();
setInterval(() => { if (R.running && Date.now() >= nextPayout) payout(); }, 1000);
if (C.marketTickSeconds > 0) setInterval(tickMarket, C.marketTickSeconds * 1000);
setInterval(checkSettings, 3000);
server.listen(PORT, () => console.log(`Jeu scout running on port ${PORT} (epoch ${R.epoch})`));