import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileImage,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ImageWorkerClient,
  createDrawPlan,
  inspectInputMetadata,
  PRESETS,
  deduplicateOutputName,
  deleteCustomPreset as deleteStoredPreset,
  extensionForMimeType,
  listCustomPresets,
  saveCustomPreset as persistCustomPreset,
  verifyOutputMetadata,
  type CustomImagePreset,
  type InputMetadataSummary,
  type OutputMetadataVerification,
  type ProcessOptions,
  type ProcessedImage,
  type ProcessWarningCode,
  type ResizeOptions,
} from "../lib";
import "../styles/app.css";

type QueueStatus = "ready" | "processing" | "done" | "error";
type CompressionMode = "quality" | "target-size" | "auto";
type NamingMode = "original" | "pattern";
type SnippetKind = "markdown" | "astro";

type QueueItem = {
  id: string;
  file: File;
  sourceUrl: string;
  width: number;
  height: number;
  status: QueueStatus;
  result?: ProcessedImage;
  resultUrl?: string;
  outputName?: string;
  error?: string;
  metadata?: InputMetadataSummary;
  metadataVerification?: OutputMetadataVerification;
  cropApplied?: boolean;
};

type BundleFile = {
  name: string;
  blob: Blob;
  width: number;
  height: number;
  kind: "original" | "responsive" | "thumbnail";
  metadataVerified: boolean;
};

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_QUEUE_LENGTH = 30;
const DESKTOP_PIXEL_WARNING = 40_000_000;
const MOBILE_PIXEL_WARNING = 20_000_000;
const DESKTOP_PIXEL_LIMIT = 100_000_000;
const MOBILE_PIXEL_LIMIT = 40_000_000;
const ZIP_MEMORY_WARNING = 250 * 1024 * 1024;

const PRESET_LABELS: Record<string, { label: string; use: string }> = {
  "blog-body": { label: "博客正文", use: "最长边 1600" },
  "blog-thumbnail": { label: "博客缩略图", use: "640 × 360" },
  "open-graph": { label: "Open Graph", use: "1200 × 630" },
  "github-readme": { label: "GitHub README", use: "最长边 1200" },
  avatar: { label: "Avatar", use: "512 × 512" },
  original: { label: "Original", use: "不缩放" },
};

const FORMAT_LABELS: Record<ProcessOptions["format"], string> = {
  original: "保留格式",
  webp: "WebP",
  jpeg: "JPEG",
  png: "PNG",
};

const WARNING_LABELS: Record<ProcessWarningCode, string> = {
  PNG_QUALITY_UNSUPPORTED: "PNG 为 lossless，quality 设置不会精确生效",
  PNG_TARGET_SIZE_UNSUPPORTED: "PNG 无法通过 quality 精确命中目标体积",
  TARGET_SIZE_UNREACHABLE: "最低 quality 仍高于目标体积",
  TARGET_SIZE_ABOVE_SOURCE: "目标体积高于原文件，本次优先保留质量",
  TRANSPARENCY_FLATTENED: "透明区域已在白色背景上合成",
  FORMAT_FALLBACK: "浏览器不支持所选 encoder，已使用兼容格式",
  INPUT_TYPE_UNSUPPORTED: "无法保留原格式，已使用 WebP",
};

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function sourceExtension(file: File) {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName === "jpeg") return "jpg";
  if (fromName && ["jpg", "png", "webp"].includes(fromName)) return fromName;
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function fileStem(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

function cleanName(value: string, lowerCase: boolean, stripSpecial: boolean) {
  let output = value.trim().replace(/\s+/g, "-");
  if (stripSpecial) {
    output = output
      .normalize("NFKC")
      .replace(/[\p{P}\p{S}]+/gu, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
  if (lowerCase) output = output.toLowerCase();
  return output || "image";
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function getImageDimensions(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("无法读取图片尺寸"));
    image.src = url;
  });
}

function statusText(status: QueueStatus) {
  if (status === "processing") return "处理中";
  if (status === "done") return "已完成";
  if (status === "error") return "失败";
  return "待处理";
}

export default function AyayaImageApp() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const operationLockRef = useRef(false);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [queueMessage, setQueueMessage] = useState("");
  const [isMobile, setIsMobile] = useState(false);

  const [selectedPreset, setSelectedPreset] = useState("blog-body");
  const [resizeMode, setResizeMode] =
    useState<ResizeOptions["mode"]>("long-edge");
  const [width, setWidth] = useState(1600);
  const [height, setHeight] = useState(1200);
  const [longEdge, setLongEdge] = useState(1600);
  const [percent, setPercent] = useState(100);
  const [noUpscale, setNoUpscale] = useState(true);
  const [format, setFormat] =
    useState<ProcessOptions["format"]>("webp");
  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("auto");
  const [quality, setQuality] = useState(82);
  const [targetSizeKb, setTargetSizeKb] = useState(500);

  const [namingMode, setNamingMode] = useState<NamingMode>("pattern");
  const [pattern, setPattern] = useState("{name}-{index}");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [lowerCase, setLowerCase] = useState(true);
  const [stripSpecial, setStripSpecial] = useState(true);
  const [appendDimensions, setAppendDimensions] = useState(false);

  const [comparePosition, setComparePosition] = useState(50);
  const [customPresets, setCustomPresets] = useState<CustomImagePreset[]>([]);
  const [customPresetName, setCustomPresetName] = useState("");
  const [presetSaved, setPresetSaved] = useState(false);

  const [bundleBaseName, setBundleBaseName] = useState("desk-setup");
  const [bundleAlt, setBundleAlt] = useState("");
  const [bundleFiles, setBundleFiles] = useState<BundleFile[]>([]);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleMessage, setBundleMessage] = useState("");
  const [snippetKind, setSnippetKind] = useState<SnippetKind>("astro");
  const [copied, setCopied] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const isBusy = isImporting || isProcessing || bundleBusy || zipBusy;

  const activeItem = useMemo(
    () => items.find((item) => item.id === activeId) ?? items[0],
    [activeId, items],
  );

  const totalInputSize = useMemo(
    () => items.reduce((sum, item) => sum + item.file.size, 0),
    [items],
  );
  const doneCount = items.filter((item) => item.status === "done").length;
  const pixelWarningLimit = isMobile
    ? MOBILE_PIXEL_WARNING
    : DESKTOP_PIXEL_WARNING;
  const hasLargeImage = items.some(
    (item) => item.width * item.height > pixelWarningLimit,
  );
  const hasPng = items.some((item) => item.file.type === "image/png");
  const targetIncludesPng =
    format === "png" || (format === "original" && hasPng);
  const formatRecommendation = activeItem
    ? activeItem.file.type === "image/png"
      ? "PNG 输入：截图或透明内容优先 WebP；需要无损时保留 PNG"
      : activeItem.file.type === "image/jpeg"
        ? "照片优先 WebP；需要最广兼容时选择 JPEG"
        : "已是 WebP：通常保留 WebP 即可"
    : "导入图片后会根据原格式给出建议";

  const makeObjectUrl = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  const releaseObjectUrl = useCallback((url?: string) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(url);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    listCustomPresets()
      .then(setCustomPresets)
      .catch(() => setQueueMessage("自定义 preset 暂时无法读取"));
  }, []);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeItem) return;
    if (
      bundleBaseName === "desk-setup" ||
      !items.some(
        (item) =>
          cleanName(fileStem(item.file.name), true, true) === bundleBaseName,
      )
    ) {
      setBundleBaseName(
        cleanName(fileStem(activeItem.file.name), true, true),
      );
    }
  }, [activeItem?.id]); // Keep a manually edited base name while selection is stable.

  useEffect(() => {
    setBundleFiles([]);
    setBundleMessage("");
  }, [activeItem?.id, bundleBaseName]);

  const updateItem = useCallback(
    (id: string, update: Partial<QueueItem>) => {
      setItems((current) =>
        current.map((item) => (item.id === id ? { ...item, ...update } : item)),
      );
    },
    [],
  );

  const addFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (operationLockRef.current) return;
      operationLockRef.current = true;
      setIsImporting(true);

      try {
        const incoming = Array.from(fileList);
        const availableSlots = Math.max(0, MAX_QUEUE_LENGTH - items.length);
        const supported = incoming
          .filter((file) => ACCEPTED_TYPES.has(file.type))
          .slice(0, availableSlots);
        const rejectedCount = incoming.length - supported.length;

        if (!supported.length) {
          setQueueMessage(
            availableSlots === 0
              ? `一次最多处理 ${MAX_QUEUE_LENGTH} 张图片`
              : "仅支持 JPEG、PNG 与 WebP",
          );
          return;
        }

        setQueueMessage("正在读取图片尺寸与 metadata…");
        const nextItems: QueueItem[] = [];
        for (const file of supported) {
          const sourceUrl = makeObjectUrl(file);
          try {
            const dimensions = await getImageDimensions(sourceUrl);
            let metadata: InputMetadataSummary | undefined;
            try {
              metadata = await inspectInputMetadata(file);
            } catch {
              // Metadata inspection must never prevent importing a valid image.
            }
            nextItems.push({
              id: makeId(),
              file,
              sourceUrl,
              ...dimensions,
              status: "ready",
              metadata,
            });
          } catch {
            releaseObjectUrl(sourceUrl);
          }
        }

        setItems((current) => [...current, ...nextItems]);
        setActiveId((current) => current ?? nextItems[0]?.id);
        setQueueMessage(
          rejectedCount > 0
            ? `已加入 ${nextItems.length} 张；${rejectedCount} 个文件未导入`
            : `已加入 ${nextItems.length} 张图片`,
        );
      } finally {
        setIsImporting(false);
        operationLockRef.current = false;
      }
    },
    [items.length, makeObjectUrl, releaseObjectUrl],
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = "";
  };

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isBusy) return;
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter(
          (item) =>
            item.kind === "file" &&
            item.type.startsWith("image/") &&
            ACCEPTED_TYPES.has(item.type),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (!imageFiles.length) return;
      event.preventDefault();
      void addFiles(imageFiles);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [addFiles, isBusy]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (isBusy) return;
    if (event.dataTransfer.files.length) {
      void addFiles(event.dataTransfer.files);
    }
  };

  const removeItem = (id: string) => {
    const target = items.find((item) => item.id === id);
    releaseObjectUrl(target?.sourceUrl);
    releaseObjectUrl(target?.resultUrl);
    setItems((current) => current.filter((item) => item.id !== id));
    if (activeId === id) {
      setActiveId(items.find((item) => item.id !== id)?.id);
    }
  };

  const clearQueue = () => {
    items.forEach((item) => {
      releaseObjectUrl(item.sourceUrl);
      releaseObjectUrl(item.resultUrl);
    });
    setItems([]);
    setActiveId(undefined);
    setQueueMessage("队列已清空");
  };

  const setResizeFromPreset = (resize: ResizeOptions) => {
    setResizeMode(resize.mode);
    setNoUpscale(resize.noUpscale ?? true);
    if (resize.mode === "width") setWidth(resize.width);
    if (resize.mode === "long-edge") setLongEdge(resize.length);
    if (resize.mode === "percent") setPercent(resize.percent);
    if (resize.mode === "fixed") {
      setWidth(resize.width);
      setHeight(resize.height);
    }
  };

  const applyPreset = (id: string) => {
    const preset =
      PRESETS.find((candidate) => candidate.id === id) ??
      customPresets.find((candidate) => candidate.id === id);
    if (!preset) return;
    setSelectedPreset(id);
    setResizeFromPreset(preset.resize);
    setFormat(preset.suggestedFormat);
    setQuality(Math.round(preset.suggestedQuality * 100));
  };

  const getResizeOptions = (): ResizeOptions => {
    const clampDimension = (value: number) =>
      Math.max(1, Math.min(12_000, Math.round(value || 1)));
    if (resizeMode === "width") {
      return { mode: "width", width: clampDimension(width), noUpscale };
    }
    if (resizeMode === "long-edge") {
      return {
        mode: "long-edge",
        length: clampDimension(longEdge),
        noUpscale,
      };
    }
    if (resizeMode === "percent") {
      return {
        mode: "percent",
        percent: Math.max(1, Math.min(400, Math.round(percent || 1))),
        noUpscale,
      };
    }
    if (resizeMode === "fixed") {
      return {
        mode: "fixed",
        width: clampDimension(width),
        height: clampDimension(height),
        noUpscale,
      };
    }
    return { mode: "original", noUpscale };
  };

  const getProcessOptions = (): ProcessOptions => {
    const compression: ProcessOptions["compression"] =
      compressionMode === "quality"
        ? { mode: "quality", quality: quality / 100 }
        : compressionMode === "target-size"
          ? {
              mode: "target-size",
              maxBytes: Math.max(1, targetSizeKb) * 1024,
            }
          : { mode: "auto", qualityHint: quality / 100 };
    return {
      resize: getResizeOptions(),
      format,
      compression,
      backgroundColor: "#ffffff",
    };
  };

  const makeOutputName = (
    item: QueueItem,
    result: ProcessedImage,
    index: number,
  ) => {
    const originalStem = fileStem(item.file.name);
    let base =
      namingMode === "original"
        ? originalStem
        : pattern
            .replaceAll("{name}", originalStem)
            .replaceAll("{index}", String(index + 1).padStart(2, "0"))
            .replaceAll("{width}", String(result.width))
            .replaceAll("{height}", String(result.height));
    base = cleanName(`${prefix}${base}${suffix}`, lowerCase, stripSpecial);
    if (appendDimensions) base += `-${result.width}x${result.height}`;
    return `${base}.${extensionForMimeType(result.mimeType)}`;
  };

  const processQueue = async () => {
    if (!items.length || operationLockRef.current) return;
    const options = getProcessOptions();
    const outputPixelLimit = isMobile
      ? MOBILE_PIXEL_LIMIT
      : DESKTOP_PIXEL_LIMIT;
    const unsafeOutput = items.find((item) => {
      const plan = createDrawPlan(
        { width: item.width, height: item.height },
        options.resize,
      );
      return plan.outputWidth * plan.outputHeight > outputPixelLimit;
    });
    if (unsafeOutput) {
      setQueueMessage(
        `${unsafeOutput.file.name} 的预计输出像素过高，请降低尺寸或开启“禁止放大小图”`,
      );
      return;
    }

    operationLockRef.current = true;
    setIsProcessing(true);
    setQueueMessage("正在本地逐张处理…");
    const workerClient = new ImageWorkerClient();
    let failedCount = 0;
    const usedOutputNames = new Set<string>();

    try {
      for (const [index, item] of items.entries()) {
        releaseObjectUrl(item.resultUrl);
        updateItem(item.id, {
          status: "processing",
          error: undefined,
          result: undefined,
          resultUrl: undefined,
          outputName: undefined,
          metadataVerification: undefined,
          cropApplied: undefined,
        });
        try {
          const result = await workerClient.process(item.file, options);
          const metadataVerification = await verifyOutputMetadata(
            result.blob,
          ).catch(() => undefined);
          const resultUrl = makeObjectUrl(result.blob);
          const outputName = deduplicateOutputName(
            makeOutputName(item, result, index),
            usedOutputNames,
          );
          updateItem(item.id, {
            result,
            resultUrl,
            outputName,
            status: "done",
            metadataVerification,
            cropApplied: options.resize.mode === "fixed",
          });
        } catch (error) {
          failedCount += 1;
          updateItem(item.id, {
            status: "error",
            error: error instanceof Error ? error.message : "处理失败",
          });
        }
      }
    } finally {
      workerClient.terminate();
      setIsProcessing(false);
      operationLockRef.current = false;
    }

    setQueueMessage(
      failedCount > 0
        ? `处理完成，${failedCount} 张失败`
        : "处理完成，文件仍只存在于当前浏览器",
    );
  };

  const saveCurrentPreset = async () => {
    const label = customPresetName.trim();
    if (!label) return;
    try {
      const saved = await persistCustomPreset({
        label,
        description: "自定义输出设置",
        resize: getResizeOptions(),
        suggestedFormat: format,
        suggestedQuality: quality / 100,
      });
      setCustomPresets((current) => [...current, saved]);
      setCustomPresetName("");
      setPresetSaved(true);
      window.setTimeout(() => setPresetSaved(false), 1_500);
    } catch {
      setQueueMessage("Preset 未能保存到此设备");
    }
  };

  const deleteCustomPreset = async (id: string) => {
    const next = customPresets.filter((preset) => preset.id !== id);
    setCustomPresets(next);
    if (selectedPreset === id) setSelectedPreset("blog-body");
    try {
      await deleteStoredPreset(id);
    } catch {
      setQueueMessage("无法更新本地 preset");
    }
  };

  const downloadZip = async (
    files: Array<{ name: string; blob: Blob }>,
    filename: string,
    folder?: string,
  ) => {
    if (!files.length || operationLockRef.current) return;
    operationLockRef.current = true;
    setZipBusy(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const target = folder ? zip.folder(folder) : zip;
      files.forEach((file) => target?.file(file.name, file.blob));
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
      });
      triggerDownload(blob, filename);
    } finally {
      setZipBusy(false);
      operationLockRef.current = false;
    }
  };

  const createBlogBundle = async () => {
    if (!activeItem || operationLockRef.current) return;
    operationLockRef.current = true;
    setBundleBusy(true);
    setBundleMessage("正在逐个生成尺寸，避免同时占用过多内存…");
    setBundleFiles([]);

    const base = cleanName(bundleBaseName, true, true);
    const output: BundleFile[] = [];
    const workerClient = new ImageWorkerClient();

    try {
      const originalResult = await workerClient.process(activeItem.file, {
        resize: { mode: "original", noUpscale: true },
        format: "original",
        compression: { mode: "quality", quality: 0.92 },
      });
      const originalMetadata = await verifyOutputMetadata(originalResult.blob);
      output.push({
        name: `${base}-original.${extensionForMimeType(originalResult.mimeType)}`,
        blob: originalResult.blob,
        width: originalResult.width,
        height: originalResult.height,
        kind: "original",
        metadataVerified: originalMetadata.metadataRemoved,
      });

      const seenWidths = new Set<number>();
      for (const [index, requestedWidth] of [1600, 960, 640].entries()) {
        const result = await workerClient.process(activeItem.file, {
          resize: {
            mode: "width",
            width: requestedWidth,
            noUpscale: true,
          },
          format: "webp",
          compression: {
            mode: "quality",
            quality: [0.82, 0.8, 0.78][index] ?? 0.8,
          },
        });
        if (seenWidths.has(result.width)) continue;
        seenWidths.add(result.width);
        const metadata = await verifyOutputMetadata(result.blob);
        output.push({
          name: `${base}-${result.width}.${extensionForMimeType(result.mimeType)}`,
          blob: result.blob,
          width: result.width,
          height: result.height,
          kind: "responsive",
          metadataVerified: metadata.metadataRemoved,
        });
      }

      const thumbnail = await workerClient.process(activeItem.file, {
        resize: {
          mode: "fixed",
          width: 640,
          height: 360,
          noUpscale: true,
        },
        format: "webp",
        compression: { mode: "quality", quality: 0.78 },
      });
      const thumbnailMetadata = await verifyOutputMetadata(thumbnail.blob);
      output.push({
        name: `${base}-thumbnail.${extensionForMimeType(thumbnail.mimeType)}`,
        blob: thumbnail.blob,
        width: thumbnail.width,
        height: thumbnail.height,
        kind: "thumbnail",
        metadataVerified: thumbnailMetadata.metadataRemoved,
      });

      setBundleFiles(output);
      setBundleMessage(
        output.every((file) => file.metadataVerified)
          ? "资源包已生成，所有输出均未发现常见隐私 metadata"
          : "资源包已生成；部分文件未能完成常见隐私 metadata 检查",
      );
    } catch (error) {
      setBundleMessage(
        error instanceof Error ? error.message : "资源包生成失败",
      );
    } finally {
      workerClient.terminate();
      setBundleBusy(false);
      operationLockRef.current = false;
    }
  };

  const snippet = useMemo(() => {
    const base = cleanName(bundleBaseName, true, true);
    const alt = bundleAlt
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    const responsiveFiles = bundleFiles
      .filter((file) => file.kind === "responsive")
      .sort((a, b) => a.width - b.width);
    const originalFile = bundleFiles.find((file) => file.kind === "original");
    const fallbackResponsive = responsiveFiles.at(-1);

    if (snippetKind === "markdown") {
      const markdownAlt = bundleAlt
        .replaceAll("\\", "\\\\")
        .replaceAll("]", "\\]");
      const path = fallbackResponsive?.name ?? `${base}-1600.webp`;
      return `![${markdownAlt}](/images/${path})`;
    }

    const plannedWidths = [640, 960, 1600]
      .map((value) => Math.min(activeItem?.width ?? value, value))
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((a, b) => a - b);
    const srcset = responsiveFiles.length > 0
      ? responsiveFiles
          .map((file) => `      /images/${file.name} ${file.width}w`)
          .join(",\n")
      : plannedWidths
          .map((value) => `      /images/${base}-${value}.webp ${value}w`)
          .join(",\n");
    const originalName = originalFile?.name
      ?? `${base}-original.${activeItem ? sourceExtension(activeItem.file) : "jpg"}`;
    const intrinsicWidth = originalFile?.width ?? activeItem?.width ?? 1600;
    const intrinsicHeight = originalFile?.height ?? activeItem?.height ?? 1200;

    return `<picture>
  <source
    type="image/webp"
    srcset="
${srcset}
    "
  />
  <img
    src="/images/${originalName}"
    width="${intrinsicWidth}"
    height="${intrinsicHeight}"
    loading="lazy"
    decoding="async"
    alt="${alt}"
  />
</picture>`;
  }, [
    activeItem,
    bundleAlt,
    bundleBaseName,
    bundleFiles,
    snippetKind,
  ]);

  const copySnippet = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const handleDropZoneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isBusy) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const previewStyle = {
    "--compare-position": `${comparePosition}%`,
    "--preview-aspect": activeItem?.result
      ? `${activeItem.result.width} / ${activeItem.result.height}`
      : "auto",
  } as CSSProperties;

  return (
    <div className="app-shell" data-testid="ayayaimage-app">
      <header className="topbar">
        <a className="brand" href="./" aria-label="AyayaImage 首页">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>AyayaImage</span>
        </a>
        <div className="privacy-status" title="文件不会上传到服务器">
          <ShieldCheck aria-hidden="true" size={15} />
          <span>本地处理</span>
          <span className="status-dot" aria-hidden="true" />
        </div>
      </header>

      <main>
        <section className="import-section" aria-labelledby="import-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">01 / IMPORT</p>
              <h1 id="import-heading">发布前，把图片处理好。</h1>
            </div>
            <p className="section-note">
              JPEG、PNG、WebP · 文件不会离开你的设备
            </p>
          </div>

          <div
            className={`drop-zone${isDragging ? " is-dragging" : ""}${
              isBusy ? " is-disabled" : ""
            }`}
            data-testid="drop-zone"
            role="button"
            tabIndex={0}
            aria-label="选择或拖入图片"
            aria-disabled={isBusy}
            onClick={() => {
              if (!isBusy) fileInputRef.current?.click();
            }}
            onKeyDown={handleDropZoneKeyDown}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setIsDragging(false);
              }
            }}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              tabIndex={-1}
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={isBusy}
              onChange={handleFileInput}
            />
            <Upload aria-hidden="true" size={20} />
            <div>
              <strong>{isImporting ? "正在读取…" : "拖入图片"}</strong>
              <span>
                或点击选择 / ⌘V 粘贴，最多 {MAX_QUEUE_LENGTH} 张
              </span>
            </div>
            <span className="drop-action">选择文件</span>
          </div>

          <p className="sr-announcement" aria-live="polite">
            {queueMessage}
          </p>

          {items.length > 0 && (
            <div className="queue-block">
              <div className="queue-meta">
                <span>
                  {items.length} 张 · {formatBytes(totalInputSize)}
                </span>
                <button
                  className="text-button danger"
                  type="button"
                  onClick={clearQueue}
                  disabled={isBusy}
                >
                  <Trash2 aria-hidden="true" size={14} />
                  清空
                </button>
              </div>
              <div
                className="queue-list"
                role="list"
                aria-label="图片队列"
                data-testid="image-queue"
              >
                {items.map((item, index) => (
                  <div
                    key={item.id}
                    className={`queue-item${
                      activeItem?.id === item.id ? " is-active" : ""
                    }`}
                    role="listitem"
                  >
                    <button
                      className="queue-select"
                      type="button"
                      disabled={isBusy}
                      onClick={() => setActiveId(item.id)}
                      aria-pressed={activeItem?.id === item.id}
                    >
                      <span className="queue-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <img src={item.sourceUrl} alt="" />
                      <span className="queue-file">
                        <strong>{item.file.name}</strong>
                        <small>
                          {item.width} × {item.height} ·{" "}
                          {formatBytes(item.file.size)}
                        </small>
                      </span>
                      <span className={`queue-state state-${item.status}`}>
                        {item.status === "processing" && (
                          <LoaderCircle
                            className="spin"
                            aria-hidden="true"
                            size={13}
                          />
                        )}
                        {item.status === "done" && (
                          <Check aria-hidden="true" size={13} />
                        )}
                        {statusText(item.status)}
                      </span>
                    </button>
                    <button
                      className="icon-button remove-file"
                      type="button"
                      disabled={isBusy}
                      aria-label={`移除 ${item.file.name}`}
                      onClick={() => removeItem(item.id)}
                    >
                      <X aria-hidden="true" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section
          className="editor-section"
          aria-labelledby="settings-heading"
          data-testid="optimize-workspace"
        >
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">02 / OPTIMIZE</p>
              <h2 id="settings-heading">输出设置</h2>
            </div>
            {items.length > 0 && (
              <span className="active-file-label">
                <FileImage aria-hidden="true" size={14} />
                {activeItem?.file.name}
              </span>
            )}
          </div>

          <div className="preset-row" aria-label="用途预设">
            {PRESETS.map((preset) => {
              const copy = PRESET_LABELS[preset.id] ?? {
                label: preset.label,
                use: preset.description,
              };
              return (
                <button
                  className={`preset-chip${
                    selectedPreset === preset.id ? " is-active" : ""
                  }`}
                  type="button"
                  key={preset.id}
                  disabled={isBusy}
                  onClick={() => applyPreset(preset.id)}
                  aria-pressed={selectedPreset === preset.id}
                >
                  <span>{copy.label}</span>
                  <small>{copy.use}</small>
                </button>
              );
            })}
            {customPresets.map((preset) => (
              <span className="custom-chip-wrap" key={preset.id}>
                <button
                  className={`preset-chip${
                    selectedPreset === preset.id ? " is-active" : ""
                  }`}
                  type="button"
                  disabled={isBusy}
                  onClick={() => applyPreset(preset.id)}
                  aria-pressed={selectedPreset === preset.id}
                >
                  <span>{preset.label}</span>
                  <small>自定义</small>
                </button>
                <button
                  className="delete-preset"
                  type="button"
                  disabled={isBusy}
                  aria-label={`删除 preset ${preset.label}`}
                  onClick={() => void deleteCustomPreset(preset.id)}
                >
                  <X aria-hidden="true" size={11} />
                </button>
              </span>
            ))}
          </div>

          <div className="editor-grid">
            <div className="controls-panel">
              <fieldset className="control-group" disabled={isBusy}>
                <legend>尺寸</legend>
                <label className="field">
                  <span>模式</span>
                  <select
                    value={resizeMode}
                    onChange={(event) => {
                      setResizeMode(
                        event.target.value as ResizeOptions["mode"],
                      );
                      setSelectedPreset("");
                    }}
                  >
                    <option value="original">保持原始尺寸</option>
                    <option value="width">指定宽度</option>
                    <option value="long-edge">指定最长边</option>
                    <option value="percent">按百分比</option>
                    <option value="fixed">固定尺寸裁剪</option>
                  </select>
                </label>

                <div className="inline-fields">
                  {resizeMode === "width" && (
                    <label className="field">
                      <span>宽度</span>
                      <span className="number-input">
                        <input
                          type="number"
                          min="1"
                          max="12000"
                          value={width}
                          onChange={(event) =>
                            setWidth(Number(event.target.value))
                          }
                        />
                        <small>px</small>
                      </span>
                    </label>
                  )}
                  {resizeMode === "long-edge" && (
                    <label className="field">
                      <span>最长边</span>
                      <span className="number-input">
                        <input
                          type="number"
                          min="1"
                          max="12000"
                          value={longEdge}
                          onChange={(event) =>
                            setLongEdge(Number(event.target.value))
                          }
                        />
                        <small>px</small>
                      </span>
                    </label>
                  )}
                  {resizeMode === "percent" && (
                    <label className="field">
                      <span>缩放</span>
                      <span className="number-input">
                        <input
                          type="number"
                          min="1"
                          max="400"
                          value={percent}
                          onChange={(event) =>
                            setPercent(Number(event.target.value))
                          }
                        />
                        <small>%</small>
                      </span>
                    </label>
                  )}
                  {resizeMode === "fixed" && (
                    <>
                      <label className="field">
                        <span>宽度</span>
                        <span className="number-input">
                          <input
                            type="number"
                            min="1"
                            max="12000"
                            value={width}
                            onChange={(event) =>
                              setWidth(Number(event.target.value))
                            }
                          />
                          <small>px</small>
                        </span>
                      </label>
                      <label className="field">
                        <span>高度</span>
                        <span className="number-input">
                          <input
                            type="number"
                            min="1"
                            max="12000"
                            value={height}
                            onChange={(event) =>
                              setHeight(Number(event.target.value))
                            }
                          />
                          <small>px</small>
                        </span>
                      </label>
                    </>
                  )}
                </div>

                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={noUpscale}
                    onChange={(event) => setNoUpscale(event.target.checked)}
                  />
                  <span className="check-box" aria-hidden="true">
                    <Check size={11} />
                  </span>
                  禁止放大小图
                </label>
              </fieldset>

              <fieldset className="control-group" disabled={isBusy}>
                <legend>格式与压缩</legend>
                <div className="segmented" aria-label="输出格式">
                  {(
                    ["webp", "jpeg", "png", "original"] as const
                  ).map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={format === value ? "is-active" : ""}
                      onClick={() => setFormat(value)}
                      aria-pressed={format === value}
                    >
                      {FORMAT_LABELS[value]}
                    </button>
                  ))}
                </div>
                <p className="format-hint">{formatRecommendation}</p>

                <label className="field">
                  <span>压缩方式</span>
                  <select
                    value={compressionMode}
                    onChange={(event) =>
                      setCompressionMode(
                        event.target.value as CompressionMode,
                      )
                    }
                  >
                    <option value="auto">自动平衡</option>
                    <option value="quality">指定 quality</option>
                    <option value="target-size">指定最大体积</option>
                  </select>
                </label>

                {compressionMode === "target-size" ? (
                  <label className="field">
                    <span>最大体积</span>
                    <span className="number-input">
                      <input
                        type="number"
                        min="10"
                        max="100000"
                        value={targetSizeKb}
                        onChange={(event) =>
                          setTargetSizeKb(Number(event.target.value))
                        }
                      />
                      <small>KB</small>
                    </span>
                  </label>
                ) : (
                  <label className="range-field">
                    <span>
                      {compressionMode === "auto"
                        ? "质量倾向"
                        : "Quality"}
                      <output>{quality}%</output>
                    </span>
                    <input
                      type="range"
                      min="20"
                      max="100"
                      step="1"
                      value={quality}
                      onChange={(event) =>
                        setQuality(Number(event.target.value))
                      }
                    />
                  </label>
                )}

                {targetIncludesPng &&
                  compressionMode === "target-size" && (
                    <p className="inline-notice">
                      <AlertTriangle aria-hidden="true" size={14} />
                      PNG 是 lossless，无法像 JPEG / WebP 一样精确命中体积。
                    </p>
                  )}
              </fieldset>

              <fieldset
                className="control-group naming-group"
                disabled={isBusy}
              >
                <legend>命名</legend>
                <div className="segmented two" aria-label="命名方式">
                  <button
                    type="button"
                    className={namingMode === "original" ? "is-active" : ""}
                    onClick={() => setNamingMode("original")}
                    aria-pressed={namingMode === "original"}
                  >
                    原文件名
                  </button>
                  <button
                    type="button"
                    className={namingMode === "pattern" ? "is-active" : ""}
                    onClick={() => setNamingMode("pattern")}
                    aria-pressed={namingMode === "pattern"}
                  >
                    命名规则
                  </button>
                </div>

                {namingMode === "pattern" && (
                  <label className="field">
                    <span>
                      规则
                      <small>{"{name} {index} {width} {height}"}</small>
                    </span>
                    <input
                      type="text"
                      value={pattern}
                      onChange={(event) => setPattern(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                )}

                <div className="inline-fields">
                  <label className="field">
                    <span>Prefix</span>
                    <input
                      type="text"
                      value={prefix}
                      onChange={(event) => setPrefix(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Suffix</span>
                    <input
                      type="text"
                      value={suffix}
                      onChange={(event) => setSuffix(event.target.value)}
                    />
                  </label>
                </div>

                <div className="check-row">
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={lowerCase}
                      onChange={(event) => setLowerCase(event.target.checked)}
                    />
                    <span className="check-box" aria-hidden="true">
                      <Check size={11} />
                    </span>
                    小写
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={stripSpecial}
                      onChange={(event) =>
                        setStripSpecial(event.target.checked)
                      }
                    />
                    <span className="check-box" aria-hidden="true">
                      <Check size={11} />
                    </span>
                    清理标点
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={appendDimensions}
                      onChange={(event) =>
                        setAppendDimensions(event.target.checked)
                      }
                    />
                    <span className="check-box" aria-hidden="true">
                      <Check size={11} />
                    </span>
                    添加尺寸
                  </label>
                </div>
              </fieldset>

              <details className="save-preset">
                <summary>
                  <Plus aria-hidden="true" size={14} />
                  保存当前设置为 preset
                </summary>
                <div>
                  <label className="field">
                    <span>Preset 名称</span>
                    <input
                      type="text"
                      value={customPresetName}
                      disabled={isBusy}
                      placeholder="例如：博客横图"
                      onChange={(event) =>
                        setCustomPresetName(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveCurrentPreset();
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void saveCurrentPreset()}
                    disabled={!customPresetName.trim() || isBusy}
                  >
                    {presetSaved ? (
                      <CheckCircle2 aria-hidden="true" size={15} />
                    ) : (
                      <Save aria-hidden="true" size={15} />
                    )}
                    {presetSaved ? "已保存" : "保存到此设备"}
                  </button>
                </div>
              </details>

              {(hasLargeImage ||
                totalInputSize > ZIP_MEMORY_WARNING) && (
                <div className="warning-stack" aria-label="处理提示">
                  {hasLargeImage && (
                    <p>
                      <AlertTriangle aria-hidden="true" size={14} />
                      队列包含超大图片，将逐张处理；移动端建议先减少数量。
                    </p>
                  )}
                  {totalInputSize > ZIP_MEMORY_WARNING && (
                    <p>
                      <Archive aria-hidden="true" size={14} />
                      输入总量较大，ZIP 会额外占用内存，建议分批下载。
                    </p>
                  )}
                </div>
              )}

              <button
                className="primary-button process-button"
                data-testid="process-button"
                type="button"
                onClick={() => void processQueue()}
                disabled={!items.length || isBusy}
              >
                {isProcessing ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={17} />
                ) : (
                  <SlidersHorizontal aria-hidden="true" size={17} />
                )}
                {isProcessing
                  ? "正在逐张处理"
                  : `处理 ${items.length || 0} 张图片`}
              </button>
              <p className="processing-footnote">
                <LockKeyhole aria-hidden="true" size={12} />
                Canvas 本地重编码，不上传原图
              </p>
            </div>

            <div className="preview-panel">
              <div className="preview-toolbar">
                <span>Before / After</span>
                {activeItem?.result && (
                  <span>
                    {activeItem.result.savingsPercent >= 0
                      ? `节省 ${activeItem.result.savingsPercent.toFixed(1)}%`
                      : `增加 ${Math.abs(
                          activeItem.result.savingsPercent,
                        ).toFixed(1)}%`}
                  </span>
                )}
              </div>

              <div
                className={[
                  "comparison",
                  activeItem?.resultUrl && "has-result",
                  activeItem?.cropApplied && "is-cropped",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={previewStyle}
                data-testid="before-after"
              >
                {activeItem ? (
                  <>
                    <img
                      className="comparison-before"
                      src={activeItem.sourceUrl}
                      alt={`处理前：${activeItem.file.name}`}
                    />
                    {activeItem.resultUrl && (
                      <>
                        <div className="comparison-after-wrap">
                          <img
                            className="comparison-after"
                            src={activeItem.resultUrl}
                            alt={`处理后：${
                              activeItem.outputName ?? activeItem.file.name
                            }`}
                          />
                        </div>
                        <span className="compare-line" aria-hidden="true">
                          <span />
                        </span>
                        <input
                          className="compare-range"
                          type="range"
                          min="0"
                          max="100"
                          value={comparePosition}
                          onChange={(event) =>
                            setComparePosition(Number(event.target.value))
                          }
                          aria-label="调整处理前后对比位置"
                        />
                        <span className="compare-label before">原图</span>
                        <span className="compare-label after">输出</span>
                      </>
                    )}
                  </>
                ) : (
                  <div className="preview-empty">
                    <ImageIcon aria-hidden="true" size={24} />
                    <p>导入图片后在这里预览</p>
                    <span>处理完成后可拖动比较</span>
                  </div>
                )}
              </div>

              {activeItem?.status === "error" && (
                <p className="error-message">
                  <AlertTriangle aria-hidden="true" size={14} />
                  {activeItem.error}
                </p>
              )}

              {activeItem?.metadata?.hasMetadata && (
                <div className="source-metadata">
                  <span>原图 metadata</span>
                  <p>
                    {[
                      activeItem.metadata.device && "拍摄设备",
                      activeItem.metadata.takenAt && "拍摄时间",
                      activeItem.metadata.software && "软件信息",
                      activeItem.metadata.hasGps && "GPS 坐标",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "检测到 metadata marker"}
                  </p>
                </div>
              )}

              {activeItem?.result ? (
                <div className="result-block" data-testid="result-panel">
                  <dl className="result-stats">
                    <div>
                      <dt>原始尺寸</dt>
                      <dd>
                        {activeItem.width} × {activeItem.height}
                      </dd>
                    </div>
                    <div>
                      <dt>输出尺寸</dt>
                      <dd>
                        {activeItem.result.width} × {activeItem.result.height}
                      </dd>
                    </div>
                    <div>
                      <dt>文件大小</dt>
                      <dd>
                        {formatBytes(activeItem.file.size)}
                        <span aria-hidden="true"> → </span>
                        {formatBytes(activeItem.result.size)}
                      </dd>
                    </div>
                    <div>
                      <dt>格式 / Quality</dt>
                      <dd>
                        {activeItem.result.mimeType
                          .replace("image/", "")
                          .toUpperCase()}{" "}
                        /{" "}
                        {activeItem.result.quality === null
                          ? "lossless"
                          : Math.round(activeItem.result.quality * 100)}
                      </dd>
                    </div>
                    <div>
                      <dt>透明通道</dt>
                      <dd>
                        {activeItem.result.hasAlpha ? "保留" : "不包含"}
                      </dd>
                    </div>
                    <div>
                      <dt>Metadata</dt>
                      <dd
                        className={
                          activeItem.metadataVerification?.metadataRemoved
                            ? "verified"
                            : ""
                        }
                      >
                        {activeItem.metadataVerification?.metadataRemoved && (
                          <CheckCircle2 aria-hidden="true" size={13} />
                        )}
                        {activeItem.metadataVerification?.verified
                          ? activeItem.metadataVerification.metadataRemoved
                            ? "未发现常见隐私 metadata"
                            : "仍含 metadata"
                          : "未能验证"}
                      </dd>
                    </div>
                  </dl>

                  {activeItem.result.warnings.length > 0 && (
                    <div className="result-warnings">
                      {activeItem.result.warnings.map((warning) => (
                        <p key={warning}>
                          <AlertTriangle aria-hidden="true" size={13} />
                          {WARNING_LABELS[warning]}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="download-row">
                    <a
                      className="primary-button"
                      href={activeItem.resultUrl}
                      download={activeItem.outputName}
                    >
                      <Download aria-hidden="true" size={16} />
                      下载 {activeItem.outputName}
                    </a>
                    <button
                      className="secondary-button"
                      data-testid="download-zip"
                      type="button"
                      disabled={!doneCount || isBusy}
                      onClick={() =>
                        void downloadZip(
                          items
                            .filter(
                              (
                                item,
                              ): item is QueueItem & {
                                result: ProcessedImage;
                                outputName: string;
                              } =>
                                Boolean(item.result && item.outputName),
                            )
                            .map((item) => ({
                              name: item.outputName,
                              blob: item.result.blob,
                            })),
                          "ayayaimage-output.zip",
                        )
                      }
                    >
                      {zipBusy ? (
                        <LoaderCircle
                          className="spin"
                          aria-hidden="true"
                          size={16}
                        />
                      ) : (
                        <Archive aria-hidden="true" size={16} />
                      )}
                      全部 ZIP ({doneCount})
                    </button>
                  </div>
                </div>
              ) : (
                <div className="result-placeholder">
                  <span>OUTPUT</span>
                  <p>处理后显示尺寸、体积、格式与 metadata 状态。</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <section
          className="bundle-section"
          aria-labelledby="bundle-heading"
          data-testid="blog-bundle"
        >
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">03 / BLOG BUNDLE</p>
              <h2 id="bundle-heading">一张原图，生成完整资源包。</h2>
            </div>
            <p className="section-note">1600 / 960 / 640 / thumbnail + code</p>
          </div>

          <div className="bundle-grid">
            <div className="bundle-builder">
              <div className="inline-fields">
                <label className="field">
                  <span>文件名</span>
                  <input
                    type="text"
                    value={bundleBaseName}
                    disabled={isBusy}
                    onChange={(event) => setBundleBaseName(event.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>Alt text</span>
                  <input
                    type="text"
                    value={bundleAlt}
                    disabled={isBusy}
                    placeholder="简短描述图片内容"
                    onChange={(event) => setBundleAlt(event.target.value)}
                  />
                </label>
              </div>

              <div className="file-tree" aria-label="资源包文件">
                <p>{cleanName(bundleBaseName, true, true)}/</p>
                {(bundleFiles.length > 0
                  ? bundleFiles.map((file) => file.name)
                  : [
                      `${cleanName(bundleBaseName, true, true)}-original.${
                        activeItem ? sourceExtension(activeItem.file) : "jpg"
                      }`,
                      ...[1600, 960, 640]
                        .map((value) =>
                          Math.min(activeItem?.width ?? value, value),
                        )
                        .filter(
                          (value, index, values) =>
                            values.indexOf(value) === index,
                        )
                        .map(
                          (value) =>
                            `${cleanName(bundleBaseName, true, true)}-${value}.webp`,
                        ),
                      `${cleanName(bundleBaseName, true, true)}-thumbnail.webp`,
                    ]
                ).map((name, index, list) => (
                  <span key={name}>
                    {index === list.length - 1 ? "└──" : "├──"}{" "}
                    {name}
                  </span>
                ))}
              </div>

              <div className="bundle-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={!activeItem || isBusy}
                  onClick={() => void createBlogBundle()}
                >
                  {bundleBusy ? (
                    <LoaderCircle
                      className="spin"
                      aria-hidden="true"
                      size={16}
                    />
                  ) : (
                    <Plus aria-hidden="true" size={16} />
                  )}
                  {bundleBusy ? "正在生成" : "生成资源包"}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!bundleFiles.length || isBusy}
                  onClick={() =>
                    void downloadZip(
                      bundleFiles,
                      `${cleanName(bundleBaseName, true, true)}.zip`,
                      cleanName(bundleBaseName, true, true),
                    )
                  }
                >
                  <Archive aria-hidden="true" size={16} />
                  下载 ZIP
                </button>
              </div>
              <p className="bundle-status" aria-live="polite">
                {bundleMessage ||
                  (activeItem
                    ? `来源：${activeItem.file.name}`
                    : "先在上方导入并选择一张图片")}
              </p>
            </div>

            <div className="snippet-panel" data-testid="snippet-panel">
              <div className="snippet-toolbar">
                <div className="snippet-tabs">
                  <button
                    type="button"
                    aria-pressed={snippetKind === "astro"}
                    className={snippetKind === "astro" ? "is-active" : ""}
                    onClick={() => setSnippetKind("astro")}
                  >
                    Astro / HTML
                  </button>
                  <button
                    type="button"
                    aria-pressed={snippetKind === "markdown"}
                    className={snippetKind === "markdown" ? "is-active" : ""}
                    onClick={() => setSnippetKind("markdown")}
                  >
                    Markdown
                  </button>
                </div>
                <button
                  className="copy-button"
                  type="button"
                  onClick={() => void copySnippet()}
                  aria-label="复制代码"
                >
                  {copied ? (
                    <Check aria-hidden="true" size={14} />
                  ) : (
                    <Copy aria-hidden="true" size={14} />
                  )}
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              <pre>
                <code>{snippet}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="privacy-section" aria-labelledby="privacy-heading">
          <div>
            <ShieldCheck aria-hidden="true" size={18} />
            <h2 id="privacy-heading">隐私是处理流程的一部分。</h2>
          </div>
          <p>
            图片通过浏览器 Canvas 重新编码，通常会移除 EXIF、GPS、设备与拍摄时间。
            AyayaImage 面向 Web publishing，不用于专业摄影归档；下载前仍建议检查重要文件。
          </p>
        </section>
      </main>

      <footer>
        <span>AyayaImage</span>
        <span>Local-first web publishing optimizer</span>
      </footer>
    </div>
  );
}
