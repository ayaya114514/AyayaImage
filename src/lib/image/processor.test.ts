import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processImage } from './processor';
import { ImageWorkerClient } from './worker-client';
import type { ProcessOptions } from './types';

let sourceSize = { width: 1000, height: 1000 };
let decodeFails = false;
const encodedQualities: Array<number | undefined> = [];

/** Lossy output grows linearly with quality; PNG is a fixed size. */
function encodedByteLength(type: string, quality?: number): number {
  if (type === 'image/png') {
    return 5_000;
  }
  return Math.round((quality ?? 0.92) * 1_000);
}

class FakeOffscreenCanvas {
  public constructor(public width: number, public height: number) {}

  public getContext() {
    return {
      fillStyle: '',
      globalCompositeOperation: 'source-over',
      drawImage() {},
      fillRect() {},
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(255),
      }),
    };
  }

  public async convertToBlob({ type, quality }: { type: string; quality?: number }) {
    encodedQualities.push(quality);
    return new Blob([new Uint8Array(encodedByteLength(type, quality))], { type });
  }
}

function sourceBlob(bytes: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

const ORIGINAL: ProcessOptions = {
  resize: { mode: 'original' },
  format: 'original',
};

beforeEach(() => {
  sourceSize = { width: 1000, height: 1000 };
  decodeFails = false;
  encodedQualities.length = 0;
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('createImageBitmap', async () => {
    if (decodeFails) {
      throw new DOMException('The source image could not be decoded.');
    }
    return { ...sourceSize, close() {} };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processImage size guards', () => {
  it('keeps the source bytes when re-encoding would not be smaller', async () => {
    const input = sourceBlob(500);
    const result = await processImage(input, {
      ...ORIGINAL,
      keepSourceIfSmaller: true,
    });

    expect(result.blob).toBe(input);
    expect(result.size).toBe(500);
    expect(result.quality).toBeNull();
    expect(result.warnings).toEqual(['SOURCE_KEPT']);
  });

  it('reports a larger output when keeping the source is not allowed', async () => {
    const result = await processImage(sourceBlob(500), ORIGINAL);

    expect(result.size).toBe(840);
    expect(result.savingsPercent).toBeLessThan(0);
    expect(result.warnings).toEqual(['OUTPUT_LARGER_THAN_SOURCE']);
  });

  it('never returns the source when pixels change', async () => {
    const result = await processImage(sourceBlob(500), {
      resize: { mode: 'width', width: 500 },
      format: 'original',
      keepSourceIfSmaller: true,
    });

    expect(result.width).toBe(500);
    expect(result.warnings).not.toContain('SOURCE_KEPT');
  });

  it('caps a target size above the source at the source size', async () => {
    const result = await processImage(sourceBlob(500), {
      ...ORIGINAL,
      compression: { mode: 'target-size', maxBytes: 2_000 },
    });

    expect(result.size).toBeLessThanOrEqual(500);
    expect(result.warnings).toEqual(['TARGET_SIZE_ABOVE_SOURCE']);
  });

  it('binary-searches the highest quality within the target size', async () => {
    const result = await processImage(sourceBlob(5_000), {
      ...ORIGINAL,
      compression: { mode: 'target-size', maxBytes: 700 },
    });

    expect(result.size).toBeLessThanOrEqual(700);
    expect(result.quality).toBeGreaterThan(0.68);
    expect(result.warnings).toEqual([]);
  });

  it('warns when even the lowest quality misses the target size', async () => {
    const result = await processImage(sourceBlob(5_000), {
      ...ORIGINAL,
      compression: { mode: 'target-size', maxBytes: 100 },
    });

    expect(result.quality).toBe(0.2);
    expect(result.warnings).toEqual(['TARGET_SIZE_UNREACHABLE']);
  });

  it('flags PNG target sizes as unsupported', async () => {
    const result = await processImage(sourceBlob(9_000, 'image/png'), {
      ...ORIGINAL,
      compression: { mode: 'target-size', maxBytes: 1_000 },
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.warnings).toContain('PNG_TARGET_SIZE_UNSUPPORTED');
  });
});

describe('processImage quality selection', () => {
  it('picks auto quality from the output megapixels', async () => {
    await processImage(sourceBlob(5_000), {
      ...ORIGINAL,
      compression: { mode: 'auto' },
    });
    sourceSize = { width: 5_000, height: 1_000 };
    await processImage(sourceBlob(5_000), {
      ...ORIGINAL,
      compression: { mode: 'auto' },
    });

    expect(encodedQualities).toEqual([0.84, 0.8]);
  });

  it('allows a manual quality of 100%', async () => {
    const result = await processImage(sourceBlob(5_000), {
      ...ORIGINAL,
      compression: { mode: 'quality', quality: 1 },
    });

    expect(result.quality).toBe(1);
  });

  it('reports decode failures in Chinese', async () => {
    decodeFails = true;

    await expect(processImage(sourceBlob(500), ORIGINAL)).rejects.toThrow(
      '无法解码图片',
    );
  });
});

describe('ImageWorkerClient', () => {
  it('finishes pending work on the main thread after a worker error', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const fakeWorker = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: () => {},
      postMessage: () => {
        queueMicrotask(() => {
          listeners.get('error')?.({ preventDefault() {} });
        });
      },
      terminate: vi.fn(),
    };
    vi.stubGlobal('Worker', class {});
    const client = new ImageWorkerClient({
      workerFactory: () => fakeWorker as unknown as Worker,
    });

    const result = await client.process(sourceBlob(5_000), ORIGINAL);

    expect(result.mimeType).toBe('image/jpeg');
    expect(fakeWorker.terminate).toHaveBeenCalled();
  });
});
