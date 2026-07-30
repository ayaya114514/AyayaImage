import { describe, expect, it } from 'vitest';
import { createBlogBundlePlan } from './blog-bundle';
import {
  buildOutputName,
  deduplicateOutputName,
} from './naming';
import {
  generateMarkdownImage,
  generatePictureSnippet,
} from './snippets';

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

  it('generates markdown and responsive picture snippets', () => {
    expect(generateMarkdownImage('/images/desk.webp', '桌面环境'))
      .toBe('![桌面环境](/images/desk.webp)');
    const snippet = generatePictureSnippet('/images/desk', [
      { width: 640, format: 'webp' },
      { width: 960, format: 'webp' },
    ], {
      alt: 'Desk',
      width: 960,
      height: 720,
    });
    expect(snippet).toContain('/images/desk-640.webp 640w');
    expect(snippet).toContain('width="960"');
  });

  it('builds the expected default blog bundle', () => {
    const plan = createBlogBundlePlan();
    expect(plan.map((variant) => variant.suffix)).toEqual([
      '-original',
      '-1600',
      '-960',
      '-640',
      '-thumbnail',
    ]);
    expect(plan.at(-1)?.resize).toEqual({
      mode: 'fixed',
      width: 640,
      height: 360,
      noUpscale: true,
    });
  });
});
