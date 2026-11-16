#!/usr/bin/env node
// chaosD6-Skills manifest generator: index.json = { format, hash, skills: { <id>: sha256 }, lib: { <id>: sha256 } }.
// sha256 is taken over the CANONICAL JSON of each definition (keys sorted, no whitespace), so
// formatting and key order in skills/<id>.json / lib/<id>.json never change a definition's identity.
// Standalone on purpose (no chaosD6 game code needed); must stay identical in behaviour to
// canonicalJson/defHash in chaosD6 game/defs-repo.mjs (skills-repo-check.mjs asserts it).
//
//   node tools/manifest.mjs            write index.json
//   node tools/manifest.mjs --check    exit 1 if index.json is stale (CI / before proposing)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function canonicalJson(value) {
  const out = (v, where) => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string': return JSON.stringify(v);
      case 'boolean': return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`non-finite number at ${where}`);
        return JSON.stringify(v);
      case 'object': {
        if (Array.isArray(v)) return `[${v.map((x, i) => out(x, `${where}[${i}]`)).join(',')}]`;
        const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${out(v[k], `${where}.${k}`)}`).join(',')}}`;
      }
      default: throw new TypeError(`unsupported ${typeof v} at ${where}`);
    }
  };
  return out(value, '$');
}
export const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const defHash = (def) => sha256Hex(canonicalJson(def));
export const skillHash = defHash;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function mapDir(root, sub, problems) {
  const dir = path.join(root, sub);
  const m = {};
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort() : [];
  for (const n of names) {
    let def;
    try { def = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) { problems.push(`${sub}/${n}: ${e.message}`); continue; }
    if (typeof def?.id !== 'string' || !ID_RE.test(def.id) || `${def.id}.json` !== n) { problems.push(`${sub}/${n}: id ${JSON.stringify(def?.id)} does not match the file name`); continue; }
    m[def.id] = defHash(def);
  }
  return m;
}

export function manifestFor(root) {
  const problems = [];
  const skills = mapDir(root, 'skills', problems);
  const lib = mapDir(root, 'lib', problems);
  return { manifest: { format: 1, hash: 'sha256(canonical-json)', skills, lib }, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { manifest, problems } = manifestFor(root);
  for (const p of problems) console.error(`!! ${p}`);
  const txt = JSON.stringify(manifest, null, 2) + '\n';
  const file = path.join(root, 'index.json');
  const n = `${Object.keys(manifest.skills).length} skills, ${Object.keys(manifest.lib).length} libs`;
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== txt || problems.length) { console.error('index.json is stale — run: node tools/manifest.mjs'); process.exit(1); }
    console.log(`index.json ok (${n})`);
  } else {
    fs.writeFileSync(file, txt);
    console.log(`index.json: ${n}${problems.length ? `, ${problems.length} problem(s)` : ''}`);
    if (problems.length) process.exit(1);
  }
}
