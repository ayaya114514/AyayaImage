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
});
