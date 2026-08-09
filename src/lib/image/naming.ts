import { extensionForMimeType } from './processor';
import type { SupportedMimeType } from './types';

function stemOf(inputName: string): string {
  const leafName = inputName.split(/[/\\]/).at(-1) ?? inputName;
  return leafName.replace(/\.[^.]+$/, '').replace(/\0/g, '').trim();
}

export function buildOutputName(
  inputName: string,
  mimeType: SupportedMimeType,
): string {
  return `${stemOf(inputName) || 'image'}.${extensionForMimeType(mimeType)}`;
}

/**
 * Reserves a filename in a batch and appends a stable numeric suffix when the
 * same name has already been used. Comparison is case-insensitive so a ZIP
 * cannot silently overwrite files that collide on common filesystems.
 */
export function deduplicateOutputName(
  candidate: string,
  usedNames: Set<string>,
): string {
  const normalizedCandidate = candidate.toLowerCase();
  if (!usedNames.has(normalizedCandidate)) {
    usedNames.add(normalizedCandidate);
    return candidate;
  }

  const dotIndex = candidate.lastIndexOf('.');
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? candidate.slice(0, dotIndex) : candidate;
  const extension = hasExtension ? candidate.slice(dotIndex) : '';
  let index = 2;
  let outputName = `${stem}-${String(index).padStart(2, '0')}${extension}`;

  while (usedNames.has(outputName.toLowerCase())) {
    index += 1;
    outputName = `${stem}-${String(index).padStart(2, '0')}${extension}`;
  }

  usedNames.add(outputName.toLowerCase());
  return outputName;
}
