import { ImageWorkerClient } from './worker-client';
import type {
  BlogBundleOutput,
  BlogBundlePlanOptions,
  BlogBundleVariant,
  ProcessOptions,
} from './types';

const DEFAULT_WIDTHS = [1600, 960, 640] as const;

export interface BlogBundleTask extends BlogBundleVariant {
  options: ProcessOptions;
}

export interface ProcessBlogBundleOptions extends BlogBundlePlanOptions {
  backgroundColor?: string;
  onProgress?: (completed: number, total: number) => void;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be greater than 0`);
  }
  return Math.max(1, Math.round(value));
}

export function createBlogBundlePlan(
  options: BlogBundlePlanOptions = {},
): BlogBundleVariant[] {
  const format = options.format ?? 'webp';
  const quality = Math.min(0.98, Math.max(0.05, options.quality ?? 0.82));
  const widths = [...new Set(options.widths ?? DEFAULT_WIDTHS)]
    .map((width) => positiveInteger(width, 'widths[]'))
    .sort((a, b) => b - a);
  const thumbnail = options.thumbnail ?? { width: 640, height: 360 };
  const plan: BlogBundleVariant[] = [];

  if (options.includeOriginal ?? true) {
    plan.push({
      id: 'original',
      suffix: '-original',
      width: null,
      height: null,
      resize: { mode: 'original', noUpscale: true },
      format: 'original',
      quality: Math.max(quality, 0.9),
    });
  }

  for (const width of widths) {
    plan.push({
      id: `width-${width}`,
      suffix: `-${width}`,
      width,
      height: null,
      resize: { mode: 'width', width, noUpscale: true },
      format,
      quality,
    });
  }

  plan.push({
    id: 'thumbnail',
    suffix: '-thumbnail',
    width: positiveInteger(thumbnail.width, 'thumbnail.width'),
    height: positiveInteger(thumbnail.height, 'thumbnail.height'),
    resize: {
      mode: 'fixed',
      width: positiveInteger(thumbnail.width, 'thumbnail.width'),
      height: positiveInteger(thumbnail.height, 'thumbnail.height'),
      noUpscale: true,
    },
    format,
    quality: Math.min(quality, 0.8),
  });

  return plan;
}

export function buildBlogBundleTasks(
  options: BlogBundlePlanOptions & { backgroundColor?: string } = {},
): BlogBundleTask[] {
  return createBlogBundlePlan(options).map((variant) => ({
    ...variant,
    options: {
      resize: variant.resize,
      format: variant.format,
      compression: {
        mode: 'quality',
        quality: variant.quality,
      },
      backgroundColor: options.backgroundColor,
    },
  }));
}

/**
 * Generates a complete responsive-image set while processing strictly one
 * decoded source at a time. This avoids multiplying memory usage by the number
 * of requested widths.
 */
export async function processBlogBundle(
  file: Blob,
  options: ProcessBlogBundleOptions = {},
): Promise<BlogBundleOutput[]> {
  const tasks = buildBlogBundleTasks(options);
  const client = new ImageWorkerClient();
  const outputs: BlogBundleOutput[] = [];

  try {
    for (const [index, task] of tasks.entries()) {
      const image = await client.process(file, task.options);
      outputs.push({
        id: task.id,
        suffix: task.suffix,
        width: task.width,
        height: task.height,
        resize: task.resize,
        format: task.format,
        quality: task.quality,
        image,
      });
      options.onProgress?.(index + 1, tasks.length);
    }
  } finally {
    client.terminate();
  }

  return outputs;
}
