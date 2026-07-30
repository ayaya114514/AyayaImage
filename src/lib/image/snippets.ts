import {
  extensionForMimeType,
  mimeTypeForFormat,
} from './processor';
import type {
  OutputFormat,
  SupportedMimeType,
} from './types';

export interface PictureVariant {
  width: number;
  path?: string;
  format?: Exclude<OutputFormat, 'original'>;
  mimeType?: SupportedMimeType;
}

export interface PictureSnippetOptions {
  alt?: string;
  width?: number;
  height?: number;
  fallbackPath?: string;
  loading?: 'lazy' | 'eager';
  className?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeMarkdownAlt(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
}

function variantMimeType(variant: PictureVariant): SupportedMimeType {
  if (variant.mimeType) {
    return variant.mimeType;
  }
  return mimeTypeForFormat(variant.format ?? 'webp');
}

function withoutImageExtension(path: string): string {
  return path.replace(/\.(?:jpe?g|png|webp)$/i, '');
}

function variantPath(
  basePath: string,
  variant: PictureVariant,
): string {
  if (variant.path) {
    return variant.path;
  }
  const mimeType = variantMimeType(variant);
  return `${withoutImageExtension(basePath)}-${variant.width}.${extensionForMimeType(mimeType)}`;
}

export function generateMarkdownImage(
  path: string,
  alt = '',
  title?: string,
): string {
  const safeAlt = escapeMarkdownAlt(alt);
  const titlePart = title
    ? ` "${title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : '';
  return `![${safeAlt}](${path}${titlePart})`;
}

export function generateAstroImageSnippet(
  path: string,
  options: Omit<PictureSnippetOptions, 'fallbackPath'> = {},
): string {
  const attributes = [
    `src="${escapeHtml(path)}"`,
    options.width === undefined ? null : `width="${options.width}"`,
    options.height === undefined ? null : `height="${options.height}"`,
    `loading="${options.loading ?? 'lazy'}"`,
    `alt="${escapeHtml(options.alt ?? '')}"`,
    options.className ? `class="${escapeHtml(options.className)}"` : null,
  ].filter((attribute): attribute is string => attribute !== null);

  return `<img\n${attributes.map((attribute) => `  ${attribute}`).join('\n')}\n/>`;
}

export function generatePictureSnippet(
  basePath: string,
  variants: readonly PictureVariant[],
  options: PictureSnippetOptions = {},
): string {
  if (variants.length === 0) {
    throw new Error('At least one picture variant is required.');
  }

  const sorted = [...variants].sort((a, b) => a.width - b.width);
  const groups = new Map<SupportedMimeType, PictureVariant[]>();
  for (const variant of sorted) {
    if (!Number.isFinite(variant.width) || variant.width <= 0) {
      throw new RangeError('Picture variant widths must be greater than 0.');
    }
    const mimeType = variantMimeType(variant);
    groups.set(mimeType, [...(groups.get(mimeType) ?? []), variant]);
  }

  const sourceLines = [...groups.entries()].map(([mimeType, group]) => {
    const srcset = group
      .map((variant) => (
        `${escapeHtml(variantPath(basePath, variant))} ${Math.round(variant.width)}w`
      ))
      .join(',\n      ');
    return [
      '  <source',
      `    type="${mimeType}"`,
      '    srcset="',
      `      ${srcset}`,
      '    "',
      '  />',
    ].join('\n');
  });

  const largest = sorted.at(-1);
  if (!largest) {
    throw new Error('At least one picture variant is required.');
  }
  const fallbackPath = options.fallbackPath
    ?? variantPath(basePath, largest);
  const imageAttributes = [
    `src="${escapeHtml(fallbackPath)}"`,
    options.width === undefined ? null : `width="${options.width}"`,
    options.height === undefined ? null : `height="${options.height}"`,
    `loading="${options.loading ?? 'lazy'}"`,
    `alt="${escapeHtml(options.alt ?? '')}"`,
    options.className ? `class="${escapeHtml(options.className)}"` : null,
  ].filter((attribute): attribute is string => attribute !== null);

  return [
    '<picture>',
    ...sourceLines,
    '  <img',
    ...imageAttributes.map((attribute) => `    ${attribute}`),
    '  />',
    '</picture>',
  ].join('\n');
}
