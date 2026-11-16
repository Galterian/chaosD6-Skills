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
  3 negate_kind              Grapple → Disruption Move → Overrun          pass 2, one-kind prohibitions
    (peer: Confusion, natural Mists, class stances, r.action / r.trance finalised)
  4 trance_assign            Battle Trance                                option per adjacent enemy → r.vs / r.played
    block_cost               Ranged Weapon                                Reaver auto-target cost
    (peer: movement — noMove from Overrun vetoes 'move negated by Overrun')
    (peer: Bard shares skills using rides)
    perm_stats               every permanent skill                        Rule 24 destroyable stats
  5 strike() per hit         block_in (Ranged) → attack_out (Powerful) → [Assassin] → attack_target (Taunt)
                             → [Inner Fire, buildings] → defend_in (Barricade → Sanctuary) → [untouchable, shield token]
  6 damage_in                Dodge                                        after all strikes, on the damage map
  7 effect hit legs          effect_in / effect_leg (Force Shield)        die before rounding, first landing leg
doResolution() after the run:
  8 disposition              all non-permanent skills                     Rule 8 card bookkeeping (user ruling 2026-11-12)
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
| `negate_kind` | Grapple, Disruption Move, Overrun | same | P → EP (Grapple, Disruption), `noMove.add` + `skillFx` (Overrun on M/EM) | simulate pass 2 | same; Overrun negates the move (movement veto reads `noMove`) |
| `trance_assign` | Battle Trance | ctx: `reveals, view, viewValues, enemyOf, hiddenFrom, dist, edgeDmg`; args `{byActor, codeVs, attacksOn}` | writes `r.vs` (enemy → option), `r.played` | simulate after r.action/r.trance are final | damage matrix 2026-11-05 (via edgeDmg); an A option hits one enemy |
| `block_cost` | Ranged Weapon | `{attacker, defender}` | 1 if the defender Blocks and the attacker is not ranged | Reaver EP/EM auto-target | Reaver EM/EP fight as Attack |
| `block_in` | Ranged Weapon | `{defender}` (the attacker the Block meets) | true = the Block deals nothing | `strike` code B | — |
| `attack_out` | Powerful Attack | `{attacker, dmg}` | dmg + 1 if dmg ≥ 1 | `strike` code A | bonus rounds: base damage only (dmg passed already clamped) |
| `attack_target` | Taunt | `{attacker, defender}` | true = this Attack deals 0 (an adjacent revealer taunts) | `strike` code A, after Assassin | — |
| `defend_in` | Barricade, Sanctuary | `{code, defender, dmg, byActor}`; `skillId` null = both in order | dmg or 0 | `strike`, after building bonuses | Sanctuary "until you emit or act": resting = declared EP |
| `damage_in` | Dodge | `{damage}` (Map victim → entries) | edits the first `action` entry −1, pushes `skillFx {what:'damage'}` | after all strikes | Dodge = one less combat damage this action, not per attacker |
| `effect_in` | Force Shield | `{defender}`; ctx `hasPerm, permPower` | shield die (0 when none) | effect-hit pass, per hit | **Force Shield die absorbs before rounding** |
| `effect_leg` | Force Shield | `{shield, sum}` | `{shield, sum, spent}` — absorbs only on a leg that would land (round(sum) > 0) | effect-hit pass, per leg | same; spent → `brokenShield` → permanent falls |
| `disposition` | all | `{fx, self}`, ctx `skillData` | `permanent · negated · countered · spent · unused · judge` | Rule 8 loop in doResolution | 2026-11-12: negating skills judged by whether they did their job; `judge` = Rule 8 counterfactual (stays in peer: needs `runRound`) |
| `end_round` | Sanctuary | `{reveal}` (my reveal) | true = Sanctuary falls (declared ≠ EP, any non-building skill, any effect) | doResolution after the run | Sanctuary ends on any action/emission |
| `perm_landing` | permanent skills | `{skillIds, playedCodes, stats}` | `[{id, stat}]` (`any` → best stat) | doResolution after the run; peer rolls `pointBuyPermanent` | Rule 12 (highest die = power) |
| `perm_stats` | permanent skills | `skillId` | stats it can be destroyed by | simulate `permStats`, npc `_npcPermStats` | Rule 24 |

## Registers a hook reads or writes (owned by simulate, passed in `skCtx`)

`effAction` Map id → code · `tranceOpts` Map id → [code, code] · `noMove` Set · `counterPen` Map id → {elem: amount}
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

## Unmodelled paper text (unchanged by S1, documented for S2)

Powerful Attack "only Attack until end of round"; Overrun swap places / alt push; Grapple shared-tile ban; Ranged Weapon
"does not trigger traps, follow rule"; Taunt "cannot Block against you"; Barricade stops every A/B strike (strikes are adjacent anyway); Sanctuary
protects permanents / tokens; Disruption Move "EP played as EM"; Intimidation "until end of round" (one action only).
