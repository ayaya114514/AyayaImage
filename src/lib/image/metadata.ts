export type MetadataWarning =
  | 'UNRECOGNIZED_CONTAINER'
  | 'CONTAINER_SCAN_FAILED'
  | 'EXIF_PARSE_FAILED';

export interface InputMetadataSummary {
  hasMetadata: boolean;
  hasGps: boolean;
  device: string | null;
  takenAt: Date | null;
  software: string | null;
  orientation: number | null;
  latitude: number | null;
  longitude: number | null;
  containerMarkers: string[];
  warnings: MetadataWarning[];
}

export interface OutputMetadataVerification {
  verified: boolean;
  metadataRemoved: boolean;
  hasMetadata: boolean;
  hasGps: boolean;
  containerMarkers: string[];
  warnings: MetadataWarning[];
}

interface ContainerScan {
  recognized: boolean;
  markers: string[];
}

type ExifRecord = Record<string, unknown>;

const JPEG_SIGNATURE = [0xff, 0xd8] as const;
const PNG_SIGNATURE = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let result = '';
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function scanJpeg(bytes: Uint8Array): ContainerScan {
  if (!startsWith(bytes, JPEG_SIGNATURE)) {
    return { recognized: false, markers: [] };
  }

  const markers: string[] = [];
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= bytes.length) {
      break;
    }

    const segmentLength = ((bytes[offset] ?? 0) << 8)
      | (bytes[offset + 1] ?? 0);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }
    const payloadStart = offset + 2;
    const payloadLength = segmentLength - 2;

    if (marker === 0xe1) {
      const identifier = ascii(
        bytes,
        payloadStart,
        Math.min(40, payloadLength),
      );
      if (identifier.startsWith('Exif\0\0')) {
        markers.push('exif');
      } else if (
        identifier.startsWith('http://ns.adobe.com/xap/1.0/')
        || identifier.includes('xmp')
      ) {
        markers.push('xmp');
      } else {
        markers.push('app1');
      }
    } else if (marker === 0xed) {
      markers.push('iptc');
    } else if (marker === 0xfe) {
      markers.push('comment');
    }

    offset += segmentLength;
  }

  return {
    recognized: true,
    markers: unique(markers),
  };
}

function scanPng(bytes: Uint8Array): ContainerScan {
  if (!startsWith(bytes, PNG_SIGNATURE)) {
    return { recognized: false, markers: [] };
  }

  const markers: string[] = [];
  const metadataChunks = new Map<string, string>([
    ['eXIf', 'exif'],
    ['iTXt', 'text'],
    ['tEXt', 'text'],
    ['zTXt', 'text'],
    ['tIME', 'time'],
  ]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = PNG_SIGNATURE.length;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const chunkType = ascii(bytes, offset + 4, 4);
    const marker = metadataChunks.get(chunkType);
    if (marker) {
      markers.push(marker);
    }
    const nextOffset = offset + 12 + length;
    if (nextOffset <= offset || nextOffset > bytes.length) {
      break;
    }
    offset = nextOffset;
    if (chunkType === 'IEND') {
      break;
    }
  }

  return {
    recognized: true,
    markers: unique(markers),
  };
}

function scanWebp(bytes: Uint8Array): ContainerScan {
  if (
    bytes.length < 12
    || ascii(bytes, 0, 4) !== 'RIFF'
    || ascii(bytes, 8, 4) !== 'WEBP'
  ) {
    return { recognized: false, markers: [] };
  }

  const markers: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    if (chunkType === 'EXIF') {
      markers.push('exif');
    } else if (chunkType === 'XMP ') {
      markers.push('xmp');
    }
    const paddedLength = chunkLength + (chunkLength % 2);
    const nextOffset = offset + 8 + paddedLength;
    if (nextOffset <= offset || nextOffset > bytes.length) {
      break;
    }
    offset = nextOffset;
  }

  return {
    recognized: true,
    markers: unique(markers),
  };
}

async function scanContainer(blob: Blob): Promise<ContainerScan> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const jpeg = scanJpeg(bytes);
  if (jpeg.recognized) {
    return jpeg;
  }
  const png = scanPng(bytes);
  if (png.recognized) {
    return png;
  }
  return scanWebp(bytes);
}

async function parseExif(blob: Blob): Promise<ExifRecord> {
  const { parse } = await import('exifr');
  const parsed: unknown = await parse(blob, {
    tiff: true,
    exif: true,
    gps: true,
    xmp: true,
    iptc: true,
    icc: false,
    jfif: false,
    ihdr: false,
    sanitize: true,
    mergeOutput: true,
  });
  return parsed && typeof parsed === 'object'
    ? (parsed as ExifRecord)
    : {};
}

function firstString(
  record: ExifRecord,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstNumber(
  record: ExifRecord,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstDate(
  record: ExifRecord,
  keys: readonly string[],
): Date | null {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return null;
}

function containsGpsKeys(record: ExifRecord): boolean {
  return Object.keys(record).some((key) => (
    /^(?:gps|latitude|longitude)/i.test(key)
  ));
}

function containsPrivacyMetadata(record: ExifRecord): boolean {
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return false;
  }

  return keys.some((key) => (
    /^(?:make|model|software|artist|copyright|owner|serial|lens|gps|latitude|longitude|date|create|modify|offset|usercomment|description|keywords|rating|orientation)/i
      .test(key)
  ));
}

export async function inspectInputMetadata(
  file: Blob,
): Promise<InputMetadataSummary> {
  const warnings: MetadataWarning[] = [];
  let scan: ContainerScan = { recognized: false, markers: [] };
  let metadata: ExifRecord = {};

  try {
    scan = await scanContainer(file);
    if (!scan.recognized) {
      warnings.push('UNRECOGNIZED_CONTAINER');
    }
  } catch {
    warnings.push('CONTAINER_SCAN_FAILED');
  }

  try {
    metadata = await parseExif(file);
  } catch {
    warnings.push('EXIF_PARSE_FAILED');
  }

  const make = firstString(metadata, ['Make', 'make']);
  const model = firstString(metadata, ['Model', 'model']);
  const device = [make, model]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' ') || null;
  const latitude = firstNumber(metadata, ['latitude', 'Latitude']);
  const longitude = firstNumber(metadata, ['longitude', 'Longitude']);
  const hasGps = (
    (latitude !== null && longitude !== null)
    || containsGpsKeys(metadata)
  );

  return {
    hasMetadata: (
      scan.markers.length > 0
      || containsPrivacyMetadata(metadata)
    ),
    hasGps,
    device,
    takenAt: firstDate(metadata, [
      'DateTimeOriginal',
      'CreateDate',
      'DateTimeDigitized',
      'ModifyDate',
      'DateTime',
    ]),
    software: firstString(metadata, [
      'Software',
      'CreatorTool',
      'ProcessingSoftware',
    ]),
    orientation: firstNumber(metadata, ['Orientation']),
    latitude,
    longitude,
    containerMarkers: scan.markers,
    warnings: unique(warnings) as MetadataWarning[],
  };
}

/**
 * Re-opens and checks the encoded output. A successful result is based on the
 * bytes in `blob`, not on an assumption that Canvas normally strips metadata.
 * Color profiles are intentionally not classified as privacy metadata.
 */
export async function verifyOutputMetadata(
  blob: Blob,
): Promise<OutputMetadataVerification> {
  const warnings: MetadataWarning[] = [];
  let scan: ContainerScan = { recognized: false, markers: [] };
  let metadata: ExifRecord = {};
  let scanCompleted = false;

  try {
    scan = await scanContainer(blob);
    scanCompleted = true;
    if (!scan.recognized) {
      warnings.push('UNRECOGNIZED_CONTAINER');
    }
  } catch {
    warnings.push('CONTAINER_SCAN_FAILED');
  }

  try {
    metadata = await parseExif(blob);
  } catch {
    // exifr throws for a valid image with no metadata in some browser/build
    // combinations. The independent container scan remains authoritative.
    warnings.push('EXIF_PARSE_FAILED');
  }

  const hasGps = containsGpsKeys(metadata);
  const hasMetadata = (
    scan.markers.length > 0
    || containsPrivacyMetadata(metadata)
  );
  const verified = scanCompleted && scan.recognized;

  return {
    verified,
    metadataRemoved: verified && !hasMetadata && !hasGps,
    hasMetadata,
    hasGps,
    containerMarkers: scan.markers,
    warnings: unique(warnings) as MetadataWarning[],
  };
}
