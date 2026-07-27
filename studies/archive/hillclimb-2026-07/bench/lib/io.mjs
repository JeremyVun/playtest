import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function readJsonIfExists(file, fallback = null) {
  return existsSync(file) ? readJson(file) : fallback;
}

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function parseArgs(argv, options = {}) {
  const repeatable = new Set(options.repeatable ?? []);
  const booleans = new Set(['help', ...(options.booleans ?? [])]);
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    if (booleans.has(key)) {
      args[key] = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    index += 1;

    if (repeatable.has(key)) {
      if (!Array.isArray(args[key])) args[key] = [];
      args[key].push(value);
    } else {
      args[key] = value;
    }
  }

  return args;
}

export function requireArgs(args, keys) {
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`missing required --${key}`);
    }
  }
}

export function isDirectRun(importMetaUrl, argv = process.argv) {
  return argv[1] && importMetaUrl === pathToFileURL(argv[1]).href;
}

export function walkDirs(root) {
  const out = [];
  if (!existsSync(root)) return out;

  function visit(dir) {
    out.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(dir, entry.name));
    }
  }

  visit(root);
  return out;
}

export function walkFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  }

  visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

export function listJsonFiles(root) {
  return walkFiles(root).filter((file) => file.endsWith('.json'));
}

export function pathExists(file) {
  return existsSync(file);
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export async function runCli(main, argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
