"use client";

import { useParams, useRouter } from "next/navigation";
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

// Generic map of taskKey -> generated text for a given (page, output-language,
// book-language) triple. taskKey is "translation", "explanation", or
// `custom:${promptId}` for a saved custom prompt.
type PageAIData = Record<string, string>;

interface CustomPrompt {
  id: string;
  name: string;
  prompt: string;
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

const CUSTOM_PROMPTS_STORAGE_KEY = "reader_custom_prompts";

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
  const router = useRouter();

  const [book, setBook] = useState<BookType | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Extraction states
  const [selectedOcrLang, setSelectedOcrLang] = useState<"eng" | "ara" | "eng+ara">("ara");
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [currentExtractionType, setCurrentExtractionType] = useState<string | null>(null);

  // AI & Translation States
  const [outputLanguage, setOutputLanguage] = useState<string>("English");
  const [resultText, setResultText] = useState<string>("");
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  // "none" | "translation" | "explanation" | `custom:${promptId}`
  const [activeAITab, setActiveAITab] = useState<string>("none");

  // Custom prompts (persisted to localStorage)
  const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>([]);
  const [showPromptManager, setShowPromptManager] = useState(false);
  const [showNewPromptForm, setShowNewPromptForm] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptText, setNewPromptText] = useState("");

  // Reading experience states
  const [pdfVisible, setPdfVisible] = useState<boolean>(true);
  const [pdfZoom, setPdfZoom] = useState<number>(1);
  const [pdfBaseWidth, setPdfBaseWidth] = useState<number>(320);
  const [continuousMode, setContinuousMode] = useState<boolean>(false);
  const [flipClass, setFlipClass] = useState<string>("");

  // Mobile toolbar
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

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
  const activeTaskRef = useRef<string>("none");
  // Holds the raw text of whichever custom prompt is currently active, so
  // continuous mode / prefetch can re-use it without needing the prompt id
  // to still exist in `customPrompts` (e.g. right after it's deleted mid-flight).
  const activeCustomPromptTextRef = useRef<string>("");
  const lastAutoTriggeredRef = useRef<string>("");
  const touchStartXRef = useRef<number | null>(null);
  const flipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipSwapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the fetch() powering the CURRENTLY VISIBLE translation/explanation
  // request, so we can abort it the instant the reader navigates away.
  const aiAbortControllerRef = useRef<AbortController | null>(null);

  // Scroll containers — reset to top on page/tab change so a long page you
  // scrolled through doesn't leave the next page pre-scrolled down.
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  const promptManagerRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    activeTaskRef.current = activeAITab;
  }, [activeAITab]);

  // Reset scroll position whenever the visible page or the active
  // translation/explanation tab changes, so the reader always starts each
  // page at the top instead of wherever the previous page left off.
  useEffect(() => {
    mainScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    contentScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [currentPage, activeAITab]);

  // Close the mobile menu whenever the page changes, so it doesn't linger
  // open over the newly-turned page.
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [currentPage]);

  // Load saved preferences + saved custom prompts
  useEffect(() => {
    const savedLang = localStorage.getItem("reader_preferred_output_lang");
    if (savedLang && SUPPORTED_OUTPUT_LANGS.includes(savedLang)) {
      setOutputLanguage(savedLang);
    }
    const savedContinuous = localStorage.getItem("reader_continuous_mode");
    if (savedContinuous === "1") setContinuousMode(true);
    const savedPdfVisible = localStorage.getItem("reader_pdf_visible");
    if (savedPdfVisible === "0") setPdfVisible(false);

    try {
      const rawPrompts = localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY);
      if (rawPrompts) {
        const parsed = JSON.parse(rawPrompts);
        if (Array.isArray(parsed)) setCustomPrompts(parsed);
      }
    } catch (err) {
      console.warn("Could not load saved custom prompts", err);
    }
  }, []);

  // Close the custom-prompt dropdown when clicking outside it.
  useEffect(() => {
    if (!showPromptManager) return;
    const handleClick = (e: MouseEvent) => {
      if (promptManagerRef.current && !promptManagerRef.current.contains(e.target as Node)) {
        setShowPromptManager(false);
        setShowNewPromptForm(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showPromptManager]);

  // Keep the PDF page's render width in sync with however much horizontal
  // space its container actually has — this is what makes the viewer usable
  // instead of a fixed tiny thumbnail, on both phones and desktop.
  useEffect(() => {
    const el = pdfContainerRef.current;
    if (!el || !pdfVisible) return;

    const updateWidth = () => {
      setPdfBaseWidth(Math.max(el.clientWidth - 16, 120));
    };
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdfVisible]);

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

  const persistCustomPrompts = (list: CustomPrompt[]) => {
    setCustomPrompts(list);
    try {
      localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      console.warn("Could not save custom prompts", err);
    }
  };

  const addCustomPrompt = () => {
    const name = newPromptName.trim();
    const text = newPromptText.trim();
    if (!name || !text) return;

    const newPrompt: CustomPrompt = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      prompt: text,
    };

    persistCustomPrompts([...customPrompts, newPrompt]);
    setNewPromptName("");
    setNewPromptText("");
    setShowNewPromptForm(false);
  };

  const deleteCustomPrompt = (id: string) => {
    persistCustomPrompts(customPrompts.filter((p) => p.id !== id));
    if (activeAITab === `custom:${id}`) {
      setActiveAITab("none");
      setResultText("");
      activeCustomPromptTextRef.current = "";
    }
  };

  const getTaskLabel = useCallback(
    (taskKey: string): string => {
      if (taskKey === "translation") return "Translation";
      if (taskKey === "explanation") return "Explanation";
      const id = taskKey.startsWith("custom:") ? taskKey.slice("custom:".length) : "";
      return customPrompts.find((p) => p.id === id)?.name || "Custom";
    },
    [customPrompts]
  );

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

  // IndexedDB / LocalStorage Multi-Language AI Cache Helpers.
  // Each (page, outputLanguage, bookLanguage) key stores a PageAIData map of
  // taskKey -> generated text, so translation/explanation/every custom
  // prompt's result for that page+language all live in one record.
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

  // Wipes every language's translation/explanation/custom-prompt cache for a
  // page under the current book (OCR) language — used when the reader
  // manually refreshes a page so stale AI output from a bad extraction can't
  // linger. Since every task for a given (page, lang) lives in one record,
  // this doesn't need to know which task keys exist.
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

  // Synchronize AI State on Page / Language / Tab change
  useEffect(() => {
    const syncAICache = async () => {
      if (!book || activeAITab === "none") {
        setResultText("");
        return;
      }
      const cached = await getCachedAIData(currentPage, outputLanguage);
      setResultText(cached?.[activeAITab] || "");
    };

    syncAICache();
  }, [currentPage, outputLanguage, activeAITab, book, getCachedAIData]);

  // Page extraction (OCR / native text) cache — backed by IndexedDB, with
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

    // Self-hosted assets, resolved to absolute URLs on our own origin.
    const origin = window.location.origin;

    const worker = await createWorker(selectedOcrLang.split("+"), 1, {
      workerPath: `${origin}/tesseract/worker.min.js`,
      corePath: `${origin}/tesseract/tesseract-core-simd-lstm.js`,
      langPath: "https://tessdata.projectnaptha.com/4.0.0_best",
      logger: () => {},
      // Load the worker script directly instead of fetching it and wrapping
      // it in a blob: URL. Blob-wrapping is only needed to dodge
      // cross-origin worker restrictions when workerPath points at a CDN;
      // since everything is self-hosted on the same origin it's
      // unnecessary — and it broke the core.js file's relative resolution
      // of its own .wasm file.
      workerBlobURL: false,
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
        // right before this ran (or hit a bad core build). Recreate it once
        // and retry rather than crash.
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
          if (currentPageRef.current === pageToLoad) {
            setOcrText("Could not extract text from this page.");
          }
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

  // Builds the prompt sent to the AI endpoint for a given task. "translation"
  // and "explanation" use their fixed templates; anything else is treated as
  // a saved custom prompt and `customText` (the user's own instructions) is
  // spliced in ahead of the page content.
  const buildPrompt = (
    taskKey: string,
    lang: string,
    text: string,
    previousPageContext: string,
    customText?: string
  ): string => {
    if (taskKey === "translation") {
      return `Translate the following text accurately into ${lang}.
Preserve the meaning and important context.
Automatically detect the source language.
Return ONLY the result inside <artifact></artifact> tags.

--- SOURCE TEXT ---
${text}`;
    }

    if (taskKey === "explanation") {
      return `Explain the following book content clearly in ${lang}.
${previousPageContext ? "Use the previous page context to understand continuation." : ""}
Automatically detect the source language.
Return ONLY the explanation inside <artifact></artifact> tags.

${previousPageContext}

--- CURRENT PAGE CONTENT ---
${text}`;
    }

    // Custom prompt
    return `${customText || "Analyze the following page."}
${lang !== "Same as original" ? `Respond in ${lang}.` : ""}
${previousPageContext ? "Use the previous page context to understand continuation." : ""}
Automatically detect the source language of the material.
Return ONLY the result inside <artifact></artifact> tags.

${previousPageContext}

--- CURRENT PAGE CONTENT ---
${text}`;
  };

  // Silently prepares a task's result for an upcoming page so it's instantly
  // ready by the time the reader turns to it. Never touches the visible AI
  // state — it only warms the IndexedDB cache.
  const prefetchAIForPage = useCallback(
    async (pageNum: number, taskKey: string, lang: string, customText?: string) => {
      if (pageNum < 1 || pageNum > numPages || !pdfDocProxy) return;

      const existingAI = await getCachedAIData(pageNum, lang);
      if (existingAI?.[taskKey]) return;

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
      if (taskKey !== "translation" && pageNum > 1) {
        const prevData = await getCachedData(pageNum - 1);
        if (prevData?.text) {
          previousPageContext = `\n--- PREVIOUS PAGE CONTEXT ---\n${prevData.text.slice(-500)}`;
        }
      }

      const prompt = buildPrompt(taskKey, lang, extraction.text, previousPageContext, customText);

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
        await setCachedAIData(pageNum, lang, { ...currentData, [taskKey]: cleanContent });
      } catch (err) {
        console.warn("Background AI prefetch failed for page", pageNum, err);
      }
    },
    [numPages, pdfDocProxy, getCachedAIData, setCachedAIData, getCachedData]
  );

  // AI Task Handler (Translate / Explain / any saved custom prompt)
  const handleAITask = useCallback(
    async (taskKey: string, customText?: string) => {
      if (!ocrText.trim()) return;

      // Snapshot what this specific request is "for" — if the reader has
      // moved to a different page, language, or task by the time it
      // resolves, we must not paint this result over whatever is now on screen.
      const requestPage = currentPage;
      const requestLang = outputLanguage;
      const requestText = ocrText;
      const requestCustomText =
        customText ?? (taskKey.startsWith("custom:") ? activeCustomPromptTextRef.current : undefined);
      const isStillRelevant = () =>
        currentPageRef.current === requestPage &&
        outputLanguageRef.current === requestLang &&
        activeTaskRef.current === taskKey;

      setActiveAITab(taskKey);
      activeTaskRef.current = taskKey;
      if (requestCustomText !== undefined) activeCustomPromptTextRef.current = requestCustomText;

      // Whenever the reader asks for a page, warm up the next two pages in the
      // background so there's no wait when they turn forward.
      prefetchAIForPage(requestPage + 1, taskKey, requestLang, requestCustomText);
      prefetchAIForPage(requestPage + 2, taskKey, requestLang, requestCustomText);

      // 1. Check if already stored in cache
      const existingCache = await getCachedAIData(requestPage, requestLang);
      if (existingCache?.[taskKey]) {
        if (isStillRelevant()) setResultText(existingCache[taskKey]);
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
        // Fetch previous page context for explanation and custom prompts.
        let previousPageContext = "";
        if (taskKey !== "translation" && requestPage > 1) {
          const prevPageData = await getCachedData(requestPage - 1);
          if (prevPageData?.text) {
            previousPageContext = `\n--- PREVIOUS PAGE CONTEXT ---\n${prevPageData.text.slice(-500)}`;
          }
        }

        const prompt = buildPrompt(taskKey, requestLang, requestText, previousPageContext, requestCustomText);

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
            setResultText(
              `Max tokens used — response exceeded ${MAX_RESPONSE_WORD_COUNT.toLocaleString()} words.`
            );
          }
          return;
        }

        // Save updated result in multi-task storage — this always happens,
        // regardless of whether the reader has since moved on, so the cache
        // is correct next time they land on this page.
        const currentData = (await getCachedAIData(requestPage, requestLang)) || {};
        const updatedData: PageAIData = {
          ...currentData,
          [taskKey]: cleanContent,
        };

        await setCachedAIData(requestPage, requestLang, updatedData);

        if (isStillRelevant()) {
          setResultText(cleanContent);
        }
      } catch (err: any) {
        if (err?.name === "AbortError") {
          // Cancelled on purpose (reader navigated away) — nothing to show.
          return;
        }
        console.error(err);
        if (isStillRelevant()) {
          setResultText(`${getTaskLabel(taskKey)} failed. Please try again.`);
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
    [
      ocrText,
      currentPage,
      outputLanguage,
      getCachedAIData,
      setCachedAIData,
      getCachedData,
      prefetchAIForPage,
      getTaskLabel,
    ]
  );

  // Continuous mode: once turned on, keeps generating the same task
  // (translation / explanation / custom prompt) automatically as the reader
  // turns pages.
  useEffect(() => {
    if (!continuousMode || activeAITab === "none") return;
    if (!ocrText.trim()) return;

    const key = `${currentPage}|${activeAITab}|${outputLanguage}`;
    if (lastAutoTriggeredRef.current === key) return;
    lastAutoTriggeredRef.current = key;

    handleAITask(
      activeAITab,
      activeAITab.startsWith("custom:") ? activeCustomPromptTextRef.current : undefined
    );
  }, [continuousMode, currentPage, ocrText, activeAITab, outputLanguage, handleAITask]);

  const handleDocumentLoad = (pdf: any) => {
    setNumPages(pdf.numPages);
    setPdfDocProxy(pdf);
  };

  const FLIP_DURATION_MS = 500;

  const changePageWithFlip = (targetPage: number, direction: "next" | "prev") => {
    if (flipTimeoutRef.current) clearTimeout(flipTimeoutRef.current);
    if (flipSwapTimeoutRef.current) clearTimeout(flipSwapTimeoutRef.current);

    setFlipClass("");
    requestAnimationFrame(() => {
      setFlipClass(direction === "next" ? "page-flip-next" : "page-flip-prev");
    });

    // Swap the actual page content right at the midpoint, when the lift/fade
    // is at its deepest — so what "lands" as the animation settles is
    // genuinely the new page rather than the old one snapping to new text.
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

  // Deletes the book row itself plus every cached page-extraction and
  // AI translation/explanation/custom-prompt entry across all OCR languages
  // and all output languages, then returns to the library. Uses
  // book.numPages (persisted at add-time) rather than the in-memory numPages
  // state so deletion is thorough even if the PDF hasn't finished loading yet.
  const handleDeleteBookForever = useCallback(async () => {
    if (!book || deleting) return;

    const confirmed = window.confirm(
      `Delete "${book.name}" permanently? This removes the file and all cached translations/explanations. This can't be undone.`
    );
    if (!confirmed) return;

    setDeleting(true);
    cancelOngoingAIRequest();

    try {
      const db = await getDB();

      // Adjust this to match however "books" is actually keyed — e.g.
      // book.id if it's an out-of-line key, or book.name if that's the
      // inline keyPath used when the book was added.
      const bookKey = (book as any).id ?? book.name;
      await db.delete("books", bookKey);

      const pagesToClean = Math.max(numPages, (book as any).numPages ?? 0, 1);

      for (const ocrOpt of OCR_LANGUAGE_OPTIONS) {
        for (let p = 1; p <= pagesToClean; p++) {
          const extractionKey = `ocr_cache_${book.name}_${ocrOpt.value}_page_${p}`;
          try {
            if (db.objectStoreNames.contains("page_extractions")) {
              await db.delete("page_extractions", extractionKey);
            }
          } catch (err) {
            console.warn("IndexedDB delete failed (extraction) during book delete", err);
          }
          try {
            localStorage.removeItem(extractionKey);
          } catch {}

          for (const lang of SUPPORTED_OUTPUT_LANGS) {
            const aiKey = `page_ai_${book.name}_p${p}_${lang}_${ocrOpt.value}`;
            try {
              if (db.objectStoreNames.contains("ai_translations")) {
                await db.delete("ai_translations", aiKey);
              }
            } catch (err) {
              console.warn("IndexedDB delete failed (AI cache) during book delete", err);
            }
            try {
              localStorage.removeItem(aiKey);
            } catch {}
          }
        }
      }
    } catch (err) {
      console.error("Failed to delete book", err);
      alert("Something went wrong deleting the book. Check the console.");
      setDeleting(false);
      return;
    }

    router.push("/");
  }, [book, deleting, numPages, cancelOngoingAIRequest, router]);

  const handleRefreshPage = useCallback(async () => {
    cancelOngoingAIRequest();
    await clearCachedData(currentPage);
    await clearCachedAIDataForPage(currentPage);
    setResultText("");
    setActiveAITab("none");
    loadActivePageText(currentPage);
  }, [cancelOngoingAIRequest, clearCachedData, clearCachedAIDataForPage, currentPage, loadActivePageText]);

  const Document = PDFComponents?.Document;
  const Page = PDFComponents?.Page;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-orange-50 text-stone-600">
        {error}
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-orange-50 text-stone-500">
        Loading book...
      </div>
    );
  }

  if (!Document || !Page) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-orange-50 text-stone-500">
        Loading PDF reader...
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-orange-50">

      {/* Header / toolbar — fixed-height, always visible, never scrolls away.
          On phones this collapses to Back + title + a hamburger; on sm+
          screens the full control row shows inline like before. */}
      <header className="z-20 flex-shrink-0 border-b border-orange-200 bg-orange-50/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-2.5">
          <Link href="/" className="shrink-0 text-sm font-semibold text-orange-800 sm:text-base">
            ← Back
          </Link>

          <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-stone-800 sm:text-left sm:text-lg">
            {book.name}
          </h1>

          {/* Desktop controls — hidden on phones */}
          <div className="hidden flex-wrap items-end gap-2 sm:flex">
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
                className="rounded-lg border border-orange-300 bg-white px-2.5 py-1.5 text-sm font-medium text-stone-700 outline-none focus:border-orange-600"
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
                className="rounded-lg border border-orange-300 bg-white px-2.5 py-1.5 text-sm font-medium text-stone-700 outline-none focus:border-orange-600"
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
                  ? "bg-orange-700 text-white"
                  : "bg-orange-100 text-orange-800 hover:bg-orange-200"
              }`}
              title="Automatically keep translating/explaining as you turn pages"
            >
              {continuousMode ? "⏸ Continuous on" : "▶ Continuous"}
            </button>

            <button
              onClick={togglePdfVisible}
              className="rounded-lg bg-orange-100 px-3 py-1.5 text-sm font-medium text-orange-800 shadow-sm hover:bg-orange-200"
              title="Show or hide the original page image"
            >
              {pdfVisible ? "Hide page" : "Show page"}
            </button>

            <button
              onClick={handleRefreshPage}
              disabled={ocrLoading}
              className="rounded-lg bg-orange-100 px-2.5 py-1.5 text-sm font-medium text-orange-700 shadow-sm hover:bg-orange-200 disabled:opacity-50"
              title="Re-extract this page's text and clear any cached translation/explanation for it"
            >
              ↻
            </button>

            <button
              onClick={handleDeleteBookForever}
              disabled={deleting}
              className="rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 shadow-sm hover:bg-red-100 disabled:opacity-50"
              title="Delete this book and all its cached data permanently"
            >
              {deleting ? "Deleting…" : "🗑 Delete"}
            </button>
          </div>

          {/* Mobile hamburger — hidden on sm+ */}
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="flex shrink-0 items-center justify-center rounded-lg bg-orange-100 p-2 text-orange-800 shadow-sm sm:hidden"
            aria-label="Menu"
            aria-expanded={mobileMenuOpen}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              {mobileMenuOpen ? (
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="M3 5.5h14M3 10h14M3 14.5h14"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile dropdown panel — all the same controls, stacked */}
        {mobileMenuOpen && (
          <div className="border-t border-orange-200 bg-orange-50 px-4 py-3 sm:hidden">
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <div className="flex flex-1 flex-col gap-0.5">
                  <label htmlFor="book-lang-m" className="text-[11px] text-stone-500">
                    Book language
                  </label>
                  <select
                    id="book-lang-m"
                    value={selectedOcrLang}
                    onChange={(e) =>
                      setSelectedOcrLang(e.target.value as "eng" | "ara" | "eng+ara")
                    }
                    className="w-full rounded-lg border border-orange-300 bg-white px-2.5 py-1.5 text-sm font-medium text-stone-700 outline-none focus:border-orange-600"
                  >
                    {OCR_LANGUAGE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-1 flex-col gap-0.5">
                  <label htmlFor="output-lang-m" className="text-[11px] text-stone-500">
                    Translate into
                  </label>
                  <select
                    id="output-lang-m"
                    value={outputLanguage}
                    onChange={(e) => handleLanguageChange(e.target.value)}
                    className="w-full rounded-lg border border-orange-300 bg-white px-2.5 py-1.5 text-sm font-medium text-stone-700 outline-none focus:border-orange-600"
                  >
                    {SUPPORTED_OUTPUT_LANGS.map((lang) => (
                      <option key={lang} value={lang}>
                        {lang}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={toggleContinuousMode}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium shadow-sm transition ${
                    continuousMode
                      ? "bg-orange-700 text-white"
                      : "bg-orange-100 text-orange-800 hover:bg-orange-200"
                  }`}
                >
                  {continuousMode ? "⏸ Continuous on" : "▶ Continuous"}
                </button>

                <button
                  onClick={togglePdfVisible}
                  className="flex-1 rounded-lg bg-orange-100 px-3 py-2 text-sm font-medium text-orange-800 shadow-sm hover:bg-orange-200"
                >
                  {pdfVisible ? "Hide page" : "Show page"}
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleRefreshPage}
                  disabled={ocrLoading}
                  className="flex-1 rounded-lg bg-orange-100 px-3 py-2 text-sm font-medium text-orange-700 shadow-sm hover:bg-orange-200 disabled:opacity-50"
                >
                  ↻ Refresh page
                </button>

                <button
                  onClick={handleDeleteBookForever}
                  disabled={deleting}
                  className="flex-1 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600 shadow-sm hover:bg-red-100 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "🗑 Delete book"}
                </button>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Reading area — fills whatever space is left between header and nav.
          Only this region scrolls (and only if its content needs it); the
          header and bottom nav are always fully visible. */}
      <main
        ref={mainScrollRef as any}
        className="mx-auto flex w-full min-h-0 max-w-4xl flex-1 flex-col overflow-y-auto px-3 pt-2 sm:px-4 sm:pt-3"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Original page viewer — a proper, readable PDF pane (not a
            thumbnail): zoomable, scrollable in both directions, and takes a
            real chunk of the screen. Sits on top; the translation/explanation
            panel below is the "normal reader" split underneath it. */}
        {pdfVisible && (
          <div className="mb-2 flex-shrink-0 sm:mb-3">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold text-orange-800">
                Original page
                {currentExtractionType && (
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      currentExtractionType === "pdf-text"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-violet-50 text-violet-700"
                    }`}
                  >
                    {currentExtractionType === "pdf-text" ? "Direct text" : "OCR"}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPdfZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
                  className="rounded-md bg-orange-100 px-2 py-0.5 text-sm font-semibold text-orange-800 hover:bg-orange-200"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="w-10 text-center text-[11px] text-stone-500">
                  {Math.round(pdfZoom * 100)}%
                </span>
                <button
                  onClick={() => setPdfZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}
                  className="rounded-md bg-orange-100 px-2 py-0.5 text-sm font-semibold text-orange-800 hover:bg-orange-200"
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
            </div>

            <div
              ref={pdfContainerRef}
              className="h-[40vh] w-full overflow-auto rounded-xl border border-orange-200 bg-white p-2 shadow-sm sm:h-[46vh]"
            >
              <div className="flex min-h-full items-start justify-center">
                <Document
                  file={book.file}
                  onLoadSuccess={handleDocumentLoad}
                  loading={<div className="p-6 text-center text-xs text-stone-400">Loading PDF…</div>}
                  error={<div className="p-6 text-center text-xs text-red-400">Could not load PDF</div>}
                >
                  <Page
                    pageNumber={currentPage}
                    width={Math.max(pdfBaseWidth * pdfZoom, 100)}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                  />
                </Document>
              </div>
            </div>
          </div>
        )}

        {/* The "book page" — translation / explanation / custom-prompt
            reading surface. This flexes to fill the remaining height and
            only its inner text area scrolls, so the toolbar/tabs stay
            pinned in view. */}
        <div className={`page-stage flex min-h-0 flex-1 flex-col pb-2 sm:pb-3 ${flipClass}`}>
          <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-orange-200 bg-white p-3 shadow-md sm:p-8">
            <div className="mb-2 flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-orange-100 pb-2 sm:mb-4 sm:pb-3">
              <button
                onClick={() => handleAITask("translation")}
                disabled={aiLoading || !ocrText}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 sm:px-3 sm:text-sm ${
                  activeAITab === "translation"
                    ? "bg-orange-600 text-white shadow-sm"
                    : "bg-orange-50 text-orange-800 hover:bg-orange-100"
                }`}
              >
                Translation
              </button>
              <button
                onClick={() => handleAITask("explanation")}
                disabled={aiLoading || !ocrText}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 sm:px-3 sm:text-sm ${
                  activeAITab === "explanation"
                    ? "bg-amber-600 text-white shadow-sm"
                    : "bg-orange-50 text-orange-800 hover:bg-orange-100"
                }`}
              >
                Explanation
              </button>

              {/* Custom prompt picker: saved prompts loaded from & written to
                  localStorage, with delete support. */}
              <div className="relative" ref={promptManagerRef}>
                <button
                  onClick={() => setShowPromptManager((v) => !v)}
                  disabled={aiLoading || !ocrText}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 sm:px-3 sm:text-sm ${
                    activeAITab.startsWith("custom:")
                      ? "bg-orange-800 text-white shadow-sm"
                      : "bg-orange-50 text-orange-800 hover:bg-orange-100"
                  }`}
                >
                  {activeAITab.startsWith("custom:") ? `✨ ${getTaskLabel(activeAITab)}` : "✨ Custom"}
                </button>

                {showPromptManager && (
                  <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-xl border border-orange-200 bg-white p-2 shadow-lg">
                    {customPrompts.length === 0 && !showNewPromptForm && (
                      <p className="px-1 py-2 text-xs text-stone-400">No saved prompts yet.</p>
                    )}

                    <div className="max-h-40 overflow-y-auto">
                      {customPrompts.map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-orange-50"
                        >
                          <button
                            onClick={() => {
                              activeCustomPromptTextRef.current = p.prompt;
                              setShowPromptManager(false);
                              handleAITask(`custom:${p.id}`, p.prompt);
                            }}
                            className="flex-1 truncate text-left text-xs font-medium text-stone-700"
                            title={p.prompt}
                          >
                            {p.name}
                          </button>
                          <button
                            onClick={() => deleteCustomPrompt(p.id)}
                            className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50"
                            title="Delete this prompt"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>

                    {showNewPromptForm ? (
                      <div className="mt-2 space-y-1 border-t border-orange-100 pt-2">
                        <input
                          value={newPromptName}
                          onChange={(e) => setNewPromptName(e.target.value)}
                          placeholder="Prompt name"
                          className="w-full rounded-lg border border-orange-200 px-2 py-1 text-xs outline-none focus:border-orange-600"
                        />
                        <textarea
                          value={newPromptText}
                          onChange={(e) => setNewPromptText(e.target.value)}
                          placeholder="e.g. Summarize this page in 3 bullet points"
                          rows={3}
                          className="w-full rounded-lg border border-orange-200 px-2 py-1 text-xs outline-none focus:border-orange-600"
                        />
                        <div className="flex gap-1">
                          <button
                            onClick={addCustomPrompt}
                            disabled={!newPromptName.trim() || !newPromptText.trim()}
                            className="flex-1 rounded-lg bg-orange-600 px-2 py-1 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-40"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => {
                              setShowNewPromptForm(false);
                              setNewPromptName("");
                              setNewPromptText("");
                            }}
                            className="flex-1 rounded-lg bg-orange-50 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-100"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowNewPromptForm(true)}
                        className="mt-1 w-full rounded-lg border border-dashed border-orange-300 px-2 py-1.5 text-xs font-medium text-orange-600 hover:bg-orange-50"
                      >
                        + New custom prompt
                      </button>
                    )}
                  </div>
                )}
              </div>

              <span className="ml-auto whitespace-nowrap rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-medium text-orange-700 sm:px-2.5 sm:text-xs">
                {outputLanguage} · p.{currentPage}
              </span>
            </div>

            <div ref={contentScrollRef} className="min-h-0 flex-1 overflow-y-auto">
              {ocrLoading ? (
                <p className="py-10 text-center text-sm text-stone-400">
                  Reading this page…
                </p>
              ) : activeAITab === "none" ? (
                <p className="py-10 text-center text-sm text-stone-400">
                  Choose Translation, Explanation, or a custom prompt above to start reading this page.
                </p>
              ) : aiLoading ? (
                <p className="animate-pulse py-10 text-center text-sm text-stone-400">
                  Generating {getTaskLabel(activeAITab)} in {outputLanguage}…
                </p>
              ) : (
                <p
                  dir={detectDirection(resultText)}
                  className="whitespace-pre-wrap break-words font-serif text-base leading-7 text-stone-800 sm:text-xl sm:leading-9"
                >
                  {resultText || "Nothing generated for this page yet."}
                </p>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Bottom navigation — normal flow, fixed height, always visible without scrolling */}
      <nav className="z-30 flex-shrink-0 border-t border-orange-200 bg-orange-50/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.6rem)] pt-2.5 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <button
            onClick={previousPage}
            disabled={currentPage === 1}
            className="rounded-full bg-orange-100 p-3 text-lg leading-none text-orange-800 hover:bg-orange-200 disabled:opacity-30"
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
              className="w-14 rounded-lg border border-orange-300 bg-white px-2 py-1 text-center outline-none focus:border-orange-600"
            />
            <span className="text-stone-400">/ {numPages || "…"}</span>
          </div>

          <button
            onClick={nextPage}
            disabled={currentPage === numPages}
            className="rounded-full bg-orange-600 p-3 text-lg leading-none text-white hover:bg-orange-700 disabled:opacity-30"
            aria-label="Next page"
          >
            →
          </button>
        </div>
      </nav>

      <style jsx>{`
        .page-stage {
          position: relative;
          will-change: transform, box-shadow, opacity;
        }
        .page-flip-next {
          animation: liftShiftNext 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .page-flip-prev {
          animation: liftShiftPrev 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        /* The whole page lifts off the surface, drifts to one side, dips in
           opacity right as the content swaps underneath (masking the swap
           instead of exposing it mid-motion), drifts back, and settles down
           — meant to read as "picked up and set back down" rather than a
           rigid 3D rotation. */
        @keyframes liftShiftNext {
          0% {
            transform: translate(0, 0) scale(1);
            box-shadow: 0 1px 2px rgba(194, 120, 20, 0.15);
            opacity: 1;
          }
          30% {
            transform: translate(-2%, -16px) scale(0.98);
            box-shadow: 0 24px 36px -14px rgba(154, 82, 10, 0.35);
            opacity: 1;
          }
          48% {
            transform: translate(-5%, -20px) scale(0.965);
            box-shadow: 0 28px 42px -14px rgba(154, 82, 10, 0.4);
            opacity: 0.5;
          }
          52% {
            transform: translate(5%, -20px) scale(0.965);
            box-shadow: 0 28px 42px -14px rgba(154, 82, 10, 0.4);
            opacity: 0.5;
          }
          70% {
            transform: translate(2%, -14px) scale(0.98);
            box-shadow: 0 20px 32px -14px rgba(154, 82, 10, 0.3);
            opacity: 1;
          }
          100% {
            transform: translate(0, 0) scale(1);
            box-shadow: 0 1px 2px rgba(194, 120, 20, 0.15);
            opacity: 1;
          }
        }
        @keyframes liftShiftPrev {
          0% {
            transform: translate(0, 0) scale(1);
            box-shadow: 0 1px 2px rgba(194, 120, 20, 0.15);
            opacity: 1;
          }
          30% {
            transform: translate(2%, -16px) scale(0.98);
            box-shadow: 0 24px 36px -14px rgba(154, 82, 10, 0.35);
            opacity: 1;
          }
          48% {
            transform: translate(5%, -20px) scale(0.965);
            box-shadow: 0 28px 42px -14px rgba(154, 82, 10, 0.4);
            opacity: 0.5;
          }
          52% {
            transform: translate(-5%, -20px) scale(0.965);
            box-shadow: 0 28px 42px -14px rgba(154, 82, 10, 0.4);
            opacity: 0.5;
          }
          70% {
            transform: translate(-2%, -14px) scale(0.98);
            box-shadow: 0 20px 32px -14px rgba(154, 82, 10, 0.3);
            opacity: 1;
          }
          100% {
            transform: translate(0, 0) scale(1);
            box-shadow: 0 1px 2px rgba(194, 120, 20, 0.15);
            opacity: 1;
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