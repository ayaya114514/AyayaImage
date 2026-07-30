import type { ImagePreset } from './types';

export const PRESETS = [
  {
    id: 'blog-body',
    label: '博客正文',
    description: '适合 Markdown / Astro 正文插图',
    resize: { mode: 'long-edge', length: 1600, noUpscale: true },
    suggestedFormat: 'webp',
    suggestedQuality: 0.82,
    builtIn: true,
  },
  {
    id: 'blog-thumbnail',
    label: '博客缩略图',
    description: '16:9 卡片列表缩略图',
    resize: { mode: 'fixed', width: 640, height: 360, noUpscale: true },
    suggestedFormat: 'webp',
    suggestedQuality: 0.8,
    builtIn: true,
  },
  {
    id: 'open-graph',
    label: 'Open Graph',
    description: '社交媒体分享图',
    resize: { mode: 'fixed', width: 1200, height: 630, noUpscale: true },
    suggestedFormat: 'jpeg',
    suggestedQuality: 0.84,
    builtIn: true,
  },
  {
    id: 'github-readme',
    label: 'GitHub README',
    description: '项目截图与文档插图',
    resize: { mode: 'long-edge', length: 1200, noUpscale: true },
    suggestedFormat: 'webp',
    suggestedQuality: 0.82,
    builtIn: true,
  },
  {
    id: 'avatar',
    label: 'Avatar',
    description: '正方形头像',
    resize: { mode: 'fixed', width: 512, height: 512, noUpscale: true },
    suggestedFormat: 'webp',
    suggestedQuality: 0.86,
    builtIn: true,
  },
  {
    id: 'original',
    label: 'Original',
    description: '不缩放，仅转换或压缩',
    resize: { mode: 'original', noUpscale: true },
    suggestedFormat: 'original',
    suggestedQuality: 0.86,
    builtIn: true,
  },
] as const satisfies readonly ImagePreset[];

export type BuiltInPresetId = (typeof PRESETS)[number]['id'];

export function getPreset(id: string): ImagePreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
