// The five dots. Each is a seat a ChatGPT dot can take; an empty seat plays the temperament
// below through the autopilot. Floors and caps are in hood units (state.unit lamports).
export const ROSTER = [
  {
    id: 'marrow', name: 'Marrow', color: '#8c1c22', start: 17,
    temper: 'The raider. Sits on cash so it is always the richer dot in the room, then buys out whoever is not.',
    p: { raid: 1.7, vulture: 0.4, trade: 0.3, land: 0.6, build: 0.6, flip: 0, floor: 30, maxLots: 9, kinds: { tower: 1.4, shop: 1, house: 0.5 }, crateKeep: 12, idle: 0.35 },
  },
  {
    id: 'pip', name: 'Pip', color: '#a9832f', start: 23,
    temper: 'The builder. Spends down to the floorboards on land and houses and trusts the rent roll to carry it.',
    p: { raid: 0.2, vulture: 0.3, trade: 0.2, land: 1.3, build: 1.5, flip: 0, floor: 1.5, maxLots: 12, kinds: { house: 1.3, shop: 1.1, tower: 0.8 }, crateKeep: 10, idle: 0.25 },
  },
  {
    id: 'soot', name: 'Soot', color: '#6d4bb3', start: 25,
    temper: 'The maker. Runs workshops, turns every epoch into crates and sells them to whoever wants a tower.',
    p: { raid: 0.3, vulture: 0.5, trade: 0.4, land: 0.9, build: 1.2, flip: 0, floor: 10, maxLots: 7, kinds: { workshop: 1.5, house: 0.6, shop: 0.5 }, crateKeep: 3, crateSeller: 1.4, idle: 0.3 },
  },
  {
    id: 'brine', name: 'Brine', color: '#3e7a6b', start: 31,
    temper: 'The vulture. Builds little and waits at the office table, where everything is half price and dropping.',
    p: { raid: 0.5, vulture: 1.9, trade: 0.8, land: 0.35, build: 0.5, flip: 0.3, markup: 1.25, floor: 18, maxLots: 10, kinds: { house: 1, shop: 0.8 }, crateKeep: 6, idle: 0.4 },
  },
  {
    id: 'lark', name: 'Lark', color: '#4a5d86', start: 11,
    temper: 'The trader. Buys whatever is listed under appraisal and lists it again at a third more.',
    p: { raid: 0.6, vulture: 0.8, trade: 1.6, land: 0.7, build: 0.4, flip: 1.3, markup: 1.33, floor: 4, maxLots: 9, kinds: { shop: 1, house: 0.8 }, crateKeep: 6, idle: 0.3 },
  },
];

export const PERSONA = Object.fromEntries(ROSTER.map(r => [r.id, r.p]));
