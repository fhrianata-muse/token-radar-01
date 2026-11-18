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
//
// v2 scope (V2-SPEC section 1, AUDIT.md section 2): ONE classification standard on both sides of
// the watchlist floor. The board carries the 40 watchlist protocols plus every other stand-alone
// pre-token protocol the snapshot holds, down to the snapshot's own $5M floor: stand-alone means
// the snapshot records no token for it and it is not an exchange, not a versioned pool of another
// entry, and not a wrapped, staked or bridged product of an asset that already trades (whole
// product categories, plus a short named correction list where the fields alone cannot see the
// product). The partition of all 758 snapshot protocols is computed in code (classifyProtocol)
// and printed on the dashboard, so the board's scope can be checked line by line. v2 also adds,
// all computed at runtime from the snapshot: a two-cutoff walk-forward validation, LOO hit rates,
// a band coverage audit, bootstrap rank ranges (200 refits, fixed seed), and per-row farm
// economics under one stated $1,000 scenario (see ECON below). The radar-2 value model itself is
// unchanged from v1 — same constants, same runtime refit; the tournament in research/TOURNAMENT.md
// measured no challenger that earns a change.

import { FARM_RESEARCH } from './farmdata.ts';

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
  // v2 board floor: the snapshot's own $5M floor (AUDIT.md fix 2.3). The value-model
  // constants below this line are radar-2 exactly as shipped in v1 — not one retuned.
  board_floor_usd: 5_000_000,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard carries: all of them (the full calibration set). */
export const LIVE_ROWS = 128;

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

/** The three farm verdicts every board row carries. */
export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/** One row's farm economics under the stated $1,000 scenario (see ECON in this file). */
export interface FarmEcon {
  deposit_usd: number;
  slice_usd: number;
  fees_usd: number;
  forgone_usd: number;
  net_usd: number;
  breakeven_pct: number | null;
  per_hour_usd: number;
  hours: number;
  txs: number;
  chain: string;
  chain_cost_usd: number;
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
  rank_lo: number;
  rank_hi: number;
  cat_n: number;
  cat_median: number | null;
  watchlist: boolean;
  verdict: Verdict;
  econ: FarmEcon;
  farm_program: string | null;
  farm_source: string | null;
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
  offset: number;
  p25: number;
  p75: number;
}

/** The classification of every protocol in the snapshot: the partition sums to the snapshot size. */
export interface Partition {
  ranked: number;
  trading: number;
  zero_cap: number;
  sentinel_cap: number;
  sub_products: number;
  exchanges: number;
  versioned: number;
  staking_products: number;
  bridge_products: number;
  named_products: number;
  unranked_small: number;
  total: number;
}

/** One walk-forward (time-split) validation row: fit on the older comps, score the newer ones. */
export interface WalkForwardRow {
  cutoff: string;
  n_train: number;
  n_test: number;
  radar2_mean_log10: number;
  radar2_median_fold: number;
  flat_mean_log10: number;
  flat_median_fold: number;
}

/** Held-out accuracy extras: LOO hit rates and the coverage audit of the printed bands. */
export interface ValidationExtras {
  n: number;
  within_3x_pct: number;
  within_10x_pct: number;
  band_p25_p75_pct: number;
  band_p10_p90_pct: number;
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
  partition: Partition;
  walk_forward: WalkForwardRow[];
  extras: ValidationExtras;
  coverage: number;
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
  assumptions: { deposit_usd: number; horizon_days: number; weeks: number; drop_share: number; forgone_rate: number; forgone_usd: number };
  chain_costs: { label: string; usd: number }[];
  bootstrap: { refits: number; seed: number };
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

/** What one snapshot protocol is, for board scope: exactly one class per protocol. */
export type ProtocolClass =
  | 'ranked'
  | 'trading'
  | 'zero-cap'
  | 'sentinel-cap'
  | 'sub-product'
  | 'exchange'
  | 'versioned'
  | 'staking-product'
  | 'bridge-product'
  | 'named-product'
  | 'unranked-small';

/** Whole categories that are receipts for an asset that already trades, never launch candidates. */
const STAKING_PRODUCT_CATEGORIES: ReadonlySet<string> = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Whole categories whose product is moving an already-traded asset between chains. */
const BRIDGE_PRODUCT_CATEGORIES: ReadonlySet<string> = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge']);

/**
 * Named corrections to the field rule, each with its reason: protocols the category field alone
 * does not mark as products of an asset that already trades (audit of the baseline entry,
 * research/AUDIT.md section 2.2). Only these three; every other exclusion is a field rule.
 */
export const PRODUCT_CORRECTIONS: Record<string, string> = {
  'bitlayer-ybtc-family': 'YBTC is a wrapped-BTC product family; the underlying BTC already trades.',
  'chain-fusion': 'a bridged-BTC product; the underlying BTC already trades.',
  usdcx: 'USDCx is USDC wrapped for another chain; the underlying USDC already trades.',
};

/**
 * The one classification standard, applied on both sides of the watchlist floor: a protocol is
 * ranked when the snapshot records no token for it and it is not an exchange, not a versioned
 * pool, and not a wrapped, staked or bridged product of an asset that already trades.
 */
export function classifyProtocol(p: SnapshotProtocol): ProtocolClass {
  if (p.mcap_usd !== null && p.mcap_usd > 0) return 'trading';
  if (p.mcap_usd === 0) return 'zero-cap';
  if (p.mcap_usd !== null) return 'sentinel-cap';
  if (!isPreToken(p)) return 'sub-product';
  if (p.category === 'CEX') return 'exchange';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (p.category !== null && STAKING_PRODUCT_CATEGORIES.has(p.category)) return 'staking-product';
  if (p.category !== null && BRIDGE_PRODUCT_CATEGORIES.has(p.category)) return 'bridge-product';
  if (PRODUCT_CORRECTIONS[p.slug] !== undefined) return 'named-product';
  if (p.tvl_usd < MODEL.board_floor_usd) return 'unranked-small';
  return 'ranked';
}

/** The partition of the whole snapshot by class: the counts sum to the snapshot's size. */
export function partitionOf(snapshot: Snapshot): Partition {
  const part: Partition = {
    ranked: 0,
    trading: 0,
    zero_cap: 0,
    sentinel_cap: 0,
    sub_products: 0,
    exchanges: 0,
    versioned: 0,
    staking_products: 0,
    bridge_products: 0,
    named_products: 0,
    unranked_small: 0,
    total: snapshot.protocols.length,
  };
  for (const p of snapshot.protocols) {
    switch (classifyProtocol(p)) {
      case 'ranked': part.ranked++; break;
      case 'trading': part.trading++; break;
      case 'zero-cap': part.zero_cap++; break;
      case 'sentinel-cap': part.sentinel_cap++; break;
      case 'sub-product': part.sub_products++; break;
      case 'exchange': part.exchanges++; break;
      case 'versioned': part.versioned++; break;
      case 'staking-product': part.staking_products++; break;
      case 'bridge-product': part.bridge_products++; break;
      case 'named-product': part.named_products++; break;
      case 'unranked-small': part.unranked_small++; break;
    }
  }
  return part;
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

/**
 * Per-category log offsets for a comp set, computed once: exactly categoryOffset's arithmetic
 * (same medians, same shrinkage, same clamp), batched so the bootstrap can refit 200 times
 * inside the runtime budget. A category with no comps in the set is absent, which callers
 * read as offset 0 — the same answer categoryOffset gives.
 */
export function offsetMapFor(comps: SnapshotProtocol[]): Map<string, number> {
  const glob = median(comps.map((q) => Math.log(q.mcap_usd! / q.tvl_usd)));
  const by = new Map<string, number[]>();
  for (const q of comps) {
    const key = q.category ?? '';
    const list = by.get(key) ?? [];
    list.push(Math.log(q.mcap_usd! / q.tvl_usd));
    by.set(key, list);
  }
  const out = new Map<string, number>();
  for (const [key, own] of by) {
    const shrunk = (own.length * median(own) + MODEL.cat_offset_k * glob) / (own.length + MODEL.cat_offset_k);
    out.set(key, clamp(shrunk - glob, -MODEL.cat_offset_cap, MODEL.cat_offset_cap));
  }
  return out;
}

/** radarValue's raw prediction with precomputed offsets: identical arithmetic, no refit per row. */
export function radarValueFast(p: SnapshotProtocol, asOf: string, fit: { a: number; b: number }, offsets: Map<string, number>): number {
  const base = powerValue(p.tvl_usd, fit) * Math.exp(offsets.get(p.category ?? '') ?? 0);
  return base * growthFactor(p) * maturityFactor(p, asOf);
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

/** Score a predictor over a held-out set with the two error figures the dashboard prints. */
function splitScore(test: SnapshotProtocol[], predict: (p: SnapshotProtocol) => number): { mean_log10: number; median_fold: number } {
  const e10: number[] = [];
  const efold: number[] = [];
  for (const p of test) {
    const ratio = predict(p) / p.mcap_usd!;
    e10.push(Math.abs(Math.log10(ratio)));
    efold.push(Math.abs(Math.log(ratio)));
  }
  return {
    mean_log10: round4(e10.reduce((s, x) => s + x, 0) / e10.length),
    median_fold: Math.round(Math.exp(median(efold)) * 1000) / 1000,
  };
}

/**
 * Walk-forward validation: fit on the comps listed up to a cutoff, score the comps listed after
 * it, at two cutoffs — the median listing date of the dated comps and 2024-07-01. radar-2 must
 * beat the flat 0.25 baseline at both for the dashboard to print the claim, and it does; the
 * numbers are recomputed here from the snapshot, and they match the research tournament's
 * time-split (research/tournament/results.json) to the printed rounding.
 */
export function walkForward(snapshot: Snapshot): WalkForwardRow[] {
  const comps = liveComps(snapshot);
  const dated = comps.filter((p) => p.listed_at !== null);
  const dates = dated.map((p) => p.listed_at!).sort();
  const cutoffs = [dates[Math.floor(dates.length / 2)]!, '2024-07-01'];
  const out: WalkForwardRow[] = [];
  for (const cutoff of cutoffs) {
    if (out.some((r) => r.cutoff === cutoff)) continue;
    const train = dated.filter((p) => p.listed_at! <= cutoff);
    const test = dated.filter((p) => p.listed_at! > cutoff);
    if (train.length === 0 || test.length === 0) continue;
    const fit = fitOls(train);
    const r2 = splitScore(test, (p) => radarValue(p, snapshot.as_of, fit, train).raw);
    const fl = splitScore(test, (p) => p.tvl_usd * 0.25);
    out.push({
      cutoff,
      n_train: train.length,
      n_test: test.length,
      radar2_mean_log10: r2.mean_log10,
      radar2_median_fold: r2.median_fold,
      flat_mean_log10: fl.mean_log10,
      flat_median_fold: fl.median_fold,
    });
  }
  return out;
}

/**
 * Held-out accuracy extras, all from leave-one-out predictions under the shipped model: the share
 * of comps predicted within 3x and within 10x of their actual cap, and a coverage audit of the
 * printed range bands — the share of held-out actual caps that fall inside the band the board
 * prints (per category where the category has at least 5 comps, else the global band). The bands
 * are fitted in-sample, so the audit is expected to under-cover; it is printed as a self-critique,
 * not hidden.
 */
export function validationExtras(snapshot: Snapshot): ValidationExtras {
  const comps = liveComps(snapshot);
  const asOf = snapshot.as_of;
  const fit = fitOls(comps);
  const looPred = new Map<string, number>();
  for (let i = 0; i < comps.length; i++) {
    const others = comps.filter((_, j) => j !== i);
    looPred.set(comps[i]!.slug, radarValue(comps[i]!, asOf, fitOls(others), others).raw);
  }
  let in3 = 0;
  let in10 = 0;
  for (const p of comps) {
    const pred = looPred.get(p.slug)!;
    const ratio = Math.max(pred / p.mcap_usd!, p.mcap_usd! / pred);
    if (ratio <= 3) in3++;
    if (ratio <= 10) in10++;
  }
  const residAll: number[] = [];
  const residBy = new Map<string, number[]>();
  for (const q of comps) {
    const r = Math.log(q.mcap_usd! / radarValue(q, asOf, fit, comps).raw);
    residAll.push(r);
    const key = q.category ?? '';
    const list = residBy.get(key) ?? [];
    list.push(r);
    residBy.set(key, list);
  }
  const bandFor = (key: string, lo: number, hi: number): [number, number] => {
    const list = residBy.get(key);
    const src = list !== undefined && list.length >= MODEL.range_min_category_comps ? list : residAll;
    return [quantile(src, lo), quantile(src, hi)];
  };
  let inMid = 0;
  let inWide = 0;
  for (const p of comps) {
    const r = Math.log(p.mcap_usd! / looPred.get(p.slug)!);
    const key = p.category ?? '';
    const mid = bandFor(key, 0.25, 0.75);
    const wide = bandFor(key, 0.1, 0.9);
    if (r >= mid[0] && r <= mid[1]) inMid++;
    if (r >= wide[0] && r <= wide[1]) inWide++;
  }
  const pct = (x: number): number => Math.round((x / comps.length) * 1000) / 10;
  return {
    n: comps.length,
    within_3x_pct: pct(in3),
    within_10x_pct: pct(in10),
    band_p25_p75_pct: pct(inMid),
    band_p10_p90_pct: pct(inWide),
  };
}

/** Every category's live-comp multiples, tabulated for the method section, busiest categories first. */
export function categoryTable(snapshot: Snapshot): CategoryRow[] {
  const comps = liveComps(snapshot);
  const glob = median(comps.map((q) => q.mcap_usd! / q.tvl_usd));
  const offsets = offsetMapFor(comps);
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
    offset: round4(Math.exp(offsets.get(category === 'Uncategorised' ? '' : category) ?? 0)),
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

/**
 * Farm economics: one stated scenario for every row (research/DEBATE.md item 1, V2-SPEC section 3).
 * A $1,000 position, held 90 days, in a launch that distributes 10% of the protocol's implied value
 * pro-rata across its current TVL. Slice = 0.10 x implied x (1000 / TVL); fees = the plan's
 * transaction count x the per-transaction cost of the cheapest chain the protocol lists; forgone
 * yield = $1,000 at 4% a year for 90 days. Net = slice - fees - forgone. The break-even figure is
 * the launch probability at which the farm would break even - a threshold printed for comparison,
 * never a predicted probability, and no step anywhere in this file promises a token or a return.
 */
export const ECON = {
  deposit_usd: 1000,
  horizon_days: 90,
  weeks: 13,
  drop_share: 0.1,
  forgone_rate: 0.04,
};

/** The forgone yield of the scenario: $1,000 parked for 90 days at 4% a year = $9.86. */
export const FORGONE_USD = Math.round(ECON.deposit_usd * ECON.forgone_rate * (ECON.horizon_days / 365) * 100) / 100;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A dollar figure with cents and thousands separators, for plan text: 1,000.00 style. */
function usd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Per-transaction cost in USD by chain: November 2026 planning estimates, printed on the dashboard
 * as estimates, not quotes. Chains the table does not name use DEFAULT_TX_COST_USD.
 */
const CHAIN_TX_COST_USD: Record<string, number> = {
  Ethereum: 6,
  Bitcoin: 4,
  Stacks: 1,
  Cardano: 0.2,
  Binance: 0.3,
  Polygon: 0.3,
  Avalanche: 0.3,
  Tron: 0.3,
  Cronos: 0.3,
  Core: 0.1,
  Base: 0.25,
  Arbitrum: 0.25,
  Optimism: 0.25,
  Ink: 0.25,
  Linea: 0.25,
  Scroll: 0.25,
  'zkSync Era': 0.25,
  Mantle: 0.25,
  Mode: 0.25,
  Blast: 0.25,
  Taiko: 0.25,
  Unichain: 0.25,
  Monad: 0.25,
  Sonic: 0.25,
  Berachain: 0.25,
  Plasma: 0.25,
  Katana: 0.25,
  'World Chain': 0.25,
  'Robinhood Chain': 0.25,
  BSquared: 0.25,
  Solana: 0.05,
  Sui: 0.05,
  Aptos: 0.05,
  TON: 0.05,
  Near: 0.05,
  Sei: 0.05,
  Injective: 0.05,
  Flare: 0.05,
  Gnosis: 0.05,
  Fantom: 0.05,
  Hedera: 0.05,
  Kaia: 0.05,
  Bittensor: 0.05,
  'Babylon Genesis': 0.05,
  'Hyperliquid L1': 0.05,
  Stellar: 0.01,
  Algorand: 0.01,
  Ripple: 0.01,
};
const DEFAULT_TX_COST_USD = 1;

/** The chain-cost classes the dashboard prints, from the table above. */
export const CHAIN_COST_TABLE: { label: string; usd: number }[] = [
  { label: 'Ethereum mainnet', usd: 6 },
  { label: 'Bitcoin', usd: 4 },
  { label: 'Other chains (default estimate)', usd: 1 },
  { label: 'Mid-cost chains (Binance, Polygon, Avalanche, Tron)', usd: 0.3 },
  { label: 'Low-cost L2s (Base, Arbitrum, Ink, Linea and peers)', usd: 0.25 },
  { label: 'Near-zero-fee chains (Solana, Sui, Stellar, Algorand and peers)', usd: 0.05 },
];

/** The cheapest chain a protocol lists, by the cost table: the chain a costed plan would use. */
export function costChainFor(p: SnapshotProtocol): { chain: string; cost: number } {
  let best: { chain: string; cost: number } | null = null;
  for (const chain of p.chains) {
    const cost = CHAIN_TX_COST_USD[chain] ?? DEFAULT_TX_COST_USD;
    if (best === null || cost < best.cost) best = { chain, cost };
  }
  return best ?? { chain: 'its main chain', cost: DEFAULT_TX_COST_USD };
}

/**
 * How a protocol is actually used, per category: a label, the two qualifying actions (with {name}
 * and {chain} filled from the protocol's own record), and the plan's rhythm. Transaction counts are
 * uniform so the fee maths can be checked: 2 setup + 2 action + 1 exit transactions, plus one a week
 * for active mechanisms and none for hold mechanisms, over the scenario's 13 weeks.
 */
interface Mechanism {
  label: string;
  actions: [string, string];
  weekly_txs: number;
  setup_min: number;
  weekly_min: number;
}

const HOLD = { weekly_txs: 0, setup_min: 25, weekly_min: 5 };
const ACTIVE = { weekly_txs: 1, setup_min: 30, weekly_min: 10 };

const MECHANISMS: Record<string, Mechanism> = {
  'Risk Curators': {
    label: 'curated vaults', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital as USDC into a {name} vault on {chain} and keep the vault shares in the wallet; write down the curator and the strategy named on the vault page.',
      'After two weeks, move a quarter of the position into a second {name} vault on {chain}, keeping the total at $1,000 across both vaults.',
    ],
  },
  'Onchain Capital Allocator': {
    label: 'allocation vaults', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital as USDC into one {name} allocation vault on {chain} and record the strategy it follows.',
      'After two weeks, shift a quarter of the position into a second {name} strategy vault on {chain}, keeping the total at $1,000.',
    ],
  },
  Yield: {
    label: 'yield vault', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital as USDC into the main {name} yield vault on {chain} and keep the vault shares in the wallet.',
      'After two weeks, withdraw a tenth of the position and deposit it straight back, proving the exit path works while the position stays open.',
    ],
  },
  'Yield Aggregator': {
    label: 'auto-compounding vaults', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital into a {name} aggregator vault on {chain} and note which strategy the aggregator routes it to.',
      'After two weeks, move a quarter of the position to a second {name} vault on {chain}, keeping the total at $1,000 across both.',
    ],
  },
  RWA: {
    label: 'tokenised real-world assets', ...HOLD,
    actions: [
      'Mint $1,000 of the {name} real-world-asset product on {chain} through its own app and hold the token in the wallet; check the app eligibility and minimum first, since some RWA products are gated.',
      'Hold the position across one full distribution cycle and claim the yield once from the {name} app, completing a hold-and-claim record.',
    ],
  },
  'Basis Trading': {
    label: 'basis vault', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital as USDC into the {name} basis vault on {chain} and keep the strategy shares in the wallet.',
      'After the first funding cycle, record the funding income the {name} dashboard reports and leave the position running into a second cycle.',
    ],
  },
  CeDeFi: {
    label: 'earn product (term)', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital as USDC into a {name} earn product on {chain} for the shortest term it offers.',
      'When the first term ends, roll the position into a second term inside {name} instead of withdrawing it.',
    ],
  },
  'Liquidity Manager': {
    label: 'managed liquidity vault', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital into a {name}-managed liquidity vault on {chain} and keep the vault shares in the wallet.',
      'Leave the position through one full rebalance cycle without withdrawing, then check the range and the fees the vault reports.',
    ],
  },
  Farm: {
    label: 'farm vault', ...HOLD,
    actions: [
      'Deposit the $1,000 of scenario capital into the main {name} farm on {chain} and stake the position for the full window.',
      'Harvest the rewards the {name} farm page shows once and restake them into the same farm instead of selling.',
    ],
  },
  'Staking Pool': {
    label: 'staking pool', ...HOLD,
    actions: [
      'Stake $1,000 worth of the native asset in the {name} pool on {chain} and keep it delegated to the same validator set.',
      'Claim the staking rewards once and restake them into the same {name} pool, compounding the position.',
    ],
  },
  Restaking: {
    label: 'restaking', ...HOLD,
    actions: [
      'Restake $1,000 worth of the staking asset through {name} on {chain} and keep the restaking receipt in the wallet.',
      'Delegate the restaked position to one operator inside {name} and leave the delegation unchanged for the window.',
    ],
  },
  Indexes: {
    label: 'index token', ...HOLD,
    actions: [
      'Buy $1,000 of a {name} index product on {chain} and hold the index token in the wallet.',
      'After a month, rebalance nothing and simply hold; check the index composition the {name} page reports against the token balance.',
    ],
  },
  'Stablecoin Wrapper': {
    label: 'wrapped stablecoin', ...HOLD,
    actions: [
      'Wrap $1,000 of USDC into the {name} wrapped stable asset on {chain} through its own app and hold the wrapped balance.',
      'Use a tenth of the wrapped balance in one partner market the {name} app lists, keeping the rest wrapped.',
    ],
  },
  'Collateral Markets': {
    label: 'collateral supply', ...HOLD,
    actions: [
      'Supply $1,000 of USDC as collateral through {name} on {chain} and keep the collateral position open and healthy.',
      'Top the collateral up by a tenth from the same wallet once, then leave both positions untouched.',
    ],
  },
  Lending: {
    label: 'lending market', ...ACTIVE,
    actions: [
      'Supply the $1,000 of scenario capital as USDC to {name} on {chain} and keep the supply position open.',
      'Borrow a small amount against the supply, repay it in full a week later, and keep supplying, so the wallet shows both sides of the market.',
    ],
  },
  Dexs: {
    label: 'DEX liquidity', ...ACTIVE,
    actions: [
      'Provide the $1,000 of scenario capital as liquidity to the main {name} pool on {chain} and keep the LP position in range.',
      'Route one small swap through {name} on {chain}, so the wallet appears as a trader as well as a liquidity provider.',
    ],
  },
  Derivatives: {
    label: 'perpetuals margin', ...ACTIVE,
    actions: [
      'Deposit the $1,000 of scenario capital as USDC margin on {name} on {chain} and open one small hedged position rather than a directional bet.',
      'Close the first position, record the funding paid or received, and open one more small position the following week.',
    ],
  },
  CDP: {
    label: 'CDP vault', ...ACTIVE,
    actions: [
      'Deposit the $1,000 of scenario capital as collateral into a {name} vault on {chain} and mint a conservative amount of its stablecoin against it.',
      'Repay part of the minted debt and top the collateral up once, keeping the vault safely over-collateralised.',
    ],
  },
  'CDP Manager': {
    label: 'managed CDP', ...ACTIVE,
    actions: [
      'Open a {name}-managed CDP on {chain} with the $1,000 of scenario capital as collateral and mint a conservative amount of the stablecoin it manages.',
      'Adjust the vault once from the manager page - a small collateral top-up - and hold the position.',
    ],
  },
  'Leveraged Farming': {
    label: 'leveraged farm', ...ACTIVE,
    actions: [
      'Open a {name} leveraged farm on {chain} with the $1,000 of scenario capital as equity at the lowest leverage offered, keeping a wide safety margin.',
      'Rebalance the position once when the app prompts, rather than closing it, and record the borrow cost paid.',
    ],
  },
  'Prediction Market': {
    label: 'prediction market', ...ACTIVE,
    actions: [
      'Fund the account with the $1,000 of scenario capital and take one small position in a liquid {name} market on {chain} that settles inside the window.',
      'After the first market settles, take one more small position and keep the settled record in the account.',
    ],
  },
  Chain: {
    label: 'chain usage', ...ACTIVE,
    actions: [
      'Bridge the $1,000 of scenario capital to {chain} through the chain canonical route and hold it in the wallet on the far side.',
      'Make one swap in a native {chain} app with the bridged funds, so the wallet is a chain user and not a parked balance.',
    ],
  },
  'Interest Rate Derivatives': {
    label: 'rate position', ...ACTIVE,
    actions: [
      'Open a small fixed-rate position on {chain} inside the {name} app using part of the $1,000 of scenario capital as margin.',
      'Close the position at the end of its term and record the fixed rate actually paid against the floating rate.',
    ],
  },
  'Dual-Token Stablecoin': {
    label: 'stablecoin mint', ...ACTIVE,
    actions: [
      'Mint $1,000 of the {name} stablecoin on {chain} with its required collateral mix and hold both tokens the system issues.',
      'Provide a small liquidity position for the stable pair on {chain} using part of the minted amount, keeping it in range.',
    ],
  },
  'Decentralized BTC': {
    label: 'BTC deposit', ...ACTIVE,
    actions: [
      'Deposit $1,000 worth of BTC into {name} through the deposit route its own app provides and hold the resulting position.',
      'Withdraw a tenth of the BTC position back through the same route once, proving the exit works, and keep the rest in place.',
    ],
  },
  'Anchor BTC': {
    label: 'BTC anchor', ...ACTIVE,
    actions: [
      'Deposit $1,000 worth of BTC collateral into {name} on {chain} and keep the anchored position open and over-collateralised.',
      'Make one small additional deposit a month later from the same wallet, showing the position is being built, not tested.',
    ],
  },
  'Governance Incentives': {
    label: 'governance program', ...ACTIVE,
    actions: [
      'Deposit the $1,000 of scenario capital into the {name} incentive program on {chain} and keep the earning position open.',
      'Take part in one {name} governance vote or incentive epoch while the position runs; participation records are the product here.',
    ],
  },
  Payments: {
    label: 'payments', ...ACTIVE,
    actions: [
      'Fund the wallet with the $1,000 of scenario capital and route one real payment through {name} on {chain}.',
      'Make one more {name} payment a week later to a second wallet you control, keeping each transfer small and real.',
    ],
  },
  'Crypto Card Issuer': {
    label: 'card account', ...ACTIVE,
    actions: [
      'Complete the {name} card account checks, fund it with part of the $1,000 of scenario capital through its own route, and make one real card payment.',
      'Use the card for one small payment a week later, since card issuers record active spenders.',
    ],
  },
  Insurance: {
    label: 'cover policy', ...ACTIVE,
    actions: [
      'Buy $1,000 of cover notional from {name} on {chain} for a position you actually hold, and keep the policy to its term.',
      'Record the premium and the exact cover terms from the policy page, and read the claim route once without filing.',
    ],
  },
  'Uncollateralized Lending': {
    label: 'uncollateralised pool', ...ACTIVE,
    actions: [
      'Supply the $1,000 of scenario capital as USDC to a {name} pool on {chain} whose borrower set you can inspect, for one pool term.',
      'At maturity, roll the supply into a second pool term inside {name} instead of exiting, if a suitable pool is open.',
    ],
  },
  'OTC Marketplace': {
    label: 'OTC desk', ...ACTIVE,
    actions: [
      'Register for the {name} marketplace and complete the identity checks it requires before any offer can be taken.',
      'Take one small listed offer of about $250 notional if the platform opens one to the wallet, and keep the settled asset.',
    ],
  },
};

const DEFAULT_MECHANISM: Mechanism = {
  label: 'protocol position', ...HOLD,
  actions: [
    'Deposit the $1,000 of scenario capital as USDC into the main {name} product on {chain} through its own app and keep the position open.',
    'Withdraw a tenth of the position once and deposit it straight back, proving the exit path works while the position stays open.',
  ],
};

/** The mechanism a protocol is farmed through, from its category. */
export function mechanismFor(p: SnapshotProtocol): Mechanism {
  return MECHANISMS[p.category ?? ''] ?? DEFAULT_MECHANISM;
}

const SETUP_TXS = 2;
const ACTION_TXS = 2;
const EXIT_TXS = 1;

/** One row's farm economics under the stated scenario, from its implied value and its mechanism. */
export function farmEconomics(p: SnapshotProtocol, implied: number): FarmEcon {
  const mech = mechanismFor(p);
  const { chain, cost } = costChainFor(p);
  const txs = SETUP_TXS + ACTION_TXS + mech.weekly_txs * ECON.weeks + EXIT_TXS;
  const hours = (mech.setup_min + mech.weekly_min * ECON.weeks) / 60;
  const slice = round2(ECON.drop_share * implied * (ECON.deposit_usd / p.tvl_usd));
  const fees = round2(txs * cost);
  const net = round2(slice - fees - FORGONE_USD);
  return {
    deposit_usd: ECON.deposit_usd,
    slice_usd: slice,
    fees_usd: fees,
    forgone_usd: FORGONE_USD,
    net_usd: net,
    breakeven_pct: slice > 0 ? round1(((fees + FORGONE_USD) / slice) * 100) : null,
    per_hour_usd: round2(net / hours),
    hours: round1(hours),
    txs,
    chain,
    chain_cost_usd: cost,
  };
}

/** The verdict the stated odds rule gives a row the research table does not cover. */
export function verdictFor(econ: FarmEcon): Verdict {
  if (econ.breakeven_pct === null || econ.net_usd < 0) return 'SKIP';
  if (econ.breakeven_pct <= 10) return 'FARM';
  if (econ.breakeven_pct <= 33) return 'THIN';
  return 'SKIP';
}

/** The closing step of a non-SKIP plan: the verdict and its arithmetic, in the open. */
function verdictStep(p: SnapshotProtocol, verdict: Verdict, econ: FarmEcon, researched: boolean): string {
  // Above 100% the break-even is not an odds figure: say, as the dashboard does, that the
  // costs exceed the slice at this size instead of printing a probability over 100%.
  const odds = econ.breakeven_pct === null
    ? 'a break-even launch probability that is not computable on a zero slice'
    : econ.breakeven_pct > 100
      ? 'a break-even launch probability that is not reachable at this size, because the fees plus forgone yield exceed the scenario slice'
      : `a break-even launch probability of ${econ.breakeven_pct}%`;
  const source = researched ? ' The verdict itself comes from verified program research dated 2026-11-18 (see the protocol detail), not from this scenario.' : '';
  return `Verdict: ${verdict} on the stated $1,000 scenario.${source} A launch distributing 10% of ${p.name} implied value pro-rata across TVL pays this position $${usd(econ.slice_usd)}; fees of $${usd(econ.fees_usd)} plus $${usd(econ.forgone_usd)} of forgone yield leave net $${usd(econ.net_usd)}, ${odds} and $${usd(econ.per_hour_usd)} per hour of plan time. Cost: $0. Time: 2 minutes to read.`;
}

/** A mechanism plan for a row with no researched plan: setup, two actions, the hold, the verdict. */
function mechanismSteps(p: SnapshotProtocol, econ: FarmEcon): string[] {
  const mech = mechanismFor(p);
  const fill = (t: string): string => t.split('{name}').join(p.name).split('{chain}').join(econ.chain);
  const setupGas = round2(SETUP_TXS * econ.chain_cost_usd);
  const weeklyGas = round2(mech.weekly_txs * econ.chain_cost_usd * ECON.weeks);
  const exitGas = round2(EXIT_TXS * econ.chain_cost_usd);
  const hold =
    mech.weekly_txs > 0
      ? `Hold the position for the 90-day scenario window and repeat one small qualifying action each week on ${econ.chain}; if ${p.name} runs a points program it will normally read activity like this, but the snapshot records no program, so treat any points as unconfirmed until the protocol announces one. Cost: about $${usd(weeklyGas)} of gas across ${ECON.weeks} weekly actions, plus about $${usd(exitGas)} to exit at the end. Time: ${mech.weekly_min} minutes a week.`
      : `Hold the position untouched for the 90-day scenario window and check it once a week; if ${p.name} runs a points program it will normally read balances like this, but the snapshot records no program, so treat any points as unconfirmed until the protocol announces one. Cost: about $${usd(exitGas)} to exit at the end, and nothing across the window. Time: ${mech.weekly_min} minutes a week.`;
  return [
    `Open ${p.name} in its own app and connect a fresh wallet on ${econ.chain}, the cheapest chain it lists at about $${usd(econ.chain_cost_usd)} per transaction in this model; a separate wallet keeps the farm auditable. Cost: about $${usd(setupGas)} of gas for funding and approvals. Time: ${mech.setup_min} minutes.`,
    `${fill(mech.actions[0])} Cost: $1,000 of scenario capital; its transaction gas is counted in step 1. Time: 15 minutes.`,
    `${fill(mech.actions[1])} Cost: about $${usd(round2(econ.chain_cost_usd))} of gas; the capital is already placed. Time: 10 minutes.`,
    hold,
  ];
}

/** A SKIP row's plan: why the numbers refuse, what to do instead, and the honesty line. */
function skipSteps(p: SnapshotProtocol, econ: FarmEcon): string[] {
  const odds = econ.breakeven_pct === null
    ? 'the launch would need a break-even probability that is not computable on a zero slice to pay'
    : econ.breakeven_pct > 100
      ? 'the break-even probability is not reachable at this size, because the fees plus forgone yield exceed the scenario slice'
      : `the launch would need a ${econ.breakeven_pct}% break-even probability to pay`;
  return [
    `Skip this farm on the stated $1,000 scenario: the position slice of $${usd(econ.slice_usd)} does not cover $${usd(econ.fees_usd)} of fees plus $${usd(econ.forgone_usd)} of forgone yield - net $${usd(econ.net_usd)}, and ${odds}, far above what an unannounced launch justifies staking on. Cost: $0. Time: 3 minutes to read the numbers.`,
    `Do instead: keep ${p.name} on the watchlist and use its product only if the yield itself is the goal; re-check this row when its TVL, its fees or a confirmed program changes the arithmetic above. Cost: $0. Time: 5 minutes to set a reminder.`,
    `No points program is recorded in the snapshot for ${p.name} and none is assumed anywhere in this plan; verify any program claim on the protocol official channels before depositing anything. Cost: $0. Time: 2 minutes.`,
  ];
}

/**
 * One row's complete farm plan: researched steps for the watchlist (lib/farmdata.ts, from
 * research/FARM.md), mechanism steps for the rest, the verdict and the economics. Every plan
 * ends with the verdict step, so the board's farm_steps carry the same arithmetic the dashboard
 * prints; SKIP rows open with the refusal instead.
 */
export function farmPlan(p: SnapshotProtocol, implied: number): { steps: string[]; verdict: Verdict; econ: FarmEcon; program: string | null; source: string | null } {
  const econ = farmEconomics(p, implied);
  const research = FARM_RESEARCH[p.slug];
  if (research !== undefined) {
    return {
      steps: [...research.steps, verdictStep(p, research.verdict, econ, true)],
      verdict: research.verdict,
      econ,
      program: research.program,
      source: research.source,
    };
  }
  // A FARM verdict needs two things: odds the scenario can pay, and a verified live program to
  // farm. An unresearched row can only show the odds, so it caps at THIN however good they look.
  const raw = verdictFor(econ);
  const verdict: Verdict = raw === 'FARM' ? 'THIN' : raw;
  return {
    steps: verdict === 'SKIP' ? skipSteps(p, econ) : [...mechanismSteps(p, econ), verdictStep(p, verdict, econ, false)],
    verdict,
    econ,
    program: null,
    source: null,
  };
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
  // One classification standard on both sides of the floor (classifyProtocol): every stand-alone
  // pre-token protocol in the snapshot is ranked, down to the snapshot's own $5M floor.
  for (const p of snapshot.protocols) {
    if (classifyProtocol(p) === 'ranked') chosen.set(p.slug, p);
  }
  // The watchlist is the floor: every slug is on the board whatever its class — the gate
  // requires all 40, and on this snapshot every watchlist protocol classifies as ranked anyway.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

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
    farm_steps: farmPlan(s.p, s.implied).steps,
  }));
}

/** The live-token comps, all of them, by market cap: the calibration set the dashboard tabulates. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return liveComps(snapshot)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
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

/** A small deterministic PRNG (mulberry32): the bootstrap must be reproducible byte for byte. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many bootstrap refits the rank ranges come from, and the fixed seed that makes them stable. */
export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 20261118;

/**
 * Each board row's rank range: resample the 128 comps with replacement 200 times, refit radar-2
 * on each resample, re-rank the whole board, and take the p10-p90 of the row's ranks. A narrow
 * range means the rank survives refitting; a wide one is printed just as plainly.
 */
export function bootstrapRankRanges(board: BoardRow[], snapshot: Snapshot): Map<string, { lo: number; hi: number }> {
  const comps = liveComps(snapshot);
  const index = bySlug(snapshot.protocols);
  const rows = board.map((r) => index.get(r.slug)).filter((p): p is SnapshotProtocol => p !== undefined);
  const seen = new Map<string, number[]>();
  for (const r of board) seen.set(r.slug, []);
  const rand = mulberry32(BOOTSTRAP_SEED);
  for (let i = 0; i < BOOTSTRAP_REFITS; i++) {
    const sample: SnapshotProtocol[] = [];
    for (let j = 0; j < comps.length; j++) sample.push(comps[Math.floor(rand() * comps.length)]!);
    const fit = fitOls(sample);
    const offsets = offsetMapFor(sample);
    const scored = rows.map((p) => ({ slug: p.slug, v: radarValueFast(p, snapshot.as_of, fit, offsets) }));
    scored.sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    scored.forEach((s, idx) => seen.get(s.slug)!.push(idx + 1));
  }
  const out = new Map<string, { lo: number; hi: number }>();
  for (const [slug, arr] of seen) out.set(slug, { lo: Math.round(quantile(arr, 0.1)), hi: Math.round(quantile(arr, 0.9)) });
  return out;
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
  const index = bySlug(snapshot.protocols);
  const rankRanges = bootstrapRankRanges(board, snapshot);
  const rows: RadarRow[] = board.map((row) => {
    const band = bands.byCat.get(row.category ?? '') ?? bands.global;
    const cat = row.category === null ? undefined : catByName.get(row.category);
    const plan = farmPlan(index.get(row.slug)!, row.implied_value_usd);
    const range = rankRanges.get(row.slug) ?? { lo: row.rank, hi: row.rank };
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
      rank_lo: range.lo,
      rank_hi: range.hi,
      cat_n: cat?.n ?? 0,
      cat_median: cat ? cat.median : null,
      watchlist: watch.has(row.slug),
      verdict: plan.verdict,
      econ: plan.econ,
      farm_program: plan.program,
      farm_source: plan.source,
      farm_steps: row.farm_steps,
    };
  });
  const verdict_counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) verdict_counts[r.verdict]++;
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
    partition: partitionOf(snapshot),
    walk_forward: walkForward(snapshot),
    extras: validationExtras(snapshot),
    coverage: board.filter((r) => watch.has(r.slug)).length,
    verdict_counts,
    assumptions: {
      deposit_usd: ECON.deposit_usd,
      horizon_days: ECON.horizon_days,
      weeks: ECON.weeks,
      drop_share: ECON.drop_share,
      forgone_rate: ECON.forgone_rate,
      forgone_usd: FORGONE_USD,
    },
    chain_costs: CHAIN_COST_TABLE,
    bootstrap: { refits: BOOTSTRAP_REFITS, seed: BOOTSTRAP_SEED },
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
