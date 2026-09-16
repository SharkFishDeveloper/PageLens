'use client'
import { Book } from "@/interface";
import { getDB } from "@/lib/idb";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Menu, ArrowLeft, X, ChevronLeft, ChevronRight, RefreshCw, FileText, Settings, Trash2, Pencil } from "lucide-react";
import { defaultPrompt, Prompt } from "@/lib/defaultPrompt";
import {
  Group,
  Panel,
  Separator,
} from "react-resizable-panels";
import BookOcrTextComponent from "@/components/BookOcrTextComponent";

const SingleBook = () => {

  const params = useParams();
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [openMenu, setOpenMenu] = useState(false);

  const [lang, setLang] = useState("ara")
  const [ailang, setAiLang] = useState("eng")

  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [allprompt, setallPrompt] = useState<Prompt[] | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
  const [promptInput, setPromptInput] = useState("");

  const [showPdf, setShowPdf] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [pdfDoc, setPdfDoc] = useState<any>(null);

  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [pageInput, setPageInput] = useState(pageNumber);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfWidth, setPdfWidth] = useState(600);
  const pdfContainerRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    const element = pdfContainerRef.current;
    if (!element) return;

    const updateWidth = () => {
      setPdfWidth(element.clientWidth - 24);
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);


  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [])

  useEffect(() => {
    async function loadBooks() {
      const db = await getDB();
      const books = await db.getAll("books");
      const bookName = decodeURIComponent(params.name as string);
      const foundBook = books.find((book) => book.name === bookName)
      if (!foundBook) {
        alert("Book not found");
        setTimeout(() => {
          router.push("/")
        }, 2000)
        return
      }
      setBook(foundBook);
    }

    async function getPrompt() {
      let prompts = localStorage.getItem("prompts");
      if (!prompts) {
        prompts = JSON.stringify(defaultPrompt);
        localStorage.setItem("prompts", prompts)
      }
      const parsedPrompts: Prompt[] = JSON.parse(prompts);
      const mainPrompt = parsedPrompts.find((prompt) => prompt.isMain === true)
      if (!mainPrompt) {
        throw new Error("No main prompt found");
      }
      setallPrompt(parsedPrompts);
      setPrompt(mainPrompt);
      setPromptInput(mainPrompt.prompt);
    }


    loadBooks();
    getPrompt();
  }, [])

  useEffect(() => {
    async function getPageNumber() {
      if (!book) return;
      const pageNum = localStorage.getItem(`book-${book.name}`);
      const pageNumInt = pageNum ? parseInt(pageNum, 10) : 1;
      console.log("pageNum", pageNumInt)
      setPageNumber(pageNumInt)
      setPageInput(pageNumInt)
    }
    getPageNumber();
  }, [book])

  useEffect(() => {
    if (!book) return;

    const getPageCount = async () => {
      const url = URL.createObjectURL(book.file);

      try {
        const { pdfjs } = await import("react-pdf");

        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();

        const pdf = await pdfjs.getDocument(url).promise;

        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    getPageCount();
  }, [book]);


  const [PDFComponents, setPDFComponents] = useState<{
    Document: typeof import("react-pdf").Document;
    Page: typeof import("react-pdf").Page;
  } | null>(null);

  useEffect(() => {
    import("react-pdf").then((mod) => {
      setPDFComponents({
        Document: mod.Document,
        Page: mod.Page,
      });
    });
  }, []);


  if (!book) {
    return <p>Book not found</p>;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-white px-3 shadow-sm sm:px-5">
        {/* Back Button */}
        <button
          onClick={() => router.push("/")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg p-2
               text-gray-600 transition-colors
               hover:bg-gray-100 hover:text-gray-900"
          aria-label="Go back"
        >
          <ArrowLeft size={18} />
          <span className="hidden text-sm font-medium sm:block">
            Back
          </span>
        </button>

        {/* Divider */}
        <div className="hidden h-6 w-px bg-gray-200 sm:block" />

        {/* Book Title */}
        <div className="min-w-0 flex-1 px-1 sm:px-3">
          <h1
            className="truncate text-center text-sm font-semibold
                 text-gray-800 sm:text-base"
            title={book.name}
          >
            {book.name}
          </h1>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Show PDF */}

          {/* Refresh */}
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg p-2 text-gray-600 transition-colors
                 hover:bg-gray-100 hover:text-gray-900"
            aria-label="Refresh page"
            title="Refresh page"
          >
            <RefreshCw size={17} />
          </button>

          <button
            onClick={() => setShowPdf((p) => !p)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2
                  text-sm font-medium transition-colors
                  ${showPdf
                ? "bg-blue-50 text-blue-600"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            aria-label={showPdf ? "Hide PDF" : "Show PDF"}
          >
            <FileText size={17} />
            <span className="hidden md:inline">
              {showPdf ? "Hide PDF" : "Show PDF"}
            </span>
          </button>
          {/* Menu */}
          <div className="relative">
            <button
              onClick={() => setOpenMenu((p) => !p)}
              className="rounded-lg p-2 text-gray-600 transition-colors
                   hover:bg-gray-100 hover:text-gray-900"
              aria-label="Open menu"
              aria-expanded={openMenu}
            >
              {openMenu ? <X size={19} /> : <Menu size={19} />}
            </button>

            {/* Menu content unchanged */}
          </div>
        </div>
      </header>

      {/* Menu */}
      <div className="relative">
        {/* Centered Menu Modal */}
        {openMenu && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setOpenMenu(false)}
            />

            {/* Menu Panel */}
            <div
              className="relative z-10 w-full max-w-lg rounded-2xl
                   border border-gray-200 bg-white p-6 shadow-2xl
                   sm:p-8"
            >
              {/* Header */}
              <div className="flex w-full flex-col gap-4 rounded-xl border border-gray-100 p-4">

                {/* Header */}
                <div className="flex items-center gap-3">
                  <FileText size={21} className="shrink-0 text-gray-600" />

                  <div>
                    <p className="font-medium text-gray-900">
                      AI Prompts
                    </p>
                    <p className="text-xs text-gray-500">
                      Select, edit, or delete your prompts
                    </p>
                  </div>
                </div>

                {/* Prompt Input */}
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-gray-700">
                    Selected Prompt
                  </label>

                  <textarea
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    placeholder="Enter your prompt..."
                    rows={4}
                    className="w-full resize-y rounded-lg border border-gray-200
                      px-3 py-2 text-sm outline-none transition
                      focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />

                  <button
                    onClick={() => {
                      if (!prompt) return;
                      const updatedPrompts = (allprompt ?? []).map((item) =>
                        item.id === prompt.id
                          ? { ...item, prompt: promptInput }
                          : item
                      );

                      localStorage.setItem(
                        "prompts",
                        JSON.stringify(updatedPrompts)
                      );

                      setallPrompt(updatedPrompts);
                      setPrompt({
                        ...prompt,
                        prompt: promptInput,
                      });
                    }}
                    className="self-end rounded-lg bg-blue-600 px-4 py-2
                    text-sm font-medium text-white transition
                    hover:bg-blue-700"
                  >
                    Save Prompt
                  </button>
                </div>

                {/* Prompt List */}
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold text-gray-800">
                    Available Prompts
                  </p>

                  {(allprompt ?? []).map((item) => (
                    <div
                      key={item.id}
                      className={`flex items-start gap-3 rounded-lg border p-3
          transition ${prompt?.id === item.id
                          ? "border-blue-300 bg-blue-50"
                          : "border-gray-200 hover:bg-gray-50"
                        }`}
                    >
                      {/* Select Prompt */}
                      <button
                        onClick={() => {
                          setPrompt(item);
                          setPromptInput(item.prompt);
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-800">
                            {item.isMain ? "Default Prompt" : "Custom Prompt"}
                          </p>

                          {item.isMain && (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5
                               text-[10px] font-medium text-blue-700">
                              Main
                            </span>
                          )}
                        </div>

                        <p className="mt-1 line-clamp-2 text-xs text-gray-500">
                          {item.prompt}
                        </p>
                      </button>

                      {/* Actions */}
                      <div className="flex shrink-0 items-center gap-1">
                        {/* Edit */}
                        <button
                          onClick={() => {
                            setPrompt(item);
                            setPromptInput(item.prompt);
                            setEditingPrompt(item);
                          }}
                          className="rounded-md p-2 text-gray-500
                       hover:bg-gray-200 hover:text-gray-900"
                          aria-label="Edit prompt"
                        >
                          <Pencil size={16} />
                        </button>

                        {/* Delete */}
                        {!item.isMain && (
                          <button
                            onClick={() => {
                              const updatedPrompts = (allprompt ?? []).filter(
                                (p) => p.id !== item.id
                              );

                              localStorage.setItem(
                                "prompts",
                                JSON.stringify(updatedPrompts)
                              );

                              setallPrompt(updatedPrompts);

                              if (prompt?.id === item.id) {
                                const mainPrompt = updatedPrompts.find(
                                  (p) => p.isMain
                                );

                                setPrompt(mainPrompt ?? null);
                                setPromptInput(mainPrompt?.prompt ?? "");
                              }
                            }}
                            className="rounded-md p-2 text-red-500
                         hover:bg-red-50 hover:text-red-700"
                            aria-label="Delete prompt"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                </div>
              </div>

              {/* Menu Items */}
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => setOpenMenu(false)}
                  className="flex w-full items-center gap-4 rounded-xl
                       border border-gray-100 px-4 py-4 text-left
                       text-gray-700 transition-colors
                       hover:bg-gray-50"
                >
                </button>
                {/* OCR Language */}
                <div className="rounded-xl border border-gray-100 p-4">
                  <label
                    htmlFor="ocr-language"
                    className="mb-2 block text-sm font-medium text-gray-700"
                  >
                    OCR Language
                  </label>

                  <select
                    id="ocr-language"
                    value={lang}
                    onChange={(e) => setLang(e.target.value)}
                    className="w-full rounded-lg border border-gray-200
                 bg-white px-3 py-2.5 text-sm text-gray-700
                 outline-none focus:border-blue-500
                 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="ara">Arabic</option>
                    <option value="eng">English</option>
                  </select>

                  <p className="mt-1.5 text-xs text-gray-500">
                    Language used to recognize text from the PDF.
                  </p>
                </div>

                {/* AI Translation Language */}
                <div className="rounded-xl border border-gray-100 p-4">
                  <label
                    htmlFor="ai-language"
                    className="mb-2 block text-sm font-medium text-gray-700"
                  >
                    AI Translation Language
                  </label>

                  <select
                    id="ai-language"
                    value={ailang}
                    onChange={(e) => setAiLang(e.target.value)}
                    className="w-full rounded-lg border border-gray-200
                 bg-white px-3 py-2.5 text-sm text-gray-700
                 outline-none focus:border-blue-500
                 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="eng">English</option>
                    <option value="ara">Arabic</option>
                    <option value="hin">Hindi</option>
                  </select>

                  <p className="mt-1.5 text-xs text-gray-500">
                    Language the AI will translate the text into.
                  </p>
                </div>

                {/* Close Menu */}
                <button
                  onClick={() => setOpenMenu(false)}
                  className="w-full rounded-xl bg-blue-600 px-4 py-3
               text-sm font-medium text-white transition
               hover:bg-blue-700"
                >
                  Save & Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        <Group orientation={isMobile ? "vertical" : "horizontal"}>
          {!showPdf && (
            <>
              <Panel defaultSize="50" minSize="20">
                <div
                  ref={pdfContainerRef}
                  className="relative h-full overflow-auto bg-gray-200"
                >
                  {/* Zoom controls */}
                  <div className="absolute right-3 top-3 z-10 flex items-center rounded-md border border-gray-200 bg-white/95 shadow-sm">
                    <button
                      onClick={() =>
                        setPdfScale((s) => Math.max(0.5, s - 0.1))
                      }
                      className="flex h-7 w-7 items-center justify-center text-sm text-gray-600 hover:bg-gray-100"
                    >
                      −
                    </button>

                    <span className="w-12 text-center text-[11px] font-medium text-gray-500">
                      {Math.round(pdfScale * 100)}%
                    </span>

                    <button
                      onClick={() =>
                        setPdfScale((s) => Math.min(2, s + 0.1))
                      }
                      className="flex h-7 w-7 items-center justify-center text-sm text-gray-600 hover:bg-gray-100"
                    >
                      +
                    </button>
                  </div>

                  {PDFComponents && (
                    <PDFComponents.Document
                      file={book.file}
                      onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                      loading="Loading PDF..."
                    >
                      <div className="flex justify-center">
                        <PDFComponents.Page
                          pageNumber={pageNumber}
                          width={pdfWidth * pdfScale}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                        />
                      </div>
                    </PDFComponents.Document>
                  )}
                </div>
              </Panel>

              <Separator
                className={
                  isMobile
                    ? "h-1.5 w-12 self-center rounded-full bg-gray-300"
                    : "h-12 w-1.5 self-center rounded-full bg-gray-300"
                }
              />
            </>
          )}

          {/* Main Panel Component */}
          <Panel defaultSize="55" minSize="40">
            <div className="h-full overflow-auto bg-gray-400">
              <BookOcrTextComponent book={book} pageNumber={pageNumber} lang={lang} aiLang={ailang} pdfDoc={pdfDoc} numPages={numPages} />
            </div>
          </Panel>
        </Group>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-center gap-1 border-t bg-white p-1 shadow-sm">
        <button
          onClick={() => {
            const page = Math.max(1, pageNumber - 1);
            localStorage.setItem(`book-${book.name}`, page.toString())
            setPageNumber(page);
            setPageInput(page);
          }}
          disabled={pageNumber === 1}
          className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 disabled:opacity-30"
        >
          <ChevronLeft size={18} />
        </button>

        <input
          type="number"
          min={1}
          max={numPages}
          value={pageInput}
          onChange={(e) => {
            setPageInput(Number(e.target.value))
            localStorage.setItem(`book-${book.name}`, Number(e.target.value).toString())
          }}

          className="w-12 border-0 bg-transparent text-center text-sm font-medium outline-none"
        />

        {Number(pageInput) !== pageNumber && (
          <button
            onClick={() => {
              const page = Math.min(
                numPages,
                Math.max(1, Number(pageInput) || 1)
              );

              setPageNumber(page);
              setPageInput(page);
              localStorage.setItem(`book-${book.name}`, page.toString())
            }}
            className="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-gray-700"
          >
            Go
          </button>
        )}

        <span className="mr-1 text-xs text-gray-400">
          / {numPages}
        </span>

        <button
          onClick={() => {
            const page = Math.min(numPages, pageNumber + 1);
            setPageNumber(page);
            setPageInput(page);
            localStorage.setItem(`book-${book.name}`, page.toString())
          }}
          disabled={pageNumber === numPages}
          className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 disabled:opacity-30"
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
export default SingleBook;