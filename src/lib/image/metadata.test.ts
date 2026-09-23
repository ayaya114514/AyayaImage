import { describe, expect, it } from 'vitest';
import { verifyOutputMetadata } from './metadata';

function asciiBytes(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

describe('verifyOutputMetadata', () => {
  it('verifies a clean PNG container from its output bytes', async () => {
    const cleanPng = new Blob([
      Uint8Array.from([
        0x89,
        ...asciiBytes('PNG'),
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0, 0, 0, 0,
        ...asciiBytes('IEND'),
        0, 0, 0, 0,
      ]),
    ], { type: 'image/png' });

    await expect(verifyOutputMetadata(cleanPng)).resolves.toMatchObject({
      verified: true,
      metadataRemoved: true,
      hasMetadata: false,
      containerMarkers: [],
    });
  });

  it('does not claim removal when a PNG text chunk remains', async () => {
    const pngWithText = new Blob([
      Uint8Array.from([
        0x89,
        ...asciiBytes('PNG'),
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0, 0, 0, 3,
        ...asciiBytes('tEXt'),
        ...asciiBytes('abc'),
        0, 0, 0, 0,
        0, 0, 0, 0,
        ...asciiBytes('IEND'),
        0, 0, 0, 0,
      ]),
    ], { type: 'image/png' });

    await expect(verifyOutputMetadata(pngWithText)).resolves.toMatchObject({
      verified: true,
      metadataRemoved: false,
      hasMetadata: true,
      containerMarkers: ['text'],
    });
  });

  it('detects an EXIF APP1 segment in a JPEG', async () => {
    const payload = [...asciiBytes('Exif'), 0, 0, 0, 0];
    const jpegWithExif = new Blob([
      Uint8Array.from([
        0xff, 0xd8,
        0xff, 0xe1, 0, payload.length + 2,
        ...payload,
        0xff, 0xd9,
      ]),
    ], { type: 'image/jpeg' });

    await expect(verifyOutputMetadata(jpegWithExif)).resolves.toMatchObject({
      verified: true,
      metadataRemoved: false,
      containerMarkers: ['exif'],
    });
  });

  it('detects an EXIF chunk in a WebP container', async () => {
    const webpWithExif = new Blob([
      Uint8Array.from([
        ...asciiBytes('RIFF'), 24, 0, 0, 0,
        ...asciiBytes('WEBP'),
        ...asciiBytes('VP8 '), 0, 0, 0, 0,
        ...asciiBytes('EXIF'), 4, 0, 0, 0,
        0, 0, 0, 0,
      ]),
    ], { type: 'image/webp' });

    await expect(verifyOutputMetadata(webpWithExif)).resolves.toMatchObject({
      verified: true,
      metadataRemoved: false,
      containerMarkers: ['exif'],
    });
  });
});
