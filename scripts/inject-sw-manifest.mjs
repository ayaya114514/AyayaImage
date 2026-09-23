import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(projectRoot, 'dist');
const serviceWorkerPath = resolve(outputDirectory, 'sw.js');
const injectionMarker = 'const PRECACHE_FILES = /* INJECT_PRECACHE */ [];';
const versionMarker = "const CACHE_VERSION = /* INJECT_VERSION */ 'dev';";
// Social preview images are only fetched by crawlers; precaching them would
// make every first visit download them for nothing.
const excludedFromPrecache = /^og(?:-v\d+)?\.png$/;

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
  .filter((file) => !excludedFromPrecache.test(file))
  .sort();

const hash = createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update(await readFile(resolve(outputDirectory, file)));
}
const cacheVersion = hash.digest('hex').slice(0, 12);

const source = await readFile(serviceWorkerPath, 'utf8');
if (!source.includes(injectionMarker)) {
  throw new Error('Service worker precache marker was not found.');
}
if (!source.includes(versionMarker)) {
  throw new Error('Service worker cache version marker was not found.');
}

const manifestDeclaration = `const PRECACHE_FILES = ${JSON.stringify(files, null, 2)};`;
await writeFile(
  serviceWorkerPath,
  source
    .replace(injectionMarker, manifestDeclaration)
    .replace(versionMarker, `const CACHE_VERSION = '${cacheVersion}';`),
  'utf8',
);
