// Static check: verify every named import from '@/lib/*' in app/api route.js
// files actually exists in the target module's exports.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'app', 'api');
const LIB = join(ROOT, 'lib');

function* walk(dir, ext) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p, ext);
    else if (p.endsWith(ext)) yield p;
  }
}

// Collect exports of a lib module (ts or js)
function getExports(modPath) {
  const names = new Set();
  if (!existsSync(modPath)) return names;
  const src = readFileSync(modPath, 'utf8');
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  // default export
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

const missing = new Map(); // module -> Set<name>

for (const file of walk(API, 'route.js')) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@\/lib\/([^']+)'/g)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const modRel = m[2];
    const modPath = resolve(LIB, modRel);
    const candidates = [modPath + '.ts', modPath + '.tsx', modPath + '.js', join(modPath, 'index.ts'), join(modPath, 'index.js')];
    const found = candidates.find(existsSync);
    if (!found) {
      if (!missing.has(modRel)) missing.set(modRel, new Set());
      names.forEach((n) => missing.get(modRel).add(`${n} (MODULE NOT FOUND)`));
      continue;
    }
    const exports = getExports(found);
    for (const n of names) {
      if (!exports.has(n)) {
        if (!missing.has(modRel)) missing.set(modRel, new Set());
        missing.get(modRel).add(n);
      }
    }
  }
}

if (missing.size === 0) {
  console.log('All lib imports resolve OK');
} else {
  for (const [mod, names] of [...missing.entries()].sort()) {
    console.log(`\n@/lib/${mod}:`);
    [...names].sort().forEach((n) => console.log(`  - ${n}`));
  }
}
