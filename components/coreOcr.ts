import { createWorker, Worker } from "tesseract.js";
import { preprocessImageForOcr } from "./imagePreprocessing";

let workerPromise: Promise<Worker> | null = null;

// Reuse a single worker across all pages.
function getWorker(lang: string): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(lang, 1, {
      workerPath: "/tesseract/worker.min.js",
      corePath: "/tesseract",
      langPath: "/tesseract/lang-data",
    });
  }

  return workerPromise;
}

export async function getOcrText(
  pdfDoc: any,
  pageNumber: number,
  lang: string // e.g. "ara+eng", "ara", or "eng"
): Promise<string> {
  // 1. Get the PDF page
  const page = await pdfDoc.getPage(pageNumber);

  // 2. Create a high-resolution viewport
  const viewport = page.getViewport({
    scale: 2.0,
  });

  // 3. Create an invisible canvas in memory
  const canvas = document.createElement("canvas");

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create canvas context");
  }

  // 4. Render the PDF page onto the canvas
  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  // 5. Display the original canvas (RED BORDER)
  canvas.style.border = "2px solid red";
  canvas.style.maxWidth = "100%";
  canvas.style.height = "auto";
  canvas.style.display = "block";
  canvas.style.marginBottom = "10px";

  document.body.appendChild(canvas);

  // 6. Preprocess the image
  const processedCanvas = preprocessImageForOcr(canvas, {});

  // 7. Display the processed canvas (BLUE BORDER)
  processedCanvas.style.border = "2px solid blue";
  processedCanvas.style.maxWidth = "100%";
  processedCanvas.style.height = "auto";
  processedCanvas.style.display = "block";
  processedCanvas.style.marginBottom = "20px";

  document.body.appendChild(processedCanvas);

  // 8. Get the Tesseract worker
  const worker = await getWorker(lang);

  // 9. Run OCR
  const { data } = await worker.recognize(
    processedCanvas as HTMLCanvasElement
  );

  // 10. Return extracted text
  return data.text;
}

// Call once after processing the entire book.
export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;

    await worker.terminate();

    workerPromise = null;
  }
}