import { processImage } from './processor';
import type {
  ProcessedImage,
  ProcessOptions,
  WorkerProcessRequest,
  WorkerProcessResponse,
} from './types';

interface PendingRequest {
  resolve(result: ProcessedImage): void;
  reject(error: Error): void;
  file: Blob;
  options: ProcessOptions;
}

export interface ImageWorkerClientOptions {
  /**
   * Useful for tests or custom bundlers. The default uses the Vite/Astro
   * worker URL convention.
   */
  workerFactory?: () => Worker;
  forceMainThread?: boolean;
}

export interface SequentialProgress {
  completed: number;
  total: number;
  current: ProcessedImage;
}

function createRequestId(): string {
  if (
    typeof crypto !== 'undefined'
    && typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return `image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class ImageWorkerClient {
  private readonly pending = new Map<string, PendingRequest>();

  private worker: Worker | null = null;

  public constructor(options: ImageWorkerClientOptions = {}) {
    if (
      options.forceMainThread
      || typeof Worker === 'undefined'
      || typeof OffscreenCanvas === 'undefined'
    ) {
      return;
    }

    try {
      this.worker = options.workerFactory
        ? options.workerFactory()
        : new Worker(
            new URL('../../workers/image.worker.ts', import.meta.url),
            { type: 'module' },
          );
      this.worker.addEventListener('message', this.handleMessage);
      this.worker.addEventListener('error', this.handleWorkerError);
    } catch {
      // CSP, older Safari versions, or a non-Vite consumer may reject module
      // workers. The public method transparently falls back to the main thread.
      this.worker = null;
    }
  }

  public process(file: Blob, options: ProcessOptions): Promise<ProcessedImage> {
    if (!this.worker) {
      return processImage(file, options);
    }

    const id = createRequestId();
    return new Promise<ProcessedImage>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        file,
        options,
      });
      const request: WorkerProcessRequest = {
        id,
        type: 'process',
        file,
        options,
      };
      try {
        this.worker?.postMessage(request);
      } catch {
        this.pending.delete(id);
        processImage(file, options).then(resolve, reject);
      }
    });
  }

  public terminate(): void {
    this.worker?.removeEventListener('message', this.handleMessage);
    this.worker?.removeEventListener('error', this.handleWorkerError);
    this.worker?.terminate();
    this.worker = null;

    for (const request of this.pending.values()) {
      request.reject(new Error('The image worker was terminated.'));
    }
    this.pending.clear();
  }

  private readonly handleMessage = (
    event: MessageEvent<WorkerProcessResponse>,
  ): void => {
    const request = this.pending.get(event.data.id);
    if (!request) {
      return;
    }

    this.pending.delete(event.data.id);
    if (event.data.type === 'success') {
      request.resolve(event.data.result);
    } else {
      request.reject(new Error(event.data.error));
    }
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    event.preventDefault();
    let fallbackQueue = Promise.resolve();
    for (const request of this.pending.values()) {
      fallbackQueue = fallbackQueue.then(async () => {
        try {
          request.resolve(await processImage(request.file, request.options));
        } catch (error) {
          request.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  };
}

export async function processImagesSequentially(
  files: readonly Blob[],
  options:
    | ProcessOptions
    | ((file: Blob, index: number) => ProcessOptions),
  onProgress?: (progress: SequentialProgress) => void,
): Promise<ProcessedImage[]> {
  const client = new ImageWorkerClient();
  const results: ProcessedImage[] = [];

  try {
    for (const [index, file] of files.entries()) {
      const resolvedOptions = typeof options === 'function'
        ? options(file, index)
        : options;
      const current = await client.process(file, resolvedOptions);
      results.push(current);
      onProgress?.({
        completed: index + 1,
        total: files.length,
        current,
      });
    }
  } finally {
    client.terminate();
  }

  return results;
}
