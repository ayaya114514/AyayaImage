import { describe, expect, it } from 'vitest';
import {
  buildOutputName,
  deduplicateOutputName,
} from './naming';

describe('output helpers', () => {
  it('builds a safe indexed output name', () => {
    expect(buildOutputName('IMG 8231.PNG', {
      format: 'webp',
      pattern: 'Desk Setup-{index}',
      index: 1,
    })).toBe('desk-setup-01.webp');
  });

  it('keeps unicode letters while removing punctuation', () => {
    expect(buildOutputName('桌面，环境！.png', {
      format: 'jpeg',
    })).toBe('桌面-环境.jpg');
  });

  it('deduplicates colliding output names without losing extensions', () => {
    const usedNames = new Set<string>();
    expect(deduplicateOutputName('photo.webp', usedNames))
      .toBe('photo.webp');
    expect(deduplicateOutputName('PHOTO.webp', usedNames))
      .toBe('PHOTO-02.webp');
    expect(deduplicateOutputName('photo.webp', usedNames))
      .toBe('photo-03.webp');
  });
});
