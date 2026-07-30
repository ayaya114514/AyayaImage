import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Download,
  LoaderCircle,
  Plus,
  Save,
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

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_QUEUE_LENGTH = 30;
const DESKTOP_PIXEL_WARNING = 40_000_000;
const MOBILE_PIXEL_WARNING = 20_000_000;
const DESKTOP_PIXEL_LIMIT = 100_000_000;
const MOBILE_PIXEL_LIMIT = 40_000_000;
const ZIP_MEMORY_WARNING = 250 * 1024 * 1024;

const PRESET_LABELS: Record<string, string> = {
  "blog-body": "博客正文",
  "blog-thumbnail": "博客缩略图",
  "open-graph": "Open Graph",
  "github-readme": "GitHub README",
  avatar: "Avatar",
  original: "Original",
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
  const emptyPickerRef = useRef<HTMLDivElement>(null);
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

  const [zipBusy, setZipBusy] = useState(false);
  const isBusy = isImporting || isProcessing || zipBusy;

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

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (isBusy) return;
    if (event.dataTransfer.files.length) {
      void addFiles(event.dataTransfer.files);
    }
  };

  const removeItem = (id: string) => {
    const isLastItem = items.length === 1;
    const target = items.find((item) => item.id === id);
    releaseObjectUrl(target?.sourceUrl);
    releaseObjectUrl(target?.resultUrl);
    setItems((current) => current.filter((item) => item.id !== id));
    if (activeId === id) {
      setActiveId(items.find((item) => item.id !== id)?.id);
    }
    if (isLastItem) {
      window.requestAnimationFrame(() => emptyPickerRef.current?.focus());
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
    window.requestAnimationFrame(() => emptyPickerRef.current?.focus());
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
    setCompressionMode("auto");
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
    if (selectedPreset === id) setSelectedPreset("");
    try {
      await deleteStoredPreset(id);
    } catch {
      setQueueMessage("无法更新本地 preset");
    }
  };

  const downloadZip = async (
    files: Array<{ name: string; blob: Blob }>,
    filename: string,
  ) => {
    if (!files.length || operationLockRef.current) return;
    operationLockRef.current = true;
    setZipBusy(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      files.forEach((file) => zip.file(file.name, file.blob));
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
    <div
      className={`app-shell${items.length > 0 ? " has-items" : ""}`}
      data-testid="ayayaimage-app"
    >
      <main>
        <section
          className={`import-section${isDragging ? " is-dragging" : ""}`}
          aria-label="图片导入"
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

          {items.length === 0 ? (
            <div className="empty-state">
              <div className="content-brand">
                <img
                  className="brand-icon"
                  src={`${import.meta.env.BASE_URL}icons/favicon-64.png`}
                  width="28"
                  height="28"
                  alt=""
                />
                <span>AyayaImage</span>
              </div>

              <div
                ref={emptyPickerRef}
                className={`drop-zone${isDragging ? " is-dragging" : ""}${
                  isBusy ? " is-disabled" : ""
                }`}
                data-testid="drop-zone"
                role="button"
                tabIndex={0}
                aria-label="选择或拖入 JPEG、PNG 或 WebP 图片，所有处理均在本地完成"
                aria-disabled={isBusy}
                onClick={() => {
                  if (!isBusy) fileInputRef.current?.click();
                }}
                onKeyDown={handleDropZoneKeyDown}
              >
                <Upload aria-hidden="true" size={20} />
                <strong>{isImporting ? "正在读取…" : "选择图片"}</strong>
              </div>
            </div>
          ) : (
            <>
              <div className="workspace-header">
                <div className="content-brand">
                  <img
                    className="brand-icon"
                    src={`${import.meta.env.BASE_URL}icons/favicon-64.png`}
                    width="28"
                    height="28"
                    alt=""
                  />
                  <span>AyayaImage</span>
                </div>
                <div className="workspace-actions">
                  <span>
                    {items.length} 张 · {formatBytes(totalInputSize)}
                  </span>
                  <button
                    className="text-button"
                    type="button"
                    disabled={isBusy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Plus aria-hidden="true" size={14} />
                    添加图片
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={clearQueue}
                    disabled={isBusy}
                    aria-label="清空图片队列"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
              </div>

              <div
                className="queue-list"
                role="list"
                aria-label="图片队列"
                data-testid="image-queue"
              >
                {items.map((item) => (
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
                      <X aria-hidden="true" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="sr-announcement" aria-live="polite">
            {queueMessage}
          </p>
        </section>

        {items.length > 0 && (
          <section
            className="editor-section"
            aria-label="图片设置与预览"
            data-testid="optimize-workspace"
          >
            <div className="quick-controls">
                  <label className="field">
                    <span>用途</span>
                    <select
                      value={selectedPreset}
                      disabled={isBusy}
                      onChange={(event) => applyPreset(event.target.value)}
                    >
                      <option value="" disabled>
                        自定义设置
                      </option>
                      {PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {PRESET_LABELS[preset.id] ?? preset.label}
                        </option>
                      ))}
                      {customPresets.length > 0 && (
                        <optgroup label="自定义">
                          {customPresets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </label>

                  <label className="field">
                    <span>尺寸</span>
                    <select
                      value={resizeMode}
                      disabled={isBusy}
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

                  <label className="field" title={formatRecommendation}>
                    <span>格式</span>
                    <select
                      value={format}
                      disabled={isBusy}
                      onChange={(event) => {
                        setFormat(
                          event.target.value as ProcessOptions["format"],
                        );
                        setSelectedPreset("");
                      }}
                    >
                      {(
                        ["webp", "jpeg", "png", "original"] as const
                      ).map((value) => (
                        <option key={value} value={value}>
                          {FORMAT_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span>压缩</span>
                    <select
                      value={compressionMode}
                      disabled={isBusy}
                      onChange={(event) => {
                        setCompressionMode(
                          event.target.value as CompressionMode,
                        );
                        setSelectedPreset("");
                      }}
                    >
                      <option value="auto">自动平衡</option>
                      <option value="quality">指定 quality</option>
                      <option value="target-size">指定最大体积</option>
                    </select>
                  </label>
            </div>

            <div className="editor-grid">
              <div className="controls-panel">
                <div className="contextual-controls">
                  {resizeMode === "width" && (
                    <label className="field">
                      <span>宽度</span>
                      <span className="number-input">
                        <input
                          type="number"
                          min="1"
                          max="12000"
                          value={width}
                          disabled={isBusy}
                          onChange={(event) => {
                            setWidth(Number(event.target.value));
                            setSelectedPreset("");
                          }}
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
                          disabled={isBusy}
                          onChange={(event) => {
                            setLongEdge(Number(event.target.value));
                            setSelectedPreset("");
                          }}
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
                          disabled={isBusy}
                          onChange={(event) => {
                            setPercent(Number(event.target.value));
                            setSelectedPreset("");
                          }}
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
                            disabled={isBusy}
                            onChange={(event) => {
                              setWidth(Number(event.target.value));
                              setSelectedPreset("");
                            }}
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
                            disabled={isBusy}
                            onChange={(event) => {
                              setHeight(Number(event.target.value));
                              setSelectedPreset("");
                            }}
                          />
                          <small>px</small>
                        </span>
                      </label>
                    </>
                  )}

                  {compressionMode === "target-size" ? (
                    <label className="field">
                      <span>最大体积</span>
                      <span className="number-input">
                        <input
                          type="number"
                          min="10"
                          max="100000"
                          value={targetSizeKb}
                          disabled={isBusy}
                          onChange={(event) => {
                            setTargetSizeKb(Number(event.target.value));
                            setSelectedPreset("");
                          }}
                        />
                        <small>KB</small>
                      </span>
                    </label>
                  ) : (
                    <label className="range-field">
                      <span>
                        {compressionMode === "auto" ? "质量" : "Quality"}
                        <output>{quality}%</output>
                      </span>
                      <input
                        type="range"
                        min="20"
                        max="100"
                        step="1"
                        value={quality}
                        disabled={isBusy}
                        onChange={(event) => {
                          setQuality(Number(event.target.value));
                          setSelectedPreset("");
                        }}
                      />
                    </label>
                  )}

                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={noUpscale}
                      disabled={isBusy}
                      onChange={(event) => {
                        setNoUpscale(event.target.checked);
                        setSelectedPreset("");
                      }}
                    />
                    <span className="check-box" aria-hidden="true">
                      <Check size={11} />
                    </span>
                    禁止放大
                  </label>
                </div>

                {targetIncludesPng &&
                  compressionMode === "target-size" && (
                    <p className="inline-notice">
                      <AlertTriangle aria-hidden="true" size={14} />
                      PNG 无法通过 quality 精确命中体积。
                    </p>
                  )}

                <details className="advanced-settings">
                  <summary>
                    <span>更多设置</span>
                    <small>命名与 preset</small>
                  </summary>
                  <div className="advanced-settings-content">
                    <div className="naming-settings">
                      <label className="field">
                        <span>命名方式</span>
                        <select
                          value={namingMode}
                          disabled={isBusy}
                          onChange={(event) =>
                            setNamingMode(event.target.value as NamingMode)
                          }
                        >
                          <option value="original">原文件名</option>
                          <option value="pattern">命名规则</option>
                        </select>
                      </label>

                      {namingMode === "pattern" && (
                        <label className="field">
                          <span>
                            规则
                            <small>
                              {"{name} {index} {width} {height}"}
                            </small>
                          </span>
                          <input
                            type="text"
                            value={pattern}
                            disabled={isBusy}
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
                            disabled={isBusy}
                            onChange={(event) => setPrefix(event.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span>Suffix</span>
                          <input
                            type="text"
                            value={suffix}
                            disabled={isBusy}
                            onChange={(event) => setSuffix(event.target.value)}
                          />
                        </label>
                      </div>

                      <div className="check-row">
                        <label className="check-field">
                          <input
                            type="checkbox"
                            checked={lowerCase}
                            disabled={isBusy}
                            onChange={(event) =>
                              setLowerCase(event.target.checked)
                            }
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
                            disabled={isBusy}
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
                            disabled={isBusy}
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
                    </div>

                    <div className="save-preset">
                      <p className="save-preset-label">
                        保存当前设置
                      </p>
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
                          {presetSaved ? "已保存" : "保存"}
                        </button>
                      </div>
                    </div>

                    {customPresets.length > 0 && (
                      <div className="saved-presets">
                        <span>已保存</span>
                        <div>
                          {customPresets.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              disabled={isBusy}
                              onClick={() => void deleteCustomPreset(preset.id)}
                              aria-label={`删除 preset ${preset.label}`}
                            >
                              {preset.label}
                              <X aria-hidden="true" size={11} />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </details>

                {(hasLargeImage ||
                  totalInputSize > ZIP_MEMORY_WARNING) && (
                  <div className="warning-stack" aria-label="处理提示">
                    {hasLargeImage && (
                      <p>
                        <AlertTriangle aria-hidden="true" size={14} />
                        队列包含超大图片，建议降低尺寸。
                      </p>
                    )}
                    {totalInputSize > ZIP_MEMORY_WARNING && (
                      <p>
                        <Archive aria-hidden="true" size={14} />
                        ZIP 可能占用较多内存，建议分批下载。
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
                    <LoaderCircle
                      className="spin"
                      aria-hidden="true"
                      size={17}
                    />
                  ) : (
                    <SlidersHorizontal aria-hidden="true" size={17} />
                  )}
                  {isProcessing
                    ? "正在处理"
                    : `处理 ${items.length || 0} 张图片`}
                </button>
              </div>

              <div className="preview-panel">
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
                {activeItem && (
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
                      </>
                    )}
                  </>
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

              {activeItem?.result && (
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
                        {activeItem.result.savingsPercent >= 0 && (
                          <>
                            {" · "}
                            节省 {activeItem.result.savingsPercent.toFixed(1)}%
                          </>
                        )}
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
              )}
            </div>
          </div>
          </section>
        )}

      </main>
    </div>
  );
}
