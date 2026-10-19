// Named designs: one <name>.json per design in a folder, in the same format as the live design file.
import fs from 'node:fs';
import path from 'node:path';
import * as M from './model.js';

// Which file a server keeps its live design in: an explicit override, else one file per Claude Code
// session, else the shared file. A session id with anything but letters, digits, - and _ is ignored
// so it can't point outside the sessions folder.
export function designPathFor(env, home) {
  const root = path.join(home, '.breadboard-bench');
  if (env.BREADBOARD_DESIGN) return { file: env.BREADBOARD_DESIGN, kind: 'override' };
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (id && /^[A-Za-z0-9_-]+$/.test(id)) return { file: path.join(root, 'sessions', `${id}.json`), kind: 'session' };
  return { file: path.join(root, 'design.json'), kind: 'shared' };
}

// A short name for people to tell design files apart.
export function designLabel(file, kind) {
  const base = path.basename(file);
  return kind === 'session' ? `session ${base.replace(/\.json$/, '').slice(0, 8)}` : base;
}

const fileFor = (dir, name) => path.join(dir, `${M.designFileName(name)}.json`);

export function saveDesign(dir, name, design) {
  const file = fileFor(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(design, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

// Saved designs, newest first. Files that aren't valid designs are skipped.
export function listDesigns(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of names) {
    try {
      const file = path.join(dir, f);
      const d = M.normalizeDesign(JSON.parse(fs.readFileSync(file, 'utf8')));
      out.push({ name: f.slice(0, -5), title: d.name, boards: d.boards.length, parts: d.parts.length, wires: d.wires.length, modified: fs.statSync(file).mtime.toISOString() });
    } catch { /* not a design */ }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function openDesign(dir, name) {
  const file = fileFor(dir, name);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch {
    const saved = listDesigns(dir).map((d) => d.name);
    throw new M.ModelError(`No saved design "${name}".${saved.length ? ` Saved designs: ${saved.join(', ')}.` : ' Nothing has been saved yet; use save_design first.'}`);
  }
  try { return M.normalizeDesign(JSON.parse(text)); }
  catch { throw new M.ModelError(`The saved design "${name}" isn't valid JSON, so it can't be opened. Fix or delete ${file}.`); }
}
