import { describe, expect, it } from 'vitest';
import {
  buildOutputName,
  deduplicateOutputName,
} from './naming';

describe('output helpers', () => {
  it('keeps the original stem while replacing the extension', () => {
    expect(buildOutputName('IMG 8231.PNG', 'image/webp'))
      .toBe('IMG 8231.webp');
  });

  it('keeps unicode and punctuation in the original stem', () => {
    expect(buildOutputName('桌面，环境！.png', 'image/jpeg'))
      .toBe('桌面，环境！.jpg');
  });

  it('deduplicates colliding output names without losing extensions', () => {
    const usedNames = new Set<string>();
    expect(deduplicateOutputName(
      buildOutputName('Photo.PNG', 'image/webp'),
      usedNames,
    )).toBe('Photo.webp');
    expect(deduplicateOutputName(
      buildOutputName('Photo.jpg', 'image/webp'),
      usedNames,
    )).toBe('Photo-02.webp');
    expect(deduplicateOutputName(
      buildOutputName('PHOTO.png', 'image/webp'),
      usedNames,
    )).toBe('PHOTO-03.webp');
  });
});
