export {
  PRESETS,
  getPreset,
  type BuiltInPresetId,
} from './presets';
export {
  processImage as processImageOnCurrentThread,
  mimeTypeForFormat,
  extensionForMimeType,
} from './processor';
export {
  processImage,
  disposeSharedImageWorker,
} from './browser-processor';
export {
  ImageWorkerClient,
  processImagesSequentially,
  type ImageWorkerClientOptions,
  type SequentialProgress,
} from './worker-client';
export {
  createDrawPlan,
} from './geometry';
export {
  buildOutputName,
  deduplicateOutputName,
} from './naming';
export {
  inspectInputMetadata,
  verifyOutputMetadata,
  type InputMetadataSummary,
  type MetadataWarning,
  type OutputMetadataVerification,
} from './metadata';
export {
  SUPPORTED_MIME_TYPES,
  type CompressionOptions,
  type DrawPlan,
  type ImagePreset,
  type OutputFormat,
  type ProcessedImage,
  type ProcessOptions,
  type ProcessWarningCode,
  type ResizeOptions,
  type SourceDimensions,
  type SupportedMimeType,
} from './types';
