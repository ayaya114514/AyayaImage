import { processImage as processImageOnCurrentThread } from './processor';
import { ImageWorkerClient } from './worker-client';
import type {
  ProcessedImage,
  ProcessOptions,
} from './types';

let sharedClient: ImageWorkerClient | null = null;

/**
 * Public browser entry point. It keeps one sequential OffscreenCanvas worker
 * alive for the page lifetime and transparently uses the reusable main-thread
 * processor when workers are unavailable.
 */
export function processImage(
  file: Blob,
  options: ProcessOptions,
): Promise<ProcessedImage> {
  if (typeof window === 'undefined') {
    return processImageOnCurrentThread(file, options);
  }

  sharedClient ??= new ImageWorkerClient();
  return sharedClient.process(file, options);
}

export function disposeSharedImageWorker(): void {
  sharedClient?.terminate();
  sharedClient = null;
}
