import type { ImagePreset } from './types';

export const PRESETS = [
  {
    id: 'original',
    label: '原图压缩',
    description: '保持原始尺寸与输入格式',
    resize: { mode: 'original', noUpscale: true },
    suggestedFormat: 'original',
    suggestedQuality: 0.86,
    builtIn: true,
  },
  {
    id: 'id-photo-1-inch',
    label: '1 寸证件照',
    description: '295 × 413 px，居中裁剪',
    resize: {
      mode: 'fixed',
      width: 295,
      height: 413,
      noUpscale: false,
    },
    suggestedFormat: 'jpeg',
    suggestedQuality: 0.92,
    builtIn: true,
  },
  {
    id: 'id-photo-2-inch',
    label: '2 寸证件照',
    description: '413 × 579 px，居中裁剪',
    resize: {
      mode: 'fixed',
      width: 413,
      height: 579,
      noUpscale: false,
    },
    suggestedFormat: 'jpeg',
    suggestedQuality: 0.92,
    builtIn: true,
  },
  {
    id: 'id-photo-small-2-inch',
    label: '小二寸照片',
    description: '390 × 567 px，居中裁剪',
    resize: {
      mode: 'fixed',
      width: 390,
      height: 567,
      noUpscale: false,
    },
    suggestedFormat: 'jpeg',
    suggestedQuality: 0.92,
    builtIn: true,
  },
  {
    id: 'id-photo-3x4',
    label: '3:4 电子证件照',
    description: '600 × 800 px，居中裁剪',
    resize: {
      mode: 'fixed',
      width: 600,
      height: 800,
      noUpscale: false,
    },
    suggestedFormat: 'jpeg',
    suggestedQuality: 0.9,
    builtIn: true,
  },
  {
    id: 'avatar-square',
    label: '正方形头像',
    description: '512 × 512 px，居中裁剪',
    resize: {
      mode: 'fixed',
      width: 512,
      height: 512,
      noUpscale: false,
    },
    suggestedFormat: 'jpeg',
    suggestedQuality: 0.9,
    builtIn: true,
  },
] as const satisfies readonly ImagePreset[];

export type BuiltInPresetId = (typeof PRESETS)[number]['id'];

export function getPreset(id: string): ImagePreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
