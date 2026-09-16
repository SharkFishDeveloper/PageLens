"use client";

let openCVPromise: Promise<any> | null = null;

/**
 * Loads and initializes OpenCV.js safely without freezing the main thread.
 */
export function waitForOpenCV(): Promise<any> {
  if (openCVPromise) return openCVPromise;

  openCVPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      return reject(new Error("OpenCV requires a browser environment."));
    }

    // Fast path: Already loaded and ready
    if ((window as any).cv?.Mat) {
      return resolve((window as any).cv);
    }

    const timeout = setTimeout(() => {
      reject(new Error("OpenCV initialization timed out after 20 seconds. Check if opencv.js script exists."));
    }, 20000);

    const onCvReady = (cvInstance: any) => {
      clearTimeout(timeout);
      console.log("OpenCV is ready!");
      resolve(cvInstance);
    };

    // Case 1: Script tag exists or window.cv is an Emscripten loader hook
    if ((window as any).cv) {
      const cvObj = (window as any).cv;
      if (typeof cvObj === "function") {
        // Emscripten modularized promise/factory
        cvObj().then((instance: any) => {
          (window as any).cv = instance;
          onCvReady(instance);
        }).catch(reject);
        return;
      }

      // Emscripten onRuntimeInitialized callback
      const prevCallback = cvObj.onRuntimeInitialized;
      cvObj.onRuntimeInitialized = () => {
        if (prevCallback) prevCallback();
        onCvReady((window as any).cv);
      };
      return;
    }

    // Case 2: opencv.js script not loaded yet; dynamically inject it
    let script = document.querySelector('script[src*="opencv.js"]') as HTMLScriptElement;
    if (!script) {
      script = document.createElement("script");
      script.src = "https://docs.opencv.org/4.8.0/opencv.js";
      script.async = true;
      script.type = "text/javascript";
      document.head.appendChild(script);
    }

    // Hook runtime readiness
    (window as any).Module = {
      onRuntimeInitialized() {
        onCvReady((window as any).cv);
      },
    };

    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Failed to fetch opencv.js script"));
    };
  });

  return openCVPromise;
}

/**
 * Clean preprocessing tailored to Arabic/English historical and scanned books:
 * 1. Automatically crops heavy black scanner glass margins.
 * 2. Normalizes background without generating noisy borders.
 * 3. Applies high-contrast sharpening without destroying Arabic dots or thin ligatures.
 */
export async function preprocessWithOpenCV(
  sourceCanvas: HTMLCanvasElement
): Promise<HTMLCanvasElement> {
  const cv = await waitForOpenCV();

  const src = cv.imread(sourceCanvas);
  const gray = new cv.Mat();
  const cropped = new cv.Mat();
  const bg = new cv.Mat();
  const diff = new cv.Mat();
  const normalized = new cv.Mat();

  try {
    // 1. Grayscale
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // 2. Detect and crop heavy black scanner borders
    // Average row intensities to find book page margins
    const width = gray.cols;
    const height = gray.rows;
    let leftCrop = 0;
    let rightCrop = width;

    // Fast margin check across horizontal spans
    const sampleYStart = Math.floor(height * 0.25);
    const sampleYEnd = Math.floor(height * 0.75);
    const step = 8;

    for (let x = 0; x < Math.floor(width * 0.3); x += step) {
      let colSum = 0;
      let count = 0;
      for (let y = sampleYStart; y < sampleYEnd; y += step) {
        colSum += gray.ucharPtr(y, x)[0];
        count++;
      }
      if (colSum / count > 60) { // Page detected
        leftCrop = Math.max(0, x - step);
        break;
      }
    }

    for (let x = width - 1; x > Math.floor(width * 0.7); x -= step) {
      let colSum = 0;
      let count = 0;
      for (let y = sampleYStart; y < sampleYEnd; y += step) {
        colSum += gray.ucharPtr(y, x)[0];
        count++;
      }
      if (colSum / count > 60) {
        rightCrop = Math.min(width, x + step);
        break;
      }
    }

    const cropWidth = rightCrop - leftCrop;
    const workingMat = (cropWidth > width * 0.4)
      ? gray.roi(new cv.Rect(leftCrop, 0, cropWidth, height))
      : gray;

    // 3. Morphological background division (eliminates shadows and yellowed paper)
    // A large structuring element captures the lighting gradient without touching text
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(41, 41));
    cv.morphologyEx(workingMat, bg, cv.MORPH_DILATE, kernel);
    kernel.delete();

    // normalized = 255 - (background - original)
    cv.absdiff(bg, workingMat, diff);
    cv.subtract(cv.Mat.ones(workingMat.rows, workingMat.cols, cv.CV_8UC1), cv.Mat.zeros(workingMat.rows, workingMat.cols, cv.CV_8UC1), normalized);
    cv.subtract(new cv.Mat(workingMat.rows, workingMat.cols, cv.CV_8UC1, new cv.Scalar(255)), diff, normalized);

    // 4. Contrast normalization (darkens text while forcing background paper to clean white)
    cv.normalize(normalized, normalized, 0, 255, cv.NORM_MINMAX, cv.CV_8UC1);

    // 5. Export directly to output canvas (Grayscale output is superior for Tesseract LSTM)
    const outputCanvas = document.createElement("canvas");
    cv.imshow(outputCanvas, normalized);

    if (workingMat !== gray) workingMat.delete();

    return outputCanvas;
  } finally {
    src.delete();
    gray.delete();
    cropped.delete();
    bg.delete();
    diff.delete();
    normalized.delete();
  }
}