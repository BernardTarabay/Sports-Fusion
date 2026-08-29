// Development seed data.
//
// Generated rather than hand-typed so the dataset is big enough to be honest: 140
// players across 6 districts with 20 weeks of match history behind them. A UI that only
// ever sees 5 players and 2 games hides every layout problem that matters -- long names
// wrapping, a leaderboard with ties, a player with no history, a game nobody joined.
//
// Names are drawn from real Lebanese given and family names. No John Doe.

const FIRST = [
  'George', 'Karim', 'Tony', 'Ali', 'Elias', 'Rami', 'Hadi', 'Fadi', 'Ziad', 'Marwan',
  'Nabil', 'Samir', 'Joe', 'Michel', 'Jad', 'Omar', 'Walid', 'Bilal', 'Charbel', 'Rabih',
  'Hussein', 'Antoine', 'Wissam', 'Mazen', 'Sami', 'Tarek', 'Roy', 'Ibrahim', 'Nadim',
  'Peter', 'Chris', 'Daniel', 'Youssef', 'Hassan', 'Ahmad', 'Jean', 'Paul', 'Gaby',
  'Bassam', 'Firas', 'Nader', 'Rodrigue', 'Sarkis', 'Kamal', 'Adib', 'Maroun', 'Naji',
  'Elie', 'Toufic', 'Ghassan', 'Wael', 'Amir', 'Habib', 'Issam', 'Jamil', 'Khalil',
  'Malek', 'Nicolas', 'Riad', 'Salim',
];

const LAST = [
  'Khoury', 'Haddad', 'Nassar', 'Aoun', 'Salameh', 'Chalhoub', 'Rizk', 'Sfeir', 'Karam',
  'Mansour', 'Abou Jaoude', 'Gerges', 'Sleiman', 'Daher', 'Ghanem', 'Bou Assi', 'Attieh',
  'Fares', 'Zeaiter', 'Chamoun', 'Tabet', 'Younes', 'Hobeika', 'Maalouf', 'Saad',
  'Bou Khalil', 'Jabbour', 'Matar', 'Estephan', 'Nakhle', 'Wehbe', 'Ayoub', 'Bitar',
  'Feghali', 'Zgheib', 'Assaf', 'Kfoury', 'Hanna', 'Douaihy', 'Sarkis', 'Bechara',
  'Chidiac', 'Moukarzel', 'Traboulsi', 'Yammine', 'Zakhia', 'Antoun', 'Boustany',
];

const POSITIONS = ['GK', 'LB', 'CB', 'RB', 'CDM', 'CM', 'CAM', 'LW', 'ST', 'RW'];

/** Deterministic PRNG so the mock world is identical on every reload. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260829);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (min, max) => min + rand() * (max - min);
const intBetween = (min, max) => Math.floor(between(min, max + 1));

// ---------------------------------------------------------------------------
// Districts
// ---------------------------------------------------------------------------

export const districts = [
  { id: 'd-beirut', slug: 'beirut', name: 'Beirut', region: 'Beirut', lat: 33.888, lng: 35.495 },
  { id: 'd-metn', slug: 'metn', name: 'Metn', region: 'Mount Lebanon', lat: 33.92, lng: 35.62 },
  { id: 'd-keserwan', slug: 'keserwan', name: 'Keserwan', region: 'Mount Lebanon', lat: 34.0, lng: 35.68 },
  { id: 'd-baabda', slug: 'baabda', name: 'Baabda', region: 'Mount Lebanon', lat: 33.83, lng: 35.54 },
  { id: 'd-jbeil', slug: 'jbeil', name: 'Jbeil', region: 'Mount Lebanon', lat: 34.12, lng: 35.65 },
  { id: 'd-batroun', slug: 'batroun', name: 'Batroun', region: 'North', lat: 34.25, lng: 35.66 },
];

export const venues = [
  { id: 'v-1', districtId: 'd-beirut', name: 'Beirut Football Club', address: 'Karantina', pitchType: 'turf', capacity: 22 },
  { id: 'v-2', districtId: 'd-beirut', name: 'City Sporting Club', address: 'Bir Hassan', pitchType: 'grass', capacity: 22 },
  { id: 'v-3', districtId: 'd-metn', name: 'Hoops Arena', address: 'Sin El Fil', pitchType: 'turf', capacity: 22 },
  { id: 'v-4', districtId: 'd-metn', name: 'Antelias Sports Hub', address: 'Antelias', pitchType: 'turf', capacity: 14 },
  { id: 'v-5', districtId: 'd-keserwan', name: 'Jounieh Pitch', address: 'Jounieh', pitchType: 'grass', capacity: 22 },
  { id: 'v-6', districtId: 'd-keserwan', name: 'Adma Fields', address: 'Adma', pitchType: 'turf', capacity: 22 },
  { id: 'v-7', districtId: 'd-baabda', name: 'Hazmieh Arena', address: 'Hazmieh', pitchType: 'turf', capacity: 22 },
  { id: 'v-8', districtId: 'd-jbeil', name: 'Byblos Sporting', address: 'Jbeil', pitchType: 'grass', capacity: 22 },
  { id: 'v-9', districtId: 'd-batroun', name: 'Batroun Coastal Pitch', address: 'Batroun', pitchType: 'turf', capacity: 14 },
];

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

const usedNames = new Set();
function uniqueName() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  return `${pick(FIRST)} ${pick(LAST)} ${usedNames.size}`;
}

export const players = Array.from({ length: 140 }, (_, i) => {
  const name = uniqueName();
  const districtId = districts[Math.floor(rand() * districts.length)].id;
  const isKeeper = i % 11 === 0;
  const position = isKeeper ? 'GK' : pick(POSITIONS.slice(1));

  // A realistic spread: a handful of regulars the system knows well, a long tail of
  // occasional players it barely knows.
  const games = Math.max(0, Math.round(between(0, 1) ** 2 * 70));
  const sigma = games === 0 ? 350 : Math.max(38, 350 - games * 4.4 + between(-20, 20));
  const mu = 1500 + between(-190, 210) + Math.min(games, 40) * between(-1.2, 2.4);

  const attended = Math.round(games * between(0.82, 1));
  const form = Array.from({ length: 5 }, () =>
    Math.max(1, Math.min(10, Math.round((6.5 + (mu - 1500) / 150 + between(-1.1, 1.1)) * 10) / 10))
  );

  return {
    id: `p-${String(i).padStart(3, '0')}`,
    name,
    districtId,
    position,
    secondaryPositions: isKeeper ? [] : [pick(POSITIONS.slice(1))],
    isGoalkeeper: isKeeper,
    preferredFoot: rand() > 0.78 ? 'left' : 'right',
    joinedAt: new Date(Date.now() - intBetween(20, 900) * 86_400_000).toISOString(),
    ratingMu: Math.round(mu * 10) / 10,
    ratingSigma: Math.round(sigma),
    pointsBalance: Math.round(attended * 125 * between(0.35, 1) + between(0, 400)),
    games,
    attended,
    noShows: Math.max(0, games - attended - intBetween(0, 2)),
    goals: Math.round(games * between(0, 1.1)),
    assists: Math.round(games * between(0, 0.7)),
    motm: Math.round(games * between(0, 0.14)),
    cleanSheets: isKeeper ? Math.round(games * between(0.1, 0.4)) : 0,
    form,
    streak: intBetween(0, 9),
  };
});

/** The signed-in player for the demo session. Given a strong, complete profile. */
export const currentPlayer = {
  ...players[3],
  id: 'p-me',
  name: 'George Khoury',
  position: 'CM',
  isGoalkeeper: false,
  districtId: 'd-beirut',
  ratingMu: 1642,
  ratingSigma: 58,
  pointsBalance: 2450,
  games: 47,
  attended: 45,
  noShows: 1,
  goals: 31,
  assists: 19,
  motm: 6,
  streak: 7,
  form: [8.1, 8.4, 8.7, 8.1, 8.5],
};
players[3] = currentPlayer;

export const playersById = Object.fromEntries(players.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

const FORMATION_11 = ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CM', 'CM', 'LW', 'ST', 'RW'];
const FORMATION_7 = ['GK', 'LB', 'CB', 'RB', 'CM', 'CM', 'ST'];

function buildTeams(squad, teamSize) {
  const formation = teamSize === 7 ? FORMATION_7 : FORMATION_11;
  const keepers = squad.filter((p) => p.isGoalkeeper);
  const outfield = squad.filter((p) => !p.isGoalkeeper);

  const sides = [[], []];
  keepers.slice(0, 2).forEach((p, i) => sides[i].push(p));
  // Snake draft by rating: crude, but it produces the near-even split the real
  // balancer produces, which is what the UI needs to look right.
  [...outfield]
    .sort((a, b) => b.ratingMu - a.ratingMu)
    .forEach((p, i) => {
      const side = Math.floor(i / 2) % 2 === 0 ? i % 2 : 1 - (i % 2);
      (sides[side].length < teamSize ? sides[side] : sides[1 - side]).push(p);
    });

  return ['black', 'white'].map((color, i) => ({
    id: `t-${color}`,
    color,
    strength: Math.round(sides[i].reduce((s, p) => s + p.ratingMu, 0) * 10) / 10,
    players: sides[i].slice(0, teamSize).map((p, idx) => ({
      id: p.id,
      name: p.name,
      position: formation[idx] ?? p.position,
      ratingMu: p.ratingMu,
      ratingSigma: p.ratingSigma,
      isGoalkeeper: p.isGoalkeeper,
      shirtNumber: idx + 1,
    })),
  }));
}

function makeGame(index, { daysFromNow, districtId, venueId, teamSize = 11, status, fillRatio = 1 }) {
  const capacity = teamSize * 2;
  const kickoff = new Date();
  kickoff.setDate(kickoff.getDate() + daysFromNow);
  kickoff.setHours(daysFromNow % 2 === 0 ? 21 : 20, 0, 0, 0);

  const pool = players.filter((p) => p.districtId === districtId);
  const eligible = pool.length >= capacity ? pool : players;
  const confirmedCount = Math.min(capacity, Math.round(capacity * fillRatio));

  const squad = [];
  const keepers = eligible.filter((p) => p.isGoalkeeper).slice(0, 2);
  squad.push(...keepers);
  for (const p of eligible) {
    if (squad.length >= confirmedCount) break;
    if (!squad.includes(p)) squad.push(p);
  }

  const waitlist = eligible
    .filter((p) => !squad.includes(p))
    .slice(0, status === 'full' || status === 'teams_generated' ? intBetween(2, 6) : 0)
    .map((p, i) => ({ playerId: p.id, name: p.name, position: p.position, waitlistPosition: i + 1 }));

  const venue = venues.find((v) => v.id === venueId);
  const hasTeams = ['teams_generated', 'completed'].includes(status);
  const teams = hasTeams && squad.length === capacity ? buildTeams(squad, teamSize) : [];

  let result = null;
  if (status === 'completed' && teams.length === 2) {
    const a = intBetween(0, 8);
    const b = Math.max(0, a - intBetween(-4, 4));
    const motm = pick([...teams[0].players, ...teams[1].players]);
    result = {
      score: { black: a, white: b },
      motm: { playerId: motm.id, name: motm.name, rating: Math.round(between(8.2, 9.6) * 10) / 10 },
      scorers: squad.slice(0, intBetween(3, 7)).map((p) => ({
        playerId: p.id, name: p.name, goals: intBetween(1, 3),
      })),
    };
  }

  return {
    id: `g-${String(index).padStart(3, '0')}`,
    slug: `${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][kickoff.getDay()]}-${
      districts.find((d) => d.id === districtId).slug
    }-${(index * 7919).toString(16).slice(-4)}`,
    districtId,
    districtName: districts.find((d) => d.id === districtId).name,
    venue: venue ? { id: venue.id, name: venue.name, address: venue.address, pitchType: venue.pitchType } : null,
    kickoffAt: kickoff.toISOString(),
    durationMinutes: 90,
    arriveByMinutes: 15,
    capacity,
    teamSize,
    status,
    price: teamSize === 11 ? 10 : 12,
    currency: 'USD',
    confirmedCount: squad.length,
    waitlistCount: waitlist.length,
    roster: squad.map((p, i) => ({
      playerId: p.id,
      name: p.name,
      position: p.position,
      ratingMu: p.ratingMu,
      ratingSigma: p.ratingSigma,
      isGoalkeeper: p.isGoalkeeper,
      registeredAt: new Date(kickoff.getTime() - (capacity - i) * 3_600_000).toISOString(),
      attendance: status === 'completed' ? (rand() > 0.06 ? 'attended' : 'no_show') : null,
      // Matchday operational state. Payment is the thing an admin chases on the
      // touchline, so it lives on the roster rather than in a separate ledger view.
      paid: status === 'completed' ? rand() > 0.12 : rand() > 0.55,
      paidAt: null,
      goals: 0,
      assists: 0,
      rating: null,
    })),
    waitlist,
    teams,
    result,
    formation: teamSize === 11 ? '4-3-3' : teamSize === 7 ? '3-2-1' : null,
    lockedTeams: status === 'completed',
    scheduleId: null,
  };
}

const upcomingSpecs = [
  { daysFromNow: 0, districtId: 'd-beirut', venueId: 'v-1', status: 'teams_generated', fillRatio: 1 },
  { daysFromNow: 1, districtId: 'd-metn', venueId: 'v-3', status: 'full', fillRatio: 1 },
  { daysFromNow: 2, districtId: 'd-beirut', venueId: 'v-2', status: 'registration_open', fillRatio: 0.77 },
  { daysFromNow: 2, districtId: 'd-keserwan', venueId: 'v-5', status: 'registration_open', fillRatio: 0.95 },
  { daysFromNow: 3, districtId: 'd-baabda', venueId: 'v-7', status: 'registration_open', fillRatio: 0.5 },
  { daysFromNow: 3, districtId: 'd-metn', venueId: 'v-4', teamSize: 7, status: 'registration_open', fillRatio: 0.86 },
  { daysFromNow: 4, districtId: 'd-jbeil', venueId: 'v-8', status: 'registration_open', fillRatio: 0.32 },
  { daysFromNow: 5, districtId: 'd-beirut', venueId: 'v-1', status: 'registration_open', fillRatio: 0.18 },
  { daysFromNow: 5, districtId: 'd-batroun', venueId: 'v-9', teamSize: 7, status: 'registration_open', fillRatio: 0.64 },
  { daysFromNow: 6, districtId: 'd-keserwan', venueId: 'v-6', status: 'registration_open', fillRatio: 0.41 },
  { daysFromNow: 7, districtId: 'd-metn', venueId: 'v-3', status: 'registration_open', fillRatio: 0.09 },
  { daysFromNow: 8, districtId: 'd-beirut', venueId: 'v-2', status: 'draft', fillRatio: 0 },
];

// Occupancy varies. Seeding every past game at 100% makes the analytics look broken
// and hides the exact signal the admin dashboard exists to surface.
const pastSpecs = Array.from({ length: 26 }, (_, i) => ({
  daysFromNow: -(i + 1) * 2 - 1,
  districtId: districts[i % districts.length].id,
  venueId: venues[i % venues.length].id,
  status: 'completed',
  fillRatio: [1, 1, 1, 0.91, 1, 0.82, 1, 1, 0.95, 0.77][i % 10],
}));

export const games = [
  ...upcomingSpecs.map((spec, i) => makeGame(i, spec)),
  ...pastSpecs.map((spec, i) => makeGame(100 + i, spec)),
];

// One cancelled fixture, because the UI has to handle it and it never appears if
// every seeded game is healthy.
games.push({
  ...makeGame(200, {
    daysFromNow: 4, districtId: 'd-baabda', venueId: 'v-7', status: 'cancelled', fillRatio: 0.6,
  }),
  status: 'cancelled',
  cancelledReason: 'Pitch flooded after last night’s storm.',
});

export const gamesById = Object.fromEntries(games.map((g) => [g.id, g]));

// ---------------------------------------------------------------------------
// Recurring schedules
//
// Sports Fusion runs on weekly rhythm: the same pitch, the same night, the same
// people. A schedule is the RULE; games are instances generated from it. An admin
// defines "every Sunday 9pm at Jounieh" once, and the system produces the fixtures.
// ---------------------------------------------------------------------------

export const schedules = [
  {
    id: 's-1', districtId: 'd-beirut', venueId: 'v-1', weekday: 5, time: '21:00',
    capacity: 22, teamSize: 11, price: 10, isActive: true,
    // How far ahead instances are created. One week is when a fixture becomes real
    // and starts appearing in the admin's match navigation.
    horizonDays: 21, createdAt: '2025-01-12',
  },
  {
    id: 's-2', districtId: 'd-metn', venueId: 'v-3', weekday: 6, time: '20:00',
    capacity: 22, teamSize: 11, price: 10, isActive: true, horizonDays: 21,
    createdAt: '2025-02-03',
  },
  {
    id: 's-3', districtId: 'd-keserwan', venueId: 'v-5', weekday: 0, time: '21:00',
    capacity: 22, teamSize: 11, price: 10, isActive: true, horizonDays: 21,
    createdAt: '2025-03-20',
  },
  {
    id: 's-4', districtId: 'd-metn', venueId: 'v-4', weekday: 2, time: '20:00',
    capacity: 14, teamSize: 7, price: 12, isActive: true, horizonDays: 21,
    createdAt: '2025-05-08',
  },
  {
    id: 's-5', districtId: 'd-baabda', venueId: 'v-7', weekday: 1, time: '20:00',
    capacity: 22, teamSize: 11, price: 10, isActive: false, horizonDays: 21,
    createdAt: '2025-06-14',
  },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (n) => WEEKDAYS[n] ?? '';

/** The next N dates a schedule would produce, from today. */
export function upcomingOccurrences(schedule, count = 5, from = new Date()) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const dates = [];
  const cursor = new Date(from);
  cursor.setHours(hour, minute, 0, 0);
  if (cursor <= from) cursor.setDate(cursor.getDate() + 1);

  while (dates.length < count) {
    if (cursor.getDay() === schedule.weekday) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Man of the Month
// ---------------------------------------------------------------------------

function monthKey(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() - offset);
  return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
           label: d.toLocaleString('en-GB', { month: 'long', year: 'numeric' }) };
}

const motmPool = [...players].sort((a, b) => b.ratingMu - a.ratingMu).slice(0, 8);

export const manOfTheMonth = {
  current: {
    ...monthKey(0),
    inProgress: true,
    player: motmPool[0],
    stats: { games: 11, motm: 4, goals: 14, assists: 6, rating: 8.92 },
    reward: { name: 'Any item from the Sports Fusion store', slug: 'motm-voucher', claimed: false },
  },
  previous: [1, 2, 3].map((offset) => ({
    ...monthKey(offset),
    inProgress: false,
    player: motmPool[offset],
    stats: {
      games: 9 + offset, motm: 5 - offset, goals: 12 - offset, assists: 5,
      rating: Math.round((8.9 - offset * 0.11) * 100) / 100,
    },
    reward: { name: 'Any item from the Sports Fusion store', slug: 'motm-voucher', claimed: true },
  })),
};

// ---------------------------------------------------------------------------
// AI action audit. Every mutation the assistant makes lands here.
// ---------------------------------------------------------------------------

export const aiActions = [];

// ---------------------------------------------------------------------------
// Registrations for the demo player
// ---------------------------------------------------------------------------

// A believable amount: a couple of upcoming games plus the history, not every fixture
// in the country.
export const myRegistrations = new Set(
  games
    .filter((g) => g.roster.some((r) => r.playerId === currentPlayer.id))
    .filter((g, i) => new Date(g.kickoffAt) < new Date() || i % 3 === 0)
    .map((g) => g.id)
);

// ---------------------------------------------------------------------------
// Rewards and achievements
// ---------------------------------------------------------------------------

export const rewards = [
  {
    id: 'r-1', slug: 'discount-10', name: '10% off the store', description: 'One-time code for the Sports Fusion shop.',
    pointCost: 1000, fulfilmentType: 'shopify_discount', discountPercent: 10, stockRemaining: null,
    maxPerPlayer: 3, minGamesPlayed: 0, isActive: true,
  },
  {
    id: 'r-2', slug: 'free-game', name: 'Free game', description: 'One game on us, any district.',
    pointCost: 2500, fulfilmentType: 'free_game', stockRemaining: 40, maxPerPlayer: 2,
    minGamesPlayed: 5, isActive: true,
  },
  {
    id: 'r-3', slug: 'training-shirt', name: 'Training shirt', description: 'Black, badge on the chest.',
    pointCost: 3500, fulfilmentType: 'shopify_product', stockRemaining: 12, maxPerPlayer: 1,
    minGamesPlayed: 10, isActive: true,
  },
  {
    id: 'r-4', slug: 'match-jersey', name: 'Premium match jersey', description: 'Full kit jersey with your name and number.',
    pointCost: 8000, fulfilmentType: 'shopify_product', stockRemaining: 5, maxPerPlayer: 1,
    minGamesPlayed: 25, isActive: true,
  },
  {
    id: 'r-5', slug: 'boot-bag', name: 'Sports Fusion boot bag', description: 'Because nobody wants wet boots in the car.',
    pointCost: 1800, fulfilmentType: 'shopify_product', stockRemaining: 0, maxPerPlayer: 1,
    minGamesPlayed: 0, isActive: true,
  },
];

export const achievements = [
  { slug: 'first-game', name: 'Debut', description: 'Played your first Sports Fusion game', icon: 'flag', tier: 'bronze', earnedAt: '2025-02-14', progress: 1, target: 1 },
  { slug: 'iron-man', name: 'Iron Man', description: '10 consecutive games attended', icon: 'shield', tier: 'gold', earnedAt: '2026-04-02', progress: 10, target: 10 },
  { slug: 'hat-trick', name: 'Hat Trick', description: 'Three goals in a single match', icon: 'target', tier: 'gold', earnedAt: '2026-01-19', progress: 1, target: 1 },
  { slug: 'motm-first', name: 'Man of the Match', description: 'Your first MOTM award', icon: 'trophy', tier: 'silver', earnedAt: '2025-06-07', progress: 1, target: 1 },
  { slug: 'playmaker', name: 'Playmaker', description: '10 assists', icon: 'wand', tier: 'silver', earnedAt: '2025-11-21', progress: 19, target: 10 },
  { slug: 'wall', name: 'The Wall', description: '5 games without missing attendance', icon: 'brick', tier: 'bronze', earnedAt: '2025-04-30', progress: 5, target: 5 },
  { slug: 'centurion', name: 'Centurion', description: '100 Sports Fusion games', icon: 'crown', tier: 'platinum', earnedAt: null, progress: 47, target: 100 },
  { slug: 'sharpshooter', name: 'Sharpshooter', description: '50 career goals', icon: 'crosshair', tier: 'gold', earnedAt: null, progress: 31, target: 50 },
  { slug: 'ever-present', name: 'Ever Present', description: '25 consecutive games attended', icon: 'infinity', tier: 'platinum', earnedAt: null, progress: 7, target: 25 },
];

export const pointHistory = [
  { id: 1, delta: 100, reason: 'game_played', at: daysAgo(1), note: 'Beirut, Friday' },
  { id: 2, delta: 25, reason: 'on_time_bonus', at: daysAgo(1), note: 'Arrived on time' },
  { id: 3, delta: 250, reason: 'motm', at: daysAgo(1), note: 'Man of the Match' },
  { id: 4, delta: 100, reason: 'game_played', at: daysAgo(8), note: 'Beirut, Friday' },
  { id: 5, delta: 25, reason: 'on_time_bonus', at: daysAgo(8), note: 'Arrived on time' },
  { id: 6, delta: -1000, reason: 'redemption', at: daysAgo(12), note: '10% off the store' },
  { id: 7, delta: 100, reason: 'referral', at: daysAgo(15), note: 'Invited Rami Haddad' },
  { id: 8, delta: 100, reason: 'streak', at: daysAgo(22), note: '5 game streak' },
  { id: 9, delta: 100, reason: 'game_played', at: daysAgo(22), note: 'Metn, Saturday' },
];

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

export const myRedemptions = [
  { id: 'rr-1', rewardName: '10% off the store', status: 'fulfilled', pointsSpent: 1000, discountCode: 'SF-K4M2PXQR', createdAt: daysAgo(12), expiresAt: daysAgo(-78) },
  { id: 'rr-2', rewardName: 'Free game', status: 'pending', pointsSpent: 2500, discountCode: null, createdAt: daysAgo(1), expiresAt: null },
];

// ---------------------------------------------------------------------------
// Rating history for the demo player
// ---------------------------------------------------------------------------

export const myRatingHistory = Array.from({ length: 24 }, (_, i) => {
  const base = 1500 + i * 6 + Math.sin(i / 2.2) * 34;
  return {
    at: daysAgo((24 - i) * 7),
    mu: Math.round(base),
    sigma: Math.round(Math.max(58, 300 - i * 10)),
    change: i === 0 ? null : Math.round(base - (1500 + (i - 1) * 6 + Math.sin((i - 1) / 2.2) * 34)),
    gameId: `g-${String(100 + (23 - i)).padStart(3, '0')}`,
  };
});

// ---------------------------------------------------------------------------
// Derived collections
// ---------------------------------------------------------------------------

export function districtStats(districtId) {
  const dGames = games.filter((g) => g.districtId === districtId);
  const upcoming = dGames.filter((g) => new Date(g.kickoffAt) > new Date() && g.status !== 'cancelled');
  const dPlayers = players.filter((p) => p.districtId === districtId);
  const played = dGames.filter((g) => g.status === 'completed');
  const occupancy = played.length
    ? played.reduce((s, g) => s + g.confirmedCount / g.capacity, 0) / played.length
    : 0;

  return {
    activeGames: upcoming.length,
    players: dPlayers.length,
    occupancy,
    gamesPlayed: played.length,
    venues: venues.filter((v) => v.districtId === districtId).length,
  };
}

export const platformStats = {
  players: players.length * 32, // stands in for the real 4-5k membership
  districts: districts.length,
  gamesThisMonth: games.filter(
    (g) => g.status === 'completed' && new Date(g.kickoffAt) > new Date(Date.now() - 30 * 86_400_000)
  ).length,
  avgOccupancy: 0.91,
  playerHours: 2068,
};
