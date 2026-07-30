import {
  extensionForMimeType,
  mimeTypeForFormat,
} from './processor';
import type {
  OutputFormat,
  SupportedMimeType,
} from './types';

export interface NamingOptions {
  format: Exclude<OutputFormat, 'original'> | SupportedMimeType;
  index?: number;
  width?: number;
  height?: number;
  /**
   * Supported tokens: {name}, {index}, {width}, and {height}.
   */
  pattern?: string;
  prefix?: string;
  suffix?: string;
  lowercase?: boolean;
  separator?: string;
  stripSpecial?: boolean;
  padding?: number;
}

function stemOf(inputName: string): string {
  const leafName = inputName.split(/[/\\]/).at(-1) ?? inputName;
  return leafName.replace(/\.[^.]+$/, '');
}

function resolveMimeType(
  format: NamingOptions['format'],
): SupportedMimeType {
  if (
    format === 'image/jpeg'
    || format === 'image/png'
    || format === 'image/webp'
  ) {
    return format;
  }
  return mimeTypeForFormat(format);
}

function sanitizeFileStem(
  value: string,
  separator: string,
  stripSpecial: boolean,
  lowercase: boolean,
): string {
  const normalized = value.normalize('NFKC').trim();
  const safeSeparator = separator.replace(/[/\\\0]/g, '') || '-';
  const separated = stripSpecial
    ? normalized.replace(/[^\p{L}\p{N}]+/gu, safeSeparator)
    : normalized
        .replace(/[/\\\0]+/g, safeSeparator)
        .replace(/\s+/g, safeSeparator);
  const repeatedSeparator = separated
    .split(safeSeparator)
    .filter(Boolean)
    .join(safeSeparator);
  const safe = repeatedSeparator.replace(/^\.+|\.+$/g, '') || 'image';
  return lowercase ? safe.toLocaleLowerCase() : safe;
}

export function buildOutputName(
  inputName: string,
  options: NamingOptions,
): string {
  const separator = options.separator ?? '-';
  const index = Math.max(0, Math.round(options.index ?? 1));
  const padding = Math.max(1, Math.min(8, Math.round(options.padding ?? 2)));
  const tokens: Readonly<Record<string, string>> = {
    name: stemOf(inputName),
    index: String(index).padStart(padding, '0'),
    width: options.width === undefined ? '' : String(Math.round(options.width)),
    height: options.height === undefined ? '' : String(Math.round(options.height)),
  };
  const pattern = options.pattern ?? '{name}';
  const expanded = pattern.replace(
    /\{(name|index|width|height)\}/g,
    (_, token: string) => tokens[token] ?? '',
  );
  const composed = [
    options.prefix ?? '',
    expanded,
    options.suffix ?? '',
  ].filter(Boolean).join(separator);
  const stem = sanitizeFileStem(
    composed,
    separator,
    options.stripSpecial ?? true,
    options.lowercase ?? true,
  );
  return `${stem}.${extensionForMimeType(resolveMimeType(options.format))}`;
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
