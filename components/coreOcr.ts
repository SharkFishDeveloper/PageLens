import { createWorker, Worker } from "tesseract.js";
import { preprocessImageForOcr } from "./imagePreprocessing";
import { arrangeOcrWords } from "@/lib/formatOcrText";

let workerPromise: Promise<Worker> | null = null;

// Reuse a single worker across all pages.
function getWorker(lang: string): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(lang, 1, {
      workerPath: "/tesseract/worker.min.js",
      corePath: "/tesseract/tesseract-core-simd.wasm.js",
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
    scale: 3.0,
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



// 6. Preprocess the image
const processedCanvas = preprocessImageForOcr(canvas, {});
// const processedCanvas = canvas;

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
        words.push(word);
      });
    });
  });
});
  // 10. Return extracted text
 const alignedText = arrangeOcrWords(words);
  return alignedText;
}

// Call once after processing the entire book.
export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;

    await worker.terminate();

    workerPromise = null;
  }
}

// 5. Display the original canvas
// canvas.style.border = "2px solid red";
// canvas.style.width = "300px";
// canvas.style.height = "auto";
// canvas.style.display = "block";
// canvas.style.marginBottom = "10px";

// document.body.appendChild(canvas);

// // 7. Create a separate canvas for displaying the processed result
// const displayCanvas = document.createElement("canvas");

// displayCanvas.width = processedCanvas.width;
// displayCanvas.height = processedCanvas.height;

// const displayCtx = displayCanvas.getContext("2d");

// if (!displayCtx) {
//   throw new Error("Could not create display canvas context");
// }

// displayCtx.drawImage(processedCanvas, 0, 0);

// // 8. Display the processed canvas
// displayCanvas.style.border = "2px solid blue";
// displayCanvas.style.width = "300px";
// displayCanvas.style.height = "auto";
// displayCanvas.style.display = "block";
// displayCanvas.style.marginBottom = "20px";

// document.body.appendChild(displayCanvas);

// 9. Get the Tesseract worker