import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(file) {
  return sha256Buffer(readFileSync(file));
}

// Must produce byte-identical hashes to inject-faults.mjs hashTree(), which
// writes app_hash into each arm's .fault-set.json: same traversal (per-dir
// default sort, directories expanded inline) and same framing.
function walkTree(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTree(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

export function hashDir(dir, options = {}) {
  const exclude = new Set(options.exclude ?? ['.fault-set.json']);
  const hash = createHash('sha256');
  for (const rel of walkTree(dir)) {
    if (exclude.has(rel)) continue;
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function gitHead(cwd, execFile = execFileSync) {
  return execFile('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

export function gitDirty(cwd, appDir, execFile = execFileSync) {
  const out = execFile('git', ['status', '--porcelain', '--', appDir], { cwd, encoding: 'utf8' });
  return out.trim().length > 0;
}
