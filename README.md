# AyayaImage

面向证件照、头像和日常压缩的本地批量图片预处理工具。

AyayaImage 不是又一个“上传图片后等待服务器压缩”的网站。图片的读取、缩放、裁剪、编码和打包都在浏览器中完成，适合快速处理常用尺寸、格式与体积。界面只有暗色主题，并尽量减少不必要的设置和视觉干扰。

## 主要功能

- 批量拖入 PNG、JPEG 或 WebP 图片，按队列逐张处理
- 按指定宽度、最长边、百分比或固定尺寸裁剪
- 在 PNG、JPEG、WebP 与原格式之间转换
- 手动 `quality`、自动平衡，以及 JPEG/WebP 目标体积压缩
- Before / After 滑动比较与尺寸、体积、节省比例统计
- 单张下载或将批量结果打包为 ZIP
- 提供常用证件照与头像尺寸 preset；安装为 PWA 后可在已缓存的设备上离线使用
- 检查常见 EXIF 信息，并在重新编码后复核输出 metadata

所有功能都围绕一个原则：减少日常图片处理的重复劳动，同时让处理结果保持可解释、可预览。

## 内置 presets

| Preset | 输出规则 | 适合用途 |
| --- | --- | --- |
| 原图压缩 | 保持原始尺寸与输入格式 | 仅调整体积 |
| 1 寸证件照 | 295 × 413，JPEG | 25 × 35 mm 的 300 PPI 等效尺寸 |
| 2 寸证件照 | 413 × 579，JPEG | 35 × 49 mm 的 300 PPI 等效尺寸 |
| 小二寸照片 | 390 × 567，JPEG | 33 × 48 mm 的 300 PPI 等效尺寸 |
| 3:4 电子证件照 | 600 × 800，JPEG | 常用电子证件照比例 |
| 正方形头像 | 512 × 512，JPEG | 常用平台头像 |

「原图压缩」默认禁止放大小图。固定尺寸 preset 会在必要时放大输入，以保证输出像素尺寸准确；低分辨率原图可能因此变模糊。表中的毫米与 PPI 仅用于说明常见像素换算，浏览器导出不保证写入对应的 DPI metadata 或物理打印尺寸。证件照 preset 只负责居中裁剪、尺寸和格式，不会自动更换背景或校正头部位置，实际提交要求应以办理机构为准。每个 preset 都可以继续手动调整。

## 隐私与安全边界

- 图片处理不依赖上传 API，也没有账号、数据库或服务端图片处理。
- 选择的原图和生成结果保留在当前浏览器 tab 的本地内存中；下载由浏览器直接创建。
- PWA cache 只保存 AyayaImage 自身的 HTML、JavaScript、CSS、manifest 和图标，不缓存用户导入的图片。
- Canvas 重新编码通常不会复制原文件中的 EXIF，但这不等于法证级的 metadata 清除保证。AyayaImage 会尽可能复核生成文件；对隐私高度敏感的内容，下载后仍应使用独立工具再次检查。

项目没有网络上传路径，但浏览器、扩展程序、操作系统和托管平台仍属于 AyayaImage 控制范围之外。

## 已知限制

### 大图与内存

压缩包体积不代表解码后的内存占用。一张 `12000 × 8000` 图片仅 RGBA 像素就约占：

```text
12000 × 8000 × 4 bytes ≈ 366 MB
```

AyayaImage 默认逐张处理并在完成后释放临时资源，但超大图片、批量结果和 ZIP 打包仍可能触发浏览器或移动设备的内存限制。遇到提示时，请减少单批数量或降低目标尺寸。

### 格式与目标体积

- JPEG / WebP 可以用 binary search 寻找不超过目标体积的较高 `quality`，结果仍受图片内容和浏览器 encoder 影响。
- PNG 主要是 lossless 格式，不能像 JPEG / WebP 一样靠 `quality` 精确命中目标体积。
- 透明图片转换为 JPEG 时需要合成背景色，不能保留 alpha channel。
- MVP 不支持 HEIC 和 AVIF；HEIC 的浏览器解码兼容性不统一，AVIF 可在后续评估。

### 色彩

Canvas 重新编码可能改变或丢弃原图的 ICC color profile，专业摄影文件的颜色可能出现细微差异。AyayaImage 定位为浏览器本地图片预处理工具，不适合作为摄影归档、印刷前处理或原片管理工具。

## 本地开发

要求：

- Node.js `>= 22.12.0`（推荐 Node 24 LTS）
- npm

安装依赖：

```sh
npm ci
```

按项目约定，以 background mode 启动 Astro dev server：

```sh
npm run astro -- dev --background
```

查看日志或停止服务：

```sh
npm run astro -- dev status
npm run astro -- dev logs
npm run astro -- dev stop
```

类型检查与 production build：

```sh
npm run astro -- check
npm run build
```

本地预览 production output：

```sh
npm run preview
```

## GitHub Pages 部署

仓库内的 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 使用 Astro 官方 GitHub Action：

1. 将仓库推送到 GitHub，并确保默认部署分支为 `main`。
2. 打开仓库 **Settings → Pages**。
3. 将 **Build and deployment → Source** 设为 **GitHub Actions**。
4. push 到 `main`，或在 **Actions** 页面手动运行 workflow。

workflow 会根据 GitHub repository 自动注入 `SITE_URL` 和 `BASE_PATH`；`astro.config.mjs` 再用这两个环境变量生成 `site` 与 `base`。普通项目仓库的等效配置通常是：

```js
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://YOUR_NAME.github.io',
  base: '/YOUR_REPOSITORY',
});
```

如果仓库名是特殊的 `YOUR_NAME.github.io`，通常不需要 `base`。页面中的 manifest、service worker 和静态资源都应通过 Astro 的 `BASE_URL` 生成路径，不能写死 `/`；这样 PWA 在 repo subpath 下才能正常安装和离线运行。

如需在本地模拟普通 GitHub Pages repo path：

```sh
SITE_URL=https://YOUR_NAME.github.io BASE_PATH=/YOUR_REPOSITORY npm run build
```

使用 custom domain 时，应同时调整 workflow 中注入的 `SITE_URL` / `BASE_PATH`，并按 GitHub Pages 要求配置 `public/CNAME`。

## 技术结构

```text
Astro + React UI
        ↓
File / Blob
        ↓
Web Worker + createImageBitmap
        ↓
Canvas / OffscreenCanvas
        ↓
PNG / JPEG / WebP Blob
        ↓
本地预览、单张下载或 JSZip
```

- Astro：静态页面与 GitHub Pages build
- React + TypeScript：交互与处理状态
- Web Worker / OffscreenCanvas：尽量避免编码阻塞 UI，并提供兼容 fallback
- JSZip：批量下载
- Service Worker：缓存 app shell，支持再次访问时离线运行

## 浏览器建议

建议使用最新稳定版 Chrome、Edge、Firefox 或 Safari。实际可用的输入解码、WebP encoder、OffscreenCanvas 和 PWA 安装行为取决于浏览器；不支持的能力应自动回退或在界面中给出说明。
