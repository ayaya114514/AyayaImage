import { describe, expect, it } from 'vitest';
import { createDrawPlan } from './geometry';

describe('createDrawPlan', () => {
  it('resizes by longest edge without changing aspect ratio', () => {
    expect(createDrawPlan(
      { width: 4032, height: 3024 },
      { mode: 'long-edge', length: 1600, noUpscale: true },
    )).toMatchObject({
      outputWidth: 1600,
      outputHeight: 1200,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 4032,
      sourceHeight: 3024,
    });
  });

  it('does not upscale a small source', () => {
    expect(createDrawPlan(
      { width: 400, height: 300 },
      { mode: 'width', width: 1600, noUpscale: true },
    )).toMatchObject({
      outputWidth: 400,
      outputHeight: 300,
    });
  });

  it('calculates a centered fixed-size crop', () => {
    expect(createDrawPlan(
      { width: 1600, height: 1200 },
      { mode: 'fixed', width: 1200, height: 630 },
    )).toMatchObject({
      outputWidth: 1200,
      outputHeight: 630,
      sourceX: 0,
      sourceY: 180,
      sourceWidth: 1600,
      sourceHeight: 840,
    });
  });

  it('accepts a fractional percentage', () => {
    expect(createDrawPlan(
      { width: 800, height: 600 },
      { mode: 'percent', percent: 12.5 },
    )).toMatchObject({
      outputWidth: 100,
      outputHeight: 75,
    });
  });
});
