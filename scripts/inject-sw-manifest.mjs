import { readdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(projectRoot, 'dist');
const serviceWorkerPath = resolve(outputDirectory, 'sw.js');
const injectionMarker = 'const PRECACHE_FILES = /* INJECT_PRECACHE */ [];';

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

const files = (await listFiles(outputDirectory))
  .filter((file) => file !== serviceWorkerPath)
  .map((file) => relative(outputDirectory, file).split(sep).join('/'))
  .sort();

const source = await readFile(serviceWorkerPath, 'utf8');
if (!source.includes(injectionMarker)) {
  throw new Error('Service worker precache marker was not found.');
}

const manifestDeclaration = `const PRECACHE_FILES = ${JSON.stringify(files, null, 2)};`;
await writeFile(
  serviceWorkerPath,
  source.replace(injectionMarker, manifestDeclaration),
  'utf8',
);
