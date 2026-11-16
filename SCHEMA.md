# Skill definitions as data (chaosD6-Skills, milestone S2)

A skill is one JSON file `skills/<skill_id>.json` (schema `chaosd6.skill/1`). Its `hooks` map the hook points of
`game/skills.mjs#skillHook` (inventory, call sites, resolver order: `HOOKS.md`) to programs in the effects'
JsonLogic dialect (`game/effects-data/SCHEMA.md` — same evaluator, op budget, depth limit). Shared subroutines and
the std programs live in `lib/<id>.json` (schema `chaosd6.skill-lib/1`). Engine: `game/skill-engine.mjs`, dispatch:
`game/skills.mjs`. Structural JSON schema of both file kinds: `skill.schema.json`.

```
game/skills-data/
  SCHEMA.md  skill.schema.json  HOOKS.md
  skills/skill_dodge.json …          one definition per skill (14 built-ins)
  lib/skills_std.json                subroutines + the std programs of the per-skill hooks
```
S3 (`tools/skills-repo-sync.mjs`) mirrors this layout into the chaosD6-Skills repo; S5's validator reads the same files.
A content hash of a skill must cover the skill file AND every library it `uses`.

## Engine switch

`SKILL_ENGINE=js` (default) | `data` | `shadow`, read once by `skills.mjs`:
- `js` — unchanged: the S1 JS hooks.
- `data` — every hook marked **data** below runs the program of the skill's definition (`SKILL_DEFS_DIR=<dir>` points
  the loader elsewhere); the **js** hooks stay on JS.
- `shadow` — both run; results must be JSON-identical (key order included; for `damage_in` the edited damage map and
  the pushed `skillFx`); a mismatch goes to stderr (`[skills] SHADOW MISMATCH …`), `SKILL_SHADOW_STRICT=1` throws;
  the JS result is returned. `SKILL_SHADOW_REPORT=1` prints a tally at exit.
- A program error or limit in `data` mode gives the hook's **neutral value** (what the JS hook returns when the skill
  is not in play) and a `[skills] data hook:` line on stderr — deterministic on every peer. A ctx query that throws
  propagates (same as JS).
- `planning` calls `ridesOn` directly (peer.mjs), so `rides` in data only changes `skillHook('rides', …)` callers.

API (skills.mjs): `skillHook(hook, id, ctx, args)`, `resolveSkillProgram(def, hook, ctx, args)` (run ONE definition —
S5's audit), `validateSkillDef(def, {libs|libMap})`, `registerForeignSkill(key, id, flags, hooks[, opts])`,
`isForeignSkillId(id)`, `foreignSkillDef(keyOrId)`, `clearForeignSkills()` (tests), `skillBundle()`, `SKILL_ENGINE`,
`skillShadowStats`. skill-engine.mjs: `loadSkillDefs`, `validateSkillDef`, `validateSkillLib`, `HOOK_SPECS`,
`SKILL_OPS`, `SKILL_CTX_OPS`, `SKILL_LIMITS`, `runHookProgram`, `neutralOf`, `resultOk`.

## Definition fields

| field | meaning |
|---|---|
| `schema` | `"chaosd6.skill/1"` |
| `id`, `name`, `version` | `skill_[a-z0-9_]+`, display name, semver of THIS definition |
| `source` | provenance of the metadata (`data/skills.json` active version) |
| `action_type` | `A · M · B · P` — the action card it rides on (M / P also on EM / EP; Battle Trance on anything) |
| `is_permanent`, `point_buy_stat` | permanent (Rule 12 landing, Rule 24 destruction) and its stat `stat_vitality · stat_world · stat_matter · stat_will · any`; `null` for an instant |
| `element`, `text` | optional, from data/skills.json (documentation) |
| `flags` | resolver + validator metadata (below) |
| `uses` | library ids whose subroutines `call` may name (`["skills_std"]`) |
| `hooks` | `{ <hook>: <program> }` or, for a built-in hook kept in JS, `{ <hook>: {"engine": "js", "impl": "skills.mjs#…", "note": "…"} }` |

### `flags` — two vocabularies in one object

| vocabulary | keys | read by | checked by |
|---|---|---|---|
| **resolver** (= `skills.mjs#SKILL_RULES[id]`, same key order) | `action`, `permanent`, `pointBuyStat` (`'any'`), `negating` (judged by whether it did its job — ruling 2026-11-12), `hooks` (the hook points it acts in, incl. peer-side `plan` / `move`), `range`, `negates`, `keepsTarget`, `trance`, `attackBonus`, `damageOff` | peer.mjs / bots / UI (via SKILL_RULES); in `data` mode the programs read them with `skill_flag` | skill-engine-check: equal to SKILL_RULES |
| **validator** (S5 `skills-rebalancing-check.mjs#FLAG_KEYS`, what a skill is priced by) | `attackBonus`, `damageOff`, `negate {codes, who, mode}`, `altCounterSkill`, `counterSkill`, `counterElement`, `trance`, `blockImmune`, `trapImmune`, `tauntGuard`, `immuneTo`, `restInvincible`, `effectShield` | the validator (`normalizeDef` drops the resolver-only keys `hooks negating range keepsTarget notes action permanent pointBuyStat negates`) | skill-engine-check: equal to `BUILTIN_FLAGS[id]`; S5: a built-in is ok in baseline mode |

Shared keys (`attackBonus`, `damageOff`, `trance`) mean the same in both and carry the same value. Every other key
belongs to exactly one vocabulary; an unknown key is an error for the validator.

## Hooks

Every program sees the registers below plus `skill` (its own id — a program tests `has_skill(attacker, skill)`, not a
literal id, so a foreign copy works unchanged). Maps arrive as `[[key, value]…]` pairs (`call pair_get`), Sets as arrays.
`kind` = how `skillHook` combines the participants of one call: the named built-in (or, with id `null`, every
built-in with a program, in deal order), then registered foreign skills in id order.

| hook | engine | kind | registers | result | std default |
|---|---|---|---|---|---|
| `rides` | data | single | `codes, req` | bool | `rides` |
| `plan_target` | data | single | `skillIds` | bool (any skill with `flags.keepsTarget`) | `plan_target` |
| `counter_pre` | **js** | pass | — (edits `o.skills`, `counterPen`, `effAction/tranceOpts`, `skillFx`) | — | |
| `negate_action` | **js** | pass | — (edits `effAction/tranceOpts`, `o.skills`, `skillFx`) | — | |
| `negate_kind` | **js** | pass | — (edits codes, `noMove`, `skillFx`) | — | |
| `trance_assign` | **js** | pass | — (writes `r.vs`, `r.played`) | — | |
| `block_in` | data | or | `defender, blocker` | truthy = the Block deals nothing | |
| `block_cost` | data | max | `attacker, defender` | number | |
| `attack_range` | data | max | `attacker, code` | hexes the strike reaches (neutral 1) | |
| `attack_out` | data | chain `dmg` | `attacker, dmg` | dmg | |
| `attack_target` | data | or | `attacker, defender` | truthy = this Attack deals 0 | |
| `attack_vs_block` | data | or | `attacker, defender` | truthy = the defender's Block does not count against this Attack | |
| `defend_in` | data | chain `dmg` | `code, defender, dmg, byActor` (pairs id → reveal with `declared`) | dmg | |
| `damage_in` | data | edit | `damage` (pairs victim → `[{source, amount, attacker}]`) | `{edits: [{victim, i, amount}], fx: [skillFx records]}` — the dispatcher sets `damage[victim][i].amount` and pushes `fx`, in order | |
| `effect_in` | data | first | `defender` | the shield die (0 = none) | |
| `effect_leg` | data | single | `shield, sum` | `{shield, sum, spent}` | |
| `end_round` | data | single | `reveal` (my reveal) | bool: Sanctuary falls | |
| `perm_landing` | data | each id of `skillIds` | `skillIds, playedCodes (array or null), stats` + `skill` = that id | `{id, stat[, power]}` or null (nulls dropped; `power` 1–6 = a fixed landing power, no roll) | `perm_landing` |
| `perm_stats` | data | single | — | `[stat…]` | `perm_stats` |
| `disposition` | data | single | `fx, self` | `permanent · negated · countered · spent · unused · judge` | `disposition` |
| `plan_lock` | data | single | `paid` | the action codes still allowed this round, or null (neutral) | |

A result of the wrong shape (e.g. a string from `attack_out`) is replaced by the neutral value. Force Shield's
`end_round` is marked `{"engine": "js", "impl": "peer.mjs#endRound"}`: the falling of a spent shield is peer
bookkeeping (the die spent by `effect_leg`), there is no rule left to run.

**Data / JS split (S2):** data — `rides, plan_target, block_in, block_cost, attack_range, attack_out, attack_target,
attack_vs_block, defend_in, damage_in, effect_in, effect_leg, end_round, perm_landing, perm_stats, disposition, plan_lock`
(attack_range, attack_vs_block, plan_lock and block_in's `blocker`: SKILL REBALANCE 2026-11-16); JS — `counter_pre, negate_action,
negate_kind, trance_assign` (Counter Spell, Bluff, Intimidation, Grapple, Disruption Move, Overrun, Battle Trance).

### Moving the pass hooks to data (next milestone)

They edit the resolver's registers in place and later skills read the edits of earlier ones in the same pass
(Intimidation sees Bluff's EP; Overrun's target choice reads codes rewritten by Grapple; Counter Spell's
`bestElem` writes and restores `counterPen` while it probes). A data version needs an **ordered edit record**, the
generalisation of `damage_in`: the dispatcher runs the participants one reveal at a time in the old order, each
program returns `[{op: 'set_code'|'replace_code'|'drop_trance'|'strip_skills'|'no_move'|'pen'|'fx'|'vs', …}]`, and the
dispatcher applies them before the next program runs (so `code_is`, `reveal_of` see the edits). Plus: a pure
`effect_dmg_with_pen(o, def, pen)` query (so Counter Spell can probe without mutating `counterPen`), `codeVs` /
`attacksOn` as ctx queries for `trance_assign`, and the Map-valued `r.vs` written from an `{enemy: index}` result.
The identity method stays the same (skills-check worlds + skill-engine-check ≥ 600 cases per skill per hook).

## Vocabulary (`SKILL_OPS`, 90 ops)

The effects' control forms and pure ops (`effects-data/SCHEMA.md` — `if and or seq let set call var quote obj map
filter find all some none reduce sort_by range`, maths, strings, lists, `??`, `bool`) **minus** the outcome / dice
forms (`emit put out note return return_empty seed hash_int rng point_buy point_buy_seed` — refused at load and at run
time), plus the skill ctx queries (read-only; registers come back as arrays):

| query | = resolver ctx |
|---|---|
| `has_skill [id, skill]` | `byActorPre.get(id).skills` includes skill |
| `from_building [by, skill]` | `byActorPre.get(by).buildingSkill === skill` |
| `reveal_of id`, `reveals` | the reveal of an actor (or null), all reveals of the action |
| `code_is [id, code]` | trance-aware code test |
| `has_perm [id, perm]`, `perm_power id` | permanents, powers `{perm: die}` |
| `enemy_of [a, b]`, `hidden_from [viewer, id]`, `dist [a, b]`, `life_of id` | sides, invisibility, hex distance, life |
| `view id`, `views` | one snapshot (or null) / all snapshots in view order |
| `elem_stat el`, `edge_dmg [atk, def]` | ELEM_TO_STAT, the damage matrix |
| `casts_damage o`, `effect_dmg [o, def]` | effect queries (effect_dmg reads counterPen) |
| `skill_data id` | the skill's data/skills.json `data` (a foreign skill: its metadata) |
| `skill_flag [id, key]` | a key of the skill's `flags` |
| `ctx_self`, `ctx_has name` | my peer id; whether the ctx has a query |

New pure op in effect-engine.mjs (S2): `bool x` = JS `!!x` (JsonLogic `!!` treats `[]` as false).

**Limits** (`SKILL_LIMITS`): 20 000 evaluated operations per hook call, depth 64, `range` ≤ 256.

## Library `skills_std` (lib/skills_std.json)

`defaults` names the std program of each per-skill hook; `subs`: `pair_get pairs key`, `strip_stat s`
(`stat_matter` → `matter`), `rides`, `plan_target`, `perm_landing`, `perm_stats`, `disposition` (the S1 rules, see
HOOKS.md). A skill file lists the std hooks it relies on as `{"call": ["perm_stats"]}` (same program).

## Foreign skills (S4)

`registerForeignSkill(key, id, flags, hooks[, {meta, uses, libs, name, version}])` validates (`builtin: false` — no JS
markers, data hooks only), binds the libraries, adds `flags` to `SKILL_RULES` (never over a built-in) and, when
`flags.negating`, to `NEGATING_SKILLS`; dealing (`SKILLS_IMPLEMENTED`) is unchanged. The last registration of an id
wins. From then on the skill takes part in every data hook it has a program for — after the built-ins, foreign ids in
code-unit order — in every `SKILL_ENGINE` mode; its per-skill hooks (`perm_stats`, `disposition`, …) run its own program
or the std default on its metadata. It cannot act in the JS pass hooks yet.

## Example (Dodge)

```json
"damage_in": {"let":[{"hits":{"filter":[{"map":[{"var":"damage"},
  {"if":[{"has_skill":[{"at":[{"var":"e"},0]},{"var":"skill"}]},
    {"let":[{"h":{"find":[{"map":[{"at":[{"var":"e"},1]},{"obj":{"i":{"var":"i"},"source":{"var":"d.source"},"amount":{"var":"d.amount"},"attacker":{"var":"d.attacker"}}},"d"]},
                          {"and":[{"===":[{"var":"x.source"},"action"]},{">":[{"var":"x.amount"},0]}]},"x"]}},
      {"if":[{"var":"h"},{"obj":{"victim":{"at":[{"var":"e"},0]},"i":{"var":"h.i"},"amount":{"-":[{"var":"h.amount"},1]},"attacker":{"var":"h.attacker"}}},null]}]},
    null]},"e"]},{"var":"y"},"y"]}},
  {"obj":{"edits":{"map":[{"var":"hits"},{"obj":{"victim":{"var":"h.victim"},"i":{"var":"h.i"},"amount":{"var":"h.amount"}}},"h"]},
          "fx":{"map":[{"var":"hits"},{"obj":{"by":{"var":"h.victim"},"skill":{"var":"skill"},"on":{"var":"h.attacker"},"what":"damage","building":{"from_building":[{"var":"h.victim"},{"var":"skill"}]}}},"h"]}}}]}
```

## Validate

`node tools/skill-engine-check.mjs` (files, flags, ≥ 600 seeded cases per skill per data hook vs the JS hooks,
rejection, limits, foreign API, skills-check under shadow / data) and `SKILL_ENGINE=shadow SKILL_SHADOW_STRICT=1 node
tools/skills-check.mjs`. Pricing: `node tools/skills-rebalancing-check.mjs check skills-data/skills/<id>.json`.
