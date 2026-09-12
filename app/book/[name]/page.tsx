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
const ACTIVE_PROMPT_STORAGE_KEY = "reader_active_custom_prompt_id";
const RTL_OUTPUT_LANGUAGES = new Set(["Arabic", "Urdu"]);
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
  const [activeAITab, setActiveAITab] = useState<"translation" | "explanation">("translation");

  // Custom prompts states
  const [customPrompts, setCustomPrompts] = useState<CustomPrompt[]>([]);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [showNewPromptForm, setShowNewPromptForm] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptText, setNewPromptText] = useState("");

  // Reading experience states
  const [pdfVisible, setPdfVisible] = useState<boolean>(true);
  const [pdfZoom, setPdfZoom] = useState<number>(1);
  const [pdfBaseWidth, setPdfBaseWidth] = useState<number>(320);
  const [continuousMode, setContinuousMode] = useState<boolean>(true);
  const [flipClass, setFlipClass] = useState<string>("");

  // Resizable split-pane states
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [splitHeightPx, setSplitHeightPx] = useState<number>(240);
  const isDraggingRef = useRef<boolean>(false);

  // Drawer / Menu
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
  const activeTaskRef = useRef<"translation" | "explanation">(activeAITab);
  const activeCustomPromptTextRef = useRef<string>("");
  const lastAutoTriggeredRef = useRef<string>("");
  const touchStartXRef = useRef<number | null>(null);
  const flipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipSwapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiAbortControllerRef = useRef<AbortController | null>(null);

  const mainContainerRef = useRef<HTMLElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [currentPage, activeAITab]);

  // Load preferences & prompts
  useEffect(() => {
    const savedLang = localStorage.getItem("reader_preferred_output_lang");
    if (savedLang && SUPPORTED_OUTPUT_LANGS.includes(savedLang)) {
      setOutputLanguage(savedLang);
    }
    const savedContinuous = localStorage.getItem("reader_continuous_mode");
    if (savedContinuous !== null) setContinuousMode(savedContinuous === "1");
    const savedPdfVisible = localStorage.getItem("reader_pdf_visible");
    if (savedPdfVisible === "0") setPdfVisible(false);

    let loadedPrompts: CustomPrompt[] = [];
    try {
      const rawPrompts = localStorage.getItem(CUSTOM_PROMPTS_STORAGE_KEY);
      if (rawPrompts) {
        const parsed = JSON.parse(rawPrompts);
        if (Array.isArray(parsed)) {
          loadedPrompts = parsed;
          setCustomPrompts(parsed);
        }
      }
    } catch (err) {
      console.warn("Could not load saved custom prompts", err);
    }

    try {
      const savedActivePrompt = localStorage.getItem(ACTIVE_PROMPT_STORAGE_KEY);
      if (savedActivePrompt) {
        setActivePromptId(savedActivePrompt);
        const match = loadedPrompts.find((p) => p.id === savedActivePrompt);
        if (match) {
          activeCustomPromptTextRef.current = match.prompt;
        }
      }
    } catch (err) {
      console.warn("Could not load active custom prompt", err);
    }
  }, []);

  useEffect(() => {
    const el = pdfContainerRef.current;
    if (!el || !pdfVisible) return;

    const updateWidth = () => {
      setPdfBaseWidth(Math.max(el.clientWidth - 24, 120));
    };
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdfVisible, splitPercent]);

  // Split-pane Resizer
  const startResizing = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = window.innerWidth >= 768 ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (!isDraggingRef.current || !mainContainerRef.current) return;
      const clientX = "touches" in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const clientY = "touches" in moveEvent ? moveEvent.touches[0].clientY : moveEvent.clientY;

      if (window.innerWidth >= 768) {
        const bounds = mainContainerRef.current.getBoundingClientRect();
        const rawPercent = ((clientX - bounds.left) / bounds.width) * 100;
        const clampedPercent = Math.min(Math.max(rawPercent, 20), 80);
        setSplitPercent(clampedPercent);
      } else {
        const bounds = mainContainerRef.current.getBoundingClientRect();
        const rawHeight = clientY - bounds.top;
        const clampedHeight = Math.min(Math.max(rawHeight, 100), bounds.height - 120);
        setSplitHeightPx(clampedHeight);
      }
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("touchmove", onPointerMove);
      window.removeEventListener("touchend", onPointerUp);
    };

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("touchmove", onPointerMove);
    window.addEventListener("touchend", onPointerUp);
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

  const persistCustomPrompts = (list: CustomPrompt[]) => {
    setCustomPrompts(list);
    try {
      localStorage.setItem(CUSTOM_PROMPTS_STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      console.warn("Could not save custom prompts", err);
    }
  };

  const persistActivePromptId = (id: string | null) => {
    setActivePromptId(id);
    try {
      if (id) localStorage.setItem(ACTIVE_PROMPT_STORAGE_KEY, id);
      else localStorage.removeItem(ACTIVE_PROMPT_STORAGE_KEY);
    } catch (err) {
      console.warn("Could not save active prompt", err);
    }
  };

  const cancelOngoingAIRequest = useCallback(() => {
    if (aiAbortControllerRef.current) {
      aiAbortControllerRef.current.abort();
      aiAbortControllerRef.current = null;
    }
    setAiLoading(false);
  }, []);

  useEffect(() => {
    const loadPDF = async () => {
      const { Document, Page, pdfjs } = await import("react-pdf");
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
      setPDFComponents({ Document, Page, pdfjs });
    };
    loadPDF();
  }, []);

  useEffect(() => {
    return () => {
      if (tesseractWorkerRef.current) tesseractWorkerRef.current.terminate();
      if (flipTimeoutRef.current) clearTimeout(flipTimeoutRef.current);
      if (flipSwapTimeoutRef.current) clearTimeout(flipSwapTimeoutRef.current);
      if (aiAbortControllerRef.current) aiAbortControllerRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const loadBook = async () => {
      try {
        const db = await getDB();
        const books = await db.getAll("books");
        const bookName = Array.isArray(params.name) ? params.name[0] : params.name;

        if (!bookName) {
          setError("Book not specified");
          return;
        }

        const decodedBookName = decodeURIComponent(bookName);
        const foundBook = books.find(
          (item) => item.name.replace(/\.pdf$/i, "") === decodedBookName.replace(/\.pdf$/i, "")
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

  const getAIStorageKey = useCallback(
    (pageNum: number, lang: string) =>
      `page_ai_${book?.name || "book"}_p${pageNum}_${lang}_${selectedOcrLang}_${activePromptId || "base"}`,
    [book?.name, selectedOcrLang, activePromptId]
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
        console.warn("IndexedDB read fallback", err);
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
        console.warn("IndexedDB write failed", err);
      }
      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch (e) {
        console.warn("Storage quota exceeded", e);
      }
    },
    [getAIStorageKey]
  );

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
          console.warn("IndexedDB delete failed", err);
        }
        try {
          localStorage.removeItem(key);
        } catch {}
      }
    },
    [getAIStorageKey]
  );

  useEffect(() => {
    const syncAICache = async () => {
      if (!book) {
        setResultText("");
        return;
      }
      const cached = await getCachedAIData(currentPage, outputLanguage);
      setResultText(cached?.[activeAITab] || "");
    };
    syncAICache();
  }, [currentPage, outputLanguage, activeAITab, book, getCachedAIData]);

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
        console.warn("IndexedDB read error", err);
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
        console.warn("IndexedDB write error", err);
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
        console.warn("IndexedDB delete error", err);
      }
      try {
        localStorage.removeItem(key);
      } catch {}
    },
    [getCacheKey]
  );

  const getTesseractWorker = async () => {
    if (tesseractWorkerRef.current && activeWorkerLangRef.current === selectedOcrLang) {
      return tesseractWorkerRef.current;
    }
    if (tesseractWorkerRef.current) {
      await tesseractWorkerRef.current.terminate();
    }

    const { createWorker, PSM } = await import("tesseract.js");
    const origin = window.location.origin;

    const worker = await createWorker(selectedOcrLang.split("+"), 1, {
      workerPath: `${origin}/tesseract/worker.min.js`,
      corePath: `${origin}/tesseract/tesseract-core-simd-lstm.js`,
      langPath: "https://tessdata.projectnaptha.com/4.0.0_best",
      logger: () => {},
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

  const processPageExtraction = async (pageNum: number): Promise<CachedPageResult | null> => {
    if (!pdfDocProxy) return null;

    const cached = await getCachedData(pageNum);
    if (cached) return cached;

    const page = await pdfDocProxy.getPage(pageNum);
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

    // OCR Fallback
    const viewport = page.getViewport({ scale: 2.2 });
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
      if (!existing) deduplicatedLines.push(current);
      else if (current.text.length > existing.text.length) existing.text = current.text;
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
      ]);
    },
    [getCachedData, queuePagesForPreload]
  );

  useEffect(() => {
    if (pdfDocProxy && numPages > 0) {
      loadActivePageText(currentPage);
    }
  }, [currentPage, pdfDocProxy, numPages, selectedOcrLang, loadActivePageText]);

  const extractArtifact = (raw: string) => {
    const match = raw.match(/<artifact>([\s\S]*?)<\/artifact>/i);
    return match ? match[1].trim() : raw.trim();
  };

  // Build unified prompt: always includes custom prompt directives if one is active
  const buildPrompt = (
    taskKey: "translation" | "explanation",
    lang: string,
    text: string,
    previousPageContext: string,
    customInstructions?: string
  ): string => {
    const customSection = customInstructions?.trim()
      ? `\n--- USER CUSTOM INSTRUCTIONS (APPLY ALWAYS) ---\n${customInstructions.trim()}\n`
      : "";

    if (taskKey === "translation") {
      return `Translate the following text accurately into ${lang}.
Preserve the meaning and important context.
Automatically detect the source language.
${customSection}
Return ONLY the final translated result inside <artifact></artifact> tags.

--- SOURCE TEXT ---
${text}`;
    }

    return `Explain the following book content clearly in ${lang}.
${previousPageContext ? "Use the previous page context to understand continuation." : ""}
Automatically detect the source language.
${customSection}
Return ONLY the explanation inside <artifact></artifact> tags.

${previousPageContext}

--- CURRENT PAGE CONTENT ---
${text}`;
  };

  const prefetchAIForPage = useCallback(
    async (pageNum: number, taskKey: "translation" | "explanation", lang: string, customText?: string) => {
      if (pageNum < 1 || pageNum > numPages || !pdfDocProxy) return;

      const existingAI = await getCachedAIData(pageNum, lang);
      if (existingAI?.[taskKey]) return;

      let extraction = await getCachedData(pageNum);
      if (!extraction) {
        try {
          extraction = await processPageExtraction(pageNum);
        } catch {
          return;
        }
      }
      if (!extraction || !extraction.text.trim()) return;

      let previousPageContext = "";
      if (taskKey === "explanation" && pageNum > 1) {
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

        if (countWords(cleanContent) > MAX_RESPONSE_WORD_COUNT) return;

        const currentData = (await getCachedAIData(pageNum, lang)) || {};
        await setCachedAIData(pageNum, lang, { ...currentData, [taskKey]: cleanContent });
      } catch (err) {
        console.warn("Background AI prefetch failed", err);
      }
    },
    [numPages, pdfDocProxy, getCachedAIData, setCachedAIData, getCachedData]
  );

  const handleAITask = useCallback(
    async (taskKey: "translation" | "explanation", explicitCustomText?: string) => {
      if (!ocrText.trim()) return;

      const requestPage = currentPage;
      const requestLang = outputLanguage;
      const requestText = ocrText;
      const activeCustomText = explicitCustomText ?? activeCustomPromptTextRef.current;

      const isStillRelevant = () =>
        currentPageRef.current === requestPage &&
        outputLanguageRef.current === requestLang &&
        activeTaskRef.current === taskKey;

      setActiveAITab(taskKey);
      activeTaskRef.current = taskKey;

      prefetchAIForPage(requestPage + 1, taskKey, requestLang, activeCustomText);

      const existingCache = await getCachedAIData(requestPage, requestLang);
      if (existingCache?.[taskKey]) {
        if (isStillRelevant()) setResultText(existingCache[taskKey]);
        return;
      }

      if (aiAbortControllerRef.current) aiAbortControllerRef.current.abort();
      const controller = new AbortController();
      aiAbortControllerRef.current = controller;

      if (isStillRelevant()) setAiLoading(true);

      try {
        let previousPageContext = "";
        if (taskKey === "explanation" && requestPage > 1) {
          const prevPageData = await getCachedData(requestPage - 1);
          if (prevPageData?.text) {
            previousPageContext = `\n--- PREVIOUS PAGE CONTEXT ---\n${prevPageData.text.slice(-500)}`;
          }
        }

        const prompt = buildPrompt(taskKey, requestLang, requestText, previousPageContext, activeCustomText);

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
          if (isStillRelevant()) {
            setResultText("Max response size exceeded.");
          }
          return;
        }

        const currentData = (await getCachedAIData(requestPage, requestLang)) || {};
        await setCachedAIData(requestPage, requestLang, { ...currentData, [taskKey]: cleanContent });

        if (isStillRelevant()) setResultText(cleanContent);
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        console.error(err);
        if (isStillRelevant()) {
          setResultText(`${taskKey === "translation" ? "Translation" : "Explanation"} failed. Try again.`);
        }
      } finally {
        const stillCurrent = aiAbortControllerRef.current === controller;
        if (stillCurrent) aiAbortControllerRef.current = null;
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
    ]
  );

  // Auto-run trigger: runs every time the page or extracted text updates
  useEffect(() => {
    if (!ocrText.trim()) return;

    const key = `${currentPage}|${activeAITab}|${outputLanguage}|${activePromptId || "none"}`;
    if (lastAutoTriggeredRef.current === key) return;
    lastAutoTriggeredRef.current = key;

    handleAITask(activeAITab);
  }, [continuousMode, currentPage, ocrText, activeAITab, outputLanguage, activePromptId, handleAITask]);

  // Handle prompt switch: selects, persists, invalidates cache for fresh response, and runs immediately
  const handleSelectPrompt = (p: CustomPrompt | null) => {
    const newId = p ? p.id : null;
    const newText = p ? p.prompt : "";
    persistActivePromptId(newId);
    activeCustomPromptTextRef.current = newText;
    setMobileMenuOpen(false);

    // Clear stale page-level cache and trigger immediately with the newly selected prompt
    clearCachedAIDataForPage(currentPage);
    setResultText("");
    lastAutoTriggeredRef.current = "";
    handleAITask(activeAITab, newText);
  };

  const savePromptForm = () => {
    const name = newPromptName.trim();
    const text = newPromptText.trim();
    if (!name || !text) return;

    let targetPrompt: CustomPrompt;

    if (editingPromptId) {
      targetPrompt = { id: editingPromptId, name, prompt: text };
      const updated = customPrompts.map((p) =>
        p.id === editingPromptId ? targetPrompt : p
      );
      persistCustomPrompts(updated);
    } else {
      targetPrompt = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        prompt: text,
      };
      persistCustomPrompts([...customPrompts, targetPrompt]);
    }

    setShowNewPromptForm(false);
    setEditingPromptId(null);
    setNewPromptName("");
    setNewPromptText("");

    // Automatically select & apply newly saved prompt
    handleSelectPrompt(targetPrompt);
  };

  const deleteCustomPrompt = (id: string) => {
    const nextList = customPrompts.filter((p) => p.id !== id);
    persistCustomPrompts(nextList);
    if (activePromptId === id) {
      handleSelectPrompt(null);
    }
  };

  const handleDocumentLoad = (pdf: any) => {
    setNumPages(pdf.numPages);
    setPdfDocProxy(pdf);
  };

  const FLIP_DURATION_MS = 400;

  const changePageWithFlip = (targetPage: number, direction: "next" | "prev") => {
    if (flipTimeoutRef.current) clearTimeout(flipTimeoutRef.current);
    if (flipSwapTimeoutRef.current) clearTimeout(flipSwapTimeoutRef.current);

    setFlipClass("");
    requestAnimationFrame(() => {
      setFlipClass(direction === "next" ? "page-flip-next" : "page-flip-prev");
    });

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

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartXRef.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartXRef.current;
    touchStartXRef.current = null;
    if (Math.abs(deltaX) < 70) return;
    if (deltaX < 0) nextPage();
    else previousPage();
  };

  const handleDeleteBookForever = useCallback(async () => {
    if (!book || deleting) return;
    const confirmed = window.confirm(
      `Delete "${book.name}" permanently? This removes all cached extractions and AI responses.`
    );
    if (!confirmed) return;

    setDeleting(true);
    cancelOngoingAIRequest();

    try {
      const db = await getDB();
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
          } catch {}
          localStorage.removeItem(extractionKey);

          for (const lang of SUPPORTED_OUTPUT_LANGS) {
            const aiKey = `page_ai_${book.name}_p${p}_${lang}_${ocrOpt.value}_${activePromptId || "base"}`;
            try {
              if (db.objectStoreNames.contains("ai_translations")) {
                await db.delete("ai_translations", aiKey);
              }
            } catch {}
            localStorage.removeItem(aiKey);
          }
        }
      }
    } catch (err) {
      console.error(err);
      alert("Error deleting book.");
      setDeleting(false);
      return;
    }

    router.push("/");
  }, [book, deleting, numPages, cancelOngoingAIRequest, activePromptId, router]);

  // Refresh Page: clears cache and re-runs OCR & AI directly
  const handleRefreshPage = useCallback(async () => {
    cancelOngoingAIRequest();
    await clearCachedData(currentPage);
    await clearCachedAIDataForPage(currentPage);
    setResultText("");
    lastAutoTriggeredRef.current = "";
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

  if (!book || !Document || !Page) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-orange-50 text-stone-500">
        Loading reader...
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-orange-50 select-none">
      {/* Top Header */}
      <header className="z-30 flex-shrink-0 border-b border-orange-200/80 bg-orange-50/95 backdrop-blur px-3 py-1.5 sm:px-4 sm:py-2">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/"
              className="shrink-0 text-xs font-semibold text-orange-800 hover:text-orange-950 sm:text-sm"
            >
              ← Library
            </Link>
            <span className="text-stone-300">|</span>
            <h1 className="truncate text-xs font-semibold text-stone-800 sm:text-base">
              {book.name}
            </h1>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Desktop toolbar */}
            <div className="hidden md:flex items-center gap-2">
              <select
                value={selectedOcrLang}
                onChange={(e) => setSelectedOcrLang(e.target.value as "eng" | "ara" | "eng+ara")}
                className="rounded-md border border-orange-300 bg-white px-2 py-1 text-xs text-stone-700 outline-none"
              >
                {OCR_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    OCR: {opt.label}
                  </option>
                ))}
              </select>

              <select
                value={outputLanguage}
                onChange={(e) => handleLanguageChange(e.target.value)}
                className="rounded-md border border-orange-300 bg-white px-2 py-1 text-xs text-stone-700 outline-none"
              >
                {SUPPORTED_OUTPUT_LANGS.map((lang) => (
                  <option key={lang} value={lang}>
                    To: {lang}
                  </option>
                ))}
              </select>

              <button
                onClick={toggleContinuousMode}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  continuousMode
                    ? "bg-orange-700 text-white"
                    : "bg-orange-100 text-orange-800 hover:bg-orange-200"
                }`}
              >
                {continuousMode ? "Continuous: ON" : "Continuous: OFF"}
              </button>

              <button
                onClick={togglePdfVisible}
                className="rounded-md bg-orange-100 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-200"
              >
                {pdfVisible ? "Hide PDF" : "Show PDF"}
              </button>

              {/* Refresh Button */}
              <button
                onClick={handleRefreshPage}
                disabled={ocrLoading}
                className="rounded-md bg-orange-100 px-2.5 py-1 text-xs font-medium text-orange-800 hover:bg-orange-200 disabled:opacity-50"
                title="Re-run OCR and regeneration for current page"
              >
                ↻ Refresh Page
              </button>
            </div>

            {/* Prompt Drawer Trigger */}
            <button
              onClick={() => setMobileMenuOpen(true)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                activePromptId
                  ? "bg-orange-600 text-white shadow-sm"
                  : "bg-orange-100 text-orange-900 hover:bg-orange-200"
              }`}
              aria-label="Open menu"
            >
              <span>Prompts & Settings</span>
              {activePromptId && (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Split-Pane Workspace */}
      <main
        ref={mainContainerRef as any}
        className="relative flex flex-1 flex-col md:flex-row overflow-hidden min-h-0"
      >
        {/* PDF Document Pane */}
        {pdfVisible && (
          <div
            style={{
              width: typeof window !== "undefined" && window.innerWidth >= 768 ? `${splitPercent}%` : "100%",
              height: typeof window !== "undefined" && window.innerWidth < 768 ? `${splitHeightPx}px` : "100%",
            }}
            className="flex flex-col border-b md:border-b-0 md:border-r border-orange-200 bg-stone-100 min-h-0 overflow-hidden shrink-0 select-auto"
          >
            <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-2 py-1 text-[11px] text-stone-600 shrink-0">
              <span className="font-semibold uppercase tracking-wider text-[10px] text-stone-500">
                PDF · {currentExtractionType === "pdf-text" ? "Embedded text" : "OCR"}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPdfZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
                  className="rounded bg-white px-1.5 py-0.5 shadow-sm hover:bg-stone-200"
                >
                  −
                </button>
                <span className="w-8 text-center">{Math.round(pdfZoom * 100)}%</span>
                <button
                  onClick={() => setPdfZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}
                  className="rounded bg-white px-1.5 py-0.5 shadow-sm hover:bg-stone-200"
                >
                  +
                </button>
              </div>
            </div>

            <div
              ref={pdfContainerRef}
              className="flex-1 overflow-auto p-2 touch-pan-x touch-pan-y"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex min-h-full items-start justify-center">
                <Document
                  file={book.file}
                  onLoadSuccess={handleDocumentLoad}
                  loading={<div className="p-4 text-xs text-stone-400">Loading page...</div>}
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

        {/* LeetCode Style Splitter Handle */}
        {pdfVisible && (
          <div
            onMouseDown={startResizing}
            onTouchStart={startResizing}
            className="group relative z-20 flex shrink-0 cursor-row-resize md:cursor-col-resize items-center justify-center bg-orange-200 hover:bg-orange-400 transition-colors h-2 md:h-full md:w-2"
          >
            <div className="h-1 w-6 md:h-6 md:w-1 rounded-full bg-orange-400 group-hover:bg-orange-700 transition-colors" />
          </div>
        )}

        {/* Reading Surface */}
        <div
          className={`flex flex-1 flex-col min-h-0 bg-white select-text overflow-hidden ${flipClass}`}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Quick Task Bar */}
          <div className="flex shrink-0 items-center justify-between border-b border-orange-100 bg-orange-50/40 px-3 py-1.5 sm:px-4">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleAITask("translation")}
                disabled={aiLoading || !ocrText}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  activeAITab === "translation"
                    ? "bg-orange-600 text-white shadow-sm"
                    : "bg-white text-stone-700 hover:bg-orange-100 border border-orange-200"
                }`}
              >
                Translate
              </button>

              <button
                onClick={() => handleAITask("explanation")}
                disabled={aiLoading || !ocrText}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  activeAITab === "explanation"
                    ? "bg-amber-600 text-white shadow-sm"
                    : "bg-white text-stone-700 hover:bg-orange-100 border border-orange-200"
                }`}
              >
                Explain
              </button>
            </div>

            <span className="text-[10px] sm:text-xs text-stone-500 font-medium">
              {outputLanguage}
            </span>
          </div>

          {/* AI Content Area */}
          <div
            ref={contentScrollRef}
            className="flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6"
          >
            {ocrLoading ? (
              <p className="text-center text-xs text-stone-400 mt-8">Scanning and extracting page text...</p>
            ) : aiLoading ? (
              <p className="animate-pulse text-center text-xs text-stone-400 mt-8">
                Processing {activeAITab === "translation" ? "Translation" : "Explanation"}...
              </p>
            ) : (
              <div
                dir={
                  outputLanguage === "Same as original"
                    ? detectDirection(resultText)
                    : RTL_OUTPUT_LANGUAGES.has(outputLanguage)
                    ? "rtl"
                    : "ltr"
                }
                className="font-serif text-sm sm:text-base leading-relaxed text-stone-800 whitespace-pre-wrap break-words"
              >
                {resultText || "No content generated for this page."}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Ultra-Compact Bottom Navigation */}
      <footer className="z-30 flex-shrink-0 border-t border-orange-200/90 bg-orange-50/95 px-3 py-1 sm:px-4 backdrop-blur pb-[max(0.35rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-sm items-center justify-between gap-3">
          <button
            onClick={previousPage}
            disabled={currentPage <= 1}
            className="flex h-8 items-center justify-center rounded-lg bg-white px-3 text-xs font-medium text-stone-700 shadow-sm border border-orange-200 active:bg-orange-100 disabled:opacity-30"
          >
            ← Prev
          </button>

          <div className="flex items-center gap-1.5 text-xs text-stone-600">
            <input
              type="number"
              min="1"
              max={numPages}
              value={gotoPage}
              onChange={(e) => setGotoPage(e.target.value)}
              onBlur={goToPage}
              onKeyDown={(e) => e.key === "Enter" && goToPage()}
              className="h-7 w-11 rounded border border-orange-300 bg-white text-center text-xs font-semibold outline-none focus:border-orange-600"
            />
            <span className="text-stone-400">/ {numPages || "…"}</span>
          </div>

          <button
            onClick={nextPage}
            disabled={currentPage >= numPages}
            className="flex h-8 items-center justify-center rounded-lg bg-orange-600 px-3 text-xs font-medium text-white shadow-sm hover:bg-orange-700 active:bg-orange-800 disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      </footer>

      {/* Slide-out Drawer: Custom Prompts + Preferences */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />

          <div className="relative ml-auto flex h-full w-full max-w-md flex-col bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-stone-200 pb-3">
              <h2 className="text-sm font-semibold text-stone-800">Settings & Custom Prompts</h2>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 space-y-4">
              {/* Mobile Quick Config */}
              <div className="space-y-2 border-b border-stone-100 pb-3 md:hidden">
                <span className="text-[11px] font-bold uppercase tracking-wider text-stone-400">
                  Settings
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-stone-500">OCR Language</label>
                    <select
                      value={selectedOcrLang}
                      onChange={(e) => setSelectedOcrLang(e.target.value as any)}
                      className="w-full rounded border border-stone-200 p-1.5 text-xs"
                    >
                      {OCR_LANGUAGE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-stone-500">Output Language</label>
                    <select
                      value={outputLanguage}
                      onChange={(e) => handleLanguageChange(e.target.value)}
                      className="w-full rounded border border-stone-200 p-1.5 text-xs"
                    >
                      {SUPPORTED_OUTPUT_LANGS.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={toggleContinuousMode}
                    className={`flex-1 rounded py-1 text-xs font-medium ${
                      continuousMode ? "bg-orange-600 text-white" : "bg-stone-100 text-stone-700"
                    }`}
                  >
                    Continuous: {continuousMode ? "ON" : "OFF"}
                  </button>
                  <button
                    onClick={togglePdfVisible}
                    className="flex-1 rounded bg-stone-100 py-1 text-xs font-medium text-stone-700"
                  >
                    {pdfVisible ? "Hide PDF" : "Show PDF"}
                  </button>
                </div>

                {/* Mobile Refresh Button */}
                <button
                  onClick={() => {
                    handleRefreshPage();
                    setMobileMenuOpen(false);
                  }}
                  disabled={ocrLoading}
                  className="w-full rounded bg-orange-100 py-1.5 text-xs font-medium text-orange-800 hover:bg-orange-200 disabled:opacity-50"
                >
                  ↻ Refresh Page
                </button>
              </div>

              {/* Custom Prompts (Applied in conjunction with Translation/Explanation) */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-stone-400">
                    Active Prompt Directives
                  </span>
                  <button
                    onClick={() => {
                      setEditingPromptId(null);
                      setNewPromptName("");
                      setNewPromptText("");
                      setShowNewPromptForm(true);
                    }}
                    className="text-xs font-semibold text-orange-600 hover:text-orange-700"
                  >
                    + Add New
                  </button>
                </div>

                {/* Default: Standard translation/explanation */}
                <div
                  onClick={() => handleSelectPrompt(null)}
                  className={`group relative flex flex-col gap-0.5 rounded-lg border p-2.5 mb-2 cursor-pointer transition ${
                    activePromptId === null
                      ? "border-orange-500 bg-orange-50/70 ring-1 ring-orange-500"
                      : "border-stone-200 bg-white hover:border-orange-200 hover:bg-orange-50/20"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-stone-800 flex items-center gap-1.5">
                      <span className={`inline-block h-2 w-2 rounded-full ${activePromptId === null ? "bg-orange-600" : "bg-stone-300"}`} />
                      Standard (Default)
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-500">
                    Pure translation or explanation with no extra directives.
                  </p>
                </div>

                <div className="space-y-2">
                  {customPrompts.map((p) => {
                    const isSelected = activePromptId === p.id;
                    return (
                      <div
                        key={p.id}
                        onClick={() => handleSelectPrompt(p)}
                        className={`group relative flex flex-col gap-1 rounded-lg border p-2.5 cursor-pointer transition ${
                          isSelected
                            ? "border-orange-500 bg-orange-50/70 ring-1 ring-orange-500"
                            : "border-stone-200 bg-white hover:border-orange-200 hover:bg-orange-50/20"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-stone-800 flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${isSelected ? "bg-orange-600" : "bg-stone-300"}`} />
                            {p.name}
                          </span>

                          <div
                            className="flex items-center gap-2 text-[11px]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() => {
                                setEditingPromptId(p.id);
                                setNewPromptName(p.name);
                                setNewPromptText(p.prompt);
                                setShowNewPromptForm(true);
                              }}
                              className="text-stone-400 hover:text-stone-700"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => deleteCustomPrompt(p.id)}
                              className="text-red-400 hover:text-red-600"
                            >
                              Delete
                            </button>
                          </div>
                        </div>

                        <p className="line-clamp-2 text-[11px] text-stone-500 pr-2">
                          {p.prompt}
                        </p>
                      </div>
                    );
                  })}
                </div>

                {/* Inline Prompt Form */}
                {showNewPromptForm && (
                  <div className="mt-3 space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3">
                    <span className="text-xs font-semibold text-stone-700">
                      {editingPromptId ? "Edit Prompt" : "New Prompt"}
                    </span>
                    <input
                      type="text"
                      placeholder="Prompt Title (e.g., Simple Language, Add Notes)"
                      value={newPromptName}
                      onChange={(e) => setNewPromptName(e.target.value)}
                      className="w-full rounded border border-stone-200 bg-white p-1.5 text-xs outline-none focus:border-orange-500"
                    />
                    <textarea
                      rows={3}
                      placeholder="Instructions sent along with translation/explanation..."
                      value={newPromptText}
                      onChange={(e) => setNewPromptText(e.target.value)}
                      className="w-full rounded border border-stone-200 bg-white p-1.5 text-xs outline-none focus:border-orange-500"
                    />
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={savePromptForm}
                        disabled={!newPromptName.trim() || !newPromptText.trim()}
                        className="flex-1 rounded bg-orange-600 py-1 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
                      >
                        Save & Apply
                      </button>
                      <button
                        onClick={() => setShowNewPromptForm(false)}
                        className="flex-1 rounded bg-stone-200 py-1 text-xs font-medium text-stone-700 hover:bg-stone-300"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Danger Zone */}
              <div className="pt-4 border-t border-stone-200">
                <button
                  onClick={handleDeleteBookForever}
                  disabled={deleting}
                  className="w-full rounded bg-red-50 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
                >
                  {deleting ? "Deleting Book..." : "Permanently Delete Book"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Book;