// Prepack guard: strip UTF-8 BOM from every package manifest under packages/
// and the shell package. pnpm (and some tooling) reject BOM-prefixed
// package.json — PowerShell's Set-Content -Encoding utf8 writes one.
// Wired as the bramble-memory package's "prepack" lifecycle script.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const roots = [
  path.resolve(import.meta.dirname, '..'),
  path.resolve(import.meta.dirname, '..', 'packages'),
];
let stripped = 0;
let checked = 0;
for (const root of roots) {
  for (const name of readdirSync(root)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const file = path.join(root, name, 'package.json');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    checked += 1;
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.replace(/^\uFEFF/, '');
      JSON.parse(text); // validate before writing
      writeFileSync(file, text, 'utf8');
      console.error(`strip-bom: removed BOM from ${file}`);
      stripped += 1;
    }
  }
}
console.error(`strip-bom: ${checked} manifests checked, ${stripped} BOM(s) removed`);
