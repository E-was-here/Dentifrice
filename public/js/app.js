(function () {
  const C = window.CONFIG;

  /* ---------- Géométrie de la carte ---------- */
  const R = 50, W = Math.sqrt(3) * R;
  const hexPts = Array.from({ length: 6 }, (_, i) => {
    const a = (60 * i - 30) * Math.PI / 180;
    return `${(R * Math.cos(a)).toFixed(1)},${(R * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

  const rows = C.map.map(l => l.trim().split(/\s+/));
  const NR = rows.length, NC = Math.max(...rows.map(r => r.length));
  const cells = [], counters = {};
  rows.forEach((row, r) => row.forEach((code, c) => {
    const isVillage = !!C.villages[code];
    let id = null;
    if (isVillage) { counters[code] = (counters[code] || 0) + 1; id = code + counters[code]; }
    cells.push({
      r, c, code, id, village: isVillage ? code : null,
      x: W * (c + 0.5 + (r % 2 ? 0.5 : 0)),
      y: R + 1.5 * R * r,
    });
  }));
  const byId = Object.fromEntries(cells.filter(c => c.id).map(c => [c.id, c]));
  const playerByName = Object.fromEntries(C.players.map(p => [p.name, p]));
  const buildingById = Object.fromEntries(C.buildings.map(b => [b.id, b]));
  const vCodes = Object.keys(C.villages);
  const payoutMs = (C.payoutSeconds || 60) * 1000;
  const rateLabel = payoutMs === 60000 ? "min" : (C.payoutSeconds + " s");
  const fmt = n => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " " + C.currency;

  /* ---------- Identifiant anonyme (pour le compteur de connectés) ---------- */
  const clientId = (() => {
    const gen = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      let id = localStorage.getItem("jeuScoutClient");
      if (!id) { id = gen(); localStorage.setItem("jeuScoutClient", id); }
      return id;
    } catch (e) { return gen(); }
  })();

  /* ---------- Données du serveur ---------- */
  let S = null, bMap = {}, timeOffset = 0, fetchFailed = false, lastFetch = null, mapKey = "";

  async function refresh() {
    try {
      const r = await fetch("api/state?c=" + encodeURIComponent(clientId), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      S = await r.json();
      fetchFailed = false; lastFetch = new Date();
      timeOffset = S.serverTime - Date.now();
      bMap = Object.fromEntries(S.buildings.map(b => [b.cell, b]));
      const key = JSON.stringify([S.buildings, S.links]);
      if (key !== mapKey) { mapKey = key; renderMap(); }
      renderMarket(); renderBank();
    } catch (e) { fetchFailed = true; }
    renderStatus();
  }

  /* ---------- Images optionnelles (sinon emoji) ---------- */
  const IMG = {};
  function preloadImages() {
    const paths = [C.villageGround.img,
      ...Object.values(C.terrains).map(t => t.img),
      ...C.buildings.map(b => b.img)].filter(Boolean);
    paths.forEach(p => {
      const im = new Image();
      im.onload = () => { IMG[p] = true; renderMap(); };
      im.onerror = () => { IMG[p] = false; };
      im.src = p;
    });
  }
  const hasImg = p => p && IMG[p] === true;

  /* ---------- Carte ---------- */
  function renderMap() {
    const svg = document.getElementById("map");
    svg.setAttribute("viewBox", `0 0 ${W * (NC + 0.5)} ${2 * R + 1.5 * R * (NR - 1)}`);
    let s = `<defs><clipPath id="hexclip"><polygon points="${hexPts}"/></clipPath></defs>`;

    cells.forEach(cell => {
      const v = cell.village ? C.villages[cell.village] : null;
      const t = v ? { ...C.villageGround, color: v.color } : (C.terrains[cell.code] || { name: "?", color: "#444", emoji: "" });
      const entry = cell.id ? bMap[cell.id] : null;
      const b = entry ? buildingById[entry.type] : null;
      const owner = entry && entry.owner ? playerByName[entry.owner] : null;
      const stroke = owner ? owner.color : "#0f1720";
      const sw = owner ? 7 : 2;

      let inner = `<polygon points="${hexPts}" fill="${t.color}"/>`;
      if (hasImg(t.img))
        inner += `<image href="${t.img}" x="${-W / 2}" y="${-R}" width="${W}" height="${2 * R}" preserveAspectRatio="xMidYMid slice" clip-path="url(#hexclip)"/>`;
      else if (t.emoji)
        inner += `<text text-anchor="middle" dominant-baseline="central" font-size="34" opacity=".85">${t.emoji}</text>`;

      if (b) {
        inner += hasImg(b.img)
          ? `<image href="${b.img}" x="${-W * .4}" y="${-R * .8}" width="${W * .8}" height="${R * 1.6}" preserveAspectRatio="xMidYMid meet"/>`
          : `<text text-anchor="middle" dominant-baseline="central" font-size="42">${b.emoji}</text>`;
      }
      if (v && C.showCellIds)
        inner += `<text class="cid" y="${R * .72}" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${cell.id}</text>`;
      inner += `<polygon points="${hexPts}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;

      s += `<g transform="translate(${cell.x},${cell.y})"><g transform="scale(.96)">${inner}</g></g>`;
    });

    // Liens usine -> producteurs (pointillés animés du producteur vers l'usine)
    if (C.showLinks !== false && S) {
      const speed = C.linkSpeed ?? 20;
      const period = speed ? 16 / Math.abs(speed) : 0;
      const phase = period ? -((performance.now() / 1000) % period) : 0;
      const anim = period
        ? `class="link-anim" style="animation-duration:${period}s;animation-delay:${phase}s;${speed < 0 ? "animation-direction:reverse;" : ""}"`
        : "";
      Object.entries(S.links).forEach(([f, link]) => {
        const fc = byId[f], fb = bMap[f];
        if (!fc || !fb) return;
        const col = fb.owner && playerByName[fb.owner] ? playerByName[fb.owner].color : "#fff";
        Object.values(link.sup).filter(Boolean).forEach(sid => {
          const sc = byId[sid]; if (!sc) return;
          s += `<line x1="${fc.x}" y1="${fc.y}" x2="${sc.x}" y2="${sc.y}" stroke="#000" stroke-width="7" opacity=".5" pointer-events="none"/>
                <line ${anim} x1="${fc.x}" y1="${fc.y}" x2="${sc.x}" y2="${sc.y}" stroke="${col}" stroke-width="4" stroke-dasharray="9 7" pointer-events="none"/>`;
        });
      });
    }

    Object.entries(C.villages).forEach(([code, v]) => {
      const idx = cells.filter(c => c.village === code);
      if (!idx.length) return;
      const cx = idx.reduce((a, c) => a + c.x, 0) / idx.length;
      const top = Math.min(...idx.map(c => c.y)) - R * 1.1;
      const n = idx.filter(c => bMap[c.id]).length;
      s += `<text class="vname" x="${cx}" y="${top}" text-anchor="middle" font-size="24" font-weight="700" fill="#fff"
              stroke="#000" stroke-width="5" paint-order="stroke">${v.name} (${n}/${idx.length})</text>`;
    });
    svg.innerHTML = s;
  }

  function renderLegend() {
    document.getElementById("legend").innerHTML =
      C.buildings.map(b => `<span>${b.emoji} ${b.name}</span>`).join("") +
      (C.showLinks !== false ? `<span>┅ lien usine → producteur</span>` : "");
  }

  /* ---------- Bourse ---------- */
  function spark(h) {
    const pts = h.slice(-30), min = Math.min(...pts), max = Math.max(...pts), r = max - min || 1;
    const p = pts.map((v, i) => `${(i / Math.max(pts.length - 1, 1)) * 100},${22 - ((v - min) / r) * 20}`).join(" ");
    const c = pts[pts.length - 1] >= pts[0] ? "#2ecc71" : "#e74c3c";
    return `<svg width="90" height="24" viewBox="0 0 100 24" preserveAspectRatio="none"><polyline points="${p}" fill="none" stroke="${c}" stroke-width="2"/></svg>`;
  }

  function prodText(p) {
    const parts = [];
    if (p.made) parts.push(`${p.made} produit${p.made > 1 ? "s" : ""}`);
    if (p.sold) parts.push(`${p.sold} vendu${p.sold > 1 ? "s" : ""}`);
    if (p.used) parts.push(`${p.used} utilisé${p.used > 1 ? "s" : ""}`);
    if (p.waiting) parts.push(`⏳ ${p.waiting} usine${p.waiting > 1 ? "s" : ""} en attente`);
    return parts.length ? parts.join(" · ") : "–";
  }

  function renderMarket() {
    if (!S) return;
    document.getElementById("market").innerHTML = vCodes.map(v => {
      const vil = C.villages[v];
      const body = C.assets.map((a, i) => {
        const h = S.history[v][i], cur = h[h.length - 1], prev = h.length > 1 ? h[h.length - 2] : cur;
        const pct = (cur - prev) / prev * 100, cls = pct >= 0 ? "up" : "down";
        return `<tr><td>${a.name}</td><td>${fmt(cur)}</td>
                <td class="${cls}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)} %</td>
                <td>${spark(h)}</td><td class="prod dim">${prodText(S.prod[v][a.name])}</td></tr>`;
      }).join("");
      return `<div class="vmarket" style="border-left-color:${vil.color}">
        <h3>${vil.name}</h3>
        <table><thead><tr><th>Actif</th><th>Cours</th><th>Var.</th><th>Tendance</th><th>Production</th></tr></thead>
        <tbody>${body}</tbody></table></div>`;
    }).join("");
  }

  /* ---------- Banque ---------- */
  function renderBank() {
    if (!S) return;
    const bal = C.players.map(p => S.balances[p.name] ?? p.startBalance);
    const order = bal.map((_, i) => i).sort((a, b) => bal[b] - bal[a]);
    const max = Math.max(...bal, 1);
    document.getElementById("bank").innerHTML = order.map(i => {
      const p = C.players[i];
      const nb = S.buildings.filter(x => x.owner === p.name).length;
      const rate = S.income[p.name] || 0;
      return `<div class="player">
        <div class="row"><span style="color:${p.color}">● ${p.name}<small>${nb} bâtiment${nb > 1 ? "s" : ""}</small></span>
          <span>${fmt(bal[i])}<span class="rate ${rate < 0 ? "neg" : ""}">${rate < 0 ? "−" : "+"}${fmt(Math.abs(rate))}/${rateLabel}</span></span></div>
        <div class="bar" style="width:${Math.max(Math.max(bal[i], 0) / max * 100, 2)}%;background:${p.color}"></div></div>`;
    }).join("");
  }

  /* ---------- Statut ---------- */
    function renderStatus() {
    let h = "";
    if (S) {
      if (S.paused) {
        h = `<span class="warn">⏸ Partie en pause : marchés et comptes figés</span>`;
      } else if (!S.running) {
        h = `<span class="warn">⏸ Partie non lancée : les marchés sont figés</span>`;
      } else {
        const left = Math.max(0, Math.ceil((S.nextPayout - (Date.now() + timeOffset)) / 1000));
        h = `Prochain versement dans ${left} s`;
        if (S.lastPayout) h += ` · dernier : ${new Date(S.lastPayout).toLocaleTimeString("fr-FR")}`;
      }
      h += `<br>Dernière mise à jour : ${lastFetch.toLocaleTimeString("fr-FR")} · epoch ${S.epoch} · 👥 ${S.online ?? "?"} en ligne`;
    }
    if (fetchFailed) h += `<br><span class="warn">⚠ Serveur injoignable (dernières données affichées)</span>`;
    document.getElementById("status").innerHTML = h;
  }

  /* ---------- Démarrage ---------- */
  renderLegend(); renderMap(); preloadImages(); refresh();
  setInterval(refresh, (C.stateRefreshSeconds || 3) * 1000);
  setInterval(renderStatus, 1000);
})();