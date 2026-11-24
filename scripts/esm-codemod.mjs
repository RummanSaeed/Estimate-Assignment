// Codemod: convert compiled CommonJS route.js files to ESM in-place.
// Handles: const {..} = require('..'), const x = require('..'),
//          exports.NAME = IDENT;  ->  export { IDENT as NAME }
//          exports.NAME = expr;   ->  export const NAME = expr;
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function* walk(dir, match) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p, match);
    else if (match(e)) yield p;
  }
}

const targets = [
  ...walk(join(ROOT, 'app', 'api'), (e) => e === 'route.js'),
  ...walk(join(ROOT, 'lib'), (e) => e.endsWith('.js')),
];

let changed = 0;
const problems = [];

for (const file of targets) {
  let src = readFileSync(file, 'utf8');
  const original = src;

  // 1. const { A, B } = require('mod');   (multiline-safe)
  src = src.replace(/const\s*\{([\s\S]*?)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;/g,
    (m, names, mod) => `import {${names.replace(/\s+/g, ' ').trim()}} from '${mod}';`);

  // 2. const x = require('mod');
  src = src.replace(/const\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;/g,
    (m, name, mod) => `import ${name} from '${mod}';`);

  // 3. exports.NAME = IDENT;  -> collect for export list
  const exportList = [];
  src = src.replace(/exports\.(\w+)\s*=\s*(\w+)\s*;/g, (m, name, ident) => {
    exportList.push(name === ident ? ident : `${ident} as ${name}`);
    return '';
  });

  // 3b. module.exports = { a, b, c };  ->  export { a, b, c };
  src = src.replace(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;/g,
    (m, names) => `export {${names.replace(/\s+/g, ' ').trim()}};`);

  // 4. exports.NAME = <expr>; -> export const NAME = <expr>;
  src = src.replace(/exports\.(\w+)\s*=\s*([^;]+);/g,
    (m, name, expr) => `export const ${name} = ${expr.trim()};`);

  if (exportList.length) {
    src += `\nexport { ${exportList.join(', ')} };\n`;
  }

  // Cleanup: collapse >2 consecutive blank lines left by removals
  src = src.replace(/\n{3,}/g, '\n\n');

  if (src !== original) {
    writeFileSync(file, src);
    changed++;
  }
  if (/require\(|exports\.|module\.exports/.test(src)) {
    problems.push(file);
  }
}

console.log(`Transformed ${changed} files`);
if (problems.length) {
  console.log('Files still containing CJS patterns:');
  problems.forEach((p) => console.log(' -', p));
}
