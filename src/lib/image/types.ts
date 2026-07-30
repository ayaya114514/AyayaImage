export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];
export type OutputFormat = 'original' | 'jpeg' | 'png' | 'webp';

export type ResizeOptions =
  | {
      mode: 'original';
      noUpscale?: boolean;
    }
  | {
      mode: 'width';
      width: number;
      noUpscale?: boolean;
    }
  | {
      mode: 'long-edge';
      length: number;
      noUpscale?: boolean;
    }
  | {
      mode: 'percent';
      percent: number;
      noUpscale?: boolean;
    }
  | {
      mode: 'fixed';
      width: number;
      height: number;
      noUpscale?: boolean;
    };

export type CompressionOptions =
  | {
      mode: 'quality';
      quality: number;
    }
  | {
      mode: 'target-size';
      maxBytes: number;
      minQuality?: number;
      maxQuality?: number;
      maxIterations?: number;
    }
  | {
      mode: 'auto';
      qualityHint?: number;
    };

export interface ProcessOptions {
  resize: ResizeOptions;
  format: OutputFormat;
  compression?: CompressionOptions;
  /**
   * JPEG cannot retain transparency. Transparent pixels are composited over
   * this CSS color before encoding. Defaults to #ffffff.
   */
  backgroundColor?: string;
}

export type ProcessWarningCode =
  | 'PNG_QUALITY_UNSUPPORTED'
  | 'PNG_TARGET_SIZE_UNSUPPORTED'
  | 'TARGET_SIZE_UNREACHABLE'
  | 'TARGET_SIZE_ABOVE_SOURCE'
  | 'TRANSPARENCY_FLATTENED'
  | 'FORMAT_FALLBACK'
  | 'INPUT_TYPE_UNSUPPORTED';

export interface ProcessedImage {
  blob: Blob;
  width: number;
  height: number;
  size: number;
  mimeType: SupportedMimeType;
  quality: number | null;
  sourceHasAlpha: boolean;
  hasAlpha: boolean;
  sourceWidth: number;
  sourceHeight: number;
  sourceSize: number;
  savedBytes: number;
  savingsPercent: number;
  warnings: ProcessWarningCode[];
}

export interface ImagePreset {
  id: string;
  label: string;
  description: string;
  resize: ResizeOptions;
  suggestedFormat: OutputFormat;
  suggestedQuality: number;
  builtIn?: boolean;
}

export interface CustomImagePreset extends ImagePreset {
  builtIn?: false;
  createdAt: number;
  updatedAt: number;
}

export interface SourceDimensions {
  width: number;
  height: number;
}

export interface DrawPlan {
  outputWidth: number;
  outputHeight: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface WorkerProcessRequest {
  id: string;
  type: 'process';
  file: Blob;
  options: ProcessOptions;
}

export interface WorkerProcessSuccess {
  id: string;
  type: 'success';
  result: ProcessedImage;
}

export interface WorkerProcessFailure {
  id: string;
  type: 'error';
  error: string;
}

export type WorkerProcessResponse =
  | WorkerProcessSuccess
  | WorkerProcessFailure;

export interface BlogBundlePlanOptions {
  widths?: readonly number[];
  thumbnail?: {
    width: number;
    height: number;
  };
  format?: Exclude<OutputFormat, 'original'>;
  quality?: number;
  includeOriginal?: boolean;
}

export interface BlogBundleVariant {
  id: string;
  suffix: string;
  width: number | null;
  height: number | null;
  resize: ResizeOptions;
  format: OutputFormat;
  quality: number;
}

export interface BlogBundleOutput extends BlogBundleVariant {
  image: ProcessedImage;
}
