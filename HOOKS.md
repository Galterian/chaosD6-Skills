# Skill hooks (chaosD6-Skills, milestone S1)

The 14 skills of `data/skills.json` had no pure module: their rules were inline in `game/peer.mjs`.
S1 moves the RULE logic into `game/skills.mjs` — the `SKILL_RULES` table (flags, like `effects.mjs#EFFECT_RULES`)
and pure hooks behind `skillHook(hookName, skillId, ctx, args) → result`. peer.mjs keeps the plumbing (reveals,
snapshots, card movement, logs to the UI) and calls the hooks at the old places (grep `S1` in peer.mjs).
Behaviour is byte-identical: `node tools/skills-check.mjs` replays every hook against a verbatim copy of the
pre-S1 inline code on ≥ 300 seeded random worlds (2000 by default; `SKILLS_CHECK_N=…`), plus the worked
examples of the user's rulings. No wire / snapshot / state-hash field changed.

**S2:** the data hooks below also exist as JsonLogic programs in `skills/<id>.json` (schema and the data / JS split:
`SCHEMA.md`); `SKILL_ENGINE=data|shadow` runs them, the pass hooks (counter_pre, negate_action, negate_kind,
trance_assign) stay JS. Identity: `node tools/skill-engine-check.mjs`.

## Where a skill acts in one action (resolver order)

```
planning (doPlanningEnd)     rides · plan_target                         which queued skill cards ride on the action
simulate():
  building skill injection   (peer: r.skills += building skill, r.buildingSkill)
  1 counter_pre              Counter Spell                                before every other skill (Rule 8 "replacement")
  2 negate_action            Bluff → Intimidation                         pass 1, whole-action prohibitions
  3 negate_kind              Grapple → Disruption Move → Overrun          pass 2, one-kind prohibitions (+ noEmit, swaps registers)
    (peer: Confusion, natural Mists, class stances, r.action / r.trance finalised)
  4 trance_assign            Battle Trance                                option per adjacent enemy → r.vs / r.played
    block_cost               Ranged Weapon                                Reaver auto-target cost
    (peer: movement — noMove from Overrun / Disruption vetoes 'move negated by Overrun'; SKR: Overrun swaps trade hexes after the moves)
    (peer: Bard shares skills using rides)
    perm_stats               every permanent skill                        Rule 24 destroyable stats
  5 strike() per hit         attack_range (Ranged: reach, SKR) → block_in (Ranged, Taunt) → attack_vs_block (Taunt, SKR)
                             → attack_out (Powerful) → [Assassin] → attack_target (Taunt)
                             → [Inner Fire, buildings] → defend_in (Barricade → Sanctuary) → [untouchable, shield token]
  6 damage_in                Dodge                                        after all strikes, on the damage map
  7 effect hit legs          effect_in / effect_leg (Force Shield)        die before rounding, first landing leg
                             defend_in code 'effect' (Sanctuary, SKR)     effect damage on a resting / moving holder → 0
doResolution() after the run:
  8 disposition              all non-permanent skills                     Rule 8 card bookkeeping (user ruling 2026-11-12)
    plan_lock                Powerful Attack (SKR)                        a skill that stayed played limits my next actions this round
  9 end_round                Sanctuary (leaves) · Force Shield (spent: brokenShield from 7)
 10 perm_landing             permanent skills                             what lands + Rule 12 point-buy stat
```

## Hook table

| hook | skills | inputs (`ctx` fields / `args`) | output | call site (peer.mjs) | user rulings |
|---|---|---|---|---|---|
| `rides` | all | `{codes, req}` (action codes played; skill's `action_type`) | bool: rides — own code, or M/P on EM/EP | planning `ridesOn`, resolver `ridesFor`, Bard share | soft slots (M/P ride on Empty) |
| `plan_target` | Counter Spell (`keepsTarget`) | `{skillIds}` | bool: a Posture keeps the character target | planning `effectNeedsTarget` | Rule 15 pc override |
| `counter_pre` | Counter Spell | ctx: `reveals, byActorPre, effAction, tranceOpts, counterPen, skillFx, enemyOf, hiddenFrom, dist, lifeOf, view, elemStat, castsDamage, effectDmgNoShield, skillData, log/self/label` | mutates `o.skills` (strips non-permanent), `counterPen` (+MY stat on ONE element), `effAction/tranceOpts` (trance collapses to card 1), pushes `skillFx {what:'skills', countered}` | simulate, before pass 1 | **Counter Spell = pick one element, subtract MY stat per instance** (Lightning Matter 16 vs 8 → 1); counter target skill = discarded; actor order breaks mutual counters |
| `negate_action` | Bluff, Intimidation | ctx: as above + `codeIs, replace` | mutates `effAction/tranceOpts` (→ EP), `o.skills`, `skillFx {negated, ridden}` / `{countered}` | simulate pass 1 | negating instants (2026-11-12): negated action's card + riders back to THEIR hand; Intimidation negates adjacent Attacks first, else counters a non-permanent skill; auto-target adjacent enemy, attackers first |
| `negate_kind` | Grapple, Disruption Move, Overrun | same + optional `noEmit` (Set), `swaps` (array) | Grapple P → EP; Disruption: the ENEMY's P (negated) / EP → EM, `noMove`, `noEmit.add` when it carries a non-instant effect (fx `what:'EP'` when only that was stopped); Overrun: `noMove.add` + `skillFx` on M/EM, and `swaps.push({by, on})` for a character-targeted Attack on an adjacent enemy (fx `what:'swap'` when nothing was negated) | simulate pass 2 | Overrun negates the move (movement veto reads `noMove`); **2026-11-16: Disruption EP → EM (no emission), Overrun swap** — without the registers (peer before the SKR hunks) those two clauses are off |
| `trance_assign` | Battle Trance | ctx: `reveals, view, viewValues, enemyOf, hiddenFrom, dist, edgeDmg`; args `{byActor, codeVs, attacksOn}` | writes `r.vs` (enemy → option), `r.played` | simulate after r.action/r.trance are final | damage matrix 2026-11-05 (via edgeDmg); an A option hits one enemy |
| `block_cost` | Ranged Weapon | `{attacker, defender}` | 1 if the defender Blocks, unless the attacker is ranged and the defender beyond contact | Reaver EP/EM auto-target | Reaver EM/EP fight as Attack; 2026-11-16 an adjacent Block costs a ranged attacker too |
| `block_in` | Ranged Weapon, Taunt | `{defender, blocker}` (defender = the unit whose Attack the Block meets); `skillId` null = both, deal order | true = the Block deals nothing — Ranged: holder and blocker beyond contact (> 1); Taunt: the defender taunts and the enemy blocker is within its range (1) | `strike` code B (SKR: id null + blocker; before: Ranged only, no blocker = out of contact = the old result) | **2026-11-16** Ranged: a Block from 2 hexes deals nothing, an adjacent one its regular 1 ("no bonuses on nearby enemy"); Taunt "cannot Block against you" |
| `attack_range` | Ranged Weapon | `{attacker, code}` | hexes a strike reaches: the holder's Attack = flag `range` (2), everything else 1 | `strike` distance test (SKR) | **2026-11-16** "+1 range"; Move / Posture with no contact do nothing |
| `attack_out` | Powerful Attack | `{attacker, dmg}` | dmg + 1 if dmg ≥ 1 | `strike` code A | bonus rounds: base damage only (dmg passed already clamped) |
| `attack_target` | Taunt | `{attacker, defender}` | true = this Attack deals 0 (an adjacent revealer taunts — every nearby enemy, every ally it attacks) | `strike` code A, after Assassin | 2026-11-16 confirmed: all nearby enemies |
| `attack_vs_block` | Taunt | `{attacker, defender}` | true = the defender's Block does not count against this Attack (matrix as vs an Empty action: 1) | `strike` code A vs B (SKR) | **2026-11-16** "cannot Block against you" |
| `defend_in` | Barricade, Sanctuary | `{code, defender, dmg, byActor}`; `skillId` null = both in order; code `'effect'` = effect damage (SKR) | dmg or 0 | `strike`, after building bonuses; effect hits (SKR) | **2026-11-16** Sanctuary holds while the holder only Moves / Empty Moves / rests — `sanctuaryBreaks(reveal)`: another code (a trance option too), a non-building skill, an effect or a destroy emission ends it, unprotected in that action |
| `damage_in` | Dodge | `{damage}` (Map victim → entries) | edits the first `action` entry −1, pushes `skillFx {what:'damage'}` | after all strikes | Dodge = one less combat damage this action, not per attacker |
| `effect_in` | Force Shield | `{defender}`; ctx `hasPerm, permPower` | shield die (0 when none) | effect-hit pass, per hit | **Force Shield die absorbs before rounding** |
| `effect_leg` | Force Shield | `{shield, sum}` | `{shield, sum, spent}` — absorbs only on a leg that would land (round(sum) > 0) | effect-hit pass, per leg | same; spent → `brokenShield` → permanent falls |
| `disposition` | all | `{fx, self}`, ctx `skillData` | `permanent · negated · countered · spent · unused · judge` | Rule 8 loop in doResolution | 2026-11-12: negating skills judged by whether they did their job; `judge` = Rule 8 counterfactual (stays in peer: needs `runRound`) |
| `end_round` | Sanctuary | `{reveal}` (my reveal) | true = Sanctuary falls (`sanctuaryBreaks`) | doResolution after the run | 2026-11-16: moving / resting keeps it |
| `perm_landing` | permanent skills | `{skillIds, playedCodes, stats}` | `[{id, stat[, power]}]` (`any` → best stat; `power` = the data's `fixed_power`) | doResolution after the run; peer rolls `pointBuyPermanent` unless `power` (SKR) | Rule 12 (highest die = power); **2026-11-16 Force Shield "always power 6"** (no roll) |
| `perm_stats` | permanent skills | `skillId` | stats it can be destroyed by | simulate `permStats`, npc `_npcPermStats` | Rule 24 |
| `plan_lock` | Powerful Attack | `{paid}` (the card did not return to my hand) | the codes I may still play this round (`['A']`) or null | doResolution after the Rule 8 loop → `entity.planOnly`; doPlanningEnd turns any other plan into a bare Empty Posture (SKR) | **2026-11-16** "cannot perform any other action except Attack until end of round" |

## Registers a hook reads or writes (owned by simulate, passed in `skCtx`)

`effAction` Map id → code · `tranceOpts` Map id → [code, code] · `noMove` Set · `noEmit` Set (optional, 2026-11-16) · `swaps` [{by, on}] (optional, 2026-11-16) · `counterPen` Map id → {elem: amount}
(read back by `casterStat` → effects ctx `statFor`) · `skillFx` [{by, skill, on, what, negated?, ridden?, countered?, building}]
(read by disposition and the UI burn) · `reveals[*].skills / .trance / .vs / .played`.

## Stays in peer.mjs (not rule logic, or not separable without changing behaviour)

- Card dealing (`makeSkillCard`, `FORCE_SKILLS`, `cardFromRef`), hand / holding moves, `releaseHeld`, UI notices (`skill fx:` lines).
- Building skill injection (`buildingPowerAt` → `r.skills`, `r.buildingSkill`) — building logic (js/building-bonus.js).
- Bard (class) sharing loop — uses `rides`; Kensei recovers a skill card (class).
- Rule 8 counterfactual (`roundWithout`, `paysOff`) for `judge` skills — needs the whole `runRound`.
- Movement veto text 'move negated by Overrun' (also used by Confusion through the same `noMove`).
- `entity.permanents` / `permPower` writes, `pointBuyPermanent` dice (salt `${salt}:perm:${id}:${action}`).
- Bots: `npcPlan` and `tools/swarm-test.mjs` only choose skills that ride (`requires`), no per-skill policy.
- UI tables: `profile.mjs` now imports the lists from skills.mjs; `js/skill_card.js` glyphs, `js/building-bonus.js` `BUILDING_SKILLS` (S6).

## Unmodelled paper text (after the 2026-11-16 SKILL REBALANCE)

Overrun alt push; Grapple shared-tile ban; Ranged Weapon "does not trigger traps, follow rule"; Barricade stops every A/B strike
(strikes are adjacent anyway); Sanctuary protects permanents / tokens; Intimidation "until end of round" (one action only — user:
do not change).
Implemented 2026-11-16 (resolver side = the `SKR` hunks of tools/out/_rb_peer_hunks.py): Powerful Attack lock (plan_lock),
Overrun swap (swaps), Taunt "cannot Block against you" (block_in, attack_vs_block), Disruption Move "EP played as EM" (noEmit),
Ranged Weapon +1 range (attack_range), Sanctuary holds while moving (defend_in / end_round, effect damage too), Force Shield fixed
power 6 (perm_landing power).
