(function () {
  const C = window.CONFIG;
  const rows = C.map.map(l => l.trim().split(/\s+/));
  const ids = {}, counters = {};
  rows.forEach(row => row.forEach(code => {
    if (!C.villages[code]) return;
    counters[code] = (counters[code] || 0) + 1;
    (ids[code] = ids[code] || []).push(code + counters[code]);
  }));

  const msg = document.getElementById("msg");
  const grid = document.getElementById("grid");
  let current = {};
  let running = false, paused = false;
  const stateEl = document.getElementById("state");
  const startBtn = document.getElementById("start");
  const pauseBtn = document.getElementById("pause");
  function renderState() {
    if (paused)       { stateEl.textContent = "⏸ Partie en pause (marchés et comptes figés)"; stateEl.style.color = "#8ab4f8"; }
    else if (running) { stateEl.textContent = "▶ Partie en cours"; stateEl.style.color = "#2ecc71"; }
    else              { stateEl.textContent = "⏸ Partie en attente (marchés figés)"; stateEl.style.color = "#f39c12"; }
    startBtn.textContent = paused ? "▶ Reprendre la partie" : "▶ Lancer la partie";
    startBtn.disabled = running;
    pauseBtn.disabled = !running;
    startBtn.style.opacity = startBtn.disabled ? ".4" : "1";
    pauseBtn.style.opacity = pauseBtn.disabled ? ".4" : "1";
  }
  const say = (t, bad) => { msg.textContent = t; msg.className = bad ? "bad" : "ok"; };

  async function api(action, body) {
    const r = await fetch("api/" + action, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    return j;
  }

  async function load() {
    const r = await fetch("../api/state", { cache: "no-store" });
    const s = await r.json();
    current = Object.fromEntries(s.buildings.map(b => [b.cell, b]));
    running = !!s.running; paused = !!s.paused; renderState();
    render();
  }

  function row(id) {
    const b = current[id];
    const div = document.createElement("div"); div.className = "row";
    const label = document.createElement("span"); label.className = "cell"; label.textContent = id;

    const t = document.createElement("select");
    t.add(new Option("— empty —", ""));
    C.buildings.forEach(x => t.add(new Option(x.emoji + " " + x.name, x.id)));
    t.value = b ? b.type : "";

    const o = document.createElement("select");
    o.add(new Option("— owner —", ""));
    C.players.forEach(p => o.add(new Option(p.name, p.name)));
    o.value = b ? b.owner : "";

    const apply = async () => {
      if (t.value && !o.value) { say(`${id}: now choose an owner (nothing saved yet)`, true); return; }
      if (!t.value && !current[id]) return;
      t.disabled = o.disabled = true;
      try {
        if (!t.value) { await api("remove", { cell: id }); say(`${id}: building removed`); }
        else { await api("set", { cell: id, type: t.value, owner: o.value }); say(`${id}: saved`); }
      } catch (e) { say(`${id}: ${e.message}`, true); }
      await load();
    };
    t.onchange = o.onchange = apply;
    div.append(label, t, o);
    return div;
  }

  function render() {
    grid.innerHTML = "";
    Object.keys(C.villages).forEach(code => {
      const col = document.createElement("div"); col.className = "village";
      col.style.borderTopColor = C.villages[code].color;
      const h = document.createElement("h2"); h.textContent = C.villages[code].name;
      col.appendChild(h);
      (ids[code] || []).forEach(id => col.appendChild(row(id)));
      grid.appendChild(col);
    });
  }

  startBtn.onclick = async () => {
    const resume = paused;
    if (!confirm(resume ? "Reprendre la partie ?" : "Lancer la partie ? Les marchés se mettent à bouger.")) return;
    try { await api(resume ? "resume" : "start"); say(resume ? "Partie reprise" : "Partie lancée"); } catch (e) { say(e.message, true); }
    await load();
  };

  pauseBtn.onclick = async () => {
    if (!confirm("Mettre la partie en pause ? Marchés et comptes seront figés.")) return;
    try { await api("pause"); say("Partie en pause"); } catch (e) { say(e.message, true); }
    await load();
  };

  document.getElementById("clear").onclick = async () => {
    if (!confirm("Supprimer TOUS les bâtiments, remettre les prix à zéro et repasser en attente ?")) return;
    try { await api("clear"); say("Remise à zéro effectuée : partie en attente"); } catch (e) { say(e.message, true); }
    await load();
  };

  load();
})();