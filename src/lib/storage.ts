import type {
  CustomImagePreset,
  ImagePreset,
} from './image/types';

// Kept separate from application preference stores so adopting this reusable
// CRUD module cannot cause an IndexedDB version collision with older builds.
const DATABASE_NAME = 'ayayaimage-presets';
const DATABASE_VERSION = 1;
const PRESET_STORE = 'custom-presets';

let databasePromise: Promise<IDBDatabase> | null = null;

export type CustomPresetDraft = Omit<
  ImagePreset,
  'id' | 'builtIn'
> & {
  id?: string;
  createdAt?: number;
};

function requireIndexedDb(): IDBFactory {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this browser.');
  }
  return indexedDB;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error('IndexedDB request failed.'),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error('IndexedDB transaction failed.'),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error('IndexedDB transaction was aborted.'),
    );
  });
}

function createPresetId(): string {
  if (
    typeof crypto !== 'undefined'
    && typeof crypto.randomUUID === 'function'
  ) {
    return `custom-${crypto.randomUUID()}`;
  }
  return `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openPresetDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = requireIndexedDb().open(
      DATABASE_NAME,
      DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PRESET_STORE)) {
        const store = database.createObjectStore(PRESET_STORE, {
          keyPath: 'id',
        });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('Unable to open IndexedDB.'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(
        new Error('IndexedDB upgrade is blocked by another open AyayaImage tab.'),
      );
    };
  });

  return databasePromise;
}

export async function listCustomPresets(): Promise<CustomImagePreset[]> {
  const database = await openPresetDatabase();
  const transaction = database.transaction(PRESET_STORE, 'readonly');
  const values = await requestToPromise(
    transaction.objectStore(PRESET_STORE).getAll(),
  ) as CustomImagePreset[];
  await transactionDone(transaction);
  return values.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getCustomPreset(
  id: string,
): Promise<CustomImagePreset | null> {
  const database = await openPresetDatabase();
  const transaction = database.transaction(PRESET_STORE, 'readonly');
  const result = await requestToPromise(
    transaction.objectStore(PRESET_STORE).get(id),
  ) as CustomImagePreset | undefined;
  await transactionDone(transaction);
  return result ?? null;
}

export async function saveCustomPreset(
  draft: CustomPresetDraft,
): Promise<CustomImagePreset> {
  const id = draft.id?.trim() || createPresetId();
  const existing = await getCustomPreset(id);
  const now = Date.now();
  const preset: CustomImagePreset = {
    id,
    label: draft.label.trim(),
    description: draft.description.trim(),
    resize: draft.resize,
    suggestedFormat: draft.suggestedFormat,
    suggestedQuality: Math.min(
      0.98,
      Math.max(0.05, draft.suggestedQuality),
    ),
    builtIn: false,
    createdAt: existing?.createdAt ?? draft.createdAt ?? now,
    updatedAt: now,
  };

  if (!preset.label) {
    throw new Error('A custom preset must have a label.');
  }

  const database = await openPresetDatabase();
  const transaction = database.transaction(PRESET_STORE, 'readwrite');
  transaction.objectStore(PRESET_STORE).put(preset);
  await transactionDone(transaction);
  return preset;
}

export async function deleteCustomPreset(id: string): Promise<void> {
  const database = await openPresetDatabase();
  const transaction = database.transaction(PRESET_STORE, 'readwrite');
  transaction.objectStore(PRESET_STORE).delete(id);
  await transactionDone(transaction);
}

export async function clearCustomPresets(): Promise<void> {
  const database = await openPresetDatabase();
  const transaction = database.transaction(PRESET_STORE, 'readwrite');
  transaction.objectStore(PRESET_STORE).clear();
  await transactionDone(transaction);
}

export async function closePresetStorage(): Promise<void> {
  if (!databasePromise) {
    return;
  }
  const database = await databasePromise;
  database.close();
  databasePromise = null;
}
