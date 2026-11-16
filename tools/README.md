# tools/ — check a skill offline

Everything here runs with plain Node >= 18, no chaosD6 checkout, no network, no npm install.

```bash
node tools/check.mjs skills/skill_<slug>.json     # one (or several) definitions
node tools/check.mjs --all                         # every skills/*.json
node tools/check.mjs --all --json                  # machine-readable
node tools/manifest.mjs [--check]                  # index.json (ids -> sha256)
```

`check.mjs` runs, in order (exit 1 on any failure):

1. **pins** — every file under `engine/` and `validator/` (and `manifest.mjs`, `check.mjs`) has the
   sha256 recorded in `pins.json`, so you are checking with exactly the tools this commit pins.
2. **stage** — the tool files are byte-identical copies of chaosD6 files; each records its chaosD6
   `source` path. They are copied to a temp dir at those paths (`lib/` → `game/skills-data/lib`,
   `skills/` → `game/skills-data/skills`), so the validator finds the engine where it does in chaosD6
   and computes the same pin.
3. **schema** — the file is a JSON object, `id` is file-name safe and equals the file name, every
   lib in `uses` exists as `lib/<id>.json` with a matching `id`; then the pinned engine's
   `validateSkillDef(def, { libs })` (from `game/skills.mjs`) when it exports one.
4. **validator** — `../validator/pin.json` must match the staged validator (`verifyPin`), then
   `checkSkill(def)` must return a `verdict` listed in the pin's `accept` (default `["ok"]`). A
   validator without `checkSkill` is run as `node <entry> check <file>` and judged by its exit code.

Steps whose component is not pinned yet are reported as `skipped`, not failed.

| path | what | source in chaosD6 |
|---|---|---|
| `manifest.mjs` | index.json generator | `game/tools/skills-repo-template/tools/manifest.mjs` |
| `check.mjs` | this checker | `game/tools/skills-repo-template/tools/check.mjs` |
| `engine/` | the engine a definition runs on + its local imports (paths as under chaosD6 `game/`) | `game/effect-engine.mjs`, `game/skills.mjs` |
| `validator/` | the skills validator, its calibration and the helpers beside it | `game/tools/skills-rebalancing-check.mjs`, `rebalancing-core.mjs`, `skills-rebalancing-calibration.json` |
| `pins.json` | sha256 (LF-normalised bytes) + chaosD6 source path of every file above, npm packages they need, `tools_sha256` over all of it | written by `game/tools/skills-repo-sync.mjs` |

Never edit `engine/` or `validator/` by hand: they are mirrored from chaosD6 by
`node game/tools/skills-repo-sync.mjs`, which rewrites `pins.json` in the same commit.
