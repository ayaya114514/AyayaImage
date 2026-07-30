import type {
  DrawPlan,
  ResizeOptions,
  SourceDimensions,
} from './types';

function positiveInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a finite number greater than 0`);
  }

  return Math.max(1, Math.round(value));
}

function scaledDimensions(
  source: SourceDimensions,
  scale: number,
): SourceDimensions {
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

function clampScale(scale: number, noUpscale: boolean): number {
  return noUpscale ? Math.min(1, scale) : scale;
}

export function createDrawPlan(
  source: SourceDimensions,
  resize: ResizeOptions,
): DrawPlan {
  const sourceWidth = positiveInteger(source.width, 'source.width');
  const sourceHeight = positiveInteger(source.height, 'source.height');
  const noUpscale = resize.noUpscale ?? true;

  if (resize.mode === 'original') {
    return {
      outputWidth: sourceWidth,
      outputHeight: sourceHeight,
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
    };
  }

  if (resize.mode === 'width') {
    const targetWidth = positiveInteger(resize.width, 'resize.width');
    const dimensions = scaledDimensions(
      { width: sourceWidth, height: sourceHeight },
      clampScale(targetWidth / sourceWidth, noUpscale),
    );
    return {
      outputWidth: dimensions.width,
      outputHeight: dimensions.height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
    };
  }

  if (resize.mode === 'long-edge') {
    const targetLength = positiveInteger(resize.length, 'resize.length');
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    const dimensions = scaledDimensions(
      { width: sourceWidth, height: sourceHeight },
      clampScale(targetLength / longestEdge, noUpscale),
    );
    return {
      outputWidth: dimensions.width,
      outputHeight: dimensions.height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
    };
  }

  if (resize.mode === 'percent') {
    if (!Number.isFinite(resize.percent) || resize.percent <= 0) {
      throw new RangeError('resize.percent must be greater than 0');
    }
    const percent = resize.percent;
    const dimensions = scaledDimensions(
      { width: sourceWidth, height: sourceHeight },
      clampScale(percent / 100, noUpscale),
    );
    return {
      outputWidth: dimensions.width,
      outputHeight: dimensions.height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
    };
  }

  const requestedWidth = positiveInteger(resize.width, 'resize.width');
  const requestedHeight = positiveInteger(resize.height, 'resize.height');
  const outputScale = noUpscale
    ? Math.min(1, sourceWidth / requestedWidth, sourceHeight / requestedHeight)
    : 1;
  const outputWidth = Math.max(1, Math.round(requestedWidth * outputScale));
  const outputHeight = Math.max(1, Math.round(requestedHeight * outputScale));
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = outputWidth / outputHeight;

  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceAspect > targetAspect) {
    cropWidth = sourceHeight * targetAspect;
  } else if (sourceAspect < targetAspect) {
    cropHeight = sourceWidth / targetAspect;
  }

  return {
    outputWidth,
    outputHeight,
    sourceX: (sourceWidth - cropWidth) / 2,
    sourceY: (sourceHeight - cropHeight) / 2,
    sourceWidth: cropWidth,
    sourceHeight: cropHeight,
  };
}
