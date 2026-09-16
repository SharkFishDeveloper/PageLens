
export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

export interface ContrastConfig {
  enabled: boolean;
  lowPercentile: number;
  highPercentile: number;
}

export interface DenoiseConfig {
  enabled: boolean;
  kernelSize: 3 | 5;
}

export interface SharpenConfig {
  enabled: boolean;
  amount: number;
}

export type BinarizeMethod = "none" | "sauvola" | "otsu";

export interface BinarizeConfig {
  enabled: boolean;
  method: BinarizeMethod;
  windowSize?: number;
  k?: number;
}

export interface UpscaleConfig {
  enabled: boolean;
  targetDpi: number;
  maxDimensionPx: number;
}

export interface OcrPreprocessConfig {
  upscale: UpscaleConfig;
  grayscale: boolean;
  contrast: ContrastConfig;
  denoise: DenoiseConfig;
  sharpen: SharpenConfig;
  binarize: BinarizeConfig;
}

export const DEFAULT_ARABIC_ENGLISH_OCR_CONFIG: OcrPreprocessConfig = {
  upscale: {
    enabled: true,
    targetDpi: 300,
    maxDimensionPx: 4000,
  },
  grayscale: true,
  contrast: {
    enabled: true,
    lowPercentile: 1,
    highPercentile: 99,
  },
  denoise: {
    enabled: false,
    kernelSize: 3,
  },
  sharpen: {
    enabled: false,
    amount: 0.4,
  },
  binarize: {
    enabled: false,
    method: "sauvola",
    windowSize: 31,
    k: 0.34,
  },
};

// -----------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------

/**
 *
 * @param sourceCanvas Canvas containing the rendered PDF page (e.g. from
 *                      PDF.js's `page.render()`).
 * @param userConfig    Partial config to override any default settings.
 */
export function preprocessImageForOcr(
  sourceCanvas: CanvasLike,
  userConfig: Partial<OcrPreprocessConfig> = {}
): CanvasLike {
  const config = mergeConfig(DEFAULT_ARABIC_ENGLISH_OCR_CONFIG, userConfig);

  // Step 1: Upscale first, so every later filter operates on more pixels.
  let workingCanvas = config.upscale.enabled
    ? upscaleCanvas(sourceCanvas, config.upscale)
    : cloneCanvas(sourceCanvas);

  const ctx = get2dContext(workingCanvas);
  let imageData = ctx.getImageData(0, 0, workingCanvas.width, workingCanvas.height);
  const { data, width, height } = imageData;

  // Step 2: Grayscale (luminosity method — weights match human/OCR
  // perception better than a flat RGB average, and collapses color
  // scan artifacts like yellowed paper or faint highlighter marks).
  if (config.grayscale) {
    toGrayscaleInPlace(data);
  }

  // Step 3: Percentile-based contrast stretch. Using percentiles (not
  // raw min/max) avoids letting a single stray dark speck or a bright
  // scanner-edge pixel skew the whole page's contrast.
  if (config.contrast.enabled) {
    stretchContrastInPlace(
      data,
      config.contrast.lowPercentile,
      config.contrast.highPercentile
    );
  }

  // Step 4: Light median denoise. Median filters remove isolated
  // speckle noise while preserving edges far better than a blur,
  // which matters for keeping Arabic dots/diacritics intact.
  if (config.denoise.enabled) {
    imageData = medianFilter(imageData, config.denoise.kernelSize);
  }

  // Step 5: Moderate unsharp mask to restore edge crispness after
  // denoising, improving separation between visually similar letterforms.
  if (config.sharpen.enabled) {
    imageData = unsharpMask(imageData, config.sharpen.amount);
  }

  // Step 6: Optional adaptive binarization (off by default — see header).
  if (config.binarize.enabled && config.binarize.method !== "none") {
    imageData =
      config.binarize.method === "sauvola"
        ? sauvolaThreshold(
            imageData,
            config.binarize.windowSize ?? 31,
            config.binarize.k ?? 0.34
          )
        : otsuThreshold(imageData);
  }

  ctx.putImageData(imageData, 0, 0);
  return workingCanvas;
}

// -----------------------------------------------------------------------
// Config helpers
// -----------------------------------------------------------------------

function mergeConfig(
  base: OcrPreprocessConfig,
  override: Partial<OcrPreprocessConfig>
): OcrPreprocessConfig {
  return {
    upscale: { ...base.upscale, ...override.upscale },
    grayscale: override.grayscale ?? base.grayscale,
    contrast: { ...base.contrast, ...override.contrast },
    denoise: { ...base.denoise, ...override.denoise },
    sharpen: { ...base.sharpen, ...override.sharpen },
    binarize: { ...base.binarize, ...override.binarize },
  };
}

// -----------------------------------------------------------------------
// Canvas plumbing (works with both HTMLCanvasElement and OffscreenCanvas)
// -----------------------------------------------------------------------

function get2dContext(canvas: CanvasLike): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error("imagePreprocessing: unable to acquire 2D canvas context.");
  }
  return ctx;
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function cloneCanvas(source: CanvasLike): CanvasLike {
  const clone = createCanvas(source.width, source.height);
  const ctx = get2dContext(clone);
  ctx.drawImage(source as CanvasImageSource, 0, 0);
  return clone;
}

/**
 * Scales the page up toward `targetDpi`, assuming PDF.js rendered at a
 * scale corresponding to ~72-150 DPI. We infer the current effective DPI
 * from pixel dimensions vs. a standard page size and only scale UP
 * (never down) — downscaling a scanned page destroys fine strokes.
 */
function upscaleCanvas(source: CanvasLike, config: UpscaleConfig): CanvasLike {
  // Assume a US-Letter/A4-ish page (~8.5in). This is a heuristic for
  // deciding whether the source is already high-resolution; it only
  // affects whether we scale up, not image quality directly.
  const assumedPageInches = 8.5;
  const currentDpi = source.width / assumedPageInches;

  let scaleFactor = config.targetDpi / currentDpi;
  if (!isFinite(scaleFactor) || scaleFactor < 1) {
    scaleFactor = 1; // never downscale here
  }

  let targetWidth = Math.round(source.width * scaleFactor);
  let targetHeight = Math.round(source.height * scaleFactor);

  // Respect the hard cap to avoid excessive memory/CPU use.
  const longestEdge = Math.max(targetWidth, targetHeight);
  if (longestEdge > config.maxDimensionPx) {
    const capFactor = config.maxDimensionPx / longestEdge;
    targetWidth = Math.round(targetWidth * capFactor);
    targetHeight = Math.round(targetHeight * capFactor);
  }

  if (targetWidth === source.width && targetHeight === source.height) {
    return cloneCanvas(source);
  }

  const scaledCanvas = createCanvas(targetWidth, targetHeight);
  const ctx = get2dContext(scaledCanvas);
  // High-quality smoothing for upscaling text (bicubic-like result).
  ctx.imageSmoothingEnabled = true;
  (ctx as any).imageSmoothingQuality = "high";
  ctx.drawImage(source as CanvasImageSource, 0, 0, targetWidth, targetHeight);
  return scaledCanvas;
}

// -----------------------------------------------------------------------
// Step: Grayscale
// -----------------------------------------------------------------------

function toGrayscaleInPlace(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Luminosity weighting: matches perceived brightness, so ink vs.
    // paper contrast is preserved more faithfully than a plain average.
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = data[i + 1] = data[i + 2] = gray;
    // alpha (data[i + 3]) left untouched
  }
}

// -----------------------------------------------------------------------
// Step: Percentile contrast stretch
// -----------------------------------------------------------------------

function stretchContrastInPlace(
  data: Uint8ClampedArray,
  lowPercentile: number,
  highPercentile: number
): void {
  const histogram = new Array(256).fill(0);
  let totalPixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    histogram[Math.round(data[i])]++; // channel already grayscale-equal
    totalPixels++;
  }

  const lowCount = totalPixels * (lowPercentile / 100);
  const highCount = totalPixels * (highPercentile / 100);

  let cumulative = 0;
  let blackPoint = 0;
  let whitePoint = 255;

  for (let level = 0; level < 256; level++) {
    cumulative += histogram[level];
    if (cumulative >= lowCount) {
      blackPoint = level;
      break;
    }
  }

  cumulative = 0;
  for (let level = 255; level >= 0; level--) {
    cumulative += histogram[level];
    if (cumulative >= cumulative - highCount) {
      whitePoint = level;
      break;
    }
  }

  if (whitePoint <= blackPoint) return; // degenerate page (e.g. blank); skip

  const range = whitePoint - blackPoint;
  for (let i = 0; i < data.length; i += 4) {
    const stretched = ((data[i] - blackPoint) / range) * 255;
    const clamped = Math.max(0, Math.min(255, stretched));
    data[i] = data[i + 1] = data[i + 2] = clamped;
  }
}

// -----------------------------------------------------------------------
// Step: Median filter (denoise)
// -----------------------------------------------------------------------

function medianFilter(imageData: ImageData, kernelSize: 3 | 5): ImageData {
  const { width, height, data } = imageData;
  const output = new Uint8ClampedArray(data.length);
  const radius = Math.floor(kernelSize / 2);
  const windowValues: number[] = new Array(kernelSize * kernelSize);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let ky = -radius; ky <= radius; ky++) {
        const sampleY = clampInt(y + ky, 0, height - 1);
        for (let kx = -radius; kx <= radius; kx++) {
          const sampleX = clampInt(x + kx, 0, width - 1);
          const idx = (sampleY * width + sampleX) * 4;
          windowValues[count++] = data[idx]; // grayscale: R=G=B
        }
      }
      windowValues.length = count;
      windowValues.sort((a, b) => a - b);
      const median = windowValues[Math.floor(count / 2)];

      const outIdx = (y * width + x) * 4;
      output[outIdx] = output[outIdx + 1] = output[outIdx + 2] = median;
      output[outIdx + 3] = data[outIdx + 3];
    }
  }

  return new ImageData(output, width, height);
}

// -----------------------------------------------------------------------
// Step: Unsharp mask (sharpen)
// -----------------------------------------------------------------------

function unsharpMask(imageData: ImageData, amount: number): ImageData {
  const { width, height, data } = imageData;
  const blurred = gaussianBlur3x3(imageData);
  const output = new Uint8ClampedArray(data.length);

  for (let i = 0; i < data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const original = data[i + channel];
      const blur = blurred.data[i + channel];
      // original + amount * (original - blurred)
      const sharpened = original + amount * (original - blur);
      output[i + channel] = Math.max(0, Math.min(255, sharpened));
    }
    output[i + 3] = data[i + 3];
  }

  return new ImageData(output, width, height);
}

function gaussianBlur3x3(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const output = new Uint8ClampedArray(data.length);
  // Small, mild 3x3 approximate Gaussian kernel (sum = 16).
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const kernelSum = 16;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let k = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const sampleY = clampInt(y + ky, 0, height - 1);
        for (let kx = -1; kx <= 1; kx++) {
          const sampleX = clampInt(x + kx, 0, width - 1);
          const idx = (sampleY * width + sampleX) * 4;
          sum += data[idx] * kernel[k++];
        }
      }
      const outIdx = (y * width + x) * 4;
      const value = sum / kernelSum;
      output[outIdx] = output[outIdx + 1] = output[outIdx + 2] = value;
      output[outIdx + 3] = data[outIdx + 3];
    }
  }

  return new ImageData(output, width, height);
}

// -----------------------------------------------------------------------
// Step: Optional binarization (Sauvola adaptive / Otsu global)
// -----------------------------------------------------------------------

/**
 * Sauvola local adaptive thresholding. Computes a per-pixel threshold
 * from the local mean and standard deviation in a window around it,
 * so it adapts to uneven scan lighting/shadows — much safer for text
 * with thin strokes than a single global threshold, because it won't
 * blow out a whole dim region of the page to black or white.
 */
function sauvolaThreshold(
  imageData: ImageData,
  windowSize: number,
  k: number
): ImageData {
  const { width, height, data } = imageData;
  const output = new Uint8ClampedArray(data.length);
  const radius = Math.floor(windowSize / 2);
  const R = 128; // dynamic range of standard deviation for grayscale

  // Integral images for fast local mean/variance computation.
  const integral = new Float64Array((width + 1) * (height + 1));
  const integralSq = new Float64Array((width + 1) * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < width; x++) {
      const value = data[(y * width + x) * 4];
      rowSum += value;
      rowSumSq += value * value;
      const idx = (y + 1) * (width + 1) + (x + 1);
      integral[idx] = integral[idx - (width + 1)] + rowSum;
      integralSq[idx] = integralSq[idx - (width + 1)] + rowSumSq;
    }
  }

  const areaSum = (
    arr: Float64Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) => {
    const w = width + 1;
    return (
      arr[(y1 + 1) * w + (x1 + 1)] -
      arr[(y0) * w + (x1 + 1)] -
      arr[(y1 + 1) * w + (x0)] +
      arr[(y0) * w + (x0)]
    );
  };

  for (let y = 0; y < height; y++) {
    const y0 = clampInt(y - radius, 0, height - 1);
    const y1 = clampInt(y + radius, 0, height - 1);
    for (let x = 0; x < width; x++) {
      const x0 = clampInt(x - radius, 0, width - 1);
      const x1 = clampInt(x + radius, 0, width - 1);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);

      const sum = areaSum(integral, x0, y0, x1, y1);
      const sumSq = areaSum(integralSq, x0, y0, x1, y1);
      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      const stdDev = Math.sqrt(variance);

      const threshold = mean * (1 + k * (stdDev / R - 1));

      const idx = (y * width + x) * 4;
      const pixelValue = data[idx];
      const binary = pixelValue > threshold ? 255 : 0;
      output[idx] = output[idx + 1] = output[idx + 2] = binary;
      output[idx + 3] = data[idx + 3];
    }
  }

  return new ImageData(output, width, height);
}

/**
 * Otsu global thresholding. Simpler/faster than Sauvola but uses a
 * single threshold for the whole page — riskier for scans with uneven
 * lighting, but useful as a quick comparison baseline.
 */
function otsuThreshold(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const histogram = new Array(256).fill(0);
  const totalPixels = width * height;

  for (let i = 0; i < data.length; i += 4) {
    histogram[data[i]]++;
  }

  let sumAll = 0;
  for (let level = 0; level < 256; level++) sumAll += level * histogram[level];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let optimalThreshold = 0;

  for (let level = 0; level < 256; level++) {
    weightBackground += histogram[level];
    if (weightBackground === 0) continue;

    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += level * histogram[level];

    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;

    const betweenVariance =
      weightBackground *
      weightForeground *
      (meanBackground - meanForeground) *
      (meanBackground - meanForeground);

    if (betweenVariance > maxVariance) {
      maxVariance = betweenVariance;
      optimalThreshold = level;
    }
  }

  const output = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const binary = data[i] > optimalThreshold ? 255 : 0;
    output[i] = output[i + 1] = output[i + 2] = binary;
    output[i + 3] = data[i + 3];
  }

  return new ImageData(output, width, height);
}

// -----------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}