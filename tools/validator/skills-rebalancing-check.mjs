#!/usr/bin/env node
// skills-rebalancing-check (milestone S5 of the chaosD6-Skills program, user-approved 2026-11-16: "do the same
// split for the skills as well … extract there the skills as jsonlogic and the tools and validator").
// The skills twin of tools/rebalancing-check.mjs (E5): every peer that meets a foreign skill runs it and must
// reach the SAME verdict, so the model is
//   * analytic and exact — expectations are enumerated over the frozen 12-character pool (no sampling, no
//     log/exp/pow: + − × ÷ and Math.round only, bit-exact IEEE everywhere);
//   * self-contained — the verdict depends only on this file, tools/rebalancing-core.mjs and
//     tools/skills-rebalancing-calibration.json (all sha256-pinned) and, for the logic audit, the engine files
//     (pinned too — user ruling 2026-11-16: the pin stays tied to the engine), never on data/*.json at check time.
//
//   node tools/skills-rebalancing-check.mjs check <def.json|skill_id> [--baseline <id|def.json>] [--no-baseline] [--tolerance t] [--json]
//   node tools/skills-rebalancing-check.mjs report [--json]       every built-in: V, C, ratio, verdict
//   node tools/skills-rebalancing-check.mjs calibrate [--write]   refit the curve on the 14 built-ins
//   node tools/skills-rebalancing-check.mjs audit <def.json|skill_id>   logic audit only (flags vs game/skills.mjs)
//   node tools/skills-rebalancing-check.mjs pin [--write <path>]  the validator pin (validator/pin.json in the chaosD6-Skills repo)
//
// Import: `import { checkSkill } from './tools/skills-rebalancing-check.mjs'`;
//   checkSkill(def, { baseline, tolerance, calibration }) → { verdict: ok|nerf|boost|reject, power, ratio, suggestions, stamp, … }
//
// POWER MODEL (unit = one point of life swing). A skill is a cheap rider on an action (A / M / B / P; M and P
// also ride on EM / EP), instant or permanent. Its effect is measured on ONE ACTION OF A DUEL — me vs a foe,
// adjacent (or 2 hexes apart for a skill with reach), plus (ally_present) an ally on Empty Posture next to the
// foe — enumerated exactly over: every ordered (me, foe) pair of the pool × the foe's code × my code (instant:
// its action_type; permanent: any code; Sanctuary: the codes that keep it; Battle Trance: two codes) × distance
// × ally present / absent × the foe's Attack/Move target (me / ally) × the foe carrying a non-permanent skill ×
// the foe casting a delta-damage effect on P/EP × the permanent's power die (fixed for a fixed-power skill).
// The basic actions carry EQUAL weights (user ruling 2026-11-16: "the basic actions are not measurable" — no
// guessed action mix; mix.foe = mix.self = 1/6 for each of A, M, B, P, EM, EP). Per scenario
//   swing = dealt − taken(me, combat + effect) − taken(ally) + negated·w_neg + denied_move·w_move
//           + stripped·foe_skill_value + swapped·swap_value
// and Δ = swing(with the skill) − swing(without). Then
//   instant    V = E[Δ] / p_job           — an instant that found nothing returns to hand (Rule 8, ruling
//              2026-11-12), so a consumed card is worth its conditional effect; who:'adjacent' × adjacent_foes
//   permanent  V = E_die[ E[Δ | die] · L(die) ] (+ trap_avoid / protect_perms per relevant action), L = lifetime
//              perm_lifetime_actions·die/6; a single-use permanent (Force Shield) = min(1, p_use·L) uses; Sanctuary
//              lasts min(L, k/(1−k)) actions, k = share of the codes that keep it
//   cost C     = card + wait·(1−p_job)/p_job (instants) + extra_card (Trance) + permanent + pointbuy_retry·E[retries]
//              + locked_action·(remaining actions of the round)·(share of the codes a self-lock forbids)
// curve V̂(C) = a + b·C (OLS over the built-ins, refit without |r−1| > fit_drop). ratio r = V / V̂(C).
// TOLERANCE ±10 % (as the effects validator, user ruling 2026-11-16). VERDICT: reject (schema / r > hard cap 2.0 /
// r < floor 0.2 — limits confirmed 2026-11-16 / logic audit), nerf (r > 1+tol), boost (r < 1−tol), ok. With a
// baseline (explicit, or automatic when the def has the id of / `extends` a built-in) the band applies to
// r / r_baseline.
//
// LOGIC AUDIT: the skills' behaviour runs in game/skills.mjs (S1 hooks dispatched by skillHook; S2 programs in
// skills-data/skills/<id>.json run by resolveSkillProgram). The audit replays the seeded duels through a small
// resolver mirroring peer.mjs simulate() (counter_pre → negate_action → negate_kind → trance_assign → strikes
// with attack_range / block_in / attack_vs_block / attack_out / attack_target / defend_in → damage_in →
// effect_in / effect_leg / defend_in 'effect', noEmit, swaps; plus plan_lock) and through the validator's own
// reading of the declared flags; the executed behaviour may not do MORE than the flags on any dimension.
//   * a definition with `hooks` programs (S2 shape, foreign or built-in) runs its programs (resolveSkillProgram);
//   * otherwise a built-in, or a branch that `extends` one, runs that built-in's hooks (skillHook);
//   * a foreign flags-only definition runs nothing (audit not run, still priced); a foreign definition with a
//     bare `logic` block (no hooks) cannot be executed → rejected.
// Without game/skills.mjs the audit is skipped (reported, and the pin says so).
//
// DEFINITION FIELDS checkSkill reads: id (skill_[a-z0-9_]+), action_type (A|M|B|P), is_permanent, point_buy_stat
// (permanent only: stat_vitality|stat_world|stat_matter|stat_will|any), fixed_power (permanent, optional: no
// roll), flags (the FLAG_KEYS vocabulary below; S1 SKILL_RULES keys such as action / negating / hooks / range /
// negates are ignored for pricing), optional extends (a built-in id), hooks (S2 programs) and logic. They may sit
// at the top level or under `data` (flags also as `rule`). A built-in is ok in baseline mode when these equal
// data/skills.json + BUILTIN_FLAGS (judged ratio exactly 1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_VERSION, r6, r3, sha256, isObj, canonicalJson, fileSha, readJson, pointBuyStats, fitCurve, bandVerdict } from './rebalancing-core.mjs';

export { canonicalJson };
export const VALIDATOR_VERSION = '1.1.0';   // 1.1.0 (2026-11-16): skill rebalance rulings, equal action weights
export const DEFAULT_TOLERANCE = 0.10;   // user ruling 2026-11-16 (same band as the effects validator)
export const PIN_FORMAT = 'chaosd6-skills-validator-pin/1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const ROOT = path.resolve(GAME, '..');
export const CALIBRATION_PATH = path.join(HERE, 'skills-rebalancing-calibration.json');
const SELF_PATH = fileURLToPath(import.meta.url);
const CORE_PATH = path.join(HERE, 'rebalancing-core.mjs');
const STATS = ['vitality', 'world', 'matter', 'will'];
const CODES6 = ['A', 'M', 'B', 'P', 'EM', 'EP'];
const CODES4 = ['A', 'M', 'B', 'P'];

// ------------------------------------------------------------------ engines (logic audit only)
const ENGINE_FILES = { skills: path.join(GAME, 'skills.mjs'), skill_engine: path.join(GAME, 'skill-engine.mjs'), effect_engine: path.join(GAME, 'effect-engine.mjs') };
const LIB_DIR = path.join(GAME, 'skills-data', 'lib');
const DEFS_DIR = path.join(GAME, 'skills-data', 'skills');
let SK = null;
try { if (fs.existsSync(ENGINE_FILES.skills)) SK = await import(pathToFileURL(ENGINE_FILES.skills).href); } catch { SK = null; }
const programEngine = () => (typeof SK?.resolveSkillProgram === 'function' ? SK.resolveSkillProgram : null);
function engineHashes() {
  const libs = fs.existsSync(LIB_DIR) ? fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.json')).sort() : [];
  return {
    'game/skills.mjs': fileSha(ENGINE_FILES.skills),
    'game/skill-engine.mjs': fileSha(ENGINE_FILES.skill_engine),
    'game/effect-engine.mjs': fileSha(ENGINE_FILES.effect_engine),
    ...Object.fromEntries(libs.map(f => [`game/skills-data/lib/${f}`, sha256(canonicalJson(readJson(path.join(LIB_DIR, f))))])),
  };
}

// ------------------------------------------------------------------ calibration + pin
let _cal = null;
export function loadCalibration(file = CALIBRATION_PATH) {
  if (file === CALIBRATION_PATH && _cal) return _cal;
  const cal = readJson(file);
  if (file === CALIBRATION_PATH) _cal = cal;
  return cal;
}
// The pin describes the code this process has loaded, so it is computed once per calibration object.
const _pins = new WeakMap();
export function computePin(cal = loadCalibration()) {
  if (_pins.has(cal)) return JSON.parse(JSON.stringify(_pins.get(cal)));
  const pin = computePinUncached(cal);
  _pins.set(cal, pin);
  return JSON.parse(JSON.stringify(pin));
}
function computePinUncached(cal) {
  const source_sha256 = fileSha(SELF_PATH);
  const core_sha256 = fileSha(CORE_PATH);
  const calibration_sha256 = sha256(canonicalJson(cal));
  const audit = cal.policy.audit !== false;
  const engines = audit ? engineHashes() : {};
  const engines_sha256 = sha256(canonicalJson(engines));
  return {
    format: PIN_FORMAT,
    validator: 'skills-rebalancing-check',
    validator_version: VALIDATOR_VERSION,
    source_path: 'game/tools/skills-rebalancing-check.mjs',
    source_sha256,
    core_path: 'game/tools/rebalancing-core.mjs',
    core_version: CORE_VERSION,
    core_sha256,
    calibration_path: 'game/tools/skills-rebalancing-calibration.json',
    calibration_sha256,
    audit,
    engines,
    engines_sha256,
    pin_id: sha256(`${VALIDATOR_VERSION}\n${source_sha256}\n${core_sha256}\n${calibration_sha256}\n${engines_sha256}`),
    policy: { tolerance: cal.policy.tolerance, hard_cap_ratio: cal.policy.hard_cap_ratio, hard_floor_ratio: cal.policy.hard_floor_ratio, audit_slack: cal.policy.audit_slack },
    fit: cal.fit ? { a: cal.fit.a, b: cal.fit.b } : null,
    accept: ['ok'],
    notes: 'A ref (skill branch) is accepted when its stamp.pin_id equals this pin_id and stamp.verdict is in `accept`. Peers re-run checkSkill on the def and compare stamp.def_sha256 + verdict; a different pin_id means a different validator (or engine) — re-check, do not trust.',
  };
}
export function verifyPin(pin, cal = loadCalibration()) {
  const mine = computePin(cal);
  const diffs = ['format', 'validator_version', 'source_sha256', 'core_sha256', 'calibration_sha256', 'engines_sha256', 'pin_id'].filter(k => pin?.[k] !== mine[k]);
  return { ok: diffs.length === 0, diffs, mine: mine.pin_id, theirs: pin?.pin_id ?? null };
}

// ------------------------------------------------------------------ definitions
// Flags = the validator's vocabulary of what a skill does (what it is priced by). The built-ins' flags below
// follow the 2026-11-16 skill rebalance (data/skills.json 1.1.0, game/skills.mjs); the logic audit proves them.
export const BUILTIN_FLAGS = {
  skill_powerful_attack: { attackBonus: 1, selfLock: { codes: ['A'], until: 'end_of_round' } },
  skill_overrun: { negate: { codes: ['M', 'EM'], who: 'target', mode: 'no_move' }, swap: true },
  skill_grapple: { negate: { codes: ['P'], who: 'target', mode: 'ep' } },
  skill_ranged_weapon: { reach: 2, trapImmune: true },
  skill_taunt: { tauntGuard: true, blockDenied: true },
  skill_force_shield: { effectShield: true },
  skill_barricade: { immuneTo: ['A', 'B'] },
  skill_sanctuary: { invincibleWhile: ['M', 'EM', 'EP'] },
  skill_disruption_move: { negate: { codes: ['P'], who: 'target', mode: 'em' }, voidEmission: true },
  skill_dodge: { damageOff: 1 },
  skill_bluff: { negate: { codes: ['A', 'M', 'B', 'P', 'EM'], who: 'target', mode: 'ep' } },
  skill_intimidation: { negate: { codes: ['A'], who: 'adjacent', mode: 'ep' }, altCounterSkill: true },
  skill_battle_trance: { trance: true },
  skill_counter_spell: { counterSkill: true, counterElement: true },
};
const PERM_ONLY = new Set(['reach', 'trapImmune', 'tauntGuard', 'blockDenied', 'immuneTo', 'invincibleWhile', 'effectShield']);
const subsetOf = (v, all, max) => Array.isArray(v) && v.length >= 1 && v.length <= max && new Set(v).size === v.length && v.every(x => all.includes(x));
const NEGATE_CODES = { ep: ['A', 'M', 'B', 'P', 'EM'], em: ['A', 'M', 'B', 'P', 'EP'], no_move: ['M', 'EM'] };
export const FLAG_KEYS = {
  attackBonus: (v, c) => Number.isInteger(v) && v >= 1 && v <= c.attack_bonus,          // +N on my landing Attack (Powerful Attack)
  selfLock: (v) => isObj(v) && Object.keys(v).every(k => ['codes', 'until'].includes(k)) && v.until === 'end_of_round' && subsetOf(v.codes, CODES6, 5),
  //                                       after it paid off I may only play these codes for the rest of the round (Powerful Attack: A)
  damageOff: (v, c) => Number.isInteger(v) && v >= 1 && v <= c.damage_off,              // −N on the first combat hit I take (Dodge)
  negate: (v, c) => isObj(v) && Object.keys(v).every(k => ['codes', 'who', 'mode'].includes(k)) && ['target', 'adjacent'].includes(v.who) && ['ep', 'em', 'no_move'].includes(v.mode)
    && subsetOf(v.codes, NEGATE_CODES[v.mode] || [], c.negate_codes),   // the foe's action → EP / EM / cannot move
  altCounterSkill: (v) => v === true,     // with nothing to negate: strip the foe's non-permanent skills (Intimidation)
  counterSkill: (v) => v === true,        // strip the foe's non-permanent skills (Counter Spell)
  counterElement: (v) => v === true,      // my stat comes off one element of the foe's cast (Counter Spell)
  voidEmission: (v) => v === true,        // the targeted foe on P / EP emits nothing this action (Disruption Move)
  swap: (v) => v === true,                // I trade hexes with the adjacent foe I attack (Overrun)
  trance: (v) => v === true,              // a second action card; per enemy the better one counts (Battle Trance)
  reach: (v, c) => Number.isInteger(v) && v >= 2 && v <= c.reach,   // my Attack reaches N hexes; beyond contact nothing hits back (Ranged Weapon)
  trapImmune: (v) => v === true,          // my Attack springs no traps (Ranged Weapon) — priced, not in the duel
  tauntGuard: (v) => v === true,          // adjacent enemies' Attacks on anyone else deal 0 (Taunt)
  blockDenied: (v) => v === true,         // adjacent enemies' Block neither hurts me nor stops my Attack (Taunt)
  immuneTo: (v) => subsetOf(v, CODES4, 4),// strikes of these codes deal me 0 (Barricade: A, B)
  invincibleWhile: (v, c) => subsetOf(v, CODES6, c.keep_codes),   // no damage while I only play these codes; another ends it (Sanctuary)
  effectShield: (v) => v === true,        // power die off the first landing effect leg, then spent (Force Shield)
};
// S1 SKILL_RULES-style keys an S2 definition carries next to the validator keys — ignored for pricing.
const META_KEYS = new Set(['hooks', 'negating', 'range', 'keepsTarget', 'notes', 'action', 'permanent', 'pointBuyStat', 'negates', 'fixedPower']);
function activeVersionOf(entry) {
  const vs = (entry.versions || []).filter(v => !['rejected', 'superseded'].includes(v.status));
  return vs.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] || null;
}
export function normalizeDef(def) {
  if (!isObj(def)) return { errors: ['definition is not an object'] };
  const v = def.versions ? activeVersionOf(def) : null;
  const data = isObj(def.data) ? def.data : (v?.data || {});
  const pick = (...ks) => { for (const k of ks) { if (def[k] !== undefined) return def[k]; if (data[k] !== undefined) return data[k]; } return undefined; };
  const pbs = pick('point_buy_stat', 'pointBuyStat');
  const flags = pick('flags', 'rule');
  const fp = pick('fixed_power') ?? (isObj(flags) ? flags.fixedPower : undefined);
  return {
    id: def.id ?? null,
    extends: pick('extends', 'base_id') ?? null,
    action: pick('action_type', 'action') ?? null,
    permanent: pick('is_permanent', 'permanent') ?? false,
    pointBuyStat: pbs == null ? null : String(pbs).replace(/^stat_/, ''),
    fixedPower: fp ?? null,
    flags: isObj(flags) ? Object.fromEntries(Object.entries(flags).filter(([k]) => !META_KEYS.has(k))) : flags,
    hasLogic: def.logic !== undefined,
    hasProgram: isObj(def.hooks) && Object.keys(def.hooks).length > 0,
    errors: [],
  };
}
export function validateNorm(n, cal) {
  const errs = [...(n.errors || [])];
  const caps = cal.policy.caps;
  if (typeof n.id !== 'string' || !/^skill_[a-z0-9_]+$/.test(n.id)) errs.push(`id must match skill_[a-z0-9_]+ (got ${JSON.stringify(n.id)})`);
  if (!CODES4.includes(n.action)) errs.push(`action_type must be one of A, M, B, P (got ${JSON.stringify(n.action)})`);
  if (typeof n.permanent !== 'boolean') errs.push('is_permanent must be a boolean');
  if (n.permanent && ![...STATS, 'any'].includes(n.pointBuyStat)) errs.push(`a permanent skill needs point_buy_stat vitality|world|matter|will|any (got ${JSON.stringify(n.pointBuyStat)})`);
  if (!n.permanent && n.pointBuyStat != null) errs.push('point_buy_stat only applies to a permanent skill');
  if (n.fixedPower != null && !(n.permanent && Number.isInteger(n.fixedPower) && n.fixedPower >= 1 && n.fixedPower <= caps.fixed_power)) errs.push(`fixed_power must be an integer 1..${caps.fixed_power} on a permanent skill`);
  if (!isObj(n.flags)) errs.push('flags (validator keys) missing');
  else {
    const ks = Object.keys(n.flags);
    if (!ks.length) errs.push('flags declare no behaviour');
    for (const [k, val] of Object.entries(n.flags)) {
      if (!FLAG_KEYS[k]) errs.push(`unknown flag ${k}`);
      else if (!FLAG_KEYS[k](val, caps)) errs.push(`flags.${k} out of bounds or malformed: ${JSON.stringify(val)}`);
    }
    if (!errs.length) {
      const f = n.flags;
      for (const k of ks) {
        if (PERM_ONLY.has(k) && !n.permanent) errs.push(`flags.${k} needs a permanent skill`);
        if (!PERM_ONLY.has(k) && n.permanent) errs.push(`flags.${k} is an instant's (the skill is permanent)`);
      }
      if (f.attackBonus && n.action !== 'A') errs.push('attackBonus rides on an Attack (action_type A)');
      if (f.swap && n.action !== 'A') errs.push('swap rides on an Attack (action_type A)');
      if (f.altCounterSkill && !f.negate) errs.push('altCounterSkill needs negate');
      if (f.selfLock && ks.length === 1) errs.push('selfLock is a drawback — it needs a behaviour flag');
      if (f.trance && ks.length > 1) errs.push('trance combines with no other flag');
      if (n.extends != null && !cal.builtins?.[n.extends] && !BUILTIN_FLAGS[n.extends]) errs.push(`extends ${n.extends}: not a built-in`);
    }
  }
  return errs;
}
const isNegating = (f) => !!(f.negate || f.counterSkill || f.counterElement || f.damageOff || f.altCounterSkill || f.voidEmission || f.swap);

// ------------------------------------------------------------------ the duel (flags reading)
// One scenario: { c, d (stats of me, foe), X (my code or [X1, X2]), Y (foe code), dist (me ↔ foe, 1 or 2), ally
// (present), tgt ('me'|'ally', the foe's A/M aim), foeSkill, foeCast (booleans), die (my permanent's power or null) }.
// The ally (when present) is adjacent to both of us.
const statOf = (u, el, E) => u[E[el]];
function castSum(sc, pen, cal) {
  let s = 0;
  for (const el of cal.weights.ref_cast_elements) s += Math.max(0, statOf(sc.d, el, cal.elements) - (pen[el] || 0) - statOf(sc.c, el, cal.elements));
  return s;
}
export function flagsOutcome(sc, n, cal, withSkill) {
  const ED = cal.edge_dmg, f = withSkill ? n.flags : {};
  const inst = withSkill && !n.permanent, perm = withSkill && n.permanent;
  const near = sc.dist <= 1;
  let y = sc.Y, foeSkillLive = sc.foeSkill, negated = 0, noMove = false, job = false, spent = false, swapped = 0, voided = 0;
  const pen = {};
  if (inst && near && (f.counterSkill || f.counterElement)) {
    let stripped = false, best = null;
    if (f.counterSkill && foeSkillLive) { foeSkillLive = false; stripped = true; }
    if (f.counterElement && sc.foeCast) {
      const before = Math.round(castSum(sc, {}, cal) / 10);
      for (const el of [...new Set(cal.weights.ref_cast_elements)].sort()) {
        const amount = statOf(sc.c, el, cal.elements);
        if (!amount) continue;
        const saved = before - Math.round(castSum(sc, { [el]: amount }, cal) / 10);
        if (!best || saved > best.saved) best = { el, amount, saved };
      }
      if (best) pen[best.el] = best.amount;
    }
    if (stripped || best) job = true;
  }
  if (inst && near && f.voidEmission && (y === 'P' || y === 'EP') && sc.foeCast) { voided = 1; job = true; }
  if (inst && near && f.negate) {
    const hit = f.negate.codes.includes(y);
    // no_move: the foe stays put (peer.mjs adds every adjacent target to noMove; it only matters for M / EM)
    if (hit) { if (f.negate.mode === 'ep') y = 'EP'; else if (f.negate.mode === 'em') y = 'EM'; else noMove = true; negated++; foeSkillLive = false; job = true; }
    else if (f.altCounterSkill && foeSkillLive) { foeSkillLive = false; job = true; }
  }
  if (inst && near && f.swap) { swapped = 1; job = true; }
  // My code against the foe (Battle Trance: the option with the best dealt − taken, first on ties).
  let my = Array.isArray(sc.X) ? sc.X[0] : sc.X;
  if (inst && f.trance) {
    const eHits = y === 'A' && sc.tgt === 'me';
    const eAims = y === 'A' ? eHits : y === 'M' ? sc.tgt === 'me' : true;
    let best = -1, bestScore = -Infinity;
    sc.X.forEach((opt, i) => {
      const score = (opt === 'B' && !eHits ? 0 : ED[opt][y]) - (eAims ? ED[y][opt] : 0);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    my = sc.X[best];
  }
  const declared = Array.isArray(sc.X) ? null : sc.X;
  const protectedMe = perm && f.invincibleWhile && declared != null && f.invincibleWhile.includes(declared);
  const codeOf = (u) => (u === 'me' ? my : u === 'foe' ? y : 'EP');
  const aimOf = (u) => (u === 'me' ? 'foe' : u === 'foe' ? sc.tgt : null);
  const distOf = (a, b) => ((a === 'me' && b === 'foe') || (a === 'foe' && b === 'me') ? sc.dist : 1);
  const reachOf = (atk, code) => (atk === 'me' && perm && f.reach && code === 'A' ? f.reach : 1);
  const strike = (atk, code, def) => {
    if (distOf(atk, def) > reachOf(atk, code)) return 0;
    const defCode = codeOf(def);
    if (code === 'B') {
      if (!(defCode === 'A' && aimOf(def) === atk)) return 0;
      if (def === 'me' && perm && f.blockDenied && distOf(atk, def) <= 1) return 0;
    }
    let dmg = ED[code][defCode];
    if (code === 'A') {
      if (atk === 'me' && defCode === 'B' && perm && f.blockDenied && distOf(atk, def) <= 1) dmg = ED.A.EP;
      if (atk === 'me' && inst && f.attackBonus && dmg >= 1) dmg += f.attackBonus;
      if (atk === 'foe' && def !== 'me' && perm && f.tauntGuard && distOf('foe', 'me') <= 1) dmg = 0;
    }
    if (def === 'me' && perm) {
      if (f.immuneTo && f.immuneTo.includes(code)) dmg = 0;
      if (protectedMe) dmg = 0;
    }
    return dmg;
  };
  let dealt = 0, taken = 0, ally = 0;
  if (my === 'A' || my === 'M' || my === 'P' || my === 'B') dealt += strike('me', my, 'foe');
  if (y === 'A' || y === 'M') { const v = strike('foe', y, sc.tgt); if (sc.tgt === 'me') taken += v; else ally += v; }
  else if (y === 'P' || y === 'B') { taken += strike('foe', y, 'me'); if (sc.ally) ally += strike('foe', y, 'ally'); }
  if (inst && f.damageOff && taken > 0) { taken = Math.max(0, taken - f.damageOff); job = true; }
  if (sc.foeCast && !voided) {
    let s = castSum(sc, pen, cal);
    if (perm && f.effectShield && sc.die && Math.round(s / 10) > 0) { s = Math.max(0, s - sc.die); spent = true; }
    if (!protectedMe) taken += Math.round(s / 10);
  }
  return { dealt, taken, ally, negated, noMove: noMove && (sc.Y === 'M' || sc.Y === 'EM') ? 1 : 0, stripped: sc.foeSkill && !foeSkillLive ? 1 : 0, swapped, voided, job: job || spent };
}
const DIMS = ['dealt', 'taken', 'ally', 'negated', 'noMove', 'stripped', 'swapped', 'voided', 'job'];
// Higher = better for me on every dimension once taken/ally are negated.
const GOOD = { dealt: 1, taken: -1, ally: -1, negated: 1, noMove: 1, stripped: 1, swapped: 1, voided: 1, job: 1 };
function swingOf(o, W) { return o.dealt - o.taken - o.ally + W.negated_action * o.negated + W.deny_move * o.noMove + W.foe_skill_value * o.stripped + W.swap_value * o.swapped; }

// Scenario enumeration: me index i (with its die distribution), then the foes, codes, distance, aims, extras.
// Full mode: the flags reading uses the foe's stats (and my die) only through the foe's cast, so a scenario
// without a cast is emitted once per caster with the summed weight of all its foes (exact, 12× fewer).
// Seeded mode (the audit) keeps every scenario: the engine is not assumed to share that property; for a permanent
// it also spans every code of mine and both distances whatever the flags declare.
function seededFoe(i, P) { let j = (7 * i + 3) % P; if (j === i) j = (i + 1) % P; return j; }
function bestStat(c) { return [...STATS].sort((a, b) => c[b] - c[a])[0]; }
const keepShare = (n, cal) => (n.flags.invincibleWhile || []).reduce((s, c) => s + (cal.mix.self[c] || 0), 0);
function forEachScenario(n, cal, { seeded = false } = {}, cb) {
  const pool = cal.pool, P = pool.length, W = cal.weights, mixF = cal.mix.foe, mixS = cal.mix.self, codes = cal.codes;
  const xs = [];
  if (!n.permanent && n.flags.trance) { for (const a of codes) for (const b of codes) if (mixS[a] * mixS[b]) xs.push([[a, b], mixS[a] * mixS[b]]); }
  else if (!n.permanent) xs.push([n.action, 1]);
  else if (n.flags.invincibleWhile && !seeded) { const k = keepShare(n, cal); for (const a of codes) if (mixS[a] && n.flags.invincibleWhile.includes(a)) xs.push([a, mixS[a] / k]); }
  else for (const a of codes) if (mixS[a]) xs.push([a, mixS[a]]);
  // the audit always meets a permanent at both distances and with every code of mine, so a definition cannot hide
  // behaviour by not declaring the flag that would make the model look there (reach, the codes that keep it)
  const dists = n.permanent && (n.flags.reach || seeded) ? [[1, 1 - W.reach_rate], [2, W.reach_rate]] : [[1, 1]];
  for (let i = 0; i < P; i++) {
    const c = pool[i];
    const dies = !n.permanent ? [[null, 1]] : n.fixedPower ? [[n.fixedPower, 1]] : pointBuyStats(c[n.pointBuyStat === 'any' ? bestStat(c) : n.pointBuyStat]).dist;
    const foes = seeded ? [seededFoe(i, P)] : [...Array(P).keys()].filter(j => j !== i);
    for (const [die, pd] of dies) {
      const group = { i, die, pd, items: [] };
      for (const j of foes) for (const [X, px] of xs) for (const Y of codes) for (const [dist, pdist] of dists) {
        if (!mixF[Y]) continue;
        const merge = !seeded && j === foes[0];
        const casts = (Y === 'P' || Y === 'EP' ? [[true, W.foe_cast_rate], [false, 1 - W.foe_cast_rate]] : [[false, 1]])
          .filter(([fc]) => seeded || fc || merge);
        for (const [ally, pa] of [[true, W.ally_present], [false, 1 - W.ally_present]]) {
          const tgts = ally && (Y === 'A' || Y === 'M') ? [['me', 1 - W.ally_target_rate], ['ally', W.ally_target_rate]] : [['me', 1]];
          for (const [tgt, pt] of tgts) for (const [foeSkill, ps] of [[true, W.foe_skill_rate], [false, 1 - W.foe_skill_rate]]) for (const [foeCast, pc] of casts) {
            const w = px * mixF[Y] * pdist * pa * pt * ps * pc / (foeCast || seeded ? foes.length : 1);
            if (w) group.items.push([{ c, d: pool[j], ci: i, di: j, X, Y, dist, ally, tgt, foeSkill, foeCast, die }, w]);
          }
        }
      }
      cb(group);
    }
  }
}

// ------------------------------------------------------------------ the power model
export function powerOf(n, cal) {
  const W = cal.weights, K = W.cost, P = cal.pool.length;
  const f = n.flags;
  const comp = {};
  const add = (k, v) => { if (v) comp[k] = r6((comp[k] || 0) + v); };
  const parts = (wo, wi) => ({ dealt: wi.dealt - wo.dealt, prevented: wo.taken - wi.taken, ally_prevented: wo.ally - wi.ally, negation: W.negated_action * (wi.negated - wo.negated), move_denied: W.deny_move * (wi.noMove - wo.noMove), skills_stripped: W.foe_skill_value * (wi.stripped - wo.stripped), swap: W.swap_value * (wi.swapped - wo.swapped) });
  let pJob = 0, uses = 0, perUse = 0, retries = 0;
  const negating = isNegating(f);
  if (!n.permanent) {
    const acc = {}; let sumD = 0;
    forEachScenario(n, cal, {}, (g) => {
      for (const [sc, w0] of g.items) {
        const w = w0 / P;
        const wo = flagsOutcome(sc, n, cal, false), wi = flagsOutcome(sc, n, cal, true);
        const job = negating ? wi.job : (wi.taken < wo.taken || wi.dealt > wo.dealt);
        if (job) pJob += w;
        const pt = parts(wo, wi);
        for (const [k, v] of Object.entries(pt)) acc[k] = (acc[k] || 0) + w * v;
        sumD += w * (swingOf(wi, W) - swingOf(wo, W));
      }
    });
    const scale = f.negate?.who === 'adjacent' ? W.adjacent_foes : 1;
    for (const [k, v] of Object.entries(acc)) if (pJob > 0) add(k, v / pJob * scale);
    uses = pJob > 0 ? 1 : 0;
    perUse = pJob > 0 ? sumD / pJob * scale : 0;
  } else {
    const k = keepShare(n, cal);
    const keepRun = f.invincibleWhile ? (k < 1 ? k / (1 - k) : Infinity) : Infinity;
    forEachScenario(n, cal, {}, (g) => {
      // group = one caster × one power die: E[Δ | die], P(use | die), lifetime L(die)
      const L = Math.min(W.perm_lifetime_actions * g.die / 6, keepRun);
      const acc = {}; let pu = 0, sumD = 0;
      for (const [sc, w] of g.items) {
        const wo = flagsOutcome(sc, n, cal, false), wi = flagsOutcome(sc, n, cal, true);
        const d = swingOf(wi, W) - swingOf(wo, W);
        if (d !== 0 || wi.job) pu += w;
        sumD += w * d;
        const pt = parts(wo, wi);
        for (const [kk, v] of Object.entries(pt)) acc[kk] = (acc[kk] || 0) + w * v;
      }
      // single use (Force Shield): min(1, p_use·L) uses of E[Δ | use]; otherwise E[Δ] per action × L
      const factor = f.effectShield ? (pu > 0 ? Math.min(1, pu * L) / pu : 0) : L;
      const wt = g.pd / P;
      for (const [kk, v] of Object.entries(acc)) add(kk, v * factor * wt);
      uses += (f.effectShield ? Math.min(1, pu * L) : pu * L) * wt;
      perUse += sumD * factor * wt;
      // constant riders outside the duel, per relevant action of the lifetime
      if (f.trapImmune) add('traps_avoided', cal.mix.self.A * W.trap_avoid_per_attack * L * wt);
      if (f.invincibleWhile) add('perms_protected', W.protect_perms_per_rest * L * wt);
    });
    if (!n.fixedPower) {
      let rs = 0;
      for (const c of cal.pool) { const pb = pointBuyStats(c[n.pointBuyStat === 'any' ? bestStat(c) : n.pointBuyStat]); rs += (1 - pb.p) / pb.p; }
      retries = rs / P;
    }
    if (uses > 0) perUse = perUse / uses;
  }
  const value = r6(Object.values(comp).reduce((a, b) => a + b, 0));
  const wait = n.permanent ? 0 : (pJob > 0 ? Math.min(K.wait_cap, (1 - pJob) / pJob) : K.wait_cap);
  // self-lock (Powerful Attack): the rest of the round (on average (actions_per_round − 1)/2 actions) may only use
  // the allowed codes — each such action costs locked_action × the share of the codes it forbids.
  const lock = f.selfLock ? K.locked_action * ((W.actions_per_round - 1) / 2) * (1 - f.selfLock.codes.reduce((s, c) => s + (cal.mix.self[c] || 0), 0)) : 0;
  const actions = r6(K.card + K.wait * wait + (f.trance ? K.extra_card : 0) + (n.permanent ? K.permanent + K.pointbuy_retry * retries : 0) + lock);
  return {
    value, components: comp,
    uses: r6(uses), per_use: r6(perUse), p_job: n.permanent ? null : r6(pJob),
    cost: { card: K.card, wait: r6(K.wait * wait), extra_card: f.trance ? K.extra_card : 0, permanent: n.permanent ? K.permanent : 0, retries: r6(retries), self_lock: r6(lock), actions },
  };
}
const expected = (fit, C) => r6(fit.a + fit.b * C);
function ratioOf(pw, fit) { const e = expected(fit, pw.cost.actions); return { expected: e, ratio: r6(e > 0.05 ? pw.value / e : pw.value / 0.05) }; }

// ------------------------------------------------------------------ mutations (suggested tuning)
function clone(n) { return JSON.parse(JSON.stringify(n)); }
// dir: +1 = the skill can do strictly more, −1 = strictly less, 0 = sideways (rider / stat). A nerf is only
// offered dir ≤ 0 changes and a boost dir ≥ 0 ones — an instant's value is per consumed card, so widening its
// trigger can lower the ratio (it fires on weaker chances), but "do more" is never a nerf.
function mutations(n) {
  const out = [];
  const m = (change, dir, fn) => { const c = clone(n); fn(c); out.push({ change, dir, norm: c }); };
  const f = n.flags;
  const many = Object.keys(f).length > 1;
  for (const a of CODES4) if (a !== n.action) m(`rides on ${a} instead of ${n.action}`, 0, c => { c.action = a; });
  if (f.attackBonus) { if (f.attackBonus > 1) m(`attackBonus ${f.attackBonus} → ${f.attackBonus - 1}`, -1, c => { c.flags.attackBonus--; }); m(`attackBonus ${f.attackBonus} → ${f.attackBonus + 1}`, 1, c => { c.flags.attackBonus++; }); }
  if (f.selfLock) m('no self-lock', 1, c => { delete c.flags.selfLock; });
  else if (f.attackBonus || f.damageOff || f.negate) m('locks you to Attack for the rest of the round', -1, c => { c.flags.selfLock = { codes: ['A'], until: 'end_of_round' }; });
  if (f.damageOff) { if (f.damageOff > 1) m(`damageOff ${f.damageOff} → ${f.damageOff - 1}`, -1, c => { c.flags.damageOff--; }); m(`damageOff ${f.damageOff} → ${f.damageOff + 1}`, 1, c => { c.flags.damageOff++; }); }
  if (f.negate) {
    const all = NEGATE_CODES[f.negate.mode];
    if (f.negate.codes.length > 1) for (const x of f.negate.codes) m(`negates no longer ${x}`, -1, c => { c.flags.negate.codes = c.flags.negate.codes.filter(z => z !== x); });
    for (const x of all) if (!f.negate.codes.includes(x)) m(`negates ${x} too`, 1, c => { c.flags.negate.codes.push(x); });
    if (f.negate.who === 'target') m('negates every adjacent enemy', 1, c => { c.flags.negate.who = 'adjacent'; });
    else m('negates the target only', -1, c => { c.flags.negate.who = 'target'; });
    if (f.altCounterSkill) m('no alternative skill counter', -1, c => { delete c.flags.altCounterSkill; });
    else m('alternative: counters a skill when nothing is negated', 1, c => { c.flags.altCounterSkill = true; });
  }
  if (f.voidEmission && many) m('no longer voids the emission', -1, c => { delete c.flags.voidEmission; });
  if (f.swap && many) m('no swap', -1, c => { delete c.flags.swap; });
  if (f.counterSkill && f.counterElement) { m('no element counter', -1, c => { delete c.flags.counterElement; }); m('no skill counter', -1, c => { delete c.flags.counterSkill; }); }
  else if (f.counterSkill) m('also counters an element of the cast', 1, c => { c.flags.counterElement = true; });
  else if (f.counterElement) m('also counters the skills', 1, c => { c.flags.counterSkill = true; });
  if (f.immuneTo) {
    if (f.immuneTo.length > 1) for (const x of f.immuneTo) m(`no longer immune to ${x}`, -1, c => { c.flags.immuneTo = c.flags.immuneTo.filter(z => z !== x); });
    for (const x of CODES4) if (!f.immuneTo.includes(x)) m(`immune to ${x} too`, 1, c => { c.flags.immuneTo.push(x); });
  }
  if (f.invincibleWhile) {
    if (f.invincibleWhile.length > 1) for (const x of f.invincibleWhile) m(`${x} ends the protection`, -1, c => { c.flags.invincibleWhile = c.flags.invincibleWhile.filter(z => z !== x); });
    for (const x of CODES6) if (!f.invincibleWhile.includes(x) && f.invincibleWhile.length < 5) m(`${x} keeps the protection too`, 1, c => { c.flags.invincibleWhile.push(x); });
  }
  if (f.reach) { if (f.reach > 2) m(`reach ${f.reach} → ${f.reach - 1}`, -1, c => { c.flags.reach--; }); m(`reach ${f.reach} → ${f.reach + 1}`, 1, c => { c.flags.reach++; }); }
  if (f.tauntGuard && many) m('no longer guards the allies', -1, c => { delete c.flags.tauntGuard; });
  if (f.blockDenied && many) m('enemies may Block you again', -1, c => { delete c.flags.blockDenied; });
  if (f.trapImmune && many) m('no trap immunity', -1, c => { delete c.flags.trapImmune; });
  if (n.permanent) {
    for (const s of [...STATS, 'any']) if (s !== n.pointBuyStat) m(`point-buy stat ${n.pointBuyStat} → ${s}`, 0, c => { c.pointBuyStat = s; });
    if (n.fixedPower) { if (n.fixedPower > 1) m(`fixed power ${n.fixedPower} → ${n.fixedPower - 1}`, -1, c => { c.fixedPower--; }); if (n.fixedPower < 6) m(`fixed power ${n.fixedPower} → ${n.fixedPower + 1}`, 1, c => { c.fixedPower++; }); m('rolled power (point-buy) instead of fixed', 0, c => { c.fixedPower = null; }); }
  }
  return out;
}
function patchOf(n0, n1) {
  const p = {};
  if (n0.action !== n1.action) p.action_type = n1.action;
  if (n0.pointBuyStat !== n1.pointBuyStat) p.point_buy_stat = n1.pointBuyStat === 'any' ? 'any' : `stat_${n1.pointBuyStat}`;
  if (n0.fixedPower !== n1.fixedPower) p.fixed_power = n1.fixedPower;
  if (canonicalJson(n0.flags) !== canonicalJson(n1.flags)) p.flags = n1.flags;
  return p;
}

// ------------------------------------------------------------------ checkSkill
export function checkSkill(def, opts = {}) {
  const cal = opts.calibration || loadCalibration();
  const pin = computePin(cal);
  const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : (Number.isFinite(cal.policy.tolerance) ? cal.policy.tolerance : DEFAULT_TOLERANCE);
  const n = normalizeDef(def);
  const def_sha256 = sha256(canonicalJson(def));
  const base = { validator: { version: VALIDATOR_VERSION, pin_id: pin.pin_id }, skill_id: n.id ?? null, def_sha256, tolerance: tol };
  const stamp = (verdict, ratio) => ({ skill_id: n.id ?? null, def_sha256, pin_id: pin.pin_id, verdict, ratio, tolerance: tol });
  const errors = validateNorm(n, cal);
  if (errors.length) return { ...base, valid: false, errors, verdict: 'reject', reasons: ['invalid definition'], suggestions: [], stamp: stamp('reject', null) };
  if (!cal.fit) throw new Error('calibration has no fit — run `node tools/skills-rebalancing-check.mjs calibrate --write`');
  const audit = auditLogic(def, n, cal);
  if (audit.fatal || audit.exceeds?.length) {
    const why = audit.exceeds?.length ? audit.exceeds.map(x => `logic exceeds its declared flags — ${x}`) : [audit.why];
    return { ...base, valid: true, errors: [], audit: { ...audit, scenarios: undefined }, verdict: 'reject', reasons: why, suggestions: [], stamp: stamp('reject', null) };
  }
  const pw = powerOf(n, cal);
  const { expected: exp, ratio } = ratioOf(pw, cal.fit);
  let baseline = null;
  let bref = opts.baseline;
  if (bref === undefined) bref = cal.builtins?.[n.id] ? n.id : (n.extends && cal.builtins?.[n.extends] ? n.extends : null);
  if (typeof bref === 'string') {
    const b = cal.builtins?.[bref];
    if (!b) return { ...base, valid: false, errors: [`baseline ${bref} is not a calibrated built-in`], verdict: 'reject', reasons: ['bad baseline'], suggestions: [], stamp: stamp('reject', null) };
    baseline = { id: bref, value: b.value, actions: b.actions, ratio: b.ratio };
  } else if (isObj(bref)) {
    const bn = normalizeDef(bref), be = validateNorm(bn, cal);
    if (be.length) return { ...base, valid: false, errors: be.map(e => `baseline: ${e}`), verdict: 'reject', reasons: ['bad baseline'], suggestions: [], stamp: stamp('reject', null) };
    const bp = powerOf(bn, cal);
    baseline = { id: bn.id, value: bp.value, actions: bp.cost.actions, ratio: ratioOf(bp, cal.fit).ratio };
  }
  const judged = baseline ? r6(ratio / Math.max(1e-6, baseline.ratio)) : ratio;
  const bv = bandVerdict(judged, tol, cal.policy.hard_cap_ratio, cal.policy.hard_floor_ratio, baseline ? 'baseline' : 'cost curve');
  const { verdict, lo, hi } = bv;
  const reasons = [bv.reason];
  const suggestions = [];
  if (verdict !== 'ok') {
    const want = judged > 1 ? -1 : 1;
    const target = baseline ? baseline.ratio : 1;
    const cands = mutations(n).filter(mu => mu.dir * want >= 0).map(mu => {
      if (validateNorm(mu.norm, cal).length) return null;
      const p2 = powerOf(mu.norm, cal), rr = ratioOf(p2, cal.fit).ratio, j = r6(rr / target);
      return { change: mu.change, value: p2.value, actions: p2.cost.actions, ratio: j, in_band: j >= lo && j <= hi, patch: patchOf(n, mu.norm) };
    }).filter(c => c && Math.sign(c.ratio - judged) === want);
    const inBand = cands.filter(c => c.in_band).sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1) || a.change.localeCompare(b.change));
    const rest = cands.filter(c => !c.in_band).sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1) || a.change.localeCompare(b.change));
    suggestions.push(...inBand.slice(0, 3), ...(inBand.length ? [] : rest.slice(0, 2)));
    const goalV = baseline ? baseline.ratio * exp : exp;
    suggestions.push({ change: `scale the outcome ×${r3(goalV / Math.max(1e-6, pw.value))} (to ${r3(goalV)})`, kind: 'hint' });
    if (cal.fit.b > 0) {
      const C2 = (pw.value / (baseline ? baseline.ratio : 1) - cal.fit.a) / cal.fit.b;
      if (C2 > 0) suggestions.push({ change: `cost ${r3(pw.cost.actions)} → ${r3(C2)} card-actions (${C2 >= pw.cost.actions ? '+' : ''}${r3(C2 - pw.cost.actions)})`, kind: 'hint' });
      else suggestions.push({ change: `no cost reaches the curve (value ${r3(pw.value)} is below the curve's intercept ${cal.fit.a}) — the outcome must grow`, kind: 'hint' });
    }
  }
  return {
    ...base, valid: true, errors: [],
    mode: baseline ? 'baseline' : 'curve',
    power: { value: pw.value, components: pw.components, uses: pw.uses, per_use: pw.per_use, p_job: pw.p_job, cost: pw.cost, expected: exp, ratio },
    baseline, judged_ratio: judged, band: { low: lo, high: hi, hard_cap: cal.policy.hard_cap_ratio, hard_floor: cal.policy.hard_floor_ratio },
    audit: audit.ran ? { ran: true, engine: audit.engine, runs: audit.runs, N: audit.N, identical: audit.identical, exceeds: [] } : { ran: false, why: audit.why },
    verdict, reasons, suggestions, stamp: stamp(verdict, judged),
  };
}

// ------------------------------------------------------------------ built-ins + calibration
// Built-ins = data/skills.json active versions + BUILTIN_FLAGS. With { prefer: 's2' } a definition file
// game/skills-data/skills/<id>.json replaces it when present and its validator flags are understood.
export async function loadBuiltinDefs({ prefer = 'data' } = {}) {
  const j = readJson(path.join(ROOT, 'data', 'skills.json'));
  const cal = loadCalibration();
  const defs = [];
  let s2 = 0;
  for (const e of [...j.entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const v = activeVersionOf(e);
    if (!v || !BUILTIN_FLAGS[e.id]) continue;
    const file = path.join(DEFS_DIR, `${e.id}.json`);
    if (prefer === 's2' && fs.existsSync(file)) {
      const d = readJson(file);
      if (!validateNorm(normalizeDef(d), cal).length) { defs.push(d); s2++; continue; }
    }
    defs.push({ id: e.id, version: v.version, action_type: v.data.action_type, is_permanent: !!v.data.is_permanent, point_buy_stat: v.data.point_buy_stat ?? null, ...(v.data.fixed_power != null ? { fixed_power: v.data.fixed_power } : {}), flags: JSON.parse(JSON.stringify(BUILTIN_FLAGS[e.id])) });
  }
  return { source: `data/skills.json + skills-rebalancing-check.mjs BUILTIN_FLAGS${s2 ? ` (${s2} from game/skills-data/skills)` : ''}`, defs };
}
export async function calibrate(cal = loadCalibration()) {
  const { source, defs } = await loadBuiltinDefs();
  const rows = [];
  for (const d of defs) {
    const n = normalizeDef(d), errs = validateNorm(n, { ...cal, builtins: {} });
    if (errs.length) { rows.push({ id: d.id, errors: errs }); continue; }
    const pw = powerOf(n, cal);
    rows.push({ id: n.id, V: pw.value, C: pw.cost.actions, pw });
  }
  const fit = fitCurve(rows.filter(r => !r.errors), { drop: cal.policy.fit_drop, minKeep: cal.policy.fit_min_keep });
  const builtins = {}, outliers = [];
  for (const r of rows.filter(x => !x.errors)) {
    const { ratio } = ratioOf(r.pw, fit);
    const v = bandVerdict(ratio, cal.policy.tolerance, cal.policy.hard_cap_ratio, cal.policy.hard_floor_ratio).verdict;
    builtins[r.id] = { value: r.V, actions: r.C, ratio, curve_verdict: v, uses: r.pw.uses, per_use: r.pw.per_use };
    if (v !== 'ok') outliers.push({ id: r.id, ratio, curve_verdict: v });
  }
  outliers.sort((a, b) => b.ratio - a.ratio || a.id.localeCompare(b.id));
  return { source, fit, builtins, known_outliers: outliers, errors: rows.filter(r => r.errors) };
}

// ------------------------------------------------------------------ logic audit (game/skills.mjs)
// The same scenario through the engine, in the order of peer.mjs simulate(). `run` = { id, H } — the skill id the
// engine knows it by and how a hook is answered: skillHook (a built-in's hooks) or resolveSkillProgram (the def's
// own programs, std defaults for the rest).
const FOE_RIDER = 'skill_foe_rider';
function engineOutcome(sc, n, cal, withSkill, run) {
  const ED = cal.edge_dmg, E = cal.elements, runId = run.id;
  const inst = withSkill && !n.permanent, held = withSkill && n.permanent ? runId : null;
  const view = (id, s) => ({ peer_id: id, life: 4, stat_vitality: s.vitality, stat_world: s.world, stat_matter: s.matter, stat_will: s.will });
  const views = { me: view('me', sc.c), foe: view('foe', sc.d), ...(sc.ally ? { ally: view('ally', sc.c) } : {}) };
  const trance = inst && n.flags.trance && Array.isArray(sc.X);
  const myCode = Array.isArray(sc.X) ? sc.X[0] : sc.X;
  const meR = { actor: 'me', action: myCode, declared: Array.isArray(sc.X) ? undefined : sc.X, skills: inst ? [runId] : [], target: { kind: 'character', ref: 'foe' }, effect: null };
  if (trance) meR.trance = [...sc.X];
  const foeR = { actor: 'foe', action: sc.Y, declared: sc.Y, skills: sc.foeSkill ? [FOE_RIDER] : [], target: { kind: 'character', ref: sc.tgt }, effect: sc.foeCast ? { elements: [...cal.weights.ref_cast_elements], is_instant: false } : null };
  const allyR = { actor: 'ally', action: 'EP', declared: 'EP', skills: [], target: null, effect: null };
  const reveals = sc.ally ? [meR, foeR, allyR] : [meR, foeR];
  const byActorPre = new Map(reveals.map(r => [r.actor, r]));
  const effAction = new Map(reveals.map(r => [r.actor, r.action]));
  const tranceOpts = new Map();
  if (trance) tranceOpts.set('me', [...sc.X]);
  const side = { me: 'a', ally: 'a', foe: 'b' };
  const counterPen = new Map();
  const pbs = n.pointBuyStat == null ? null : n.pointBuyStat === 'any' ? 'any' : `stat_${n.pointBuyStat}`;
  const ctx = {
    self: 'me', label: 'srbc', log: () => {}, reveals, byActorPre, effAction, tranceOpts, noMove: new Set(), counterPen, skillFx: [],
    noEmit: new Set(), swaps: [],
    codeIs: (id, c) => tranceOpts.has(id) ? tranceOpts.get(id).includes(c) : effAction.get(id) === c,
    replace: (id, from, to) => { const o = tranceOpts.get(id); if (o) { for (let i = 0; i < o.length; i++) if (o[i] === from) o[i] = to; } else if (effAction.get(id) === from) effAction.set(id, to); },
    enemyOf: (a, b) => side[a] !== side[b], hiddenFrom: () => false, lifeOf: () => 4,
    dist: (a, b) => ((a === 'me' && b === 'foe') || (a === 'foe' && b === 'me') ? sc.dist : a === b ? 0 : 1),
    view: (id) => views[id], viewValues: () => Object.values(views), elemStat: (el) => E[el],
    hasPerm: (id, p) => id === 'me' && held === p, permPower: (id) => (id === 'me' && held ? { [held]: sc.die } : {}),
    castsDamage: (o) => !!o?.effect,
    effectDmgNoShield: (o, def) => {
      const pen = counterPen.get(o.actor) || {}, a = views[o.actor], dv = views[def];
      let s = 0;
      for (const el of o.effect.elements) s += Math.max(0, a[`stat_${E[el]}`] - (pen[el] || 0) - dv[`stat_${E[el]}`]);
      return Math.round(s / 10);
    },
    skillData: (id) => (id === runId ? { action_type: n.action, is_permanent: n.permanent, point_buy_stat: pbs, ...(n.fixedPower ? { fixed_power: n.fixedPower } : {}) } : id === FOE_RIDER ? { action_type: sc.Y, is_permanent: false, point_buy_stat: null } : undefined),
    edgeDmg: (a, d) => ED[a][d],
  };
  const H = (name, id, args) => run.H(name, id, ctx, args);
  H('counter_pre', null); H('negate_action', null); H('negate_kind', null);
  // byActor: the reveals after the prohibitions (codes as rewritten)
  for (const r of reveals) { if (tranceOpts.has(r.actor)) r.trance = tranceOpts.get(r.actor); else r.action = effAction.get(r.actor); }
  const byActor = new Map(reveals.map(r => [r.actor, r]));
  const codeVs = (id, other) => { const r = byActor.get(id); if (!r) return 'EP'; if (!r.trance) return r.action; const idx = r.vs?.get(other) ?? (r.played ? [...r.played][0] : 0); return r.trance[idx]; };
  const attacksOn = (r, victim) => {
    if (!r) return false;
    const declared = r.target?.kind === 'character' && r.target.ref === victim;
    if (!r.trance) return r.action === 'A' && declared;
    const idx = r.vs?.get(victim);
    if (idx !== undefined) return r.trance[idx] === 'A';
    return !r.vs && declared && r.trance.includes('A');
  };
  if (meR.trance) H('trance_assign', null, { byActor, codeVs, attacksOn });
  const damage = new Map();
  const addDmg = (def, atk, amount) => { if (!damage.has(def)) damage.set(def, []); damage.get(def).push({ source: 'action', amount, attacker: atk }); };
  const strike = (r, code, defId) => {
    if (!ctx.enemyOf(r.actor, defId)) return;
    if (ctx.dist(r.actor, defId) > H('attack_range', 'skill_ranged_weapon', { attacker: r.actor, code })) return;
    let defCode = codeVs(defId, r.actor);
    if (code === 'B') {
      if (defCode !== 'A' || !attacksOn(byActor.get(defId), r.actor)) return;
      if (H('block_in', null, { defender: defId, blocker: r.actor })) return;
    }
    if (code === 'A' && defCode === 'B' && H('attack_vs_block', 'skill_taunt', { attacker: r.actor, defender: defId })) defCode = 'EP';
    let dmg = ED[code][defCode];
    if (code === 'A') {
      dmg = H('attack_out', 'skill_powerful_attack', { attacker: r.actor, dmg });
      if (H('attack_target', 'skill_taunt', { attacker: r.actor, defender: defId })) dmg = 0;
    }
    dmg = H('defend_in', null, { code, defender: defId, dmg, byActor });
    addDmg(defId, r.actor, dmg);
  };
  const enemyRevealers = (r) => reveals.filter(o => o.actor !== r.actor && ctx.enemyOf(r.actor, o.actor)).map(o => o.actor);
  for (const r of reveals) {
    if (r.trance) { for (const [e, idx] of [...(r.vs || new Map())].sort((x, y) => x[0].localeCompare(y[0]))) strike(r, r.trance[idx], e); continue; }
    const t = r.target?.kind === 'character' ? r.target.ref : null;
    if (r.action === 'A' || r.action === 'M') { if (t) strike(r, r.action, t); }
    else if (r.action === 'P' || r.action === 'B') for (const e of enemyRevealers(r)) strike(r, r.action, e);
  }
  H('damage_in', null, { damage });
  const sum = (id) => (damage.get(id) || []).reduce((a, d) => a + d.amount, 0);
  let eff = 0, spent = false;
  const voided = foeR.effect && ctx.noEmit.has('foe') ? 1 : 0;
  if (foeR.effect && !voided) {
    const pen = counterPen.get('foe') || {};
    let s = 0;
    for (const el of foeR.effect.elements) s += Math.max(0, views.foe[`stat_${E[el]}`] - (pen[el] || 0) - views.me[`stat_${E[el]}`]);
    const shield = H('effect_in', 'skill_force_shield', { defender: 'me' });
    const leg = H('effect_leg', 'skill_force_shield', { shield, sum: s });
    if (leg.spent) spent = true;
    eff = H('defend_in', null, { code: 'effect', defender: 'me', dmg: Math.round(leg.sum / 10), byActor });
  }
  const fxMine = ctx.skillFx.filter(fx => fx.by === 'me');
  return {
    dealt: sum('foe'), taken: sum('me') + eff, ally: sum('ally'),
    negated: fxMine.filter(fx => fx.negated).length,
    noMove: ctx.noMove.has('foe') && (sc.Y === 'M' || sc.Y === 'EM') ? 1 : 0,
    stripped: sc.foeSkill && !foeR.skills.includes(FOE_RIDER) ? 1 : 0,
    swapped: ctx.swaps.some(s => s.by === 'me') ? 1 : 0,
    voided,
    job: fxMine.some(fx => fx.skill === runId) || spent,
  };
}
// Audit: on the seeded duels (each pool caster vs one fixed foe, every code / distance / aim / extra / die) the
// executed behaviour may not do MORE than the declared flags on any dimension (weighted means, slack
// audit_slack), and its plan_lock may not be looser than flags.selfLock. Doing less is allowed (priced as the
// flags: the author's loss).
const _audits = new Map();
export function auditLogic(def, n, cal = loadCalibration()) {
  // memoised per (definition, calibration) — the result is a pure function of both and of the loaded engine
  const key = sha256(canonicalJson({ def, n, cal: sha256(canonicalJson(cal)) }));
  if (!_audits.has(key)) _audits.set(key, auditUncached(def, n, cal));
  return JSON.parse(JSON.stringify(_audits.get(key)));
}
function auditUncached(def, n, cal) {
  if (cal.policy.audit === false) return { ran: false, why: 'audit disabled by the calibration policy' };
  if (!SK?.skillHook) return n.hasLogic || n.hasProgram ? { ran: false, fatal: true, why: 'game/skills.mjs missing — a skill program cannot be audited' } : { ran: false, why: 'game/skills.mjs missing (audit skipped)' };
  const rules = SK.SKILL_RULES || {};
  const builtinRun = rules[n.id] && BUILTIN_FLAGS[n.id] ? n.id : (n.extends && rules[n.extends] ? n.extends : null);
  let run;
  if (n.hasProgram) {
    const R = programEngine();
    if (!R) return { ran: false, fatal: true, why: 'the definition carries hook programs, but game/skills.mjs has no resolveSkillProgram' };
    if (SK.validateSkillDef) {
      const errs = SK.validateSkillDef(def);
      if (errs.length) return { ran: false, fatal: true, why: `skill program invalid: ${errs.join('; ')}` };
    }
    run = { id: n.id, H: (name, _id, ctx, args) => R(def, name, ctx, args), engine: `game/skills.mjs#resolveSkillProgram (${n.id}'s programs)` };
  } else if (builtinRun) {
    run = { id: builtinRun, H: (name, id, ctx, args) => SK.skillHook(name, id, ctx, args), engine: `game/skills.mjs hooks of ${builtinRun}` };
  } else if (n.hasLogic) {
    return { ran: false, fatal: true, why: 'the definition carries a bare logic block (no hook programs) and is no built-in / extends none — nothing executes it, so it cannot be proven to do no more than its flags' };
  } else return { ran: false, why: 'no executable behaviour: not a built-in and extends none (flags-only foreign skill — runs nothing until it carries hook programs)' };
  const slack = cal.policy.audit_slack ?? 0.02;
  const negating = isNegating(n.flags);
  const tot = { flags: {}, engine: {} };
  let N = 0, identical = true;
  const diffs = [];
  try {
    forEachScenario(n, cal, { seeded: true }, (g) => {
      for (const [sc, w0] of g.items) {
        const w = w0 * g.pd / cal.pool.length;
        const fo = flagsOutcome(sc, n, cal, true), fwo = flagsOutcome(sc, n, cal, false);
        const eo = engineOutcome(sc, n, cal, true, run), ewo = engineOutcome(sc, n, cal, false, run);
        if (!n.permanent && !negating) { fo.job = fo.taken < fwo.taken || fo.dealt > fwo.dealt; eo.job = eo.taken < ewo.taken || eo.dealt > ewo.dealt; }
        N++;
        for (const k of DIMS) { tot.flags[k] = (tot.flags[k] || 0) + w * fo[k]; tot.engine[k] = (tot.engine[k] || 0) + w * eo[k]; }
        if (canonicalJson(fo) !== canonicalJson(eo) || canonicalJson(fwo) !== canonicalJson(ewo)) { identical = false; if (diffs.length < 5) diffs.push({ scenario: { me: sc.ci, foe: sc.di, X: sc.X, Y: sc.Y, dist: sc.dist, ally: sc.ally, tgt: sc.tgt, foeSkill: sc.foeSkill, foeCast: sc.foeCast, die: sc.die }, flags: fo, engine: eo }); }
      }
    });
  } catch (e) {
    return { ran: false, fatal: true, why: `the engine threw on a seeded duel: ${e.message || e}` };
  }
  const mean = (o) => Object.fromEntries(DIMS.map(k => [k, r6(o[k] || 0)]));
  const flags = mean(tot.flags), engine = mean(tot.engine);
  const exceeds = [];
  for (const k of DIMS) { const g = GOOD[k] * (engine[k] - flags[k]); if (g > slack * (1 + Math.abs(flags[k]))) exceeds.push(`${k}: ${run.engine} ${engine[k]} vs flags ${flags[k]}`); }
  // plan_lock (Powerful Attack): the engine's lock after a paid-off play must be at least as tight as the flags'.
  let lock = null;
  if (!n.permanent) {
    const lctx = { self: 'me', reveals: [], skillData: () => undefined };
    try { lock = run.H('plan_lock', run.id, lctx, { paid: true }); } catch { lock = null; }
    if (!Array.isArray(lock)) lock = null;
    const want = n.flags.selfLock?.codes || null;
    if (want && (!lock || lock.some(c => !want.includes(c)))) exceeds.push(`plan_lock: ${run.engine} locks to ${lock ? `[${lock.join(',')}]` : 'nothing'} vs flags selfLock [${want.join(',')}]`);
    if (!want && lock) identical = false;
  }
  return { ran: true, engine: run.engine, runs: run.id, N, identical, exceeds, flags, program: engine, plan_lock: lock, diffs };
}

// ------------------------------------------------------------------ CLI
async function cli(argv) {
  const [cmd, ...rest] = argv;
  const flags = {}; const args = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nx = rest[i + 1]; if (nx !== undefined && !nx.startsWith('--') && ['baseline', 'tolerance', 'write'].includes(k)) { flags[k] = nx; i++; } else flags[k] = true; }
    else args.push(a);
  }
  const readDef = async (ref) => {
    if (fs.existsSync(ref)) return readJson(ref);
    const { defs } = await loadBuiltinDefs({ prefer: 's2' });
    const d = defs.find(x => x.id === ref || x.id === `skill_${ref}`);
    if (!d) throw new Error(`no file or built-in skill ${ref}`);
    return d;
  };
  if (cmd === 'check') {
    if (!args[0]) throw new Error('check <def.json|skill_id>');
    const def = await readDef(args[0]);
    const opts = {};
    if (flags.tolerance !== undefined) opts.tolerance = Number(flags.tolerance);
    if (typeof flags.baseline === 'string') opts.baseline = fs.existsSync(flags.baseline) ? readJson(flags.baseline) : flags.baseline;
    if (flags['no-baseline']) opts.baseline = null;
    const res = checkSkill(def, opts);
    if (flags.json) { console.log(JSON.stringify(res, null, 2)); return res.verdict === 'reject' ? 1 : 0; }
    console.log(`${res.skill_id}: VERDICT ${res.verdict.toUpperCase()}  (skills validator ${VALIDATOR_VERSION}, pin ${res.validator.pin_id.slice(0, 12)})`);
    if (!res.valid) { for (const e of res.errors) console.log(`  ✗ ${e}`); return 1; }
    const p = res.power;
    if (p) {
      console.log(`  value ${p.value} (uses ${p.uses} × ${p.per_use}${p.p_job != null ? `, p_job ${p.p_job}` : ''})  cost ${p.cost.actions} card-actions  curve ${p.expected}  ratio ${p.ratio}`);
      console.log(`  components: ${Object.entries(p.components).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    if (res.baseline) console.log(`  baseline ${res.baseline.id}: ratio ${res.baseline.ratio} → judged ${res.judged_ratio}`);
    console.log(`  audit: ${res.audit?.ran ? `${res.audit.engine}, ${res.audit.N} duels, ${res.audit.identical ? 'identical to the flags' : 'within the flags'}` : res.audit?.why}`);
    for (const r of res.reasons) console.log(`  · ${r}`);
    for (const s of res.suggestions) console.log(`  → ${s.change}${s.ratio != null ? ` (ratio ${s.ratio}${s.in_band ? ', in band' : ''})` : ''}`);
    return res.verdict === 'reject' ? 1 : 0;
  }
  if (cmd === 'audit') {
    const def = await readDef(args[0]);
    const n = normalizeDef(def);
    const a = auditLogic(def, n);
    console.log(JSON.stringify(a, null, 2));
    return a.fatal || a.exceeds?.length ? 1 : 0;
  }
  if (cmd === 'report' || cmd === 'calibrate') {
    const cal = loadCalibration();
    const c = await calibrate(cal);
    if (cmd === 'calibrate' && flags.write) {
      const next = { ...cal, fit: c.fit, builtins: c.builtins, known_outliers: c.known_outliers, calibrated_from: c.source };
      fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(next, null, 2) + '\n');
      console.log(`calibration written: ${CALIBRATION_PATH}`);
    }
    if (flags.json) { console.log(JSON.stringify(c, null, 2)); return 0; }
    console.log(`source: ${c.source}\nfit: V = ${c.fit.a} + ${c.fit.b}·C  (${c.fit.n_fit}/${c.fit.n} built-ins in the fit)`);
    const rows = Object.entries(c.builtins).sort((a, b) => b[1].ratio - a[1].ratio);
    for (const [id, b] of rows) console.log(`  ${String(b.ratio).padStart(9)}  ${b.curve_verdict.padEnd(6)} ${id.padEnd(24)} V ${String(b.value).padStart(9)}  C ${String(b.actions).padStart(8)}  uses ${b.uses} × ${b.per_use}`);
    const cnt = {}; for (const [, b] of rows) cnt[b.curve_verdict] = (cnt[b.curve_verdict] || 0) + 1;
    console.log(`\nverdicts vs the curve (±${cal.policy.tolerance * 100}%): ${JSON.stringify(cnt)}`);
    for (const e of c.errors) console.log(`  invalid built-in ${e.id}: ${e.errors.join('; ')}`);
    return 0;
  }
  if (cmd === 'pin') {
    const pin = computePin();
    const txt = JSON.stringify(pin, null, 2) + '\n';
    if (typeof flags.write === 'string') { fs.mkdirSync(path.dirname(flags.write), { recursive: true }); fs.writeFileSync(flags.write, txt); console.log(`pin written: ${flags.write}`); }
    else process.stdout.write(txt);
    return 0;
  }
  console.log('usage: node tools/skills-rebalancing-check.mjs check <def.json|skill_id> [--baseline <id|file>] [--no-baseline] [--tolerance t] [--json]\n       | audit <def.json|skill_id> | report [--json] | calibrate [--write] | pin [--write <path>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  cli(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.stack || String(e)); process.exit(2); });
}
