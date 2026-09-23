import { createDrawPlan } from './geometry';
import {
  SUPPORTED_MIME_TYPES,
  type CompressionOptions,
  type OutputFormat,
  type ProcessedImage,
  type ProcessOptions,
  type ProcessWarningCode,
  type SupportedMimeType,
} from './types';

interface Canvas2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalCompositeOperation: GlobalCompositeOperation;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
}

type WorkingCanvas = HTMLCanvasElement | OffscreenCanvas;

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

interface EncodedResult {
  blob: Blob;
  quality: number | null;
}

const DEFAULT_COMPRESSION: CompressionOptions = {
  mode: 'auto',
};

const LOSSY_MIME_TYPES: ReadonlySet<SupportedMimeType> = new Set([
  'image/jpeg',
  'image/webp',
]);

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.82;
  }

  return Math.min(1, Math.max(0.05, value));
}

function normalizeInputMimeType(type: string): SupportedMimeType | null {
  const normalized = type.toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : type.toLowerCase();
  return SUPPORTED_MIME_TYPES.includes(normalized as SupportedMimeType)
    ? (normalized as SupportedMimeType)
    : null;
}

export function mimeTypeForFormat(
  format: Exclude<OutputFormat, 'original'>,
): SupportedMimeType {
  if (format === 'jpeg') {
    return 'image/jpeg';
  }

  return `image/${format}` as SupportedMimeType;
}

export function extensionForMimeType(mimeType: SupportedMimeType): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
}

function resolveOutputMimeType(
  input: Blob,
  format: OutputFormat,
  warnings: ProcessWarningCode[],
): SupportedMimeType {
  if (format !== 'original') {
    return mimeTypeForFormat(format);
  }

  const inputMimeType = normalizeInputMimeType(input.type);
  if (inputMimeType) {
    return inputMimeType;
  }

  warnings.push('INPUT_TYPE_UNSUPPORTED');
  return 'image/webp';
}

function createCanvas(width: number, height: number): WorkingCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  throw new Error('当前浏览器无法创建 Canvas，不能处理图片');
}

function getContext(canvas: WorkingCanvas): Canvas2DLike {
  const context = canvas.getContext('2d', {
    alpha: true,
    willReadFrequently: true,
  });
  if (!context) {
    throw new Error('无法创建 Canvas 2D context，图片可能超出浏览器的尺寸上限');
  }

  return context as Canvas2DLike;
}

async function decodeWithHtmlImage(input: Blob): Promise<DecodedImage> {
  if (
    typeof document === 'undefined'
    || typeof Image === 'undefined'
    || typeof URL === 'undefined'
  ) {
    throw new Error('当前浏览器无法解码图片');
  }

  const url = URL.createObjectURL(input);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;

  try {
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function decodeImage(input: Blob): Promise<DecodedImage> {
  try {
    if (typeof createImageBitmap !== 'undefined') {
      const bitmap = await createImageBitmap(input, {
        imageOrientation: 'from-image',
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    }

    return await decodeWithHtmlImage(input);
  } catch {
    // Browser decode errors are terse English DOMExceptions; the UI needs a
    // message users can act on.
    throw new Error('无法解码图片，文件可能已损坏、过大或格式不受支持');
  }
}

function canvasToBlob(
  canvas: WorkingCanvas,
  mimeType: SupportedMimeType,
  quality?: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({
      type: mimeType,
      quality,
    });
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error(`浏览器无法编码 ${mimeType}`));
        }
      },
      mimeType,
      quality,
    );
  });
}

function canvasHasTransparency(
  context: Canvas2DLike,
  width: number,
  height: number,
): boolean {
  // Read in strips so a 100 MP input does not require a second 400 MB
  // allocation merely to inspect its alpha channel.
  const rowsPerStrip = Math.max(1, Math.min(128, height));
  for (let y = 0; y < height; y += rowsPerStrip) {
    const stripHeight = Math.min(rowsPerStrip, height - y);
    const pixels = context.getImageData(0, y, width, stripHeight).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 255) {
        return true;
      }
    }
  }

  return false;
}

function autoQuality(
  width: number,
  height: number,
  hint?: number,
): number {
  if (hint !== undefined) {
    return clampQuality(hint);
  }

  const megapixels = (width * height) / 1_000_000;
  if (megapixels > 12) {
    return 0.78;
  }
  if (megapixels > 4) {
    return 0.8;
  }
  return 0.84;
}

async function encodeToTargetSize(
  canvas: WorkingCanvas,
  mimeType: SupportedMimeType,
  compression: Extract<CompressionOptions, { mode: 'target-size' }>,
  warnings: ProcessWarningCode[],
): Promise<EncodedResult> {
  if (!Number.isFinite(compression.maxBytes) || compression.maxBytes <= 0) {
    throw new RangeError('compression.maxBytes must be greater than 0');
  }

  const minQuality = clampQuality(compression.minQuality ?? 0.2);
  const maxQuality = Math.max(
    minQuality,
    clampQuality(compression.maxQuality ?? 0.95),
  );
  const iterations = Math.max(
    1,
    Math.min(12, Math.round(compression.maxIterations ?? 8)),
  );
  const lowest = await canvasToBlob(canvas, mimeType, minQuality);
  if (lowest.size > compression.maxBytes) {
    warnings.push('TARGET_SIZE_UNREACHABLE');
    return {
      blob: lowest,
      quality: minQuality,
    };
  }

  const highest = await canvasToBlob(canvas, mimeType, maxQuality);
  if (highest.size <= compression.maxBytes) {
    return {
      blob: highest,
      quality: maxQuality,
    };
  }

  let lowerBound = minQuality;
  let upperBound = maxQuality;
  let bestBlob = lowest;
  let bestQuality = minQuality;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const candidateQuality = (lowerBound + upperBound) / 2;
    const candidateBlob = await canvasToBlob(
      canvas,
      mimeType,
      candidateQuality,
    );

    if (candidateBlob.size <= compression.maxBytes) {
      bestBlob = candidateBlob;
      bestQuality = candidateQuality;
      lowerBound = candidateQuality;
    } else {
      upperBound = candidateQuality;
    }
  }

  return {
    blob: bestBlob,
    quality: bestQuality,
  };
}

async function encodeCanvas(
  canvas: WorkingCanvas,
  mimeType: SupportedMimeType,
  compression: CompressionOptions,
  sourceSize: number,
  warnings: ProcessWarningCode[],
): Promise<EncodedResult> {
  if (mimeType === 'image/png') {
    if (compression.mode === 'quality') {
      warnings.push('PNG_QUALITY_UNSUPPORTED');
    } else if (compression.mode === 'target-size') {
      warnings.push('PNG_TARGET_SIZE_UNSUPPORTED');
    }
    return {
      blob: await canvasToBlob(canvas, mimeType),
      quality: null,
    };
  }

  if (compression.mode === 'target-size') {
    if (sourceSize > 0 && compression.maxBytes >= sourceSize) {
      // The source already fits the budget, so spending the whole budget on
      // quality would only make the file larger. Aim for "not larger than the
      // source" first and fall back to the requested budget if unreachable.
      warnings.push('TARGET_SIZE_ABOVE_SOURCE');
      const capped = await encodeToTargetSize(
        canvas,
        mimeType,
        { ...compression, maxBytes: sourceSize },
        [],
      );
      if (capped.blob.size <= sourceSize) {
        return capped;
      }
    }
    return encodeToTargetSize(canvas, mimeType, compression, warnings);
  }

  const quality = compression.mode === 'quality'
    ? clampQuality(compression.quality)
    : autoQuality(canvas.width, canvas.height, compression.qualityHint);
  return {
    blob: await canvasToBlob(canvas, mimeType, quality),
    quality,
  };
}

function releaseCanvas(canvas: WorkingCanvas): void {
  canvas.width = 1;
  canvas.height = 1;
}

/**
 * Process one image completely in the browser.
 *
 * Calls are intentionally independent, which lets callers process a queue one
 * item at a time and release the decoded bitmap/canvas before starting the next
 * item. `ImageWorkerClient` uses this same function in an OffscreenCanvas worker.
 */
export async function processImage(
  input: Blob,
  options: ProcessOptions,
): Promise<ProcessedImage> {
  const warnings: ProcessWarningCode[] = [];
  const decoded = await decodeImage(input);
  let canvas: WorkingCanvas | undefined;

  try {
    const drawPlan = createDrawPlan(
      { width: decoded.width, height: decoded.height },
      options.resize,
    );
    canvas = createCanvas(drawPlan.outputWidth, drawPlan.outputHeight);
    const context = getContext(canvas);
    context.drawImage(
      decoded.source,
      drawPlan.sourceX,
      drawPlan.sourceY,
      drawPlan.sourceWidth,
      drawPlan.sourceHeight,
      0,
      0,
      drawPlan.outputWidth,
      drawPlan.outputHeight,
    );

    // JPEG has no alpha channel, so avoid a potentially expensive full-pixel
    // read for the most common photo input.
    const sourceHasAlpha = normalizeInputMimeType(input.type) === 'image/jpeg'
      ? false
      : canvasHasTransparency(
          context,
          drawPlan.outputWidth,
          drawPlan.outputHeight,
        );
    const requestedMimeType = resolveOutputMimeType(
      input,
      options.format,
      warnings,
    );

    if (requestedMimeType === 'image/jpeg' && sourceHasAlpha) {
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = options.backgroundColor ?? '#ffffff';
      context.fillRect(0, 0, drawPlan.outputWidth, drawPlan.outputHeight);
      context.globalCompositeOperation = 'source-over';
      warnings.push('TRANSPARENCY_FLATTENED');
    }

    const compression = options.compression ?? DEFAULT_COMPRESSION;
    let encoded: EncodedResult;
    try {
      encoded = await encodeCanvas(
        canvas,
        requestedMimeType,
        compression,
        input.size,
        warnings,
      );
    } catch (error) {
      if (requestedMimeType === 'image/png') {
        throw error;
      }
      warnings.push('FORMAT_FALLBACK');
      encoded = await encodeCanvas(
        canvas,
        'image/png',
        compression,
        input.size,
        warnings,
      );
    }
    const actualMimeType = normalizeInputMimeType(encoded.blob.type)
      ?? requestedMimeType;
    if (actualMimeType !== requestedMimeType) {
      if (!warnings.includes('FORMAT_FALLBACK')) {
        warnings.push('FORMAT_FALLBACK');
      }
    }

    const pixelsUnchanged = drawPlan.sourceX === 0
      && drawPlan.sourceY === 0
      && drawPlan.sourceWidth === decoded.width
      && drawPlan.sourceHeight === decoded.height
      && drawPlan.outputWidth === decoded.width
      && drawPlan.outputHeight === decoded.height;
    const keepSource = options.keepSourceIfSmaller === true
      && pixelsUnchanged
      && normalizeInputMimeType(input.type) === actualMimeType
      && encoded.blob.size >= input.size;
    if (keepSource) {
      warnings.push('SOURCE_KEPT');
    }
    const outputBlob = keepSource ? input : encoded.blob;
    if (outputBlob.size > input.size) {
      warnings.push('OUTPUT_LARGER_THAN_SOURCE');
    }

    const savedBytes = input.size - outputBlob.size;
    return {
      blob: outputBlob,
      width: drawPlan.outputWidth,
      height: drawPlan.outputHeight,
      size: outputBlob.size,
      mimeType: actualMimeType,
      quality: !keepSource && LOSSY_MIME_TYPES.has(actualMimeType)
        ? encoded.quality
        : null,
      sourceHasAlpha,
      hasAlpha: actualMimeType === 'image/jpeg' ? false : sourceHasAlpha,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      sourceSize: input.size,
      savedBytes,
      savingsPercent: input.size > 0
        ? (savedBytes / input.size) * 100
        : 0,
      warnings,
    };
  } finally {
    decoded.close();
    if (canvas) {
      releaseCanvas(canvas);
    }
  }
}
