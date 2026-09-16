import { createWorker, PSM, Worker } from "tesseract.js";
import { preprocessImageForOcr } from "./imagePreprocessing";

const workerPool: Record<string, Promise<Worker>> = {};

function getWorker(lang: string = "ara"): Promise<Worker> {
  if (!workerPool[lang]) {
    workerPool[lang] = (async () => {
      const worker = await createWorker(lang, 1, {
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract/tesseract-core-simd.wasm.js",
        // CRITICAL: Ensure this points to tessdata_best/ara.traineddata
        // Standard fast traineddata routinely fails on Arabic ligatures.
        langPath: "/tesseract/lang-data",
        gzip: false
      });

      // PSM 6 (Single uniform block of text) works best for scanned book pages
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
      });

      return worker;
    })();
  }
  return workerPool[lang];
}

export async function getOcrText(
  pdfDoc: any,
  pageNumber: number,
  lang: string = "ara"
): Promise<string> {
  const page = await pdfDoc.getPage(pageNumber);

  // 2.5 scale produces ~180-200 DPI from PDF standard 72 DPI, ideal for Tesseract
  const viewport = page.getViewport({ scale: 3 });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create canvas context");

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Turn off Sauvola/Otsu binarization if it was enabled; 
  // high-contrast grayscale gives Tesseract's internal Otsu much better dot/diacritic retention.
  const processedCanvas = preprocessImageForOcr(canvas, {
    upscale: { enabled: false, targetDpi: 300, maxDimensionPx: 4000 },
    binarize: { enabled: false, method: "none" },
    contrast: { enabled: true, lowPercentile: 2, highPercentile: 98 },
  });

  const worker = await getWorker(lang);
  const { data } = await worker.recognize(
    processedCanvas as HTMLCanvasElement,
    {},
    { blocks: true }
  );

  // 11. Extract words from blocks
  const words: any[] = [];
  (data as any).blocks?.forEach((block: any) => {
    block.paragraphs?.forEach((paragraph: any) => {
      paragraph.lines?.forEach((line: any) => {
        line.words?.forEach((word: any) => {
          if (word.confidence >= 30) {
            words.push(word);
          }
        });
      });
    });
  });
  // Return Tesseract's native BiDi layout engine output directly
  return words.map((word) => word.text).join(" ");
}

export async function terminateOcrWorker(): Promise<void> {
  const keys = Object.keys(workerPool);
  for (const key of keys) {
    const worker = await workerPool[key];
    await worker.terminate();
    delete workerPool[key];
  }
}