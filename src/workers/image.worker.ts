import { processImage } from '../lib/image/processor';
import type {
  WorkerProcessRequest,
  WorkerProcessResponse,
} from '../lib/image/types';

interface ImageWorkerScope {
  onmessage: ((event: MessageEvent<WorkerProcessRequest>) => void) | null;
  postMessage(message: WorkerProcessResponse): void;
}

const workerScope = globalThis as unknown as ImageWorkerScope;
let processingQueue: Promise<void> = Promise.resolve();

async function handleRequest(request: WorkerProcessRequest): Promise<void> {
  try {
    const result = await processImage(request.file, request.options);
    workerScope.postMessage({
      id: request.id,
      type: 'success',
      result,
    });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

workerScope.onmessage = (event) => {
  if (event.data.type !== 'process') {
    return;
  }

  // A single queue keeps peak decoded-image memory bounded even if the UI
  // enqueues a large batch immediately.
  processingQueue = processingQueue.then(
    () => handleRequest(event.data),
    () => handleRequest(event.data),
  );
};

export {};
