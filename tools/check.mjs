#!/usr/bin/env node
// chaosD6-Skills offline check: schema + pinned engine + pinned validator for one or more skills.
// Needs only Node >= 18 and this repo (no chaosD6 checkout, no network, no npm install).
//
//   node tools/check.mjs skills/<id>.json [more.json …]   check these definitions
//   node tools/check.mjs --all                              every skills/*.json
//   options: --json (machine output)  --no-validator  --no-engine  --keep-stage
//
// Steps, in order (any failure → exit 1):
//   1. pins       every file in tools/pins.json (manifest.mjs, check.mjs, engine/, validator/) has its
//                 recorded sha256 — you run exactly the engine/validator this commit pins
//   2. stage      engine/ + validator/ are copied (byte-identical) to a temp dir at their chaosD6 `source`
//                 paths, with lib/ → <game_dir>/skills-data/lib and skills/ → <game_dir>/skills-data/skills,
//                 so the validator finds the engine exactly where it does in chaosD6
//   3. schema     JSON object, `id` file-name safe and == file name, `uses` names existing lib/<id>.json,
//                 each used lib has a matching `id`; then the pinned engine's validateSkillDef | validateSkill
//                 (from <game_dir>/skills.mjs) when it exports one
//   4. validator  validator/pin.json must match the staged validator (its verifyPin(), when exported);
//                 then checkSkill(def) → { verdict } must be in validator/pin.json `accept` (default ["ok"]).
//                 A validator without checkSkill is run as `node <entry> check <file>` (exit code).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defHash, sha256Hex, ID_RE } from './manifest.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..');
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const JSON_OUT = flag('--json');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const lfText = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const SAFE_SRC = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_.\/-]+$/;

/** tools/pins.json → { pins, problems[] } (missing / changed files). */
export function checkPins(root = ROOT) {
  const f = path.join(root, 'tools', 'pins.json');
  if (!fs.existsSync(f)) return { pins: null, problems: ['tools/pins.json missing'] };
  const pins = readJson(f);
  const problems = [];
  for (const [area, sec] of [['', pins.self], ['engine', pins.engine], ['validator', pins.validator]]) {
    for (const [rel, rec] of Object.entries(sec?.files || {})) {
      const shown = `tools/${area ? `${area}/` : ''}${rel}`;
      const p = path.join(root, 'tools', area, rel);
      if (!fs.existsSync(p)) { problems.push(`${shown}: missing`); continue; }
      const got = sha256Hex(lfText(p));
      if (got !== rec.sha256) problems.push(`${shown}: sha256 ${got.slice(0, 12)}… != pinned ${String(rec.sha256).slice(0, 12)}…`);
      if (area && !SAFE_SRC.test(String(rec.source || ''))) problems.push(`${shown}: unsafe source path ${JSON.stringify(rec.source)}`);
    }
  }
  return { pins, problems };
}

/** Rebuild the chaosD6 layout the tools expect in a temp dir → { dir, game, cleanup }. */
export function stage(pins, root = ROOT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaosd6-skills-check-'));
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const area of ['engine', 'validator']) {
    for (const [rel, rec] of Object.entries(pins?.[area]?.files || {})) put(rec.source, lfText(path.join(root, 'tools', area, rel)));
  }
  const game = pins?.game_dir && SAFE_SRC.test(pins.game_dir) ? pins.game_dir : 'game';
  for (const [sub, to] of [['lib', 'skills-data/lib'], ['skills', 'skills-data/skills']]) {
    const d = path.join(root, sub);
    if (fs.existsSync(d)) for (const n of fs.readdirSync(d).filter(n => n.endsWith('.json'))) put(`${game}/${to}/${n}`, lfText(path.join(d, n)));
  }
  return { dir, game: path.join(dir, game), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const stagedPath = (st, pins, area, rel) => (rel && pins?.[area]?.files?.[rel] ? path.join(st.dir, pins[area].files[rel].source) : null);

let _mods = null;
async function modules(st, pins, { engine, validator }) {
  if (_mods) return _mods;
  _mods = { engine: null, validator: null, errors: [] };
  const ep = engine && stagedPath(st, pins, 'engine', pins?.engine?.entry?.skills);
  const vp = validator && stagedPath(st, pins, 'validator', pins?.validator?.entry);
  try { if (ep) _mods.engine = await import(pathToFileURL(ep).href); } catch (e) { _mods.errors.push(`engine: cannot load ${pins.engine.entry.skills}: ${e.message}`); }
  try { if (vp) _mods.validator = { mod: await import(pathToFileURL(vp).href), path: vp }; } catch (e) { _mods.errors.push(`validator: cannot load ${pins.validator.entry}: ${e.message}`); }
  return _mods;
}

/** validator/pin.json vs the staged validator: { ok, why }. */
export async function checkValidatorPin(mods, root = ROOT) {
  if (!mods.validator) return { ok: true, why: 'skipped (no validator pinned)' };
  let pin = null;
  try { pin = readJson(path.join(root, 'validator', 'pin.json')); } catch { return { ok: false, why: 'validator/pin.json missing or not JSON' }; }
  if (!pin?.pin_id) return { ok: true, why: 'skipped (validator/pin.json is a placeholder)' };
  const v = mods.validator.mod.verifyPin;
  if (typeof v !== 'function') return { ok: true, why: 'skipped (validator exports no verifyPin)' };
  const r = await v(pin);
  return r?.ok ? { ok: true, why: `ok (${String(pin.pin_id).slice(0, 12)})` } : { ok: false, why: `validator/pin.json does not match the validator in tools/ (${(r?.diffs || []).join(', ')})` };
}

export async function checkSkillFile(file, { root = ROOT, pins = null, mods = { engine: null, validator: null }, validator = true } = {}) {
  const res = { file: path.relative(root, path.resolve(file)).split(path.sep).join('/') || file, id: null, sha256: null, steps: {}, errors: [] };
  const fail = (step, msg) => { res.errors.push(`${step}: ${msg}`); res.steps[step] = 'fail'; };
  let def;
  try { def = readJson(file); } catch (e) { fail('schema', `not JSON: ${e.message}`); return res; }
  if (!def || typeof def !== 'object' || Array.isArray(def)) { fail('schema', 'definition must be an object'); return res; }
  res.id = def.id ?? null;
  res.sha256 = defHash(def);
  if (typeof def.id !== 'string' || !ID_RE.test(def.id)) fail('schema', `invalid id ${JSON.stringify(def.id)}`);
  else if (path.basename(file) !== `${def.id}.json`) fail('schema', `file name must be ${def.id}.json`);
  const libs = {};
  for (const u of Array.isArray(def.uses) ? def.uses : def.uses == null ? [] : [null]) {
    if (typeof u !== 'string' || !ID_RE.test(u)) { fail('schema', `uses: bad lib id ${JSON.stringify(u)}`); continue; }
    const lf = path.join(root, 'lib', `${u}.json`);
    if (!fs.existsSync(lf)) { fail('schema', `uses unknown lib ${u} (no lib/${u}.json)`); continue; }
    try { const l = readJson(lf); if (l?.id !== u) fail('schema', `lib/${u}.json has id ${JSON.stringify(l?.id)}`); else libs[u] = l; }
    catch (e) { fail('schema', `lib/${u}.json: ${e.message}`); }
  }
  if (!res.steps.schema) res.steps.schema = 'ok';

  const ev = mods.engine && (mods.engine.validateSkillDef || mods.engine.validateSkill);
  if (!pins?.engine?.entry?.skills) res.steps.engine = 'skipped (no skill engine pinned yet)';
  else if (!mods.engine) res.steps.engine = 'skipped (--no-engine)';
  else if (res.errors.length) res.steps.engine = 'skipped (schema failed)';
  else if (typeof ev !== 'function') res.steps.engine = `skipped (${pins.engine.entry.skills} exports no validateSkillDef)`;
  else {
    try {
      const errs = await ev(def, { libs: Object.values(libs), libMap: libs });
      for (const e of Array.isArray(errs) ? errs : []) fail('engine', String(e));
      if (!res.steps.engine) res.steps.engine = 'ok';
    } catch (e) { fail('engine', e.message); }
  }

  if (!validator) res.steps.validator = 'skipped (--no-validator)';
  else if (!pins?.validator?.entry) res.steps.validator = 'skipped (no validator pinned yet)';
  else if (!mods.validator) res.steps.validator = 'fail';
  else if (res.errors.length) res.steps.validator = 'skipped (schema/engine failed)';
  else {
    let accept = ['ok'];
    try { const pin = readJson(path.join(root, 'validator', 'pin.json')); if (Array.isArray(pin.accept) && pin.accept.length) accept = pin.accept; } catch {}
    try {
      const m = mods.validator.mod;
      if (typeof m.checkSkill === 'function') {
        const out = await m.checkSkill(def, {});
        res.verdict = out?.verdict ?? null;
        if (out?.stamp) res.stamp = out.stamp;
        if (accept.includes(res.verdict)) res.steps.validator = `ok (${res.verdict})`;
        else fail('validator', `verdict ${JSON.stringify(res.verdict)} not in ${JSON.stringify(accept)}${out?.reasons ? ` — ${[].concat(out.reasons).join('; ')}` : ''}${out?.errors?.length ? ` — ${out.errors.join('; ')}` : ''}`);
      } else {
        const r = spawnSync(process.execPath, [mods.validator.path, 'check', path.resolve(file)], { encoding: 'utf8', cwd: path.dirname(mods.validator.path) });
        if (r.status === 0) res.steps.validator = 'ok (exit 0)';
        else fail('validator', `exit ${r.status}: ${(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
      }
    } catch (e) { fail('validator', e.message); }
  }
  return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let files = argv.filter(a => !a.startsWith('--'));
  if (flag('--all')) {
    const d = path.join(ROOT, 'skills');
    files = fs.existsSync(d) ? fs.readdirSync(d).filter(n => n.endsWith('.json')).sort().map(n => path.join(d, n)) : [];
  }
  if (!files.length && !flag('--all')) {
    console.error('usage: node tools/check.mjs <skills/id.json …> | --all  [--json] [--no-validator] [--no-engine] [--keep-stage]');
    process.exit(2);
  }
  const { pins, problems } = checkPins();
  const useV = !flag('--no-validator');
  let st = null, mods = { engine: null, validator: null, errors: [] }, vpin = { ok: true, why: 'skipped' };
  if (!problems.length && pins) {
    st = stage(pins);
    mods = await modules(st, pins, { engine: !flag('--no-engine'), validator: useV });
    if (useV) vpin = await checkValidatorPin(mods);
  }
  const results = [];
  if (!problems.length) for (const f of files) results.push(await checkSkillFile(f, { pins, mods, validator: useV }));
  const bad = problems.length + mods.errors.length + (vpin.ok ? 0 : 1) + results.filter(r => r.errors.length).length;
  if (JSON_OUT) console.log(JSON.stringify({ ok: bad === 0, pins: problems.length ? problems : 'ok', load: mods.errors, validator_pin: vpin, results }, null, 2));
  else {
    console.log(`pins: ${problems.length ? 'FAIL' : 'ok'}${pins?.tools_sha256 ? ` (tools ${pins.tools_sha256.slice(0, 12)})` : ''}   validator pin: ${vpin.ok ? vpin.why : `FAIL — ${vpin.why}`}`);
    for (const p of [...problems, ...mods.errors]) console.log(`  !! ${p}`);
    for (const r of results) {
      console.log(`${r.errors.length ? 'FAIL' : 'ok  '} ${r.file}  id=${r.id} sha256=${String(r.sha256).slice(0, 12)}  schema:${r.steps.schema} engine:${r.steps.engine} validator:${r.steps.validator}`);
      for (const e of r.errors) console.log(`  !! ${e}`);
    }
    if (problems.length) console.log('(definitions not checked: the pinned tools are not intact)');
    else if (!results.length) console.log('(no skills)');
  }
  if (st && !flag('--keep-stage')) st.cleanup(); else if (st) console.error(`stage kept: ${st.dir}`);
  process.exit(bad ? 1 : 0);
}
