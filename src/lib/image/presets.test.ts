import { describe, expect, it } from 'vitest';
import { PRESETS, getPreset } from './presets';

describe('built-in presets', () => {
  it('lists the approved common sizes in a stable order', () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      'original',
      'id-photo-1-inch',
      'id-photo-2-inch',
      'id-photo-small-2-inch',
      'id-photo-3x4',
      'avatar-square',
    ]);
  });

  it('uses exact JPEG dimensions for the photo presets', () => {
    const expectedSizes = [
      ['id-photo-1-inch', 295, 413, 0.92],
      ['id-photo-2-inch', 413, 579, 0.92],
      ['id-photo-small-2-inch', 390, 567, 0.92],
      ['id-photo-3x4', 600, 800, 0.9],
      ['avatar-square', 512, 512, 0.9],
    ] as const;

    expectedSizes.forEach(([id, width, height, quality]) => {
      expect(getPreset(id)).toMatchObject({
        resize: { mode: 'fixed', width, height, noUpscale: false },
        suggestedFormat: 'jpeg',
        suggestedQuality: quality,
        builtIn: true,
      });
    });
  });

  it('keeps original compression as the safe default', () => {
    expect(PRESETS[0]).toMatchObject({
      id: 'original',
      resize: { mode: 'original', noUpscale: true },
      suggestedFormat: 'original',
    });
    expect(getPreset('unknown')).toBeUndefined();
  });
});
