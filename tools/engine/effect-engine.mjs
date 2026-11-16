// Data-driven effect engine (milestone E1 of the chaosD6-Effects program).
//
// An effect is a JSON definition (game/effects-data/effects/<id>.json, schema in
// game/effects-data/SCHEMA.md + effect.schema.json) whose `logic` is a program in a
// JsonLogic dialect. `resolveEffectData(def, ctx, cast)` runs it against the SAME
// `ctx` / `cast` that effects.mjs#resolveEffect gets and returns the SAME outcome
// object (status, hits, tokens, statTokens, locks, … rolls) — peer.mjs applies it
// unchanged. Shared building blocks live as subroutines in library files
// (game/effects-data/lib/<id>.json), themselves data.
//
// Guarantees:
//   • pure / deterministic: the only inputs are ctx (read-only queries), cast and the
//     definition; dice come from ctx.sha(seed) exactly like effects.mjs; there is no
//     clock, no Math.random, no I/O, no prototype access.
//   • bounded: every evaluated operation costs 1 from an op budget, nesting has a depth
//     limit, lists built by `range` are capped. Running out is a deterministic
//     outcome `{status: 'error', notes: ['effect engine: …']}` — never a hang.
//   • closed vocabulary: unknown operations are rejected at load (validateEffectDef).
//
// Node-18 compatible, no dependencies (the evaluator is our own so it can count ops;
// json-logic-js has a global op registry and no budget).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EFFECTS_DATA_DIR = path.join(here, 'effects-data');
export const EFFECT_SCHEMA_ID = 'chaosd6.effect/1';
export const LIB_SCHEMA_ID = 'chaosd6.effect-lib/1';
export const ENGINE_LIMITS = Object.freeze({ maxOps: 200000, maxDepth: 96, maxRange: 1024 });

// ------------------------------------------------------------ dice primitives
// Byte-for-byte the same maths as effects.mjs (diceCount / rollDice / pointBuy);
// tools/effect-engine-check.mjs compares them over thousands of seeds.
export function diceCount(stat) {
  let best = 1;
  for (let n = 1; n <= 4; n++) if (Math.abs(6 * n - stat) <= Math.abs(6 * best - stat)) best = n;
  return best;
}
export function rollDice(seed, n, sha256Hex) {
  const hex = sha256Hex(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push((parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 6) + 1);
  return out;
}
export function pointBuy(stat, seed, sha256Hex) {
  if (stat < 1) return { fail: false, dice: [], value: 0 };
  const dice = rollDice(seed, diceCount(stat), sha256Hex);
  const sum = dice.reduce((s, d) => s + d, 0);
  return sum > stat ? { fail: true, dice, value: 0 } : { fail: false, dice, value: Math.max(...dice) };
}
export const ALL_ELEMS = ['elem_vitality', 'elem_souls', 'elem_time', 'elem_space', 'elem_air', 'elem_water', 'elem_earth', 'elem_fire', 'elem_concentration', 'elem_harmony'];

// ------------------------------------------------------------ outcome model
// The building blocks peer.mjs applies (same keys, same order as effects.mjs).
export const OUTCOME_ARRAYS = ['hits', 'tokens', 'statTokens', 'locks', 'zones', 'heals', 'permanents', 'moves', 'voidFor', 'channels', 'traps', 'obstacles', 'links', 'pulls', 'relocations', 'peeks', 'notes', 'rolls'];
export const OUTCOME_SCALARS = ['status', 'shieldElem', 'disableElem', 'draw', 'every', 'kept', 'summon', 'possess', 'phantom'];
export const OUTCOME_STATUSES = ['done', 'casting', 'retry', 'fizzled', 'blocked', 'error'];
export function newOutcome() {
  return { status: 'done', hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, every: false, kept: null, summon: null, channels: [], traps: [], obstacles: [], links: [], pulls: [], relocations: [], peeks: [], possess: null, phantom: false, notes: [], rolls: [] };
}
// effects.mjs `emptied(status)`: nothing lands; status, every, kept, notes, rolls survive.
function emptied(out, status) {
  return { ...out, status, hits: [], tokens: [], statTokens: [], locks: [], zones: [], heals: [], permanents: [], moves: [], shieldElem: null, disableElem: null, voidFor: [], draw: 0, summon: null, channels: [], traps: [], obstacles: [], links: [], pulls: [], relocations: [], peeks: [], possess: null, phantom: false };
}

// ------------------------------------------------------------ evaluator
class Halt { constructor(out) { this.out = out; } }
export class EffectEngineLimit extends Error {}
export class EffectProgramError extends Error {}

const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const own = (o, k) => o !== null && typeof o === 'object' && !BAD_KEYS.has(k) && Object.prototype.hasOwnProperty.call(o, k);
const getPath = (v, parts) => { for (const p of parts) { if (!own(v, p)) return undefined; v = v[p]; } return v; };
// JsonLogic truthiness: [] is false (unlike JS), everything else as JS.
export const truthy = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
const num = (x) => Number(x);
const list = (x) => (Array.isArray(x) ? x : []);
const clone = (v) => (v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(clone) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])));

class Scope {
  constructor(parent, vars) { this.parent = parent; this.vars = new Map(Object.entries(vars || {})); }
  lookup(name) { for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s; return null; }
}

// ctx queries: name → (ctx, args) → value. Read-only; Sets come back as sorted arrays.
const CTX_OPS = {
  peers: (c) => [...c.peers()],
  stat_of: (c, [id, el]) => c.statFor(id, el),
  base_stat: (c, [id, sk]) => c.baseStat(id, sk),
  life_of: (c, [id]) => c.lifeOf(id),
  enemy_of: (c, [a, b]) => !!c.enemyOf(a, b),
  dist: (c, [a, b]) => c.dist(a, b),
  tile_of: (c, [id]) => c.tileOf(id) ?? null,
  is_free: (c, [q, r]) => !!c.isFree(q, r),
  neighbours: (c, [q, r]) => [...c.neighbours(q, r)],
  has_perm: (c, [id, p]) => !!c.hasPerm(id, p),
  shielded: (c, [id, el]) => !!c.shieldedAgainst(id, el),
  disabled_elems: (c, [id]) => [...c.disabledElems(id)].sort(),
  invisible: (c, [id]) => !!c.invisible(id),
  elem_stat: (c, [el]) => c.elemStat(el),
  threat_elem: (c, [id]) => c.threatElem(id),
  cast_elem_of: (c, [id]) => c.castElemOf(id),
  free_tiles_within: (c, [q, r, d]) => (c.freeTilesWithin ? [...c.freeTilesWithin(q, r, d)] : []),
  tile_tokens_at: (c, [q, r]) => (c.tileTokensAt ? [...c.tileTokensAt(q, r)] : []),
  traps_at: (c, [q, r]) => (c.trapsAt ? [...c.trapsAt(q, r)] : []),
  obstacle_at: (c, [q, r]) => (c.obstacleAt ? c.obstacleAt(q, r) || null : null),
  library: (c) => (c.library ? [...c.library()] : []),
  ctx_has: (c, [name]) => typeof c[name] === 'function',
  action_index: (c) => c.actionIndex,
};

// Eager pure ops: args are evaluated first. (Lazy special forms are in SPECIAL below.)
const PURE_OPS = {
  '==': ([a, b]) => a == b, '===': ([a, b]) => a === b, '!=': ([a, b]) => a != b, '!==': ([a, b]) => a !== b,
  '<': (a) => (a.length === 3 ? a[0] < a[1] && a[1] < a[2] : a[0] < a[1]),
  '<=': (a) => (a.length === 3 ? a[0] <= a[1] && a[1] <= a[2] : a[0] <= a[1]),
  '>': ([a, b]) => a > b, '>=': ([a, b]) => a >= b,
  '!': ([a]) => !truthy(a), '!!': ([a]) => truthy(a),
  '+': (a) => a.reduce((s, x) => s + num(x), 0),
  '-': (a) => (a.length === 1 ? -num(a[0]) : num(a[0]) - num(a[1])),
  '*': (a) => a.reduce((s, x) => s * num(x), 1),
  '/': ([a, b]) => num(a) / num(b), '%': ([a, b]) => num(a) % num(b),
  min: (a) => Math.min(...a.map(num)), max: (a) => Math.max(...a.map(num)),
  min_of: ([l]) => Math.min(...list(l).map(num)), max_of: ([l]) => Math.max(...list(l).map(num)),
  sum: ([l]) => list(l).reduce((s, x) => s + num(x), 0),
  round: ([x]) => Math.round(x), floor: ([x]) => Math.floor(x), ceil: ([x]) => Math.ceil(x), abs: ([x]) => Math.abs(x),
  round_div10: ([x]) => Math.round(x / 10),
  cat: (a) => a.reduce((s, x) => s + x, ''),
  join: ([l, sep]) => list(l).join(sep ?? ','),
  str: ([x]) => String(x),
  starts_with: ([s, p]) => String(s).startsWith(String(p)),
  in: ([x, h]) => (typeof h === 'string' ? h.indexOf(x) !== -1 : list(h).includes(x)),
  includes: ([h, x]) => (typeof h === 'string' ? h.includes(x) : list(h).includes(x)),
  len: ([x]) => (Array.isArray(x) || typeof x === 'string' ? x.length : 0),
  at: ([l, i]) => (Array.isArray(l) && Number.isInteger(i) && i >= 0 && i < l.length ? l[i] : undefined),
  last: ([l]) => (Array.isArray(l) && l.length ? l[l.length - 1] : undefined),
  get: ([o, k, d]) => { const v = own(o, String(k)) ? o[k] : undefined; return v === undefined && d !== undefined ? d : v; },
  slice: ([l, a, b]) => (Array.isArray(l) || typeof l === 'string' ? l.slice(a, b) : []),
  concat: (a) => [].concat(...a.map(list)),
  merge: (a) => [].concat(...a),
  uniq: ([l]) => [...new Set(list(l))],
  sort: ([l]) => [...list(l)].sort(),
  set_at: ([l, i, v]) => { const c = [...list(l)]; c[i] = v; return c; },
  is_array: ([x]) => Array.isArray(x),
  is_null: ([x]) => x === null || x === undefined,
  '??': (a) => { for (const x of a) if (x !== null && x !== undefined) return x; return a.length ? a[a.length - 1] : null; },
  hex_dist: ([a, b]) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((a.q + a.r) - (b.q + b.r))),
  dice_count: ([s]) => diceCount(s),
  all_elems: () => [...ALL_ELEMS],
  undefined: () => undefined,
  bool: ([x]) => !!x,   // JS truthiness (`!!` is JsonLogic's: [] is false) — S2 skill programs mirror JS `!!` / `?.` tests
};

const SPECIAL = new Set(['var', 'quote', 'if', '?:', 'and', 'or', 'seq', 'let', 'set', 'obj', 'map', 'filter', 'reduce', 'all', 'some', 'none', 'find', 'sort_by', 'range', 'call',
  'emit', 'put', 'out', 'note', 'return', 'return_empty', 'seed', 'hash_int', 'rng', 'point_buy', 'point_buy_seed']);
export const ALL_OPS = Object.freeze([...SPECIAL, ...Object.keys(PURE_OPS), ...Object.keys(CTX_OPS)].sort());
// S2 (skill-engine.mjs) builds its own vocabulary from these: the control forms + pure ops, minus the outcome / dice
// forms, plus its own ctx queries.
export const SPECIAL_OPS = Object.freeze([...SPECIAL].sort());
export const PURE_OP_NAMES = Object.freeze(Object.keys(PURE_OPS).sort());

// `env` (S2, skill programs): { logic, root: {register: value}, ctxOps: {name: (ctx, args) => value}, deny: Set(op) }.
// With an env the program's VALUE is returned, `env.ctxOps` replaces CTX_OPS, and limit / program errors are thrown
// (EffectEngineLimit / EffectProgramError) for the caller to map. Without one: the effect path, unchanged.
function run(def, lib, ctx, cast, limits, env = null) {
  const out = newOutcome();
  let ops = 0;
  const elems = Array.isArray(cast.elements) ? cast.elements : (cast.elements || []);
  const seedOf = (tag) => `${cast.salt || ''}:${cast.effect_id}:${ctx.actionIndex}:${tag}`;
  // Registers every program may read / set (declared up front so `set` catches typos).
  const root = env ? new Scope(null, env.root) : new Scope(null, { cast, me: cast.actor, elems, effect_id: cast.effect_id, my_tile: null, recipients: [], failed: false, declared: null, aura: false, tmp: null });
  const subs = lib || new Map();

  const ev = (node, sc, depth) => {
    if (node === null || typeof node !== 'object') return node;
    if (depth > limits.maxDepth) throw new EffectEngineLimit(`depth limit ${limits.maxDepth} exceeded`);
    if (++ops > limits.maxOps) throw new EffectEngineLimit(`op budget ${limits.maxOps} exceeded`);
    const d = depth + 1;
    if (Array.isArray(node)) return node.map(x => ev(x, sc, d));
    const keys = Object.keys(node);
    if (keys.length !== 1) throw new EffectProgramError(`an operation must have exactly one key (got ${keys.join(',') || 'none'}); use {"obj": …} or {"quote": …} for objects`);
    const op = keys[0];
    if (env && env.deny.has(op)) throw new EffectProgramError(`operation ${op} is not available here`);
    const raw = node[op];
    const args = Array.isArray(raw) ? raw : [raw];
    const E = (x) => ev(x, sc, d);
    const iter = (body, name, fn) => (items) => items.map((it, i) => fn(ev(body, new Scope(sc, { [name || 'it']: it, i }), d), it, i));
    switch (op) {
      case 'var': {
        const p = E(args[0]);
        // JS semantics (not JsonLogic's null): a missing path is `undefined`, so outcome objects built from it
        // serialise exactly like the JS engine's (`elem: elems[0]` on an empty list drops the key).
        if (p === '' || p === null || p === undefined) return undefined;
        const parts = String(p).split('.');
        const s = sc.lookup(parts[0]);
        const v = s ? getPath(s.vars.get(parts[0]), parts.slice(1)) : undefined;
        return v === undefined && args.length > 1 ? E(args[1]) : v;
      }
      case 'quote': return clone(raw);
      case 'if': case '?:': {
        let i = 0;
        for (; i + 1 < args.length; i += 2) if (truthy(E(args[i]))) return E(args[i + 1]);
        return i < args.length ? E(args[i]) : null;
      }
      case 'and': { let v = true; for (const a of args) { v = E(a); if (!truthy(v)) return v; } return v; }
      case 'or': { let v = false; for (const a of args) { v = E(a); if (truthy(v)) return v; } return v; }
      case 'seq': { let v = null; for (const a of args) v = E(a); return v; }
      case 'let': {
        const [binds, body] = args;
        if (!binds || typeof binds !== 'object' || Array.isArray(binds)) throw new EffectProgramError('let needs [{name: expr, …}, body]');
        const inner = new Scope(sc, {});
        for (const [k, x] of Object.entries(binds)) inner.vars.set(k, ev(x, inner, d));
        return ev(body, inner, d);
      }
      case 'set': {
        const name = String(args[0]);
        const s = sc.lookup(name);
        if (!s) throw new EffectProgramError(`set: unknown variable ${name}`);
        const v = E(args[1]); s.vars.set(name, v); return v;
      }
      case 'obj': {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EffectProgramError('obj needs {key: expr, …}');
        const o = {};
        for (const [k, x] of Object.entries(raw)) { if (BAD_KEYS.has(k)) throw new EffectProgramError(`obj: key ${k} not allowed`); o[k] = E(x); }
        return o;
      }
      case 'map': return iter(args[1], args[2], v => v)(list(E(args[0])));
      case 'filter': { const items = list(E(args[0])); return items.filter((it, i) => truthy(ev(args[1], new Scope(sc, { [args[2] || 'it']: it, i }), d))); }
      case 'find': { const items = list(E(args[0])); for (let i = 0; i < items.length; i++) if (truthy(ev(args[1], new Scope(sc, { [args[2] || 'it']: items[i], i }), d))) return items[i]; return null; }
      case 'all': { const items = list(E(args[0])); return items.every((it, i) => truthy(ev(args[1], new Scope(sc, { [args[2] || 'it']: it, i }), d))); }
      case 'some': { const items = list(E(args[0])); return items.some((it, i) => truthy(ev(args[1], new Scope(sc, { [args[2] || 'it']: it, i }), d))); }
      case 'none': { const items = list(E(args[0])); return !items.some((it, i) => truthy(ev(args[1], new Scope(sc, { [args[2] || 'it']: it, i }), d))); }
      case 'reduce': {
        const items = list(E(args[0]));
        let acc = E(args[2]);
        for (let i = 0; i < items.length; i++) acc = ev(args[1], new Scope(sc, { current: items[i], it: items[i], accumulator: acc, acc, i }), d);
        return acc;
      }
      case 'sort_by': {
        // {"sort_by": [list, {"asc"|"desc"|"locale"|"code": keyExpr}, …, "name"?]} — stable, like Array#sort with
        // `ka - kb || …` (asc/desc numeric), a.localeCompare(b) (locale), code-unit order (code).
        const items = list(E(args[0]));
        const specs = args.slice(1).filter(s => s && typeof s === 'object');
        const name = typeof args[args.length - 1] === 'string' ? args[args.length - 1] : 'it';
        const keyed = items.map((it, i) => ({ it, k: specs.map(s => { const [mode] = Object.keys(s); return ev(s[mode], new Scope(sc, { [name]: it, i }), d); }) }));
        const modes = specs.map(s => Object.keys(s)[0]);
        keyed.sort((a, b) => {
          for (let j = 0; j < modes.length; j++) {
            const x = a.k[j], y = b.k[j];
            const c = modes[j] === 'asc' ? x - y : modes[j] === 'desc' ? y - x : modes[j] === 'locale' ? String(x).localeCompare(String(y)) : (x < y ? -1 : x > y ? 1 : 0);
            if (c) return c;
          }
          return 0;
        });
        return keyed.map(k => k.it);
      }
      case 'range': {
        const [a, b] = args.length > 1 ? [num(E(args[0])), num(E(args[1]))] : [0, num(E(args[0]))];
        if (!(b - a <= limits.maxRange)) throw new EffectEngineLimit(`range longer than ${limits.maxRange}`);
        const r = []; for (let i = a; i < b; i++) r.push(i); return r;
      }
      case 'call': {
        const name = String(args[0]);
        const sub = subs.get(name);
        if (!sub) throw new EffectProgramError(`call: unknown subroutine ${name}`);
        const vals = args.slice(1).map(E);
        // Subroutines see the root registers and their own params, never the caller's locals.
        const inner = new Scope(root, Object.fromEntries((sub.params || []).map((p, i) => [p, vals[i]])));
        return ev(sub.body, inner, d);
      }
      case 'emit': {
        const key = E(args[0]);
        if (!OUTCOME_ARRAYS.includes(key)) throw new EffectProgramError(`emit: ${key} is not an outcome list`);
        const v = E(args[1]); out[key].push(v); return v;
      }
      case 'put': {
        const key = E(args[0]);
        if (!OUTCOME_SCALARS.includes(key)) throw new EffectProgramError(`put: ${key} is not an outcome field`);
        const v = E(args[1]);
        if (key === 'status' && !OUTCOME_STATUSES.includes(v)) throw new EffectProgramError(`put: bad status ${v}`);
        out[key] = v; return v;
      }
      case 'out': { const key = E(args[0]); if (!own(out, key)) throw new EffectProgramError(`out: unknown field ${key}`); return out[key]; }
      case 'note': { const s = args.map(E).reduce((a, x) => a + x, ''); out.notes.push(s); return s; }
      case 'return': { if (args.length && raw !== null) { const s = E(args[0]); if (s !== null) out.status = s; } throw new Halt(out); }
      case 'return_empty': throw new Halt(emptied(out, E(args[0])));
      case 'seed': return seedOf(E(args[0]));
      case 'hash_int': { const [s, a, b] = args.map(E); return parseInt(ctx.sha(String(s)).slice(a ?? 0, b ?? 8), 16); }
      case 'rng': { const [tag, n] = args.map(E); return parseInt(ctx.sha(seedOf(tag)).slice(0, 8), 16) % n; }
      case 'point_buy': { const [stat, tag] = args.map(E); return pointBuy(stat, seedOf(tag), ctx.sha); }
      case 'point_buy_seed': { const [stat, s] = args.map(E); return pointBuy(stat, String(s), ctx.sha); }
      default: {
        if (Object.prototype.hasOwnProperty.call(PURE_OPS, op)) return PURE_OPS[op](args.map(E));
        const cops = env ? env.ctxOps : CTX_OPS;
        if (Object.prototype.hasOwnProperty.call(cops, op)) return cops[op](ctx, args.map(E));
        throw new EffectProgramError(`unknown operation ${op}`);
      }
    }
  };

  try {
    const v = ev(env ? env.logic : def.logic, root, 0);
    return env ? v : out;
  } catch (e) {
    if (env) throw e;
    if (e instanceof Halt) return e.out;
    if (e instanceof EffectEngineLimit || e instanceof EffectProgramError) {
      const o = newOutcome();
      o.status = 'error';
      o.notes.push(`effect engine: ${def.id}: ${e.message}`);
      return o;
    }
    throw e;   // a ctx query threw — same behaviour as the JS engine
  }
}

// ------------------------------------------------------------ validation + loading
function walkOps(node, fn, pathStr = '$') {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((x, i) => walkOps(x, fn, `${pathStr}[${i}]`)); return; }
  const keys = Object.keys(node);
  if (keys.length !== 1) { fn(null, pathStr, `object with ${keys.length} keys is not an operation`); return; }
  const op = keys[0];
  fn(op, pathStr);
  const raw = node[op];
  if (op === 'quote') return;
  if (op === 'obj') { if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, x] of Object.entries(raw)) walkOps(x, fn, `${pathStr}.obj.${k}`); return; }
  if (op === 'let') { const [b, body] = Array.isArray(raw) ? raw : []; if (b && typeof b === 'object') for (const [k, x] of Object.entries(b)) walkOps(x, fn, `${pathStr}.let.${k}`); walkOps(body, fn, `${pathStr}.let.body`); return; }
  if (op === 'sort_by') { const a = Array.isArray(raw) ? raw : [raw]; walkOps(a[0], fn, `${pathStr}.sort_by[0]`); for (const s of a.slice(1)) if (s && typeof s === 'object') { const [m] = Object.keys(s); if (!['asc', 'desc', 'locale', 'code'].includes(m)) fn(null, pathStr, `sort_by key mode ${m}`); walkOps(s[m], fn, `${pathStr}.sort_by.${m}`); } return; }
  walkOps(raw, fn, `${pathStr}.${op}`);
}
export function validateLogic(logic, subs, known = new Set(ALL_OPS)) {   // `known`: S2 passes the skill vocabulary
  const errors = [];
  walkOps(logic, (op, p, msg) => {
    if (msg) errors.push(`${p}: ${msg}`);
    else if (!known.has(op)) errors.push(`${p}: unknown operation ${op}`);
  });
  const calls = [];
  (function findCalls(n) { if (n && typeof n === 'object') { if (!Array.isArray(n) && Object.keys(n).length === 1 && 'call' in n) { const a = Array.isArray(n.call) ? n.call : [n.call]; calls.push(a[0]); } for (const v of Object.values(n)) findCalls(v); } })(logic);
  if (subs) for (const c of calls) if (typeof c !== 'string' || !subs.has(c)) errors.push(`call to unknown subroutine ${c}`);
  return errors;
}
export function validateEffectDef(def, subs) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['definition is not an object'];
  if (def.schema !== EFFECT_SCHEMA_ID) errors.push(`schema must be ${EFFECT_SCHEMA_ID}`);
  if (typeof def.id !== 'string' || !/^effect_[a-z0-9_]+$/.test(def.id)) errors.push('id must match effect_[a-z0-9_]+');
  if (typeof def.version !== 'string' || !/^\d+\.\d+\.\d+/.test(def.version)) errors.push('version must be semver');
  if (typeof def.name !== 'string' || !def.name) errors.push('name required');
  if (!Array.isArray(def.elements) || !def.elements.every(e => ALL_ELEMS.includes(e))) errors.push('elements must be element ids');
  if (def.cost !== undefined && def.cost !== (def.elements || []).length) errors.push('cost must equal the number of elements');
  if (!['instant', 'permanent', 'channel', 'trap', 'cast'].includes(def.duration)) errors.push('duration must be instant|permanent|channel|trap|cast');
  if (!def.flags || typeof def.flags !== 'object') errors.push('flags (resolver metadata) required');
  if (def.logic === undefined) errors.push('logic required');
  else errors.push(...validateLogic(def.logic, subs));
  return errors;
}
export function validateLib(lib) {
  const errors = [];
  if (lib?.schema !== LIB_SCHEMA_ID) errors.push(`schema must be ${LIB_SCHEMA_ID}`);
  if (typeof lib?.id !== 'string') errors.push('id required');
  const subs = new Map(Object.entries(lib?.subs || {}));
  for (const [name, s] of subs) {
    if (!Array.isArray(s.params)) errors.push(`${name}: params must be an array`);
    errors.push(...validateLogic(s.body, subs).map(e => `${name}: ${e}`));
  }
  return errors;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f)) : []);

// loadEffectDefs(dir | {effects: [...], libs: [...]} | [defs]) → Map(effect id → def).
// `dir` is an effects-data root (with effects/ and lib/) or an effects directory (lib/ beside it).
// Each def gets a non-enumerable `$subs` (the subroutines of the libraries it `uses`).
// Invalid definitions throw (they must never reach a resolver).
export function loadEffectDefs(src = process.env.EFFECT_DEFS_DIR || EFFECTS_DATA_DIR) {
  let effects = [], libs = [];
  if (typeof src === 'string') {
    const effDir = fs.existsSync(path.join(src, 'effects')) ? path.join(src, 'effects') : src;
    const libDir = fs.existsSync(path.join(src, 'lib')) ? path.join(src, 'lib') : path.join(effDir, '..', 'lib');
    effects = jsonFiles(effDir).map(readJson);
    libs = jsonFiles(libDir).map(readJson);
  } else if (Array.isArray(src)) { effects = src; libs = defaultLibs(); }
  else { effects = src.effects || []; libs = src.libs || defaultLibs(); }
  const libMap = new Map();
  for (const l of libs) {
    const errs = validateLib(l);
    if (errs.length) throw new Error(`effect lib ${l?.id}: ${errs.join('; ')}`);
    libMap.set(l.id, l);
  }
  const defs = new Map();
  for (const def of effects) {
    const subs = new Map();
    for (const u of def.uses || []) {
      const l = libMap.get(u);
      if (!l) throw new Error(`${def.id}: uses unknown lib ${u}`);
      for (const [n, s] of Object.entries(l.subs)) if (!subs.has(n)) subs.set(n, s);
    }
    const errs = validateEffectDef(def, subs);
    if (errs.length) throw new Error(`effect ${def?.id}: ${errs.join('; ')}`);
    if (defs.has(def.id)) throw new Error(`effect ${def.id} defined twice`);
    Object.defineProperty(def, '$subs', { value: subs, enumerable: false });
    defs.set(def.id, def);
  }
  return defs;
}
let _defaultLibs = null;
function defaultLibs() { return (_defaultLibs ||= jsonFiles(path.join(EFFECTS_DATA_DIR, 'lib')).map(readJson)); }

// resolveEffectData(def, ctx, cast[, opts]) → the outcome effects.mjs#resolveEffect would return.
export function resolveEffectData(def, ctx, cast, opts = {}) {
  let subs = def.$subs;
  if (!subs) {   // a raw definition object: bind its libraries now
    subs = new Map();
    const libs = opts.libs || defaultLibs();
    for (const u of def.uses || []) { const l = libs.find(x => x.id === u); if (l) for (const [n, s] of Object.entries(l.subs)) if (!subs.has(n)) subs.set(n, s); }
  }
  return run(def, subs, ctx, cast, { ...ENGINE_LIMITS, ...(opts.limits || {}) });
}

// runProgram(logic, subs, ctx, root, {ctxOps, deny, limits}) → the program's value (S2 skill programs,
// game/skill-engine.mjs). Same evaluator, op budget and depth limit as the effects; `root` = the registers,
// `subs` = Map(name → {params, body}). Limit / program errors are thrown (EffectEngineLimit / EffectProgramError).
export function runProgram(logic, subs, ctx, root, { ctxOps = {}, deny = new Set(), limits = {} } = {}) {
  return run({ id: '' }, subs || new Map(), ctx, {}, { ...ENGINE_LIMITS, ...limits }, { logic, root: root || {}, ctxOps, deny });
}
