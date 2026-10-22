// Only the authorized publishing workflow builds plugin source; the host consumes verified bundles.
import { build } from 'esbuild';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'Proberen/typepro-plugins') {
  throw new Error('Plugin source bundling is restricted to the GitHub publishing workflow.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
for (const entry of await readdir(path.join(root, 'plugins'), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
  const directory = path.join(root, 'plugins', entry.name);
  const worker = path.join(directory, 'source', 'main.ts');
  if (!existsSync(worker)) continue;
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.apiVersion !== 3 || manifest.id !== entry.name) throw new Error(`Invalid source plugin: ${entry.name}`);
  const common = { bundle: true, minify: true, platform: 'browser', format: 'iife', target: 'es2020', legalComments: 'none', define: { 'process.env.NODE_ENV': '"production"' } };
  const result = await build({ ...common, entryPoints: [worker], globalName: 'TypeProPlugin', write: false });
  if (result.outputFiles.length !== 1) throw new Error('Worker cannot emit extra resources');
  await writeFile(path.join(directory, 'main.js'), result.outputFiles[0].text + '\nawait TypeProPlugin.default();\n');
  const ui = path.join(directory, 'source', 'ui.tsx');
  if (existsSync(ui)) {
    await mkdir(path.join(directory, 'files'), { recursive: true });
    await build({ ...common, jsx: 'automatic', entryPoints: [ui], outfile: path.join(directory, 'files', 'ui.js') });
  }
}
