// rebalancing-core.mjs — the pure, engine-free maths shared by the chaosD6 rebalancing validators.
//
// Used by tools/skills-rebalancing-check.mjs (chaosD6-Skills, milestone S5). The effects validator
// (tools/rebalancing-check.mjs, E5) carries byte-identical copies of the same functions and does NOT import
// this file: its pin hashes its own source, so moving them here would change the effects pin_id
// (5f8ddbb4…) — a deliberate choice, not an oversight. tools/skills-rebalancing-check-test.mjs proves the
// copies agree (same outputs on every stat 0..40, same canonical JSON, same fit). When the effects validator
// next bumps its version it can import from here.
//
// Bit-exact on every peer: only + − × ÷, Math.round / Math.abs / Math.max and integer loops (no log/exp/pow).
import crypto from 'node:crypto';
import fs from 'node:fs';

export const CORE_VERSION = '1.0.0';
export const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const r3 = (x) => Math.round(x * 1e3) / 1e3;
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Canonical JSON: sorted keys, no whitespace — the same bytes on every peer whatever the file formatting.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
// sha256 of a text file with CRLF → LF (a Windows checkout pins the same); null when absent.
export const fileSha = (p) => (fs.existsSync(p) ? sha256(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')) : null);
export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// Rule 20: 6·n nearest the stat, ties to more dice (= effects.mjs#diceCount).
export function diceCount(stat) {
  let best = 1;
  for (let n = 1; n <= 4; n++) if (Math.abs(6 * n - stat) <= Math.abs(6 * best - stat)) best = n;
  return best;
}
const _pb = new Map();
// Point-buy of `stat`: p = P(sum ≤ stat); dist = value (max die) distribution given success; evMin = E min die.
export function pointBuyStats(stat) {
  if (_pb.has(stat)) return _pb.get(stat);
  let res;
  if (!(stat >= 1)) res = { p: 1, ev: 0, evMin: 0, dist: [[0, 1]] };
  else {
    const n = diceCount(stat);
    const dice = new Array(n).fill(1);
    const cnt = [0, 0, 0, 0, 0, 0, 0];
    let ok = 0, total = 0, sumMin = 0;
    for (;;) {
      total++;
      let s = 0, mx = 0, mn = 7;
      for (const d of dice) { s += d; if (d > mx) mx = d; if (d < mn) mn = d; }
      if (s <= stat) { ok++; cnt[mx]++; sumMin += mn; }
      let i = 0;
      while (i < n && dice[i] === 6) { dice[i] = 1; i++; }
      if (i === n) break;
      dice[i]++;
    }
    const dist = [];
    let ev = 0;
    for (let v = 1; v <= 6; v++) if (cnt[v]) { dist.push([v, cnt[v] / ok]); ev += v * cnt[v] / ok; }
    res = { p: ok / total, ev, evMin: ok ? sumMin / ok : 0, dist };
  }
  _pb.set(stat, res);
  return res;
}
// Least squares V = a + b·C, then one refit without the gross outliers (|r − 1| > drop on the first fit),
// keeping at least `minKeep` points. With the defaults (0.6, 5) this is the effects validator's fitCurve.
export function fitCurve(points, { drop = 0.6, minKeep = 5 } = {}) {
  const ols = (ps) => {
    const k = ps.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of ps) { sx += p.C; sy += p.V; sxx += p.C * p.C; sxy += p.C * p.V; }
    const den = k * sxx - sx * sx;
    const b = den ? (k * sxy - sx * sy) / den : 0;
    return { a: (sy - b * sx) / k, b };
  };
  const f1 = ols(points);
  const kept = points.filter(p => { const e = f1.a + f1.b * p.C; return e > 0 && Math.abs(p.V / e - 1) <= drop; });
  const f2 = ols(kept.length >= minKeep ? kept : points);
  return { a: r6(f2.a), b: r6(f2.b), n: points.length, n_fit: kept.length >= minKeep ? kept.length : points.length, model: `V = a + b·C (OLS, refit without |r−1|>${drop})` };
}
// Verdict of a judged ratio against a band; shared wording with the effects validator.
export function bandVerdict(judged, tol, cap, floor, what = 'cost curve') {
  const lo = r6(1 - tol), hi = r6(1 + tol);
  if (judged > cap) return { verdict: 'reject', lo, hi, reason: `power ${judged}× the ${what} > hard cap ${cap}×` };
  if (judged < floor) return { verdict: 'reject', lo, hi, reason: `power ${judged}× < floor ${floor}× (does next to nothing)` };
  if (judged > hi) return { verdict: 'nerf', lo, hi, reason: `power ${judged}× above the band [${lo}, ${hi}]` };
  if (judged < lo) return { verdict: 'boost', lo, hi, reason: `power ${judged}× below the band [${lo}, ${hi}]` };
  return { verdict: 'ok', lo, hi, reason: `power ${judged}× inside the band [${lo}, ${hi}]` };
}
