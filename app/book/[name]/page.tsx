"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import { getDB } from "@/lib/idb";
import { Book as BookType } from "@/interface";
import Link from "next/link";

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

interface PageAIData {
  translation?: string;
  explanation?: string;
}

const SUPPORTED_OUTPUT_LANGS = [
  "English",
  "Arabic",
  "Hindi",
  "Urdu",
  "Spanish",
  "French",
  "Same as original",
];

const OCR_LANGUAGE_OPTIONS: { label: string; value: "eng" | "ara" | "eng+ara" }[] = [
  { label: "English", value: "eng" },
  { label: "Arabic", value: "ara" },
  { label: "Arabic + English", value: "eng+ara" },
];

// Safety cap on the AI response size. A well-formed translation/explanation
// of a single page should never come close to this — if it's exceeded it
// almost always means the model looped/degenerated, so we treat it as an
// error rather than rendering (or caching) a runaway response.
const MAX_RESPONSE_WORD_COUNT = 1_000_000;

const countWords = (str: string): number => {
  const trimmed = str.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
};

const Book = () => {
  const params = useParams();

  const [book, setBook] = useState<BookType | null>(null);
  const [error, setError] = useState("");

  // Extraction states
  const [selectedOcrLang, setSelectedOcrLang] = useState<"eng" | "ara" | "eng+ara">("ara");
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [currentExtractionType, setCurrentExtractionType] = useState<string | null>(null);

  // AI & Translation States
  const [outputLanguage, setOutputLanguage] = useState<string>("English");
  const [translationText, setTranslationText] = useState<string>("");
  const [explanationText, setExplanationText] = useState<string>("");
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [activeAITab, setActiveAITab] = useState<"none" | "translation" | "explanation">("none");

  // Reading experience states
  const [pdfVisible, setPdfVisible] = useState<boolean>(true);
  const [continuousMode, setContinuousMode] = useState<boolean>(false);
  const [flipClass, setFlipClass] = useState<string>("");

  // PDF.js references
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
  const ocrChainRef = useRef<Promise<any>>(Promise.resolve());
  const preloadQueueRef = useRef<{ pageNum: number; priority: number }[]>([]);
  const isProcessingQueueRef = useRef<boolean>(false);
  const currentPageRef = useRef<number>(currentPage);
  const outputLanguageRef = useRef<string>(outputLanguage);
  const lastAutoTriggeredRef = useRef<string>("");
  const touchStartXRef = useRef<number | null>(null);
  const flipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipSwapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the fetch() powering the CURRENTLY VISIBLE translation/explanation
  // request, so we can abort it the instant the reader navigates away.
  const aiAbortControllerRef = useRef<AbortController | null>(null);

  // Runs a function after any currently-running OCR job finishes, and blocks
  // any later job until this one is done. This is what stops "switch language
  // mid-recognize" from ever terminating a worker another call is still using.
  const runExclusiveOnOcrWorker = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = ocrChainRef.current.then(fn, fn);
    ocrChainRef.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    outputLanguageRef.current = outputLanguage;
  }, [outputLanguage]);

  // Load saved preferences
  useEffect(() => {
    const savedLang = localStorage.getItem("reader_preferred_output_lang");
    if (savedLang && SUPPORTED_OUTPUT_LANGS.includes(savedLang)) {
      setOutputLanguage(savedLang);
    }
    const savedContinuous = localStorage.getItem("reader_continuous_mode");
    if (savedContinuous === "1") setContinuousMode(true);
    const savedPdfVisible = localStorage.getItem("reader_pdf_visible");
    if (savedPdfVisible === "0") setPdfVisible(false);
  }, []);

  const handleLanguageChange = (newLang: string) => {
    setOutputLanguage(newLang);
    localStorage.setItem("reader_preferred_output_lang", newLang);
  };

  const toggleContinuousMode = () => {
    setContinuousMode((prev) => {
      const next = !prev;
      localStorage.setItem("reader_continuous_mode", next ? "1" : "0");
      return next;
    });
  };

  const togglePdfVisible = () => {
    setPdfVisible((prev) => {
      const next = !prev;
      localStorage.setItem("reader_pdf_visible", next ? "1" : "0");
      return next;
    });
  };

  // Aborts whatever translation/explanation fetch is currently in flight for
  // the visible page. Called whenever the reader navigates away (prev/next/
  // goto) so a stale, no-longer-wanted request doesn't keep running.
  const cancelOngoingAIRequest = useCallback(() => {
    if (aiAbortControllerRef.current) {
      aiAbortControllerRef.current.abort();
      aiAbortControllerRef.current = null;
    }
    setAiLoading(false);
  }, []);

  // Load PDF reader library
  useEffect(() => {
    const loadPDF = async () => {
      const { Document, Page, pdfjs } = await import("react-pdf");
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

      setPDFComponents({ Document, Page, pdfjs });
    };

    loadPDF();
  }, []);

  // Terminate Tesseract Worker on unmount
  useEffect(() => {
    return () => {
      if (tesseractWorkerRef.current) {
        tesseractWorkerRef.current.terminate();
      }
      if (flipTimeoutRef.current) clearTimeout(flipTimeoutRef.current);
      if (flipSwapTimeoutRef.current) clearTimeout(flipSwapTimeoutRef.current);
      if (aiAbortControllerRef.current) aiAbortControllerRef.current.abort();
    };
  }, []);

  // Load book from IndexedDB
  useEffect(() => {
    const loadBook = async () => {
      try {
        const db = await getDB();
        const books = await db.getAll("books");
        const bookName = Array.isArray(params.name) ? params.name[0] : params.name;

        if (!bookName) {
          setError("Something went wrong...");
          return;
        }

        const decodedBookName = decodeURIComponent(bookName);
        const foundBook = books.find(
          (item) =>
            item.name.replace(/\.pdf$/i, "") === decodedBookName.replace(/\.pdf$/i, "")
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

  // IndexedDB / LocalStorage Multi-Language AI Cache Helpers
  const getAIStorageKey = useCallback(
    (pageNum: number, lang: string) =>
      `page_ai_${book?.name || "book"}_p${pageNum}_${lang}_${selectedOcrLang}`,
    [book?.name, selectedOcrLang]
  );

  const getCachedAIData = useCallback(
    async (pageNum: number, lang: string): Promise<PageAIData | null> => {
      const key = getAIStorageKey(pageNum, lang);
      try {
        const db = await getDB();
        if (db.objectStoreNames.contains("ai_translations")) {
          const res = await db.get("ai_translations", key);
          if (res) return res;
        }
      } catch (err) {
        console.warn("IndexedDB read error, checking localStorage fallback", err);
      }

      try {
        const fallback = localStorage.getItem(key);
        return fallback ? JSON.parse(fallback) : null;
      } catch {
        return null;
      }
    },
    [getAIStorageKey]
  );

  const setCachedAIData = useCallback(
    async (pageNum: number, lang: string, data: PageAIData) => {
      const key = getAIStorageKey(pageNum, lang);
      try {
        const db = await getDB();
        if (db.objectStoreNames.contains("ai_translations")) {
          await db.put("ai_translations", data, key);
          return;
        }
      } catch (err) {
        console.warn("IndexedDB write failed, falling back to localStorage", err);
      }

      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch (e) {
        console.warn("Storage quota exceeded", e);
      }
    },
    [getAIStorageKey]
  );

  // Wipes every language's translation/explanation cached for a page under
  // the current book (OCR) language — used when the reader manually refreshes
  // a page so stale AI output from a bad extraction can't linger.
  const clearCachedAIDataForPage = useCallback(
    async (pageNum: number) => {
      let db: Awaited<ReturnType<typeof getDB>> | null = null;
      try {
        db = await getDB();
      } catch {
        db = null;
      }

      for (const lang of SUPPORTED_OUTPUT_LANGS) {
        const key = getAIStorageKey(pageNum, lang);
        try {
          if (db && db.objectStoreNames.contains("ai_translations")) {
            await db.delete("ai_translations", key);
          }
        } catch (err) {
          console.warn("IndexedDB delete failed (AI cache)", err);
        }
        try {
          localStorage.removeItem(key);
        } catch {}
      }
    },
    [getAIStorageKey]
  );

  // Synchronize AI State on Page / Language change
  useEffect(() => {
    const syncAICache = async () => {
      if (!book) return;
      const cached = await getCachedAIData(currentPage, outputLanguage);
      setTranslationText(cached?.translation || "");
      setExplanationText(cached?.explanation || "");
    };

    syncAICache();
  }, [currentPage, outputLanguage, book, getCachedAIData]);

  // Page extraction (OCR / native text) cache — now backed by IndexedDB, with
  // localStorage as a fallback if the "page_extractions" store isn't available.
  const getCacheKey = useCallback(
    (pageNum: number) =>
      `ocr_cache_${book?.name || "book"}_${selectedOcrLang}_page_${pageNum}`,
    [book?.name, selectedOcrLang]
  );

  const getCachedData = useCallback(
    async (pageNum: number): Promise<CachedPageResult | null> => {
      const key = getCacheKey(pageNum);
      try {
        const db = await getDB();
        if (db.objectStoreNames.contains("page_extractions")) {
          const res = await db.get("page_extractions", key);
          if (res) return res;
        }
      } catch (err) {
        console.warn("IndexedDB read error (extraction), checking localStorage fallback", err);
      }

      try {
        const cached = localStorage.getItem(key);
        return cached ? JSON.parse(cached) : null;
      } catch {
        return null;
      }
    },
    [getCacheKey]
  );

  const setCachedData = useCallback(
    async (pageNum: number, data: CachedPageResult) => {
      const key = getCacheKey(pageNum);
      try {
        const db = await getDB();
        if (db.objectStoreNames.contains("page_extractions")) {
          await db.put("page_extractions", data, key);
          return;
        }
      } catch (err) {
        console.warn("IndexedDB write failed (extraction), falling back to localStorage", err);
      }

      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch (e) {
        console.warn("Storage quota exceeded", e);
      }
    },
    [getCacheKey]
  );

  const clearCachedData = useCallback(
    async (pageNum: number) => {
      const key = getCacheKey(pageNum);
      try {
        const db = await getDB();
        if (db.objectStoreNames.contains("page_extractions")) {
          await db.delete("page_extractions", key);
        }
      } catch (err) {
        console.warn("IndexedDB delete failed (extraction)", err);
      }
      try {
        localStorage.removeItem(key);
      } catch {}
    },
    [getCacheKey]
  );

  const getTesseractWorker = async () => {
    if (
      tesseractWorkerRef.current &&
      activeWorkerLangRef.current === selectedOcrLang
    ) {
      return tesseractWorkerRef.current;
    }

    if (tesseractWorkerRef.current) {
      await tesseractWorkerRef.current.terminate();
    }

    const { createWorker, PSM } = await import("tesseract.js");

    const worker = await createWorker(selectedOcrLang.split("+"), 1, {
      workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5",
      langPath: "https://tessdata.projectnaptha.com/4.0.0_best",
      logger: () => {},
    });

    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });

    tesseractWorkerRef.current = worker;
    activeWorkerLangRef.current = selectedOcrLang;
    return worker;
  };

  const detectDirection = (str: string): "rtl" | "ltr" => {
    const arabicPattern = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
    return arabicPattern.test(str) ? "rtl" : "ltr";
  };

  const preprocessCanvas = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;

    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const val = gray > 160 ? 255 : gray < 90 ? 0 : gray;
      d[i] = val;
      d[i + 1] = val;
      d[i + 2] = val;
    }
    ctx.putImageData(imgData, 0, 0);
  };

  const processPageExtraction = async (
    pageNum: number
  ): Promise<CachedPageResult | null> => {
    if (!pdfDocProxy) return null;

    const cached = await getCachedData(pageNum);
    if (cached) return cached;

    const page = await pdfDocProxy.getPage(pageNum);

    // 1. Check Native PDF selectable text
    const textContent = await page.getTextContent();
    const rawItems = textContent.items as any[];
    const combinedRawText = rawItems.map((i) => i.str).join("").trim();

    if (combinedRawText.length > 15) {
      const linesMap = new Map<number, { text: string; x0: number }[]>();

      rawItems.forEach((item) => {
        if (!item.str || !item.str.trim()) return;
        const x = item.transform[4];
        const y = Math.round(item.transform[5]);

        let matchedY = Array.from(linesMap.keys()).find((k) => Math.abs(k - y) <= 4);
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

      await setCachedData(pageNum, result);
      return result;
    }

    // 2. Fallback to OCR
    const viewport = page.getViewport({ scale: 2.5 });
    const offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = viewport.width;
    offscreenCanvas.height = viewport.height;
    const ctx = offscreenCanvas.getContext("2d");

    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    await page.render({ canvasContext: ctx, viewport }).promise;
    preprocessCanvas(offscreenCanvas);

    const ocrResult = await runExclusiveOnOcrWorker(async () => {
      const worker = await getTesseractWorker();
      try {
        return await worker.recognize(offscreenCanvas, {}, { blocks: true });
      } catch (err) {
        // The worker may have been terminated by a concurrent language switch
        // right before this ran. Recreate it once and retry rather than crash.
        console.warn("OCR worker call failed, recreating worker and retrying", err);
        tesseractWorkerRef.current = null;
        activeWorkerLangRef.current = "";
        const freshWorker = await getTesseractWorker();
        return freshWorker.recognize(offscreenCanvas, {}, { blocks: true });
      }
    });

    const rawLines: { text: string; y0: number; x0: number }[] = [];
    const collectedItems: TextItemBox[] = [];

    ocrResult.data.blocks?.forEach((block: any) => {
      block.paragraphs.forEach((para: any) => {
        para.lines.forEach((line: any) => {
          const trimmed = line.text.trim();
          if (trimmed.length > 0) {
            rawLines.push({ text: trimmed, y0: line.bbox.y0, x0: line.bbox.x0 });
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

    const deduplicatedLines: { text: string; y0: number; x0: number }[] = [];
    rawLines.sort((a, b) => a.y0 - b.y0);

    rawLines.forEach((current) => {
      const existing = deduplicatedLines.find((l) => Math.abs(l.y0 - current.y0) < 14);
      if (!existing) {
        deduplicatedLines.push(current);
      } else if (current.text.length > existing.text.length) {
        existing.text = current.text;
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

    await setCachedData(pageNum, finalResult);
    return finalResult;
  };

  // Background Preload Engine (extraction only — cheap, keeps navigation instant)
  const processNextInQueue = async () => {
    if (isProcessingQueueRef.current || preloadQueueRef.current.length === 0) return;
    isProcessingQueueRef.current = true;

    preloadQueueRef.current.sort((a, b) => a.priority - b.priority);
    const task = preloadQueueRef.current.shift();

    if (task) {
      const already = await getCachedData(task.pageNum);
      if (!already) {
        try {
          await processPageExtraction(task.pageNum);
        } catch (err) {
          console.error(`Preload failed on page ${task.pageNum}:`, err);
        }
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

        const exists = preloadQueueRef.current.some((q) => q.pageNum === pageNum);
        if (!exists) {
          preloadQueueRef.current.push({ pageNum, priority });
        }
      });

      processNextInQueue();
    },
    [numPages]
  );

  const loadActivePageText = useCallback(
    async (pageToLoad: number) => {
      const cached = await getCachedData(pageToLoad);
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

  useEffect(() => {
    if (pdfDocProxy && numPages > 0) {
      loadActivePageText(currentPage);
    }
  }, [currentPage, pdfDocProxy, numPages, selectedOcrLang, loadActivePageText]);

  // Helper: Extract text from <artifact></artifact> tag
  const extractArtifact = (raw: string) => {
    const match = raw.match(/<artifact>([\s\S]*?)<\/artifact>/i);
    return match ? match[1].trim() : raw.trim();
  };

  // Silently prepares translation/explanation for an upcoming page so it's
  // instantly ready by the time the reader turns to it. Never touches the
  // visible AI state — it only warms the IndexedDB cache.
  const prefetchAIForPage = useCallback(
    async (pageNum: number, task: "translation" | "explanation", lang: string) => {
      if (pageNum < 1 || pageNum > numPages || !pdfDocProxy) return;

      const existingAI = await getCachedAIData(pageNum, lang);
      if (existingAI?.[task]) return;

      let extraction = await getCachedData(pageNum);
      if (!extraction) {
        try {
          extraction = await processPageExtraction(pageNum);
        } catch (err) {
          console.warn("Background extraction failed for page", pageNum, err);
          return;
        }
      }
      if (!extraction || !extraction.text.trim()) return;

      let previousPageContext = "";
      if (task === "explanation" && pageNum > 1) {
        const prevData = await getCachedData(pageNum - 1);
        if (prevData?.text) {
          previousPageContext = `\n--- PREVIOUS PAGE CONTEXT ---\n${prevData.text.slice(-500)}`;
        }
      }

      const prompt =
        task === "translation"
          ? `Translate the following text accurately into ${lang}.
Preserve the meaning and important context.
Automatically detect the source language.
Return ONLY the result inside <artifact></artifact> tags.

--- SOURCE TEXT ---
${extraction.text}`
          : `Explain the following book content clearly in ${lang}.
${previousPageContext ? "Use the previous page context to understand continuation." : ""}
Automatically detect the source language.
Return ONLY the explanation inside <artifact></artifact> tags.

${previousPageContext}

--- CURRENT PAGE CONTENT ---
${extraction.text}`;

      try {
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) return;

        const json = await res.json();
        const cleanContent = extractArtifact(json.text || json.result || "");

        if (countWords(cleanContent) > MAX_RESPONSE_WORD_COUNT) {
          console.warn("Background AI prefetch exceeded max word count, discarding", pageNum);
          return;
        }

        const currentData = (await getCachedAIData(pageNum, lang)) || {};
        await setCachedAIData(pageNum, lang, { ...currentData, [task]: cleanContent });
      } catch (err) {
        console.warn("Background AI prefetch failed for page", pageNum, err);
      }
    },
    [numPages, pdfDocProxy, getCachedAIData, setCachedAIData, getCachedData]
  );

  // AI Task Handler (Translate & Explain)
  const handleAITask = useCallback(
    async (task: "translation" | "explanation") => {
      if (!ocrText.trim()) return;

      // Snapshot what this specific request is "for" — if the reader has
      // moved to a different page or language by the time it resolves, we
      // must not paint this result over whatever is now on screen.
      const requestPage = currentPage;
      const requestLang = outputLanguage;
      const requestText = ocrText;
      const isStillRelevant = () =>
        currentPageRef.current === requestPage && outputLanguageRef.current === requestLang;

      setActiveAITab(task);

      // Whenever the reader asks for a page, warm up the next two pages in the
      // background so there's no wait when they turn forward.
      prefetchAIForPage(requestPage + 1, task, requestLang);
      prefetchAIForPage(requestPage + 2, task, requestLang);

      // 1. Check if already stored in cache
      const existingCache = await getCachedAIData(requestPage, requestLang);
      if (task === "translation" && existingCache?.translation) {
        if (isStillRelevant()) setTranslationText(existingCache.translation);
        return;
      }
      if (task === "explanation" && existingCache?.explanation) {
        if (isStillRelevant()) setExplanationText(existingCache.explanation);
        return;
      }

      // Cancel any previous in-flight request before starting this one, then
      // register a fresh controller so navigation can abort *this* fetch.
      if (aiAbortControllerRef.current) {
        aiAbortControllerRef.current.abort();
      }
      const controller = new AbortController();
      aiAbortControllerRef.current = controller;

      if (isStillRelevant()) setAiLoading(true);

      try {
        // Fetch previous page context if generating an explanation
        let previousPageContext = "";
        if (task === "explanation" && requestPage > 1) {
          const prevPageData = await getCachedData(requestPage - 1);
          if (prevPageData?.text) {
            previousPageContext = `\n--- PREVIOUS PAGE CONTEXT ---\n${prevPageData.text.slice(-500)}`;
          }
        }

        const prompt =
          task === "translation"
            ? `Translate the following text accurately into ${requestLang}.
Preserve the meaning and important context.
Automatically detect the source language.
Return ONLY the result inside <artifact></artifact> tags.

--- SOURCE TEXT ---
${requestText}`
            : `Explain the following book content clearly in ${requestLang}.
${previousPageContext ? "Use the previous page context to understand continuation." : ""}
Automatically detect the source language.
Return ONLY the explanation inside <artifact></artifact> tags.

${previousPageContext}

--- CURRENT PAGE CONTENT ---
${requestText}`;

        // Call your backend AI endpoint
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error("AI request failed");

        const json = await res.json();
        const cleanContent = extractArtifact(json.text || json.result || "");

        if (countWords(cleanContent) > MAX_RESPONSE_WORD_COUNT) {
          // Runaway response — surface it as an error and skip caching it,
          // rather than rendering (or persisting) a broken result.
          if (isStillRelevant()) {
            const overLimitMessage = `Max tokens used — response exceeded ${MAX_RESPONSE_WORD_COUNT.toLocaleString()} words.`;
            if (task === "translation") {
              setTranslationText(overLimitMessage);
            } else {
              setExplanationText(overLimitMessage);
            }
          }
          return;
        }

        // Save updated result in multi-language storage — this always
        // happens, regardless of whether the reader has since moved on, so
        // the cache is correct next time they land on this page.
        const currentData = (await getCachedAIData(requestPage, requestLang)) || {};
        const updatedData: PageAIData = {
          ...currentData,
          [task]: cleanContent,
        };

        await setCachedAIData(requestPage, requestLang, updatedData);

        if (isStillRelevant()) {
          if (task === "translation") {
            setTranslationText(cleanContent);
          } else {
            setExplanationText(cleanContent);
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") {
          // Cancelled on purpose (reader navigated away) — nothing to show.
          return;
        }
        console.error(err);
        if (isStillRelevant()) {
          if (task === "translation") {
            setTranslationText("Translation failed. Please try again.");
          } else {
            setExplanationText("Explanation failed. Please try again.");
          }
        }
      } finally {
        // Only the request that's still the "current" one gets to clear the
        // controller / spinner — otherwise a slow, already-superseded
        // request could stomp on a newer one that's still loading.
        const stillCurrent = aiAbortControllerRef.current === controller;
        if (stillCurrent) {
          aiAbortControllerRef.current = null;
        }
        if (stillCurrent && isStillRelevant()) setAiLoading(false);
      }
    },
    [ocrText, currentPage, outputLanguage, getCachedAIData, setCachedAIData, getCachedData, prefetchAIForPage]
  );

  // Continuous mode: once turned on, keeps generating the same task
  // (translation or explanation) automatically as the reader turns pages.
  useEffect(() => {
    if (!continuousMode || activeAITab === "none") return;
    if (!ocrText.trim()) return;

    const key = `${currentPage}|${activeAITab}|${outputLanguage}`;
    if (lastAutoTriggeredRef.current === key) return;
    lastAutoTriggeredRef.current = key;

    handleAITask(activeAITab);
  }, [continuousMode, currentPage, ocrText, activeAITab, outputLanguage, handleAITask]);

  const handleDocumentLoad = (pdf: any) => {
    setNumPages(pdf.numPages);
    setPdfDocProxy(pdf);
  };

  const FLIP_DURATION_MS = 560;

  const changePageWithFlip = (targetPage: number, direction: "next" | "prev") => {
    if (flipTimeoutRef.current) clearTimeout(flipTimeoutRef.current);
    if (flipSwapTimeoutRef.current) clearTimeout(flipSwapTimeoutRef.current);

    setFlipClass("");
    requestAnimationFrame(() => {
      setFlipClass(direction === "next" ? "page-flip-next" : "page-flip-prev");
    });

    // Swap the actual page content right as the flipping page is edge-on and
    // invisible, so what gets "revealed" as the flip completes is genuinely
    // the new page rather than the old one snapping to new text mid-turn.
    flipSwapTimeoutRef.current = setTimeout(() => {
      setCurrentPage(targetPage);
      setGotoPage(String(targetPage));
    }, FLIP_DURATION_MS / 2);

    flipTimeoutRef.current = setTimeout(() => setFlipClass(""), FLIP_DURATION_MS);
  };

  const previousPage = useCallback(() => {
    if (currentPage <= 1) return;
    cancelOngoingAIRequest();
    changePageWithFlip(currentPage - 1, "prev");
  }, [currentPage, cancelOngoingAIRequest]);

  const nextPage = useCallback(() => {
    if (currentPage >= numPages) return;
    cancelOngoingAIRequest();
    changePageWithFlip(currentPage + 1, "next");
  }, [currentPage, numPages, cancelOngoingAIRequest]);

  const goToPage = () => {
    const page = Number(gotoPage);
    if (page >= 1 && page <= numPages) {
      cancelOngoingAIRequest();
      setCurrentPage(page);
    }
  };

  // Keyboard navigation — arrow keys turn pages, feels like a real reader.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") nextPage();
      if (e.key === "ArrowLeft") previousPage();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [nextPage, previousPage]);

  // Touch swipe navigation for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartXRef.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartXRef.current;
    touchStartXRef.current = null;
    if (Math.abs(deltaX) < 60) return;
    if (deltaX < 0) nextPage();
    else previousPage();
  };

  const Document = PDFComponents?.Document;
  const Page = PDFComponents?.Page;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f1e8] text-stone-600">
        {error}
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f1e8] text-stone-500">
        Loading book...
      </div>
    );
  }

  if (!Document || !Page) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f1e8] text-stone-500">
        Loading PDF reader...
      </div>
    );
  }

  const displayedText = activeAITab === "translation" ? translationText : explanationText;

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[#f5f1e8]">

      {/* Header / toolbar — fixed-height, always visible, never scrolls away */}
      <header className="z-20 flex-shrink-0 border-b border-stone-200 bg-[#faf7f0]/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <Link href="/" className="m-1.5">
            <p className="text-bold font-xl">←  Go back </p>
          </Link>

          <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-stone-800 sm:text-lg">
            {book.name}
          </h1>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-0.5">
              <label htmlFor="book-lang" className="text-[11px] text-stone-500">
                Book language
              </label>
              <select
                id="book-lang"
                value={selectedOcrLang}
                onChange={(e) =>
                  setSelectedOcrLang(e.target.value as "eng" | "ara" | "eng+ara")
                }
                className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm font-medium text-stone-700 outline-none focus:border-teal-600"
                title="The language this book is written in — used when a page needs OCR"
              >
                {OCR_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-0.5">
              <label htmlFor="output-lang" className="text-[11px] text-stone-500">
                Translate into
              </label>
              <select
                id="output-lang"
                value={outputLanguage}
                onChange={(e) => handleLanguageChange(e.target.value)}
                className="rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm font-medium text-stone-700 outline-none focus:border-teal-600"
              >
                {SUPPORTED_OUTPUT_LANGS.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={toggleContinuousMode}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium shadow-sm transition ${
                continuousMode
                  ? "bg-teal-700 text-white"
                  : "bg-stone-100 text-stone-700 hover:bg-stone-200"
              }`}
              title="Automatically keep translating/explaining as you turn pages"
            >
              {continuousMode ? "⏸ Continuous on" : "▶ Continuous"}
            </button>

            <button
              onClick={togglePdfVisible}
              className="rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-200"
              title="Show or hide the original page image"
            >
              {pdfVisible ? "Hide page" : "Show page"}
            </button>

            <button
              onClick={async () => {
                cancelOngoingAIRequest();
                await clearCachedData(currentPage);
                await clearCachedAIDataForPage(currentPage);
                setTranslationText("");
                setExplanationText("");
                setActiveAITab("none");
                loadActivePageText(currentPage);
              }}
              disabled={ocrLoading}
              className="rounded-lg bg-stone-100 px-2.5 py-1.5 text-sm font-medium text-stone-600 shadow-sm hover:bg-stone-200 disabled:opacity-50"
              title="Re-extract this page's text and clear any cached translation/explanation for it"
            >
              ↻
            </button>
          </div>
        </div>
      </header>

      {/* Reading area — fills whatever space is left between header and nav.
          Only this region scrolls (and only if its content needs it); the
          header and bottom nav are always fully visible. */}
      <main
        className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col overflow-y-auto px-4 pt-3"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Collapsible original page preview — small by default, fully hideable */}
        <div
          className={`flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${
            pdfVisible ? "mb-3 max-h-[38vh] opacity-100" : "mb-0 max-h-0 opacity-0"
          }`}
        >
          <div className="mx-auto w-full max-w-[220px] rounded-xl border border-stone-200 bg-white p-2 shadow-sm sm:max-w-[260px]">
            <Document
              file={book.file}
              onLoadSuccess={handleDocumentLoad}
              loading={<div className="p-6 text-center text-xs text-stone-400">Loading PDF…</div>}
              error={<div className="p-6 text-center text-xs text-red-400">Could not load PDF</div>}
            >
              <Page
                pageNumber={currentPage}
                width={240}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />
            </Document>
            {currentExtractionType && (
              <div className="mt-1 flex justify-center">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    currentExtractionType === "pdf-text"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-violet-50 text-violet-700"
                  }`}
                >
                  {currentExtractionType === "pdf-text" ? "Direct text" : "OCR"}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* The "book page" — translation / explanation reading surface.
            This flexes to fill the remaining height and only its inner text
            area scrolls, so the toolbar/tabs stay pinned in view. */}
        <div className={`page-stage flex min-h-0 flex-1 flex-col pb-3 ${flipClass}`}>
          <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-stone-200 bg-[#fffdf7] p-5 shadow-md sm:p-8">
            <div className="mb-4 flex flex-shrink-0 items-center gap-2 border-b border-stone-200 pb-3">
              <button
                onClick={() => handleAITask("translation")}
                disabled={aiLoading || !ocrText}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${
                  activeAITab === "translation"
                    ? "bg-teal-700 text-white shadow-sm"
                    : "bg-stone-100 text-stone-700 hover:bg-stone-200"
                }`}
              >
                Translation
              </button>
              <button
                onClick={() => handleAITask("explanation")}
                disabled={aiLoading || !ocrText}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${
                  activeAITab === "explanation"
                    ? "bg-amber-700 text-white shadow-sm"
                    : "bg-stone-100 text-stone-700 hover:bg-stone-200"
                }`}
              >
                Explanation
              </button>
              <span className="ml-auto rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-xs font-medium text-stone-500">
                {outputLanguage} · page {currentPage}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {ocrLoading ? (
                <p className="py-10 text-center text-sm text-stone-400">
                  Reading this page…
                </p>
              ) : activeAITab === "none" ? (
                <p className="py-10 text-center text-sm text-stone-400">
                  Choose Translation or Explanation above to start reading this page.
                </p>
              ) : aiLoading ? (
                <p className="animate-pulse py-10 text-center text-sm text-stone-400">
                  {activeAITab === "translation" ? "Translating" : "Explaining"} into {outputLanguage}…
                </p>
              ) : (
                <p
                  dir={detectDirection(displayedText)}
                  className="whitespace-pre-wrap break-words font-serif text-lg leading-8 text-stone-800 sm:text-xl sm:leading-9"
                >
                  {displayedText || "Nothing generated for this page yet."}
                </p>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Bottom navigation — normal flow, fixed height, always visible without scrolling */}
      <nav className="z-30 flex-shrink-0 border-t border-stone-200 bg-[#faf7f0]/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.6rem)] pt-2.5 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <button
            onClick={previousPage}
            disabled={currentPage === 1}
            className="rounded-full bg-stone-100 p-3 text-lg leading-none text-stone-700 hover:bg-stone-200 disabled:opacity-30"
            aria-label="Previous page"
          >
            ←
          </button>

          <div className="flex items-center gap-2 text-sm text-stone-600">
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
              className="w-14 rounded-lg border border-stone-300 bg-white px-2 py-1 text-center outline-none focus:border-teal-600"
            />
            <span className="text-stone-400">/ {numPages || "…"}</span>
          </div>

          <button
            onClick={nextPage}
            disabled={currentPage === numPages}
            className="rounded-full bg-stone-900 p-3 text-lg leading-none text-white hover:bg-stone-700 disabled:opacity-30"
            aria-label="Next page"
          >
            →
          </button>
        </div>
      </nav>

      <style jsx>{`
        .page-stage {
          position: relative;
          perspective: 1700px;
          transform-style: preserve-3d;
        }
        .page-flip-next {
          animation: flipNext 0.56s cubic-bezier(0.45, 0, 0.2, 1);
          transform-origin: left center;
          backface-visibility: hidden;
          will-change: transform;
        }
        .page-flip-prev {
          animation: flipPrev 0.56s cubic-bezier(0.45, 0, 0.2, 1);
          transform-origin: right center;
          backface-visibility: hidden;
          will-change: transform;
        }
        /* The page lifts and turns away (0 → 50%), the content underneath
           swaps while it's edge-on, then it settles back down (50% → 100%),
           revealing the next page — like an actual page turn. */
        @keyframes flipNext {
          0% {
            transform: rotateY(0deg) scale(1);
            box-shadow: 0 1px 2px rgba(120, 108, 80, 0.15);
          }
          48% {
            transform: rotateY(-88deg) scale(0.97);
            box-shadow: 30px 0 40px -10px rgba(60, 50, 30, 0.35);
          }
          50% {
            transform: rotateY(-90deg) scale(0.97);
            box-shadow: 30px 0 40px -10px rgba(60, 50, 30, 0.35);
          }
          52% {
            transform: rotateY(-88deg) scale(0.97);
          }
          100% {
            transform: rotateY(0deg) scale(1);
            box-shadow: 0 1px 2px rgba(120, 108, 80, 0.15);
          }
        }
        @keyframes flipPrev {
          0% {
            transform: rotateY(0deg) scale(1);
            box-shadow: 0 1px 2px rgba(120, 108, 80, 0.15);
          }
          48% {
            transform: rotateY(88deg) scale(0.97);
            box-shadow: -30px 0 40px -10px rgba(60, 50, 30, 0.35);
          }
          50% {
            transform: rotateY(90deg) scale(0.97);
            box-shadow: -30px 0 40px -10px rgba(60, 50, 30, 0.35);
          }
          52% {
            transform: rotateY(88deg) scale(0.97);
          }
          100% {
            transform: rotateY(0deg) scale(1);
            box-shadow: 0 1px 2px rgba(120, 108, 80, 0.15);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .page-flip-next,
          .page-flip-prev {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
};

export default Book;