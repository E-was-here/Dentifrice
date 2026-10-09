window.CONFIG = {
  currency: "€",
  marketTickSeconds: 15,     // fréquence de mise à jour de la bourse (0 = bourse figée)
  payoutSeconds: 60,         // fréquence des versements aux comptes
  stateRefreshSeconds: 5,    // fréquence de relecture de state.js
  showCellIds: true,         // affiche l'identifiant (A1, B7...) sur les cases de village
  transportFactor: 2,        // coût d'un ingrédient venu d'un autre village (×prix du marché)
  showLinks: true,           // traits usine → producteurs sur la carte
  linkSpeed: 5,             // vitesse des pointillés (unités/seconde) ; 0 = immobile ; négatif = sens inverse

  players: [
    { name: "Havana",   color: "#e74c3c", startBalance: 1000 },
    { name: "Bracco",   color: "#3498db", startBalance: 1000 },
    { name: "Taureaux", color: "#f39c12", startBalance: 1000 },
    { name: "Mamba",    color: "#2ecc71", startBalance: 1000 },
    { name: "Fennec",   color: "#b36bff", startBalance: 1000 },
  ],

  assets: [   // prices = prix initial par village ; vol = volatilité à chaque mise à jour (0.05 = ±5 %)
    { name: "Riz",           vol: 0.01, prices: { A: 30,  B: 30,  C: 50 } },
    { name: "Poulet",        vol: 0.02, prices: { A: 50,  B: 30,  C: 30 } },
    { name: "Sauce",         vol: 0.04, prices: { A: 30,  B: 50,  C: 30 } },
    { name: "Tasty Crousty", vol: 0.10, prices: { A: 250, B: 250, C: 250 } },
  ],

  // Effet d'une CONSTRUCTION sur les prix (appliqué une seule fois, quand le bâtiment apparaît dans state.js)
  // target : "own" = la ressource produite par le bâtiment, ou une liste d'actifs
  // change : variation moyenne (-0.20 = -20 %) ; sd : écart-type (0.02 = ±2 points)
  // scope  : "village" (défaut) = village du bâtiment seulement ; "all" = les 3 villages
  priceEffects: {
    riziere: { target: "own", change: -0.20, sd: 0.02 },
    poulet:  { target: "own", change: -0.20, sd: 0.02 },
    sauce:   { target: "own", change: -0.20, sd: 0.02 },
    usine:   { target: "Tasty Crousty", change: -0.25, sd: 0.02 },
    maison:  { target: ["Riz", "Poulet", "Sauce", "Tasty Crousty"], change: +0.15, sd: 0.02 },
  },

  /* Carte : une ligne = une rangée d'hexagones (les lignes impaires sont décalées).
     A, B, C = cases des 3 villages (10 chacun), numérotées dans l'ordre de lecture :
     A1, A2... A10 (de gauche à droite, de haut en bas).
     Les autres lettres = décor (voir "terrains"). */
  map: [
    "f f m m f l l f m f f",
    "f A A A f l f B B B f",
    "f A A A A l l B B B B",
    "f A A A p f l B B B f",
    "f f p p f m m p f f f",
    "m f f p C C C p f f m",
    "f l p p C C C C f m f",
    "f l l p C C C p f f f",
    "l l f f m f f p f l l",
  ],

  villages: {
    A: { name: "Azmow", color: "#BD833A" },
    B: { name: "Bullmar", color: "#504233" },
    C: { name: "Calton", color: "#a25c05" },
  },
  villageGround: { img: "img/sol_village.png" },

  terrains: {
    f: { name: "Forêt",    emoji: "🌲", color: "#2e5e3a", img: "img/foret.png" },
    l: { name: "Lac",      emoji: "🌊", color: "#2f6f9f", img: "img/lac.png" },
    m: { name: "Montagne", emoji: "⛰️", color: "#7a7f86", img: "img/montagne.png" },
    p: { name: "Plaine",   emoji: "🌿", color: "#6b8f4e", img: "img/plaine.png" },
  },

  buildings: [   // produces = nom de l'actif rapporté (doit correspondre à un nom dans assets)
    { id: "maison",  name: "Maison",            emoji: "🏠", img: "img/maison.png" },
    { id: "riziere", name: "Rizière",           emoji: "🌾", img: "img/riziere.png", produces: "Riz" },
    { id: "poulet",  name: "Élevage de poulet", emoji: "🐔", img: "img/poulet.png",  produces: "Poulet" },
    { id: "sauce",   name: "Marchand de sauce", emoji: "🌶️", img: "img/sauce.png",   produces: "Sauce" },
    { id: "usine",   name: "Usine",             emoji: "🏭", img: "img/usine.png" },
  ],

  // Recettes : 1 usine + 1 de chaque "needs" (même village) = 1 unité de l'actif.
  recipes: [
    { asset: "Tasty Crousty", factory: "usine", needs: ["riziere", "poulet", "sauce"] },
  ],
};