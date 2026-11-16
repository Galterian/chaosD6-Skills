# chaosD6-Skills

The skills of chaosD6, defined as data (JsonLogic hooks). One skill per file:

```
skills/<id>.json       one skill definition; "id" inside == file name
lib/<id>.json          shared sub-routine libraries a skill lists in "uses"
SCHEMA.md              the definition format (mirrored from chaosD6 game/skills-data/SCHEMA.md)
HOOKS.md               the resolver hook points a skill can attach to (game/skills-data/HOOKS.md)
index.json             manifest: id -> sha256 of the canonical JSON, for skills and lib
validator/pin.json     which validator build gates merges into main (commit + sha256)
tools/                 everything needed to check a skill OFFLINE — see tools/README.md
  manifest.mjs         index.json generator / checker
  check.mjs            schema + pinned engine + pinned validator:  node tools/check.mjs skills/<id>.json
  engine/              copy of the pinned chaosD6 engine (effect-engine.mjs, skills.mjs hook runner)
  validator/           copy of the pinned skills validator (+ calibration)
  pins.json            sha256 of every file in engine/ and validator/
```

## Identity of a skill

A skill is identified by **sha256 of its canonical JSON** (object keys sorted, no whitespace,
arrays in order), not by its name or path. Peers in a game exchange refs:

```json
{ "repo": "rad:z…", "branch": "players/alice/mirror-step", "commit": "<40 hex>", "sha256": "<64 hex>", "id": "skill_mirror_step" }
```

A peer that lacks the skill fetches `skills/<id>.json` at `commit` from anyone (seed, peer,
local clone) and accepts it only if the sha256 matches. Libraries are fetched the same way
(`lib/<id>.json`, own sha256). Reformatting a file does not change its sha256; changing any
value does — that is a new skill version.

## Branches

| branch | contents | who writes |
|---|---|---|
| `main` | the built-in skills the game ships with | the chaosD6 delegate(s) only |
| `players/<nid-or-name>/<skill-slug>` | `main` + exactly one new or changed `skills/<id>.json` | that player (in their own Radicle namespace) |

Rules:
- **One skill per file**, one skill per player branch. Do not touch other files except
  `index.json` (regenerate it). New shared libraries go to `main` via the delegates.
- New skills pick a new `id` (`skill_<slug>`, lowercase, `[a-z0-9_]`). Changing a built-in
  skill keeps its `id`; the different sha256 makes it a distinct version.
- Branch names are permanent once announced; pick the slug carefully.
- Never rewrite history on a branch other peers may have pinned (`commit` in their refs must stay reachable).
- Do not edit `tools/` on a player branch: `tools/pins.json` would no longer match and every
  peer rejects the check.

## How to propose a skill

```bash
rad clone rad:<SKILLS_RID>             # or: git pull on an existing clone
cd chaosD6-Skills
git switch -c players/<your-nid-or-name>/<skill-slug> main
$EDITOR skills/skill_<slug>.json       # follow SCHEMA.md / HOOKS.md
node tools/check.mjs skills/skill_<slug>.json   # schema + engine + validator, offline
node tools/manifest.mjs                # refresh index.json
node tools/manifest.mjs --check
git add skills/skill_<slug>.json index.json
git commit -m "skill_<slug>: <one line>"
git push rad players/<your-nid-or-name>/<skill-slug>
rad patch open                         # optional: ask for it to be merged into main
```

Your branch is playable as soon as it is pushed: pick the skill and your peers will fetch it by
ref. Merging into `main` (making it built-in) is the delegates' call, after `tools/check.mjs`
passes with the validator pinned in `validator/pin.json`.
