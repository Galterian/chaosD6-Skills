// game/skills.mjs — PURE skill rules (chaosD6-Skills milestone S1).
//
// The 14 skills of data/skills.json used to live inline in peer.mjs. This module holds their RULE
// logic as a `SKILL_RULES` table (the flags peer.mjs / bots / UI read, like effects.mjs#EFFECT_RULES)
// plus hook functions dispatched by `skillHook(hookName, skillId, ctx, args)`. No peer globals: every
// hook works on what the caller passes in — plain data (reveals, snapshots, ids, numbers) and the
// resolver's own per-action registers (Maps / arrays owned by simulate(), mutated in place exactly as
// the inline code did, so the resolver's ordering and the state hash stay byte-identical).
// Node-18 compatible. Hook inventory, inputs / outputs, call sites, ordering: skills-data/HOOKS.md.
// S2: the same hooks as JsonLogic data (skills-data/skills/<id>.json, engine skill-engine.mjs, schema
// skills-data/SCHEMA.md); SKILL_ENGINE=js (default) | data | shadow picks who answers skillHook (bottom of file).
//
// Resolver ctx (`skCtx`, built once per simulate() in peer.mjs) — fields a hook may read:
//   self, label, log(...)                 my peer id, PEER_LABEL, quiet-aware logger
//   reveals, byActorPre                   the action's reveals (live array) and actor → reveal Map
//   effAction, tranceOpts, noMove,        resolver registers (Map id → code, Map id → [codes], Set id,
//   counterPen, skillFx                   Map id → {elem: amount}, [fx records])
//   codeIs(id, c), replace(id, from, to)  the resolver's trance-aware code test / rewrite
//   enemyOf, hiddenFrom, dist, lifeOf     queries (dist = hex distance of the snapshot tiles)
//   view(id), viewValues()                snapshot of one peer / all snapshots (iteration order = view order)
//   elemStat(el)                          ELEM_TO_STAT
//   hasPerm(id, perm), permPower(id)      permanents (snapshot / entity) and their powers ({id: die})
//   castsDamage(o), effectDmgNoShield(o, def)   effect queries (effectDmgNoShield reads counterPen)
//   skillData(id)                         the active data/skills.json version's `data` (or undefined)
//   edgeDmg(atk, def)                     the damage matrix

import * as SE from './skill-engine.mjs';   // S2 data hooks (pure; loads skills-data/ only when used)

export const TRANCE = 'skill_battle_trance';

// Flags per skill (the order is the deal order of SKILLS_IMPLEMENTED — it decides which 4 a player gets).
//   action      the action code it rides on ('M' / 'P' also ride on EM / EP; Battle Trance rides on anything)
//   permanent   lands as a permanent (Rule 12 point-buy of pointBuyStat; 'any' = my best stat)
//   negating    judged by whether it did its job, not by the damage counterfactual (user ruling 2026-11-12)
//   hooks       the hook points it acts in (see HOOKS.md)
export const SKILL_RULES = {
  skill_powerful_attack: { action: 'A', permanent: false, negating: false, hooks: ['attack_out'], attackBonus: 1 },
  skill_overrun:         { action: 'A', permanent: false, negating: true, hooks: ['negate_kind', 'move'], range: 1, negates: ['M', 'EM'] },
  skill_grapple:         { action: 'A', permanent: false, negating: true, hooks: ['negate_kind'], negates: ['P'] },
  skill_ranged_weapon:   { action: 'A', permanent: true, pointBuyStat: 'matter', negating: false, hooks: ['block_in', 'block_cost', 'perm_landing', 'perm_stats'] },
  skill_taunt:           { action: 'B', permanent: true, pointBuyStat: 'vitality', negating: false, hooks: ['attack_target', 'perm_landing', 'perm_stats'], range: 1 },
  skill_barricade:       { action: 'B', permanent: true, pointBuyStat: 'vitality', negating: false, hooks: ['defend_in', 'perm_landing', 'perm_stats'], negates: ['A', 'B'] },
  skill_sanctuary:       { action: 'B', permanent: true, pointBuyStat: 'any', negating: false, hooks: ['defend_in', 'end_round', 'perm_landing', 'perm_stats'] },
  skill_dodge:           { action: 'M', permanent: false, negating: true, hooks: ['damage_in'], damageOff: 1 },
  skill_bluff:           { action: 'M', permanent: false, negating: true, hooks: ['negate_action'], range: 1 },
  skill_intimidation:    { action: 'P', permanent: false, negating: true, hooks: ['negate_action'], range: 1, negates: ['A'] },
  skill_disruption_move: { action: 'M', permanent: false, negating: true, hooks: ['negate_kind'], negates: ['P'] },
  skill_battle_trance:   { action: 'P', permanent: false, negating: false, trance: true, hooks: ['plan', 'trance_assign'] },
  skill_force_shield:    { action: 'B', permanent: true, pointBuyStat: 'vitality', negating: false, hooks: ['effect_in', 'effect_leg', 'end_round', 'perm_landing', 'perm_stats'] },
  skill_counter_spell:   { action: 'P', permanent: false, negating: true, keepsTarget: true, hooks: ['plan_target', 'counter_pre'], range: 1 },
};
export const SKILLS_IMPLEMENTED = Object.keys(SKILL_RULES);
// Instants judged by what they did, not by the damage counterfactual (user ruling 2026-11-12).
export const NEGATING_SKILLS = new Set(SKILLS_IMPLEMENTED.filter(id => SKILL_RULES[id].negating));
export const STATS = ['vitality', 'world', 'matter', 'will'];

const roundHalfUp10 = (sum) => Math.round(sum / 10);   // = effects.mjs#roundHalfUp10
const statRaw = (v, sk) => Math.max(0, v?.[`stat_${sk}`] ?? 0);   // = peer.mjs simulate()#statRaw
// The data of a skill: the caller's data/skills.json view, else the table (a foreign skill — S2 — always the table).
const sdOf = (ctx, id) => (ctx && ctx.skillData && !foreignIds.has(id)) ? ctx.skillData(id) : (SKILL_RULES[id] ? { action_type: SKILL_RULES[id].action, is_permanent: SKILL_RULES[id].permanent, point_buy_stat: SKILL_RULES[id].pointBuyStat ? (SKILL_RULES[id].pointBuyStat === 'any' ? 'any' : `stat_${SKILL_RULES[id].pointBuyStat}`) : null } : undefined);

// ---- hook: rides / plan -----------------------------------------------------------------------------
// A skill rides on its action, or — for Move / Posture skills — on an Empty option (EM / EP).
export const ridesOn = (codes, req) => codes.includes(req) || ((req === 'M' || req === 'P') && (codes.includes('EP') || codes.includes('EM')));
export const ridesFor = (r) => { const codes = r.trance || [r.action]; return c => ridesOn(codes, c); };
// A Posture keeps a character target when a skill needs one (Counter Spell).
const planTarget = (skillIds) => skillIds.some(id => !!SKILL_RULES[id]?.keepsTarget);

// ---- resolver helpers shared by the passes -----------------------------------------------------------
function helpers(ctx) {
  const { byActorPre, effAction, skillFx } = ctx;
  const has = (id, skill) => (byActorPre.get(id)?.skills || []).includes(skill);
  const nonPerm = (id) => id !== TRANCE && !sdOf(ctx, id)?.is_permanent;
  const fromBuilding = (by, skill) => byActorPre.get(by)?.buildingSkill === skill;
  // Skill bookkeeping (user ruling 2026-11-12): what each instant actually did. A skill that served its
  // purpose is discarded; a negated action's card — and the instants riding on it, which never execute —
  // goes back to its owner's hand; a countered instant is discarded. Read by the card disposition.
  const negate = (by, skill, o, what) => {
    const ridden = (o.skills || []).filter(nonPerm);
    o.skills = (o.skills || []).filter(id => !nonPerm(id));
    skillFx.push({ by, skill, on: o.actor, what, negated: true, ridden, building: fromBuilding(by, skill) });
  };
  const counterSkills = (by, skill, o) => {
    const countered = (o.skills || []).filter(nonPerm);
    o.skills = (o.skills || []).filter(id => !nonPerm(id));
    skillFx.push({ by, skill, on: o.actor, what: 'skills', countered, building: fromBuilding(by, skill) });
  };
  const adjacentFoes = (id) => ctx.reveals.filter(o => o.actor !== id && ctx.enemyOf(id, o.actor) && !ctx.hiddenFrom(id, o.actor) && ctx.dist(id, o.actor) <= 1).map(o => o.actor);
  // A targeted skill without a right-clicked enemy picks the adjacent one: attackers first, then lowest id.
  const foeFor = (r) => {
    const t = r.target?.kind === 'character' ? r.target.ref : null;
    if (t && effAction.has(t) && !ctx.hiddenFrom(r.actor, t)) return t;
    return adjacentFoes(r.actor).sort((a, b) => (Number(ctx.codeIs(b, 'A')) - Number(ctx.codeIs(a, 'A'))) || a.localeCompare(b))[0] || null;
  };
  return { has, nonPerm, fromBuilding, negate, counterSkills, adjacentFoes, foeFor };
}

// ---- hook: counter_pre (Counter Spell pre-pass) -------------------------------------------------------
// Rule 8: no stack, but a counter is a prohibition and prohibitions apply "finally as a replacement" — so
// it runs before any other skill resolves. Target (Rule 15 pc override: Posture has no target, so the
// adjacent enemy that benefits me most): the right-clicked enemy if they are adjacent and casting, else the
// adjacent caster whose effect I blunt the most, lowest life breaking ties; with nobody casting, the
// right-clicked enemy. The target loses every non-permanent skill they played this action (a countered
// Battle Trance collapses to its first card). Then I emit one element against their cast: of the element
// types in it, the one that saves me the most; my stat for that element comes off their stat for every
// instance of it in the cast (Lightning = fire+air, Matter 16 vs my 8, counter fire → (16−8−8) + (16−8) = 8
// → 1). Caster-side only. Two Counter Spells aimed at each other cancel in actor order — the lexically
// first actor's counter lands first and strips the other's.
function counterPre(ctx) {
  const { effAction, tranceOpts, counterPen, skillFx } = ctx;
  const { fromBuilding } = helpers(ctx);
  const log = ctx.log, self = ctx.self, label = ctx.label;
  for (const r of [...ctx.reveals].sort((a, b) => a.actor.localeCompare(b.actor))) {
    if (!(r.skills || []).includes('skill_counter_spell')) continue;
    if (!ridesFor(r)('P')) continue;
    const casterV = ctx.view(r.actor);
    if (!casterV) continue;
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    const cands = ctx.reveals.filter(o => o.actor !== r.actor && ctx.enemyOf(r.actor, o.actor) && !ctx.hiddenFrom(r.actor, o.actor) && ctx.dist(r.actor, o.actor) <= 1);
    if (!cands.length) continue;
    // Best element against one caster: how much of their damage to me it removes.
    const bestElem = (o) => {
      if (!ctx.castsDamage(o)) return null;
      const before = ctx.effectDmgNoShield(o, r.actor);
      const prev = counterPen.get(o.actor);
      let best = null;
      for (const el of [...new Set(o.effect.elements)].sort()) {
        const amount = statRaw(casterV, ctx.elemStat(el));
        if (!amount) continue;
        counterPen.set(o.actor, { ...(prev || {}), [el]: (prev?.[el] || 0) + amount });
        const saved = before - ctx.effectDmgNoShield(o, r.actor);
        if (!best || saved > best.saved) best = { el, amount, saved };
      }
      if (prev) counterPen.set(o.actor, prev); else counterPen.delete(o.actor);
      return best;
    };
    const casters = cands.filter(ctx.castsDamage);
    let o = cands.find(c => c.actor === declared && ctx.castsDamage(c)) || null;
    if (!o && casters.length) {
      o = casters.map(c => ({ c, b: bestElem(c) }))
        .sort((x, y) => (y.b?.saved ?? -1) - (x.b?.saved ?? -1) || ctx.lifeOf(x.c.actor) - ctx.lifeOf(y.c.actor) || x.c.actor.localeCompare(y.c.actor))[0].c;
    }
    if (!o) o = cands.find(c => c.actor === declared) || null;
    if (!o) continue;
    const tgt = o.actor;
    const kept = (o.skills || []).filter(id => !!sdOf(ctx, id)?.is_permanent);
    const stripped = (o.skills || []).filter(id => !kept.includes(id));
    o.skills = kept;
    const bCs = bestElem(o);
    if (stripped.length || bCs) skillFx.push({ by: r.actor, skill: 'skill_counter_spell', on: tgt, what: 'skills', countered: stripped.filter(id => id !== TRANCE), building: fromBuilding(r.actor, 'skill_counter_spell') });
    if (stripped.includes(TRANCE) && o.trance) { effAction.set(tgt, o.trance[0]); tranceOpts.delete(tgt); o.trance = null; }
    const b = bestElem(o);
    if (b) {
      const pen = counterPen.get(tgt) || {};
      pen[b.el] = (pen[b.el] || 0) + b.amount;
      counterPen.set(tgt, pen);
    }
    if (r.actor === self || tgt === self) log(`[${label}] counter spell ${r.actor.slice(0, 8)} → ${tgt.slice(0, 8)}: stripped [${stripped.join(',')}]${b ? `, −${b.amount} on ${b.el} (saves ${b.saved})` : ', nothing to counter'}`);
  }
}

// ---- hook: negate_action (pass 1 — prohibitions on a whole action: Bluff, Intimidation) ---------------
// They go first: an Attack Intimidation negates never gets to Grapple. Move / Posture skills also ride on
// Empty Move / Empty Posture.
function negateAction(ctx) {
  const { effAction, tranceOpts, byActorPre } = ctx;
  const { has, nonPerm, negate, counterSkills, adjacentFoes, foeFor } = helpers(ctx);
  for (const r of ctx.reveals) {
    if (!(r.skills || []).length) continue;
    const me = r.actor, rides = ridesFor(r);
    // Bluff: the enemy's action is negated and played as Empty Posture.
    if (rides('M') && has(me, 'skill_bluff')) {
      const t = foeFor(r), o = t && byActorPre.get(t);
      if (o && ctx.dist(me, t) <= 1 && (tranceOpts.has(t) || effAction.get(t) !== 'EP')) {
        const what = tranceOpts.has(t) ? tranceOpts.get(t).join('+') : effAction.get(t);
        effAction.set(t, 'EP'); tranceOpts.delete(t); negate(me, 'skill_bluff', o, what);
      }
    }
    // Intimidation: an adjacent enemy's Attack is negated (no combat damage, the card back to their hand);
    // with nobody attacking, it counters a non-permanent skill of an adjacent enemy instead.
    if (rides('P') && has(me, 'skill_intimidation')) {
      const atk = adjacentFoes(me).filter(id => ctx.codeIs(id, 'A'));
      for (const id of atk) { ctx.replace(id, 'A', 'EP'); negate(me, 'skill_intimidation', byActorPre.get(id), 'A'); }
      if (!atk.length) {
        const o = [foeFor(r), ...adjacentFoes(me)].filter(Boolean).map(id => byActorPre.get(id))
          .find(x => x && ctx.dist(me, x.actor) <= 1 && (x.skills || []).some(nonPerm));
        if (o) counterSkills(me, 'skill_intimidation', o);
      }
    }
  }
}

// ---- hook: negate_kind (pass 2 — prohibitions on one kind of action: Grapple, Disruption Move, Overrun) --
function negateKind(ctx) {
  const { byActorPre, noMove } = ctx;
  const { has, negate, foeFor } = helpers(ctx);
  for (const r of ctx.reveals) {
    if (!(r.skills || []).length) continue;
    const me = r.actor, rides = ridesFor(r);
    if (rides('A') && has(me, 'skill_grapple')) { const t = foeFor(r); if (t && ctx.codeIs(t, 'P')) { ctx.replace(t, 'P', 'EP'); negate(me, 'skill_grapple', byActorPre.get(t), 'P'); } }
    if (rides('M') && has(me, 'skill_disruption_move')) { const t = foeFor(r); if (t && ctx.codeIs(t, 'P')) { ctx.replace(t, 'P', 'EP'); negate(me, 'skill_disruption_move', byActorPre.get(t), 'P'); } }
    if (rides('A') && has(me, 'skill_overrun')) {
      const t = foeFor(r);
      if (t && ctx.dist(me, t) <= 1) { const mv = ctx.codeIs(t, 'M') ? 'M' : ctx.codeIs(t, 'EM') ? 'EM' : null; noMove.add(t); if (mv) negate(me, 'skill_overrun', byActorPre.get(t), mv); }
    }
  }
}

// ---- hook: trance_assign (Battle Trance) ---------------------------------------------------------------
// For each adjacent enemy pick the option that benefits the trance actor most (dealt − taken). Each Attack
// option hits at most one enemy; the declared target gets first choice. With nobody adjacent both options
// are played. Writes r.vs (Map enemy → option index) and r.played (Set of indices) on every trance reveal.
// args: { byActor, codeVs(id, other), attacksOn(r, victim) }.
function tranceAssign(ctx, { byActor, codeVs, attacksOn }) {
  for (const r of ctx.reveals) {
    if (!r.trance) continue;
    const me = ctx.view(r.actor);
    if (!me) { r.vs = new Map(); r.played = new Set([0, 1]); continue; }
    const declared = r.target?.kind === 'character' ? r.target.ref : null;
    // Revealers only — their snapshots ride in the reveal, so every peer sees the same set.
    const adj = [...ctx.viewValues()]
      .filter(p => p && p.peer_id !== r.actor && byActor.has(p.peer_id) && p.life > 0 && ctx.enemyOf(r.actor, p.peer_id) && !ctx.hiddenFrom(r.actor, p.peer_id) && ctx.dist(r.actor, p.peer_id) <= 1)
      .map(p => p.peer_id)
      .sort((a, b) => (a === declared ? -1 : b === declared ? 1 : a.localeCompare(b)));
    r.vs = new Map();
    r.played = new Set();
    const usedA = new Set();
    for (const e of adj) {
      const er = byActor.get(e);
      const eCode = er ? codeVs(e, r.actor) : 'EP';
      const eHits = attacksOn(er, r.actor);
      // The enemy's Attack / Move only hurt me if aimed at me; Posture / Block hit anyone adjacent.
      const eAims = eCode === 'A' ? eHits : eCode === 'M' ? er?.target?.kind === 'character' && er.target.ref === r.actor : true;
      let best = -1, bestScore = -Infinity;
      r.trance.forEach((opt, i) => {
        if (opt === 'A' && usedA.has(i)) return;
        const taken = eAims ? ctx.edgeDmg(eCode, opt) : 0;
        const dealt = opt === 'B' && !eHits ? 0 : ctx.edgeDmg(opt, eCode);
        const score = dealt - taken;
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) continue;
      r.vs.set(e, best);
      r.played.add(best);
      if (r.trance[best] === 'A') usedA.add(best);
    }
    if (!adj.length) r.played = new Set([0, 1]);
  }
}

// ---- hooks on one strike (combat damage) ---------------------------------------------------------------
// block_in (Ranged Weapon): a Block scores against Attacks aimed at the blocker — except a ranged attacker,
// who is out of reach. Returns true when the Block does NOT score.  args: { defender } (the attacker whose
// Attack the Block meets holds the permanent).
const blockIn = (ctx, { defender }) => ctx.hasPerm(defender, 'skill_ranged_weapon');
// block_cost (Ranged Weapon, Reaver auto-target): 1 when the candidate Blocks and I am not ranged.
const blockCost = (ctx, { attacker, defender }) => ctx.codeIs(defender, 'B') && !ctx.hasPerm(attacker, 'skill_ranged_weapon') ? 1 : 0;
// attack_out (Powerful Attack): +1 on an Attack that connects.  args: { attacker, dmg } → dmg.
const attackOut = (ctx, { attacker, dmg }) => (dmg >= 1 && helpers(ctx).has(attacker, 'skill_powerful_attack')) ? dmg + 1 : dmg;
// attack_target (Taunt): a nearby taunter is the only legal Attack target. Only revealers count — their
// snapshots ride in the reveal, so every peer sees the same set.  args: { attacker, defender } → true = 0 dmg.
const attackTarget = (ctx, { attacker, defender }) => ctx.reveals.some(t => t.actor !== defender && t.actor !== attacker
  && ctx.enemyOf(attacker, t.actor) && ctx.hasPerm(t.actor, 'skill_taunt') && ctx.dist(attacker, t.actor) <= 1);
// defend_in (Barricade, then Sanctuary): Barricade stops Attack / Block damage; a Sanctuary holder resting
// on the Empty Posture it declared takes none.  args: { code, defender, dmg, byActor } → dmg.
const barricade = (ctx, { code, defender, dmg }) => ((code === 'A' || code === 'B') && ctx.hasPerm(defender, 'skill_barricade')) ? 0 : dmg;
const restingInSanctuary = (ctx, id, byActor) => ctx.hasPerm(id, 'skill_sanctuary') && (byActor.get(id)?.declared ?? 'EP') === 'EP';
const sanctuary = (ctx, { defender, dmg, byActor }) => restingInSanctuary(ctx, defender, byActor) ? 0 : dmg;
const defendIn = (ctx, args) => sanctuary(ctx, { ...args, dmg: barricade(ctx, args) });

// ---- hook: damage_in (Dodge) ---------------------------------------------------------------------------
// "One less damage done to you this action" — one point off the combat damage I take this round, not one
// per attacker.  args: { damage } (Map victim → [{source, amount, attacker}], edited in place).
function damageIn(ctx, { damage }) {
  const { has, fromBuilding } = helpers(ctx);
  for (const [victim, list] of damage) {
    if (!has(victim, 'skill_dodge')) continue;
    const hit = list.find(d => d.source === 'action' && d.amount > 0);
    if (hit) { hit.amount -= 1; ctx.skillFx.push({ by: victim, skill: 'skill_dodge', on: hit.attacker, what: 'damage', building: fromBuilding(victim, 'skill_dodge') }); }
  }
}

// ---- hooks: effect_in / effect_leg (Force Shield) -----------------------------------------------------
// Effect damage (Rule 21) is rounded per leg; before rounding, the Force Shield die comes off the first leg
// that would otherwise land, and is spent by that (user ruling: die absorbs before rounding).
const effectIn = (ctx, { defender }) => ctx.hasPerm(defender, 'skill_force_shield') ? (ctx.permPower(defender).skill_force_shield || 0) : 0;
// args: { shield, sum } → { shield, sum, spent } (spent = the die when it absorbed this leg, else 0).
const effectLeg = (_ctx, { shield, sum }) => (shield && roundHalfUp10(sum) > 0) ? { shield: 0, sum: Math.max(0, sum - shield), spent: shield } : { shield, sum, spent: 0 };

// ---- hooks after the action (end_round, perm_landing) --------------------------------------------------
// end_round (Sanctuary): it lasts while I rest — declaring anything but the plain Empty Posture (another
// action, a trance, a skill riding on the EP other than a building's, an effect) ends it from the next
// round.  args: { reveal } (my reveal after resolution) → true = the Sanctuary permanent falls.
const leftSanctuary = (_ctx, { reveal: myR }) => !!myR && ((myR.declared ?? myR.action) !== 'EP' || (myR.skills || []).filter(id => id !== myR.buildingSkill).length > 0 || !!myR.effect);
// perm_landing: the permanent skills I played that take hold (a trance only lands those whose action
// code was played), each with the stat its Rule 12 point-buy uses ('any' = my best stat, first on ties).
// args: { skillIds, playedCodes (Set|null), stats ({vitality, …}) } → [{ id, stat }] in skillIds order.
function permLanding(ctx, { skillIds, playedCodes, stats }) {
  const out = [];
  for (const id of skillIds || []) {
    const sd = sdOf(ctx, id);
    if (sd?.is_permanent && (!playedCodes || playedCodes.has(sd.action_type))) {
      const st = sd.point_buy_stat === 'any'
        ? ['vitality', 'world', 'matter', 'will'].sort((a, b) => stats[b] - stats[a])[0]
        : (sd.point_buy_stat || 'stat_vitality').replace(/^stat_/, '');
      out.push({ id, stat: st });
    }
  }
  return out;
}
// perm_stats (Rule 24): the stats a permanent skill can be destroyed by (point_buy_stat; 'any' = all four;
// none → vitality).
const permStats = (ctx, id) => { const st = sdOf(ctx, id)?.point_buy_stat; return st === 'any' ? ['vitality', 'world', 'matter', 'will'] : st ? [st.replace(/^stat_/, '')] : ['vitality']; };

// ---- hook: disposition (Rule 8 card bookkeeping, user ruling 2026-11-12) -----------------------------
// What happens to one skill card I played this action. args: { fx (skillFx of the real run), self }.
//   'permanent'  stays in play (landing is perm_landing's business)
//   'negated'    rode on my action that an enemy negated → back to my hand with the action card
//   'countered'  an enemy countered it → discarded
//   'spent'      a negating skill that did its job → discarded
//   'unused'     a negating skill that found nothing to do → back to my hand
//   'judge'      any other instant → judged by the Rule 8 damage counterfactual (peer.mjs roundWithout)
function disposition(ctx, id, { fx, self }) {
  if (sdOf(ctx, id)?.is_permanent) return 'permanent';
  const onMe = fx.filter(f => f.on === self);
  if (onMe.some(f => (f.ridden || []).includes(id))) return 'negated';
  if (onMe.some(f => (f.countered || []).includes(id))) return 'countered';
  if (NEGATING_SKILLS.has(id)) return fx.some(f => f.by === self && f.skill === id && !f.building) ? 'spent' : 'unused';
  return 'judge';
}

// ---- dispatcher -----------------------------------------------------------------------------------------
// skillHook(hookName, skillId, ctx, args) → result. `skillId` names the skill for single-skill hooks; pass
// hooks (counter_pre, negate_action, negate_kind, defend_in with null) run every skill of that hook in the
// fixed order of the old inline code.
const HOOKS = {
  rides: (_id, _ctx, { codes, req }) => ridesOn(codes, req),
  plan_target: (_id, _ctx, { skillIds }) => planTarget(skillIds),
  counter_pre: (_id, ctx) => counterPre(ctx),
  negate_action: (_id, ctx) => negateAction(ctx),
  negate_kind: (_id, ctx) => negateKind(ctx),
  trance_assign: (_id, ctx, args) => tranceAssign(ctx, args),
  block_in: (_id, ctx, args) => blockIn(ctx, args),
  block_cost: (_id, ctx, args) => blockCost(ctx, args),
  attack_out: (_id, ctx, args) => attackOut(ctx, args),
  attack_target: (_id, ctx, args) => attackTarget(ctx, args),
  defend_in: (id, ctx, args) => id === 'skill_barricade' ? barricade(ctx, args) : id === 'skill_sanctuary' ? sanctuary(ctx, args) : defendIn(ctx, args),
  damage_in: (_id, ctx, args) => damageIn(ctx, args),
  effect_in: (_id, ctx, args) => effectIn(ctx, args),
  effect_leg: (_id, ctx, args) => effectLeg(ctx, args),
  end_round: (_id, ctx, args) => leftSanctuary(ctx, args),
  perm_landing: (_id, ctx, args) => permLanding(ctx, args),
  perm_stats: (id, ctx) => permStats(ctx, id),
  disposition: (id, ctx, args) => disposition(ctx, id, args),
};
export const HOOK_NAMES = Object.keys(HOOKS);
export function skillHook(hookName, skillId, ctx, args = {}) {
  const h = HOOKS[hookName];
  if (!h) throw new Error(`skills.mjs: unknown hook ${hookName}`);
  const spec = SE.HOOK_SPECS[hookName];
  // S2: a foreign skill's own program for a per-skill hook; else JS / data / shadow, then foreign skills join in.
  if (foreignIds.has(skillId) && (spec.kind === 'single') && foreignById.get(skillId).hooks[hookName] !== undefined) return dataHook(hookName, skillId, ctx, args);
  let res;
  if (SKILL_ENGINE === 'js' || spec.engine === 'js') res = h(skillId, ctx, args);
  else if (SKILL_ENGINE === 'data') res = dataHook(hookName, skillId, ctx, args);
  else res = shadowHook(h, hookName, skillId, ctx, args);
  return foreignIds.size && FOLDED.has(spec.kind) ? foldForeign(spec, hookName, ctx, args, res) : res;
}

// ---- S2: engine switch, data hooks, foreign skills ------------------------------------------------------
// SKILL_ENGINE=js (default): the hooks above. data: every hook marked "data" in skill-engine.mjs#HOOK_SPECS runs the
// program of the skill's definition (game/skills-data/skills/<id>.json, or SKILL_DEFS_DIR); the pass hooks
// (counter_pre, negate_action, negate_kind, trance_assign) stay on JS. shadow: both run, results (and for
// damage_in the edited damage map + fx) must be JSON-identical; a mismatch goes to stderr, SKILL_SHADOW_STRICT=1
// throws; the JS result is returned. SKILL_SHADOW_REPORT=1 prints a tally at exit.
const ENGINE_ENV = (typeof process !== 'undefined' && process.env) || {};
export const SKILL_ENGINE = ['data', 'shadow'].includes(ENGINE_ENV.SKILL_ENGINE) ? ENGINE_ENV.SKILL_ENGINE : 'js';
export const skillShadowStats = { compared: 0, mismatches: 0, errors: 0, byHook: {} };
const BUILTIN_IDS = new Set(SKILLS_IMPLEMENTED);
const FOLDED = new Set(['chain', 'or', 'max', 'first', 'edit']);
let bundle = null;
// The bundled definitions: { defs: Map(id → def), libs, std (the skills_std default programs) }.
export const skillBundle = () => (bundle ||= SE.loadSkillDefs(undefined, { builtinIds: BUILTIN_IDS }));
// Foreign (player-branch) skills, for S4's handshake: registered by key (the ref's content key), dispatched by id
// (the last registration of an id wins). Never over a built-in. Their flags join SKILL_RULES (not SKILLS_IMPLEMENTED:
// dealing is unchanged); a foreign skill takes part in every data hook it has a program for, after the built-ins,
// foreign ids in code-unit order — so every peer that registered the same set computes the same result.
const foreignByKey = new Map(), foreignById = new Map(), foreignIds = new Set();
const defOf = (id) => foreignById.get(id) || (BUILTIN_IDS.has(id) ? skillBundle().defs.get(id) : undefined);
const metaOf = (d) => ({ action_type: d.action_type, is_permanent: d.is_permanent, point_buy_stat: d.point_buy_stat ?? null });
// The ctx the programs' queries see (skill-engine.mjs SKILL_CTX_OPS). `own` = a definition being run directly.
const wrap = (ctx, own) => ({
  c: ctx,
  sd: (id) => (own && id === own.id && !(ctx && ctx.skillData)) ? metaOf(own) : sdOf(ctx, id),
  flag: (id, k) => { const d = own && id === own.id ? own : defOf(id); return d ? d.flags?.[k] : SKILL_RULES[id]?.[k]; },
});
let noted = 0;
const note = (msg) => { skillShadowStats.errors++; if (noted++ < 20) console.error(`[skills] data hook: ${msg}`); };
function runOne(prog, hookName, id, ctx, args, own) {
  if (!prog) return SE.neutralOf(hookName, args);
  if (prog.js) return prog.js.impl.startsWith('skills.mjs') ? HOOKS[hookName](id, ctx, args) : SE.neutralOf(hookName, args);
  try {
    const v = SE.runHookProgram(prog, hookName, id, wrap(ctx, own), args);
    if (SE.resultOk(hookName, v)) return v;
    note(`${id} ${hookName}: bad result ${JSON.stringify(v)}`);
  } catch (e) {
    if (!(e instanceof SE.EffectEngineLimit || e instanceof SE.EffectProgramError)) throw e;   // a ctx query threw: as JS
    note(`${id} ${hookName}: ${e.message}`);
  }
  return SE.neutralOf(hookName, args);
}
const truthyJs = (v) => !!v;
function applyEdits(r, args, ctx) {
  if (!r) return;
  for (const e of r.edits) { const hit = args.damage?.get(e.victim)?.[e.i]; if (hit) hit.amount = e.amount; }
  for (const f of r.fx) ctx.skillFx.push(f);
}
function fold(spec, hookName, ids, ctx, args, acc, progFor, own) {
  for (const id of ids) {
    if (acc !== undefined && (spec.kind === 'or' || spec.kind === 'first') && truthyJs(acc)) break;
    const a = spec.kind === 'chain' && acc !== undefined ? { ...args, [spec.chain]: acc } : args;
    const r = runOne(progFor(id), hookName, id, ctx, a, own);
    acc = acc === undefined || spec.kind !== 'max' ? r : Math.max(acc, r);
  }
  return acc === undefined ? SE.neutralOf(hookName, args) : acc;
}
const hasProgram = (d, hookName) => d?.hooks?.[hookName] !== undefined && !SE.isJsMarker(d.hooks[hookName]);
function dataHook(hookName, skillId, ctx, args, own = null) {
  const spec = SE.HOOK_SPECS[hookName];
  const std = skillBundle().std;
  const progFor = (id) => SE.programOf(own && id === own.id ? own : defOf(id), hookName, std);
  if (spec.kind === 'single') return runOne(progFor(skillId), hookName, skillId, ctx, args, own);
  if (spec.kind === 'each') {
    const out = [];
    for (const id of args.skillIds || []) { const r = runOne(progFor(id), hookName, id, ctx, args, own); if (r != null) out.push(r); }
    return out;
  }
  // skillId null: every built-in with a program for the hook, in deal order (defend_in: Barricade → Sanctuary).
  const ids = skillId != null ? [skillId] : own ? [own.id] : SKILLS_IMPLEMENTED.filter(id => hasProgram(defOf(id), hookName));
  if (spec.kind === 'edit') { for (const id of ids) applyEdits(runOne(progFor(id), hookName, id, ctx, args, own), args, ctx); return undefined; }
  return fold(spec, hookName, ids, ctx, args, undefined, progFor, own);
}
function foldForeign(spec, hookName, ctx, args, res) {
  const ids = [...foreignIds].filter(id => hasProgram(foreignById.get(id), hookName)).sort();
  if (!ids.length) return res;
  const std = skillBundle().std;
  const progFor = (id) => SE.programOf(foreignById.get(id), hookName, std);
  if (spec.kind === 'edit') { for (const id of ids) applyEdits(runOne(progFor(id), hookName, id, ctx, args, null), args, ctx); return res; }
  return fold(spec, hookName, ids, ctx, args, res, progFor, null);
}
function shadowHook(h, hookName, skillId, ctx, args) {
  let want, got, js;
  if (SE.HOOK_SPECS[hookName].kind === 'edit') {
    // data first, on copies of the damage map and skillFx (it edits them); then JS on the real ones
    const pre = JSON.stringify([...(args.damage || [])]), n0 = ctx.skillFx.length;
    const dmg = new Map(JSON.parse(pre)), cCopy = { ...ctx, skillFx: [] };
    try { dataHook(hookName, skillId, cCopy, { ...args, damage: dmg }); got = JSON.stringify([[...dmg], cCopy.skillFx]); } catch (e) { got = `throws ${e?.message}`; }
    js = h(skillId, ctx, args);
    want = JSON.stringify([[...args.damage], ctx.skillFx.slice(n0)]);
  } else {
    js = h(skillId, ctx, args);
    want = JSON.stringify(js);
    try { got = JSON.stringify(dataHook(hookName, skillId, ctx, args)); } catch (e) { got = `throws ${e?.message}`; }
  }
  skillShadowStats.compared++;
  skillShadowStats.byHook[hookName] = (skillShadowStats.byHook[hookName] || 0) + 1;
  if (got !== want) {
    skillShadowStats.mismatches++;
    console.error(`[skills] SHADOW MISMATCH ${hookName} ${skillId}\n  js:   ${want}\n  data: ${got}`);
    if (ENGINE_ENV.SKILL_SHADOW_STRICT === '1') throw new Error(`skills shadow mismatch in ${hookName} (${skillId})`);
  }
  return js;
}
if (SKILL_ENGINE !== 'js') {
  skillBundle();   // fail fast on a bad definition
  if (ENGINE_ENV.SKILL_SHADOW_REPORT === '1') process.on('exit', () => console.log(`[skills] ${SKILL_ENGINE}: ${bundle.defs.size} data skills; shadow compared ${skillShadowStats.compared}, mismatches ${skillShadowStats.mismatches}, errors ${skillShadowStats.errors} ${JSON.stringify(skillShadowStats.byHook)}`));
}

// validateSkillDef(def, {libs, libMap}) → [errors] — a definition file (chaosd6.skill/1). JS markers only for built-ins.
export function validateSkillDef(def, opts = {}) {
  return SE.validateSkillDef(def, { ...opts, builtin: BUILTIN_IDS.has(def?.id) && !foreignIds.has(def?.id) });
}
const prepared = new WeakMap();
// resolveSkillProgram(def, hookName, ctx, args) → what skillHook(hookName, def.id, ctx, args) returns when only
// this definition plays the hook (no other built-in, no foreign skill): its program, else the std default, else
// the hook's neutral value. Pass hooks: a built-in's JS hook ({engine: 'js'} marker), else undefined. damage_in
// edits args.damage / ctx.skillFx in place like the JS hook. An invalid definition throws.
export function resolveSkillProgram(def, hookName, ctx, args = {}) {
  const spec = SE.HOOK_SPECS[hookName];
  if (!spec) throw new Error(`skills.mjs: unknown hook ${hookName}`);
  let own = def.$subs ? def : prepared.get(def);
  if (!own) {
    const errs = validateSkillDef(def);
    if (errs.length) throw new Error(`skill ${def?.id}: ${errs.join('; ')}`);
    own = SE.bindSkillDef(JSON.parse(JSON.stringify(def)));
    prepared.set(def, own);
  }
  if (spec.kind === 'pass') {
    const m = own.hooks?.[hookName];
    return SE.isJsMarker(m) && BUILTIN_IDS.has(own.id) && m.impl.startsWith('skills.mjs') ? HOOKS[hookName](own.id, ctx, args) : undefined;
  }
  return dataHook(hookName, spec.kind === 'each' ? null : own.id, ctx, args, own);
}
// registerForeignSkill(key, id, flags, hooks[, {meta, uses, libs, name, version}]) → the bound definition.
// flags: SKILL_RULES-style (action, permanent, pointBuyStat, negating, keepsTarget, …) and/or validator keys;
// hooks: {hookName: program} — data hooks only (a foreign skill cannot take part in the JS pass hooks yet).
// Throws on a built-in id or an invalid definition.
export function registerForeignSkill(key, id, flags, hooks, opts = {}) {
  if (BUILTIN_IDS.has(id)) throw new Error(`registerForeignSkill: ${id} is a built-in skill`);
  const f = { ...(flags || {}) }, meta = opts.meta || {};
  const pbs = f.pointBuyStat ? (f.pointBuyStat === 'any' ? 'any' : `stat_${String(f.pointBuyStat).replace(/^stat_/, '')}`) : null;
  const def = {
    schema: SE.SKILL_SCHEMA_ID, id, name: opts.name || id, version: opts.version || '0.0.0',
    action_type: meta.action_type ?? f.action, is_permanent: meta.is_permanent ?? !!f.permanent,
    point_buy_stat: meta.point_buy_stat !== undefined ? meta.point_buy_stat : pbs,
    flags: f, uses: opts.uses || [SE.STD_LIB_ID], hooks: JSON.parse(JSON.stringify(hooks || {})),
  };
  const libs = opts.libs || SE.defaultLibs();
  const errs = SE.validateSkillDef(def, { libs, builtin: false });
  if (errs.length) throw new Error(`registerForeignSkill ${id}: ${errs.join('; ')}`);
  SE.bindSkillDef(def, libs);
  foreignByKey.set(key, def); foreignById.set(id, def); foreignIds.add(id);
  SKILL_RULES[id] = { action: def.action_type, permanent: def.is_permanent, ...(def.is_permanent ? { pointBuyStat: def.point_buy_stat === 'any' ? 'any' : def.point_buy_stat.replace(/^stat_/, '') } : {}), ...f };
  if (SKILL_RULES[id].negating) NEGATING_SKILLS.add(id); else NEGATING_SKILLS.delete(id);
  return def;
}
export const isForeignSkillId = (id) => foreignIds.has(id);
export const foreignSkillDef = (keyOrId) => foreignByKey.get(keyOrId) || foreignById.get(keyOrId) || null;
// Tests only: forget every foreign skill.
export function clearForeignSkills() {
  for (const id of foreignIds) { delete SKILL_RULES[id]; NEGATING_SKILLS.delete(id); }
  foreignByKey.clear(); foreignById.clear(); foreignIds.clear();
}
