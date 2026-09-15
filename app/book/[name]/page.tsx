'use client'
import { Book } from "@/interface";
import { getDB } from "@/lib/idb";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Menu, ArrowLeft, X, ChevronLeft, ChevronRight } from "lucide-react";
import { defaultPrompt, Prompt } from "@/lib/defaultPrompt";
import {
  Group,
  Panel,
  Separator,
} from "react-resizable-panels";

const SingleBook = () => {

  const params = useParams();
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [openMenu, setOpenMenu] = useState(false);

  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [showPdf, setShowPdf] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

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
      setPrompt(mainPrompt)
    }


    loadBooks();
    getPrompt();
  }, [])

  useEffect(() => {
    async function getPageNumber() {
      if (!book) return;
      const pageNum = localStorage.getItem(`book-${book.name}`);
      console.log("pageNum", pageNum)
      const pageNumInt = pageNum ? parseInt(pageNum, 10) : 0;
      setPageNumber(pageNumInt)
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
      <header className="relative flex h-12 shrink-0 items-center border-gray px-3 shadow-sm sm:px-6">
        {/* Back */}
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-1 rounded-md p-1.5 text-gray-600 hover:bg-gray-100"
        >
          <ArrowLeft size={18} />
          <span className="hidden sm:block text-sm">Back</span>
        </button>

        {/* Title */}
        <p className="mx-3 flex-1 truncate text-center text-sm font-medium">
          {book.name}
        </p>

        <p
          className="mx-3 flex-1 cursor-pointer truncate text-center text-sm font-medium"
          onClick={() => setShowPdf((p) => !p)}
        >
          Show pdf
        </p>

        <p>Refresh page</p>

        {/* Menu */}
        <div className="relative">
          <button
            onClick={() => setOpenMenu((p) => !p)}
            className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100"
            aria-label="Open menu"
          >
            {openMenu ? <X size={20} /> : <Menu size={20} />}
          </button>

          {/* menu unchanged */}
        </div>
      </header>


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

          <Panel defaultSize="55" minSize="40">
            <div className="h-full overflow-auto bg-gray-400">
              Right panel
            </div>
          </Panel>
        </Group>
      </div>

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