import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = JSON.parse(await readFile('skill-source.json', 'utf8'));
const skill = await readFile('skills/image-diagnosis/server-SKILL.md');
if (`sha256:${createHash('sha256').update(skill).digest('hex')}` !== source.digest) throw new Error('Public Skill snapshot differs from provenance');
await mkdir('bundle', { recursive: true });
await build({ entryPoints: ['src/main.mjs'], outfile: 'bundle/bridge.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: true,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { __SKILL_DIGEST__: JSON.stringify(source.digest) }, legalComments: 'external' });
const bytes = await readFile('bundle/bridge.mjs');
await writeFile('bundle/SHA256SUMS', `${createHash('sha256').update(bytes).digest('hex')}  bridge.mjs\n`);
console.log('Built self-contained MCP bridge; users do not run npm install.');
