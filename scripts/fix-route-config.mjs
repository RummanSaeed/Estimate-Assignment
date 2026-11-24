// Fix route segment config exports: Next.js requires `export const dynamic = ...`
// directly, not `const dynamic = ...` + `export { dynamic }`.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'api');
const CONFIG_NAMES = ['dynamic', 'revalidate', 'maxDuration', 'runtime'];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (e === 'route.js') yield p;
  }
}

let fixed = 0;
for (const file of walk(ROOT)) {
  let src = readFileSync(file, 'utf8');
  const original = src;
  let changed = false;

  for (const name of CONFIG_NAMES) {
    // 1. const dynamic = 'force-dynamic';  ->  export const dynamic = 'force-dynamic';
    const declRe = new RegExp(`^const\\s+${name}\\s*=`, 'm');
    if (declRe.test(src)) {
      src = src.replace(declRe, `export const ${name} =`);
      changed = true;
    }
    // 2. remove `name` (and `name as x`) from export lists: export { dynamic, GET };
    src = src.replace(/export\s*\{([^}]+)\}/g, (m, list) => {
      const parts = list.split(',').map((s) => s.trim()).filter(Boolean);
      const kept = parts.filter((p) => {
        const base = p.split(/\s+as\s+/)[0].trim();
        return base !== name;
      });
      if (kept.length === parts.length) return m;
      changed = true;
      return kept.length ? `export { ${kept.join(', ')} };` : '';
    });
  }

  if (changed && src !== original) {
    writeFileSync(file, src);
    fixed++;
  }
}
console.log(`Fixed ${fixed} files`);
