"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import { getDB } from "@/lib/idb";
import { Book as BookType } from "@/interface";

interface TextItemBox {
  text: string;
  x0: number;
  y0: number;
  confidence?: number;
}

interface CachedPageResult {
  extractionType: "pdf-text" | "ocr";
  text: string;
  items: TextItemBox[];
  direction: "rtl" | "ltr";
}

const Book = () => {
  const params = useParams();

  const [book, setBook] = useState<BookType | null>(null);
  const [error, setError] = useState("");

  const [selectedLang, setSelectedLang] = useState<"eng" | "ara" | "eng+ara">("ara");
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [currentExtractionType, setCurrentExtractionType] = useState<string | null>(null);

  const [PDFComponents, setPDFComponents] = useState<{
    Document: any;
    Page: any;
    pdfjs: any;
  } | null>(null);

  const [pdfDocProxy, setPdfDocProxy] = useState<any | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [gotoPage, setGotoPage] = useState("1");

  const tesseractWorkerRef = useRef<any>(null);
  const activeWorkerLangRef = useRef<string>("");

  const preloadQueueRef = useRef<{ pageNum: number; priority: number }[]>([]);
  const isProcessingQueueRef = useRef<boolean>(false);
  const currentPageRef = useRef<number>(currentPage);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // Load PDF.js only in browser
  useEffect(() => {
    const loadPDF = async () => {
      const { Document, Page, pdfjs } = await import("react-pdf");
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

      setPDFComponents({
        Document,
        Page,
        pdfjs,
      });
    };

    loadPDF();
  }, []);

  // Cleanup Tesseract worker on unmount
  useEffect(() => {
    return () => {
      if (tesseractWorkerRef.current) {
        tesseractWorkerRef.current.terminate();
      }
    };
  }, []);

  // Get book from IndexedDB
  useEffect(() => {
    const loadBook = async () => {
      try {
        const db = await getDB();
        const books = await db.getAll("books");

        const bookName = Array.isArray(params.name)
          ? params.name[0]
          : params.name;

        if (!bookName) {
          setError("Something went wrong...");
          return;
        }

        const decodedBookName = decodeURIComponent(bookName);
        const foundBook = books.find(
          (item) =>
            item.name.replace(/\.pdf$/i, "") ===
            decodedBookName.replace(/\.pdf$/i, "")
        );

        if (foundBook) {
          setBook(foundBook);
        } else {
          setError("Book not found");
        }
      } catch (err) {
        console.error(err);
        setError("Could not load book");
      }
    };

    loadBook();
  }, [params.name]);

  // LocalStorage Helpers with language namespaces
  const getCacheKey = useCallback(
    (pageNum: number) =>
      `ocr_cache_${book?.name || "book"}_${selectedLang}_page_${pageNum}`,
    [book?.name, selectedLang]
  );

  const getCachedData = useCallback(
    (pageNum: number): CachedPageResult | null => {
      try {
        const cached = localStorage.getItem(getCacheKey(pageNum));
        return cached ? JSON.parse(cached) : null;
      } catch {
        return null;
      }
    },
    [getCacheKey]
  );

  const setCachedData = useCallback(
    (pageNum: number, data: CachedPageResult) => {
      try {
        localStorage.setItem(getCacheKey(pageNum), JSON.stringify(data));
      } catch (e) {
        console.warn("Storage quota exceeded or storage unavailable", e);
      }
    },
    [getCacheKey]
  );

  // Initialize shared Tesseract Worker using tessdata_best & PSM 6
  const getTesseractWorker = async () => {
    if (
      tesseractWorkerRef.current &&
      activeWorkerLangRef.current === selectedLang
    ) {
      return tesseractWorkerRef.current;
    }

    if (tesseractWorkerRef.current) {
      await tesseractWorkerRef.current.terminate();
    }

    const { createWorker, PSM } = await import("tesseract.js");

    // Pull unquantized high-accuracy LSTM models
    const worker = await createWorker(selectedLang.split("+"), 1, {
      langPath: "https://tessdata.projectnaptha.com/4.0.0_best",
      logger: () => {},
    });

    // Assume a single uniform block of text to avoid fragmented reading order
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });

    tesseractWorkerRef.current = worker;
    activeWorkerLangRef.current = selectedLang;
    return worker;
  };

  const detectDirection = (str: string): "rtl" | "ltr" => {
    const arabicPattern = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
    return arabicPattern.test(str) ? "rtl" : "ltr";
  };

  // Preprocess canvas to eliminate yellow background and sharpen text
  const preprocessCanvas = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;

    for (let i = 0; i < d.length; i += 4) {
      // Luminance grayscale conversion
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Boost contrast: push tinted paper to pure white and text to black
      const val = gray > 160 ? 255 : gray < 90 ? 0 : gray;
      d[i] = val;
      d[i + 1] = val;
      d[i + 2] = val;
    }

    ctx.putImageData(imgData, 0, 0);
  };

  // Core processor for a specific page
  const processPageExtraction = async (
    pageNum: number
  ): Promise<CachedPageResult | null> => {
    if (!pdfDocProxy) return null;

    // 1. Check Cache
    const cached = getCachedData(pageNum);
    if (cached) return cached;

    const page = await pdfDocProxy.getPage(pageNum);

    // 2. Try PDF Native Text Content
    const textContent = await page.getTextContent();
    const rawItems = textContent.items as any[];
    const combinedRawText = rawItems.map((i) => i.str).join("").trim();

    if (combinedRawText.length > 15) {
      const linesMap = new Map<number, { text: string; x0: number }[]>();

      rawItems.forEach((item) => {
        if (!item.str || !item.str.trim()) return;
        const x = item.transform[4];
        const y = Math.round(item.transform[5]);

        let matchedY = Array.from(linesMap.keys()).find(
          (k) => Math.abs(k - y) <= 4
        );
        if (matchedY === undefined) {
          matchedY = y;
          linesMap.set(matchedY, []);
        }

        linesMap.get(matchedY)!.push({ text: item.str, x0: x });
      });

      const dir = detectDirection(combinedRawText);
      const sortedY = Array.from(linesMap.keys()).sort((a, b) => b - a);

      const structuredLines = sortedY.map((y) => {
        const lineItems = linesMap.get(y)!;
        lineItems.sort((a, b) => (dir === "rtl" ? b.x0 - a.x0 : a.x0 - b.x0));
        return lineItems.map((i) => i.text).join(" ");
      });

      const result: CachedPageResult = {
        extractionType: "pdf-text",
        text: structuredLines.join("\n"),
        items: rawItems.map((i) => ({
          text: i.str,
          x0: i.transform[4],
          y0: i.transform[5],
        })),
        direction: dir,
      };

      setCachedData(pageNum, result);
      return result;
    }

    // 3. Fallback: High-resolution render (Scale 2.5 for ~250-300 DPI)
    const viewport = page.getViewport({ scale: 2.5 });
    const offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = viewport.width;
    offscreenCanvas.height = viewport.height;
    const ctx = offscreenCanvas.getContext("2d");

    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Apply binarization/contrast filter
    preprocessCanvas(offscreenCanvas);

    const worker = await getTesseractWorker();
    const ocrResult = await worker.recognize(
      offscreenCanvas,
      {},
      { blocks: true }
    );

    const rawLines: { text: string; y0: number; x0: number }[] = [];
    const collectedItems: TextItemBox[] = [];

    // Extract lines directly to preserve ligatures and avoid broken words
    ocrResult.data.blocks?.forEach((block: any) => {
      block.paragraphs.forEach((para: any) => {
        para.lines.forEach((line: any) => {
          const trimmed = line.text.trim();
          if (trimmed.length > 0) {
            rawLines.push({
              text: trimmed,
              y0: line.bbox.y0,
              x0: line.bbox.x0,
            });

            line.words?.forEach((w: any) => {
              collectedItems.push({
                text: w.text,
                x0: w.bbox.x0,
                y0: w.bbox.y0,
                confidence: w.confidence,
              });
            });
          }
        });
      });
    });

    // Deduplicate lines with overlapping Y coordinates (within 14px)
    const deduplicatedLines: { text: string; y0: number; x0: number }[] = [];

    rawLines.sort((a, b) => a.y0 - b.y0);

    rawLines.forEach((current) => {
      const existing = deduplicatedLines.find(
        (l) => Math.abs(l.y0 - current.y0) < 14
      );

      if (!existing) {
        deduplicatedLines.push(current);
      } else {
        // Keep the longer or more complete string if duplicate line exists
        if (current.text.length > existing.text.length) {
          existing.text = current.text;
        }
      }
    });

    const ocrRawText = deduplicatedLines.map((l) => l.text).join(" ");
    const dir = detectDirection(ocrRawText);

    const finalResult: CachedPageResult = {
      extractionType: "ocr",
      text: deduplicatedLines.map((l) => l.text).join("\n"),
      items: collectedItems,
      direction: dir,
    };

    setCachedData(pageNum, finalResult);
    return finalResult;
  };

  // Background Preload Engine with priority execution
  const processNextInQueue = async () => {
    if (isProcessingQueueRef.current || preloadQueueRef.current.length === 0) {
      return;
    }

    isProcessingQueueRef.current = true;

    preloadQueueRef.current.sort((a, b) => a.priority - b.priority);
    const task = preloadQueueRef.current.shift();

    if (task && !getCachedData(task.pageNum)) {
      try {
        await processPageExtraction(task.pageNum);
      } catch (err) {
        console.error(`Preload failed on page ${task.pageNum}:`, err);
      }
    }

    isProcessingQueueRef.current = false;

    if (preloadQueueRef.current.length > 0) {
      setTimeout(processNextInQueue, 50);
    }
  };

  const queuePagesForPreload = useCallback(
    (pageNumbers: { pageNum: number; priority: number }[]) => {
      pageNumbers.forEach(({ pageNum, priority }) => {
        if (pageNum < 1 || pageNum > numPages) return;
        if (getCachedData(pageNum)) return;

        const exists = preloadQueueRef.current.some(
          (q) => q.pageNum === pageNum
        );
        if (!exists) {
          preloadQueueRef.current.push({ pageNum, priority });
        }
      });

      processNextInQueue();
    },
    [numPages, getCachedData]
  );

  // Synchronize Extraction for Active Page
  const loadActivePageText = useCallback(
    async (pageToLoad: number) => {
      const cached = getCachedData(pageToLoad);
      if (cached) {
        setOcrText(cached.text);
        setCurrentExtractionType(cached.extractionType);
        setOcrLoading(false);
      } else {
        setOcrLoading(true);
        setOcrText("");
        setCurrentExtractionType(null);

        try {
          const result = await processPageExtraction(pageToLoad);
          if (result && currentPageRef.current === pageToLoad) {
            setOcrText(result.text);
            setCurrentExtractionType(result.extractionType);
          }
        } catch (err) {
          console.error(err);
          setOcrText("Could not extract text from this page.");
        } finally {
          if (currentPageRef.current === pageToLoad) {
            setOcrLoading(false);
          }
        }
      }

      queuePagesForPreload([
        { pageNum: pageToLoad + 1, priority: 1 },
        { pageNum: pageToLoad - 1, priority: 1 },
        { pageNum: pageToLoad + 2, priority: 2 },
      ]);
    },
    [getCachedData, queuePagesForPreload]
  );

  // Trigger page extraction on page change or language change
  useEffect(() => {
    if (pdfDocProxy && numPages > 0) {
      loadActivePageText(currentPage);
    }
  }, [currentPage, pdfDocProxy, numPages, selectedLang, loadActivePageText]);

  const handleDocumentLoad = (pdf: any) => {
    setNumPages(pdf.numPages);
    setPdfDocProxy(pdf);
  };

  const previousPage = () => {
    if (currentPage > 1) {
      const prev = currentPage - 1;
      setCurrentPage(prev);
      setGotoPage(String(prev));
    }
  };

  const nextPage = () => {
    if (currentPage < numPages) {
      const next = currentPage + 1;
      setCurrentPage(next);
      setGotoPage(String(next));
    }
  };

  const goToPage = () => {
    const page = Number(gotoPage);
    if (page >= 1 && page <= numPages) {
      setCurrentPage(page);
    }
  };

  const Document = PDFComponents?.Document;
  const Page = PDFComponents?.Page;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        {error}
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        Loading book...
      </div>
    );
  }

  if (!Document || !Page) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        Loading PDF reader...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-5">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-5 text-2xl font-bold">{book.name}</h1>

        {/* Toolbar & Controls */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-white p-3 shadow-sm">
          {/* Page Navigation */}
          <div className="flex items-center gap-3">
            <button
              onClick={previousPage}
              disabled={currentPage === 1}
              className="rounded-full p-2 text-lg hover:bg-gray-100 disabled:opacity-30"
              title="Previous page"
            >
              ←
            </button>

            <div className="flex items-center gap-2 text-sm">
              <input
                type="number"
                min="1"
                max={numPages}
                value={gotoPage}
                onChange={(e) => setGotoPage(e.target.value)}
                onBlur={goToPage}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goToPage();
                }}
                className="w-14 rounded-lg border border-gray-300 bg-white px-2 py-1 text-center outline-none"
              />
              <span className="text-gray-500">/ {numPages || "..."}</span>
            </div>

            <button
              onClick={nextPage}
              disabled={currentPage === numPages}
              className="rounded-full p-2 text-lg hover:bg-gray-100 disabled:opacity-30"
              title="Next page"
            >
              →
            </button>
          </div>

          {/* OCR Language Selector & Controls */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <label htmlFor="ocr-lang">OCR Fallback:</label>
              <select
                id="ocr-lang"
                value={selectedLang}
                onChange={async (e) => {
                  const newLang = e.target.value as "eng" | "ara" | "eng+ara";
                  preloadQueueRef.current = [];

                  if (tesseractWorkerRef.current) {
                    await tesseractWorkerRef.current.terminate();
                    tesseractWorkerRef.current = null;
                    activeWorkerLangRef.current = "";
                  }

                  setSelectedLang(newLang);
                }}
                className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
              >
                <option value="ara">Arabic Only</option>
                <option value="eng+ara">Both (Arabic + English)</option>
                <option value="eng">English Only</option>
              </select>
            </div>

            <button
              onClick={() => {
                localStorage.removeItem(getCacheKey(currentPage));
                loadActivePageText(currentPage);
              }}
              disabled={ocrLoading}
              className="flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
              title="Force re-extract current page"
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* PDF Viewport */}
        <div className="flex justify-center overflow-auto rounded-xl bg-gray-200 p-5 shadow-inner">
          <Document
            file={book.file}
            onLoadSuccess={handleDocumentLoad}
            loading={<div>Loading PDF...</div>}
            error={<div>Could not load PDF</div>}
          >
            <Page
              pageNumber={currentPage}
              width={750}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          </Document>
        </div>

        {/* Continuous Text Output */}
        <div className="mt-6 rounded-xl bg-white p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between border-b pb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-800">
                Continuous Text Output
              </h2>
              {currentExtractionType && (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    currentExtractionType === "pdf-text"
                      ? "bg-green-100 text-green-700"
                      : "bg-purple-100 text-purple-700"
                  }`}
                >
                  {currentExtractionType === "pdf-text"
                    ? "Direct Text"
                    : "OCR"}
                </span>
              )}
            </div>

            {ocrLoading && (
              <span className="text-sm text-blue-600 font-medium animate-pulse">
                Enhancing image & extracting Arabic text...
              </span>
            )}
          </div>

          {ocrText ? (
            <p
              dir={detectDirection(ocrText)}
              className="whitespace-pre-wrap break-words text-gray-800 leading-8 text-base font-sans"
            >
              {ocrText}
            </p>
          ) : (
            <p className="text-sm text-gray-400">
              {ocrLoading
                ? "Extracting page content..."
                : "No text detected on this page."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default Book;