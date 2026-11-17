// LaunchScope's model, radar-2: one snapshot in, one ranked board out.
//
// radar-1 (the starter) priced every protocol at TVL x 0.25, with a growth and a maturity factor.
// radar-2 was chosen by measurement, not by taste. Every candidate below was scored by leave-one-out
// (LOO) on the snapshot's own 128 live-token protocols (mcap_usd > 0 and tvl_usd > 0): fit on the
// other 127, predict the held-out market cap, and record |log10(pred / actual)|. The full script and
// output are in the build log; the table the dashboard prints is recomputed at runtime by
// validateModels() in this file, from the snapshot alone, so the numbers on the page are the numbers
// the shipped code produces.
//
//   candidate                                   mean |log10 err|   median fold
//   A flat TVL x 0.25                                0.7680           4.91
//   B flat global median multiple                    0.7848           5.07
//   C category median multiple                       0.8384           5.53
//   D category median, shrunk k=4 to global          0.8201           5.24
//   E D x starter growth factor                      0.8193           5.18
//   F D x growth x starter maturity                  0.8163           5.27
//   G F with growth weight tuned on a grid           0.8157           5.19
//   radar-1 as shipped (0.25 x growth x maturity)    0.7726           5.11
//   H power law: mcap = exp(a) x TVL^b  (OLS, log)   0.6931           3.40
//   radar-2 as shipped (below)                       0.6867           3.61   <- LOO winner
//
// Category multiples on their own lose: the snapshot's categories are thin (Risk Curators, the
// board's biggest category, has exactly 1 live comp) and their multiples span three orders of
// magnitude. The power law is the strong base: market cap grows slower than TVL (fitted slope
// b ~ 0.52), so a protocol's implied multiple falls as it grows. radar-2 keeps that base and adds
// the three signals the radar is asked to price, each at the weight the LOO grid supports and no
// more: a category offset in log space (shrunk k=8 toward the global median log multiple, clamped
// to +/-0.35), a growth factor with weight 0.25 (the starter's 0.5 measured worse), and a maturity
// factor of 0.85..1.00 over three years (the starter's 0.6..1.00 measured worse). Every factor is
// computed from the snapshot at runtime; nothing per-protocol is hardcoded and no protocol name
// is ever special-cased.
//
// A row's range is the shipped model's own error band: the p25-p75 of ln(actual / predicted) over
// the live comps of the row's category (the global band when the category has fewer than 5 comps),
// applied to the row's implied value. It is a dispersion band, not a promise.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** radar-2's fixed constants, each chosen by the LOO measurement recorded above. */
export interface RadarConstants {
  /** Shrinkage k for the category multiples the dashboard tabulates (tested as candidates C/D). */
  shrink_k: number;
  /** Shrinkage k for radar-2's category log offset, chosen on the LOO grid. */
  cat_offset_k: number;
  /** Clamp on radar-2's category log offset, in log units, chosen on the LOO grid. */
  cat_offset_cap: number;
  /** Growth factor weight, tuned down from the starter's 0.5 on the LOO grid. */
  growth_weight: number;
  /** Maturity factor at age zero, tuned up from the starter's 0.6 on the LOO grid. */
  maturity_floor: number;
  /** Maturity factor's rise over maturity_days, tuned down from the starter's 0.4. */
  maturity_range: number;
  /** Days over which the maturity factor rises. */
  maturity_days: number;
  /** Age assumed when a protocol's listing day is unreported. */
  unknown_age_days: number;
  /** A category needs at least this many live comps before a row's range uses its own band. */
  range_min_category_comps: number;
  /** The early radar's floor: rankable pre-token protocols below the watchlist floor, at or above this TVL, are ranked. */
  board_floor_usd: number;
}

export const MODEL: RadarConstants = {
  shrink_k: 4,
  cat_offset_k: 8,
  cat_offset_cap: 0.35,
  growth_weight: 0.25,
  maturity_floor: 0.85,
  maturity_range: 0.15,
  maturity_days: 1095,
  unknown_age_days: 365,
  range_min_category_comps: 5,
  board_floor_usd: 10_000_000,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one row: the board row's figures plus radar-2's range and category context. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  eff_multiple: number;
  base_multiple: number;
  cat_offset: number;
  range_lo: number;
  range_hi: number;
  cat_n: number;
  cat_median: number | null;
  watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One candidate model's leave-one-out score on the snapshot's live comps. */
export interface ValidationRow {
  id: string;
  label: string;
  mean_log10: number;
  median_fold: number;
  winner: boolean;
}

/** One category's live-comp multiples, as the method section tabulates them. */
export interface CategoryRow {
  category: string;
  n: number;
  median: number;
  shrunk: number;
  p25: number;
  p75: number;
}

/** Everything the dashboard needs: the board, the live set, the fit and the validation. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: RadarConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  scanned_size: number;
  comps_size: number;
  ols: { intercept: number; slope: number };
  global_median_multiple: number;
  validation: ValidationRow[];
  growth_grid: { w: number; mean_log10: number; median_fold: number }[];
  categories: CategoryRow[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A quantile of a list by linear interpolation on the sorted values, as the measurement script did. */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The live-token comps the model calibrates on: a real, positive market cap over a positive TVL. */
export function liveComps(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** The ordinary-least-squares fit of ln(mcap) on ln(tvl) over a set of comps. */
export function fitOls(comps: SnapshotProtocol[]): { a: number; b: number } {
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const b = den === 0 ? 0 : num / den;
  return { a: my - b * mx, b };
}

/** A protocol's implied value under a power-law fit, before rounding. */
function powerValue(tvl: number, fit: { a: number; b: number }): number {
  return Math.exp(fit.a) * Math.pow(tvl, fit.b);
}

/** radar-2's growth factor: the starter's shape at the LOO-tuned weight of 0.25. */
export function growthFactor(p: SnapshotProtocol): number {
  const g = p.change_7d === null ? 0 : clamp(p.change_7d, -60, 120);
  return 1 + (g / 100) * MODEL.growth_weight;
}

/** radar-2's maturity factor: 0.85 at listing, rising to 1.00 over three years without a token. */
export function maturityFactor(p: SnapshotProtocol, asOf: string): number {
  const age = ageDays(asOf, p.listed_at) ?? MODEL.unknown_age_days;
  return MODEL.maturity_floor + (Math.min(Math.max(age, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
}

interface CategoryOffset {
  offset: number;
  n: number;
}

/**
 * radar-2's category offset, in log units: the category's median log multiple, shrunk toward the
 * global median log multiple with k=8 and clamped to +/-0.35. Zero when the category has no comps.
 */
export function categoryOffset(p: SnapshotProtocol, comps: SnapshotProtocol[]): CategoryOffset {
  const logs = comps.map((q) => Math.log(q.mcap_usd! / q.tvl_usd));
  const glob = median(logs);
  const own = comps.filter((q) => (q.category ?? '') === (p.category ?? '')).map((q) => Math.log(q.mcap_usd! / q.tvl_usd));
  if (own.length === 0) return { offset: 0, n: 0 };
  const shrunk = (own.length * median(own) + MODEL.cat_offset_k * glob) / (own.length + MODEL.cat_offset_k);
  return { offset: clamp(shrunk - glob, -MODEL.cat_offset_cap, MODEL.cat_offset_cap), n: own.length };
}

/** radar-2's full prediction for one protocol, from a fit and the comps it was fitted on. */
export function radarValue(p: SnapshotProtocol, asOf: string, fit: { a: number; b: number }, comps: SnapshotProtocol[]): { raw: number; base: number; offset: number; catN: number; growth: number; maturity: number } {
  const { offset, n } = categoryOffset(p, comps);
  const base = powerValue(p.tvl_usd, fit) * Math.exp(offset);
  const growth = growthFactor(p);
  const maturity = maturityFactor(p, asOf);
  return { raw: base * growth * maturity, base, offset, catN: n, growth, maturity };
}

/** The starter's growth factor, kept only so the validation can score the candidates that used it. */
function starterGrowth(p: SnapshotProtocol, w: number): number {
  const g = p.change_7d === null ? 0 : clamp(p.change_7d, -60, 120);
  return 1 + (g / 100) * w;
}

/** The starter's maturity factor, kept only for the validation candidates. */
function starterMaturity(p: SnapshotProtocol, asOf: string): number {
  const age = ageDays(asOf, p.listed_at) ?? 365;
  return 0.6 + (Math.min(Math.max(age, 0), 1095) / 1095) * 0.4;
}

interface CompStats {
  glob: number;
  catMed: Map<string, number>;
  catN: Map<string, number>;
}

function compStats(others: SnapshotProtocol[]): CompStats {
  const glob = median(others.map((q) => q.mcap_usd! / q.tvl_usd));
  const by = new Map<string, number[]>();
  for (const q of others) {
    const key = q.category ?? '';
    const list = by.get(key) ?? [];
    list.push(q.mcap_usd! / q.tvl_usd);
    by.set(key, list);
  }
  const catMed = new Map<string, number>();
  const catN = new Map<string, number>();
  for (const [key, list] of by) {
    catMed.set(key, median(list));
    catN.set(key, list.length);
  }
  return { glob, catMed, catN };
}

function shrunkMultiple(p: SnapshotProtocol, st: CompStats, k: number): number {
  const key = p.category ?? '';
  const n = st.catN.get(key) ?? 0;
  if (n === 0) return st.glob;
  return (n * st.catMed.get(key)! + k * st.glob) / (n + k);
}

function categoryMultiple(p: SnapshotProtocol, st: CompStats): number {
  const key = p.category ?? '';
  return (st.catN.get(key) ?? 0) >= 3 ? st.catMed.get(key)! : st.glob;
}

/** Score one candidate over the comps by leave-one-out; returns the two error figures the dashboard prints. */
function looScore(comps: SnapshotProtocol[], asOf: string, predict: (p: SnapshotProtocol, others: SnapshotProtocol[]) => number): { mean_log10: number; median_fold: number } {
  const e10: number[] = [];
  const efold: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const p = comps[i]!;
    const others = comps.filter((_, j) => j !== i);
    const pred = predict(p, others);
    const ratio = pred / p.mcap_usd!;
    e10.push(Math.abs(Math.log10(ratio)));
    efold.push(Math.abs(Math.log(ratio)));
  }
  return {
    mean_log10: round4(e10.reduce((s, x) => s + x, 0) / e10.length),
    median_fold: Math.round(Math.exp(median(efold)) * 1000) / 1000,
  };
}

/**
 * The validation the dashboard prints: every candidate from the build measurement, rescored here at
 * runtime on the snapshot's comps with the same leave-one-out protocol, plus the growth-weight grid
 * for candidate G. The winner flag marks the lowest mean |log10 error|.
 */
export function validateModels(snapshot: Snapshot): { validation: ValidationRow[]; growth_grid: { w: number; mean_log10: number; median_fold: number }[] } {
  const comps = liveComps(snapshot);
  const asOf = snapshot.as_of;
  const defs: { id: string; label: string; predict: (p: SnapshotProtocol, others: SnapshotProtocol[]) => number }[] = [
    { id: 'A', label: 'Flat TVL x 0.25', predict: (p) => p.tvl_usd * 0.25 },
    { id: 'B', label: 'Flat global median multiple', predict: (p, o) => p.tvl_usd * compStats(o).glob },
    { id: 'C', label: 'Category median multiple', predict: (p, o) => p.tvl_usd * categoryMultiple(p, compStats(o)) },
    { id: 'D', label: 'Category median, shrunk k=4 to global', predict: (p, o) => p.tvl_usd * shrunkMultiple(p, compStats(o), MODEL.shrink_k) },
    { id: 'E', label: 'D x starter growth factor', predict: (p, o) => p.tvl_usd * shrunkMultiple(p, compStats(o), MODEL.shrink_k) * starterGrowth(p, 0.5) },
    { id: 'F', label: 'D x growth x starter maturity', predict: (p, o) => p.tvl_usd * shrunkMultiple(p, compStats(o), MODEL.shrink_k) * starterGrowth(p, 0.5) * starterMaturity(p, asOf) },
    { id: 'R1', label: 'radar-1 as shipped (0.25 x growth x maturity)', predict: (p) => p.tvl_usd * 0.25 * starterGrowth(p, 0.5) * starterMaturity(p, asOf) },
    { id: 'H', label: 'Power law exp(a) x TVL^b, OLS on log-log', predict: (p, o) => powerValue(p.tvl_usd, fitOls(o)) },
    { id: 'S', label: 'radar-2 as shipped: power law x category offset (k=8, clamp 0.35) x growth (w=0.25) x maturity (0.85-1.00)', predict: (p, o) => radarValue(p, asOf, fitOls(o), o).raw },
  ];
  const rows: ValidationRow[] = defs.map((d) => ({ id: d.id, label: d.label, ...looScore(comps, asOf, d.predict), winner: false }));
  const growth_grid = [0, 0.25, 0.5, 0.75, 1.0].map((w) => ({
    w,
    ...looScore(comps, asOf, (p, o) => p.tvl_usd * shrunkMultiple(p, compStats(o), MODEL.shrink_k) * starterGrowth(p, w) * starterMaturity(p, asOf)),
  }));
  const gBest = growth_grid.reduce((best, g) => (g.mean_log10 < best.mean_log10 ? g : best), growth_grid[0]!);
  rows.splice(6, 0, { id: 'G', label: `F with growth weight tuned on a grid (best w=${gBest.w})`, mean_log10: gBest.mean_log10, median_fold: gBest.median_fold, winner: false });
  const winner = rows.reduce((best, r) => (r.mean_log10 < best.mean_log10 ? r : best), rows[0]!);
  winner.winner = true;
  return { validation: rows, growth_grid };
}

/** Every category's live-comp multiples, tabulated for the method section, busiest categories first. */
export function categoryTable(snapshot: Snapshot): CategoryRow[] {
  const comps = liveComps(snapshot);
  const glob = median(comps.map((q) => q.mcap_usd! / q.tvl_usd));
  const by = new Map<string, number[]>();
  for (const q of comps) {
    const key = q.category ?? 'Uncategorised';
    const list = by.get(key) ?? [];
    list.push(q.mcap_usd! / q.tvl_usd);
    by.set(key, list);
  }
  const rows: CategoryRow[] = [...by.entries()].map(([category, list]) => ({
    category,
    n: list.length,
    median: round4(median(list)),
    shrunk: round4((list.length * median(list) + MODEL.shrink_k * glob) / (list.length + MODEL.shrink_k)),
    p25: round4(quantile(list, 0.25)),
    p75: round4(quantile(list, 0.75)),
  }));
  rows.sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  return rows;
}

/** The p25-p75 band of ln(actual / predicted) under radar-2's full fit, global and per category. */
function residualBands(snapshot: Snapshot, fit: { a: number; b: number }): { global: [number, number]; byCat: Map<string, [number, number]> } {
  const comps = liveComps(snapshot);
  const all: number[] = [];
  const by = new Map<string, number[]>();
  for (const q of comps) {
    const r = Math.log(q.mcap_usd! / radarValue(q, snapshot.as_of, fit, comps).raw);
    all.push(r);
    const key = q.category ?? '';
    const list = by.get(key) ?? [];
    list.push(r);
    by.set(key, list);
  }
  const byCat = new Map<string, [number, number]>();
  for (const [key, list] of by) {
    if (list.length >= MODEL.range_min_category_comps) byCat.set(key, [quantile(list, 0.25), quantile(list, 0.75)]);
  }
  return { global: [quantile(all, 0.25), quantile(all, 0.75)], byCat };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * Per-category farm actions: [core action, second qualifying action], with {name}, {chain} and
 * {cap} filled from the protocol's own record. Every category on the board has its own pair; the
 * default pair covers any category the snapshot adds later.
 */
const CATEGORY_ACTIONS: Record<string, [string, string]> = {
  'Risk Curators': [
    'Deposit ${cap} of USDC into a {name} vault on {chain} and keep the vault shares in the wallet; curator vaults track depositors by share balance over time.',
    'Add a second, smaller deposit into a different {name} vault on {chain} a week later, so the wallet shows sustained allocation rather than a single touch.',
  ],
  'Onchain Capital Allocator': [
    'Deposit ${cap} of USDC into a {name} allocation vault on {chain} and hold the shares; allocator points and launch snapshots are normally read off share balances.',
    'Move a small part of the position between two {name} strategies on {chain} once a month, keeping the total deposited, to register as an active allocator.',
  ],
  'Collateral Markets': [
    'Supply ${cap} of USDC as collateral through {name} on {chain} and keep the collateral position open and healthy.',
    'Post a second collateral asset in the same {name} account on {chain} and leave both positions untouched except for one top-up a month.',
  ],
  'RWA': [
    'Mint ${cap} of the {name} real-world-asset yield token on {chain} through its own app and hold it in the wallet; holder snapshots are how RWA launches usually find their users.',
    'Keep the {name} position across a full distribution cycle on {chain} and claim the yield once, so the wallet shows a complete hold-and-claim history.',
  ],
  'Lending': [
    'Supply ${cap} of USDC to {name} on {chain} and keep the supply position open; lending protocols read loyalty from supplied balances over time.',
    'Borrow a small amount against the {name} supply on {chain}, repay it in full a week later, and keep supplying, so the wallet shows both sides of the market.',
  ],
  'CDP': [
    'Deposit ${cap} of collateral into a {name} vault on {chain} and mint a small amount of its stablecoin against it, keeping the vault safely over-collateralised.',
    'Repay part of the {name} debt and top the collateral up once on {chain}, so the vault shows managed, long-lived activity instead of a mint-and-run.',
  ],
  'CDP Manager': [
    'Open a {name}-managed CDP on {chain} with ${cap} of collateral and mint a conservative amount of the stablecoin it manages.',
    'Adjust the {name} vault once - a small collateral top-up on {chain} - and hold the position so the manager records an actively kept vault.',
  ],
  'Dexs': [
    'Provide ${cap} of liquidity to the main {name} pool on {chain} and keep the LP position in range and in the wallet.',
    'Route a few small swaps through {name} on {chain} each week, so the wallet appears both as a liquidity provider and as a trader.',
  ],
  'Yield': [
    'Deposit ${cap} of USDC into the main {name} yield vault on {chain} and keep the vault shares unstaked in the wallet where snapshots can see them.',
    'Compound the {name} yield once a month on {chain} instead of withdrawing it, so the balance history shows a holder, not a passer-by.',
  ],
  'Yield Aggregator': [
    'Deposit ${cap} into a {name} aggregator vault on {chain} and let it route the funds; aggregator launches reward the wallets that stayed routed.',
    'Split a second ${cap} deposit across another {name} vault on {chain} and hold both, showing breadth across the aggregator strategies.',
  ],
  'Chain': [
    'Bridge ${cap} of funds to {chain} and hold them in the wallet; a chain that records no token yet can only reward wallets that actually live on it.',
    'Use two or three native {chain} apps with the bridged funds each week, building a real on-chain history rather than a parked balance.',
  ],
  'Payments': [
    'Fund the wallet with ${cap} and route a real payment through {name} on {chain}; payment networks count completed transfers, not deposits.',
    'Make one {name} payment a week on {chain} to a second wallet you control, keeping each transfer small, real and easy to repeat.',
  ],
  'Restaking': [
    'Restake ${cap} of the staking asset through {name} on {chain} and keep the restaking receipt in the wallet for the full holding period.',
    'Delegate the {name} restaked position to an operator on {chain} and leave the delegation unchanged, since operator loyalty is part of most restaking snapshots.',
  ],
  'Liquid Restaking': [
    'Mint ${cap} of the {name} liquid restaking token on {chain} and hold it in the wallet rather than looping it into another protocol.',
    'Use a small part of the {name} receipt token in one partner app on {chain}, keeping the main position intact and traceable.',
  ],
  'Liquid Staking': [
    'Stake ${cap} of the native asset through {name} on {chain} and hold the liquid staking receipt in the wallet.',
    'Keep the {name} receipt across a full rewards epoch on {chain} and claim the staking rewards once, completing the hold-and-claim record.',
  ],
  'Restaked BTC': [
    'Deposit ${cap} of BTC or its wrapped form into {name} on {chain} and keep the restaked position open for the full holding window.',
    'Leave the {name} position untouched except for one small top-up on {chain}, so the wallet reads as a long-term BTC restaker.',
  ],
  'Decentralized BTC': [
    'Bridge ${cap} of BTC value into {name} on {chain} using its own bridge route and hold the resulting position in the wallet.',
    'Use the {name} BTC position in one paired app on {chain} - a borrow or a pool - while keeping the core amount in place.',
  ],
  'Anchor BTC': [
    'Deposit ${cap} of BTC collateral into {name} on {chain} and keep the anchored position open and over-collateralised.',
    'Make one small additional {name} deposit on {chain} a month later, showing the wallet is building the position, not testing it.',
  ],
  'Basis Trading': [
    'Deposit ${cap} of USDC into the {name} basis strategy on {chain} and hold the strategy shares; basis vaults snapshot share balances, not trades.',
    'Keep the {name} position through a full funding cycle on {chain} and add a small top-up after it, so the history spans more than one regime.',
  ],
  'CeDeFi': [
    'Deposit ${cap} of USDC into a {name} earn product on {chain} and keep it there for the full term the product offers.',
    'Roll the {name} position into a second term on {chain} when the first ends instead of withdrawing, which is the behaviour these products reward.',
  ],
  'Staking Pool': [
    'Stake ${cap} of the native asset in the {name} pool on {chain} and keep the pooled stake delegated to the same validator set.',
    'Claim and restake the {name} rewards once on {chain}, compounding the position the way long-term pool members do.',
  ],
  'Governance Incentives': [
    'Deposit ${cap} into the {name} incentive program on {chain} and keep the position that earns the incentives open.',
    'Take part in every {name} governance vote or incentive epoch on {chain} while the position runs; participation records are the product here.',
  ],
  'Insurance': [
    'Buy ${cap} of cover from {name} on {chain} for a position you actually hold, and keep the policy to its full term.',
    'Stake a smaller amount into a {name} cover pool on {chain} as an underwriter, so the wallet appears on both sides of the insurance market.',
  ],
  'Stablecoin Wrapper': [
    'Mint ${cap} of the {name} wrapped stable asset on {chain} through its own app and hold the wrapped balance in the wallet.',
    'Use part of the {name} wrapped asset in one listed partner market on {chain}, keeping the rest wrapped and untouched.',
  ],
  'Dual-Token Stablecoin': [
    'Mint ${cap} of the {name} stablecoin on {chain} with its required collateral mix and hold both tokens the system issues.',
    'Provide a small {name} liquidity position on {chain} for the stable pair and keep it in range across the holding period.',
  ],
  'Bridge': [
    'Bridge ${cap} of USDC to {chain} through {name} and use the bridged funds in one app on the far side instead of bridging straight back.',
    'Bridge a second, smaller amount through {name} in the opposite direction weeks later, giving the wallet a two-way bridge history.',
  ],
  'Canonical Bridge': [
    'Bridge ${cap} of funds to {chain} through {name}, the canonical route, and hold the bridged balance in the wallet.',
    'Spend part of the bridged funds in a native {chain} app each week, so the wallet is a chain user, not a bridge passer-by.',
  ],
  'Cross Chain Bridge': [
    'Route ${cap} of USDC across chains through {name}, ending on {chain}, and keep the funds working there for the holding period.',
    'Make one more {name} transfer on a different route weeks later, since cross-chain products score route diversity as well as volume.',
  ],
  'Derivatives': [
    'Deposit ${cap} of USDC as margin on {name} on {chain} and open one small, hedged position rather than a directional bet.',
    'Trade one small {name} contract a week on {chain} and keep margin in the account between trades, showing a returning trader.',
  ],
  'Farm': [
    'Deposit ${cap} into the main {name} farm on {chain} and keep the farming position staked for the full holding period.',
    'Harvest the {name} rewards once and restake them on {chain} instead of selling, so the wallet compounds like a committed farmer.',
  ],
  'Leveraged Farming': [
    'Open a small {name} leveraged farm on {chain} with ${cap} of equity at the lowest leverage offered, and keep a wide safety margin.',
    'Rebalance the {name} position once when prompted on {chain} rather than closing it, showing an actively managed leveraged farm.',
  ],
  'Liquidity Manager': [
    'Deposit ${cap} into a {name}-managed liquidity vault on {chain} and keep the vault shares for the full holding period.',
    'Leave the {name} vault through one full rebalance cycle on {chain} without withdrawing, since managed vaults snapshot patient wallets.',
  ],
  'Indexes': [
    'Buy ${cap} of a {name} index product on {chain} and hold the index token in the wallet for the full period.',
    'Add a second small {name} index purchase a month later on {chain}, building the position the way index holders actually do.',
  ],
  'OTC Marketplace': [
    'Complete one small trade of about ${cap} through the {name} OTC desk route on {chain} and keep the settled asset in the wallet.',
    'List or take one more {name} OTC offer weeks later on {chain}, so the wallet shows repeat marketplace use, not a single test trade.',
  ],
  'Crypto Card Issuer': [
    'Fund a {name} card account with ${cap} through its {chain} route and make one real card payment from it.',
    'Use the {name} card for one small payment a week, since card issuers score active spenders when they design holder rewards.',
  ],
  'Prediction Market': [
    'Fund ${cap} and take one small position in a liquid {name} market on {chain}, choosing a market that settles inside the holding period.',
    'Trade one more {name} market after the first settles on {chain} and keep the winnings in the account, building a settled-trade record.',
  ],
  'Uncollateralized Lending': [
    'Supply ${cap} of USDC to a {name} lending pool on {chain} whose borrower set you can inspect, and keep the supply open for the pool term.',
    'Roll the {name} supply into a second pool term on {chain} at maturity instead of exiting, the pattern these pools use to find loyal lenders.',
  ],
};

const DEFAULT_ACTIONS: [string, string] = [
  'Deposit ${cap} of USDC into {name} on {chain} and keep the position open; a protocol that records no token yet can only find the wallets that used it.',
  'Make one more qualifying action in {name} on {chain} each week - a deposit, a swap or a vote, whichever its app offers - and never let the position lapse to zero.',
];

/** Fill a template with the protocol's own name, main chain and capital tier. */
function fill(template: string, p: SnapshotProtocol, cap: number): string {
  return template.split('{name}').join(p.name).split('{chain}').join(chainOf(p)).split('{cap}').join(String(cap));
}

/**
 * A protocol's farm plan: five steps written for its category, its main chain and its size, from its
 * own record. No step promises a token: the snapshot says the protocol records no token yet, and the
 * last step says what to do if a launch comes.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const cap = capitalFor(p);
  const hold = holdDaysFor(age);
  const chain = chainOf(p);
  const pair = CATEGORY_ACTIONS[p.category ?? ''] ?? DEFAULT_ACTIONS;
  return [
    `Set up a fresh wallet for ${p.name} and fund it with gas on ${chain}; a separate wallet keeps this farm auditable and limits the damage if one app is compromised. Cost: under $3 of gas for the first transactions. Time: 10 minutes.`,
    `${fill(pair[0], p, cap)} Cost: $${cap} of capital plus about $${cap >= 150 ? 8 : 4} of gas. Time: 15 minutes to set up.`,
    `${fill(pair[1], p, Math.max(25, Math.round(cap / 2)))} Cost: about $${Math.max(25, Math.round(cap / 2))} of capital plus a few dollars of gas. Time: 15 minutes.`,
    `Keep the ${p.name} position open for at least ${hold} days and repeat one small qualifying action each week on ${chain}; snapshots and points programs reward wallets that stay active across weeks, not one-day deposits. Cost: about $2 of gas a week on top of the capital already placed. Time: 10 minutes a week for ${hold} days.`,
    `${p.name} records no token yet in this snapshot, so follow its official channels for a points or launch announcement and, if a launch comes, claim only through the link the protocol itself publishes. Cost: nothing to watch, and never pay a third party to claim. Time: 15 minutes a week.`,
  ];
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const comps = liveComps(snapshot);
  const fit = fitOls(comps);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, at any TVL. Above the floor the snapshot also carries
  // products the watchlist rule itself excluded (wrapped, staked and bridged products of tokens
  // that already trade, and exchanges), so the board adds nothing above the floor but the list.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: rankable pre-token protocols below the watchlist floor, down to the board's
  // own floor - the smaller launches the radar exists to find early.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd >= MODEL.board_floor_usd && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = radarValue(p, snapshot.as_of, fit, comps);
    return { p, ...v, implied: Math.max(1, Math.round(v.raw)), age: ageDays(snapshot.as_of, p.listed_at) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: round4(s.base / s.p.tvl_usd),
      growth_pct: s.p.change_7d === null ? 0 : Math.round(clamp(s.p.change_7d, -60, 120) * 100) / 100,
      growth_multiplier: round4(s.growth),
      maturity_multiplier: round4(s.maturity),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's calibration strip. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const comps = liveComps(snapshot);
  const fit = fitOls(comps);
  const bands = residualBands(snapshot, fit);
  const { validation, growth_grid } = validateModels(snapshot);
  const categories = categoryTable(snapshot);
  const catByName = new Map(categories.map((c) => [c.category, c]));
  const watch = new Set(snapshot.watchlist);
  const rows: RadarRow[] = board.map((row) => {
    const band = bands.byCat.get(row.category ?? '') ?? bands.global;
    const cat = row.category === null ? undefined : catByName.get(row.category);
    return {
      rank: row.rank,
      slug: row.slug,
      name: row.name,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      mcap_usd: row.mcap_usd,
      listed_at: row.listed_at,
      age_days: row.age_days,
      implied_value_usd: row.implied_value_usd,
      growth_multiplier: row.model.growth_multiplier,
      maturity_multiplier: row.model.maturity_multiplier,
      eff_multiple: round4((row.model.base_multiple * row.model.growth_multiplier * row.model.maturity_multiplier)),
      base_multiple: row.model.base_multiple,
      cat_offset: round4(Math.exp(categoryOffset(row as unknown as SnapshotProtocol, comps).offset)),
      range_lo: Math.max(1, Math.round(row.implied_value_usd * Math.exp(band[0]))),
      range_hi: Math.round(row.implied_value_usd * Math.exp(band[1])),
      cat_n: cat?.n ?? 0,
      cat_median: cat ? cat.median : null,
      watchlist: watch.has(row.slug),
      farm_steps: row.farm_steps,
    };
  });
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    scanned_size: snapshot.protocols.length,
    comps_size: comps.length,
    ols: { intercept: round4(fit.a), slope: round4(fit.b) },
    global_median_multiple: round4(median(comps.map((q) => q.mcap_usd! / q.tvl_usd))),
    validation,
    growth_grid: growth_grid.map((g) => ({ w: g.w, mean_log10: g.mean_log10, median_fold: g.median_fold })),
    categories,
    rows,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
