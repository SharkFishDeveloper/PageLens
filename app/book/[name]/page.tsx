"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getDB } from "@/lib/idb";
import { Book as BookType } from "@/interface";

const Book = () => {
  const params = useParams();

  const [book, setBook] = useState<BookType | null>(null);
  const [error, setError] = useState("");

  const [PDFComponents, setPDFComponents] = useState<{
    Document: any;
    Page: any;
  } | null>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [gotoPage, setGotoPage] = useState("1");

  // Load PDF reader only in browser
  useEffect(() => {
    const loadPDF = async () => {
      const { Document, Page, pdfjs } = await import("react-pdf");

      pdfjs.GlobalWorkerOptions.workerSrc =
        `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

      setPDFComponents({
        Document,
        Page,
      });
    };

    loadPDF();
  }, []);

  // Get book from IndexedDB
  useEffect(() => {
    const loadBook = async () => {
      const db = await getDB();
      const books = await db.getAll("books");

      const bookName = Array.isArray(params.name)
        ? params.name[0]
        : params.name;

      if (!bookName) {
        setError("Something went wrong...");
        return;
      }

      const foundBook = books.find(
        (item) =>
          item.name.replace(/\.pdf$/i, "") ===
          bookName.replace(/\.pdf$/i, "")
      );

      if (foundBook) {
        setBook(foundBook);
      } else {
        setError("Book not found");
      }
    };

    loadBook();
  }, [params.name]);

  const handleDocumentLoad = ({
    numPages,
  }: {
    numPages: number;
  }) => {
    setNumPages(numPages);
  };

  const previousPage = () => {
    if (currentPage > 1) {
      const previous = currentPage - 1;
      setCurrentPage(previous);
      setGotoPage(String(previous));
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
    return <div>{error}</div>;
  }

  if (!book) {
    return <div>Loading book...</div>;
  }

  if (!Document || !Page) {
    return <div>Loading PDF reader...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-100 p-5">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-5 text-2xl font-bold">
          {book.name}
        </h1>

        {/* Navigation */}
        <div className="mb-4 flex items-center justify-center gap-4">
          <button
            onClick={previousPage}
            disabled={currentPage === 1}
            className="rounded-full p-2 text-xl hover:bg-gray-200 disabled:opacity-30"
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
                if (e.key === "Enter") {
                  goToPage();
                }
              }}
              className="w-14 rounded-lg border border-gray-300 bg-white px-2 py-1 text-center outline-none focus:border-gray-500"
            />

            <span className="text-gray-500">
              / {numPages || "..."}
            </span>
          </div>

          <button
            onClick={nextPage}
            disabled={currentPage === numPages}
            className="rounded-full p-2 text-xl hover:bg-gray-200 disabled:opacity-30"
            title="Next page"
          >
            →
          </button>
        </div>

        {/* PDF */}
        <div className="flex justify-center overflow-auto rounded-xl bg-gray-200 p-5">
          <Document
            file={book.file}
            onLoadSuccess={handleDocumentLoad}
            loading={<div>Loading PDF...</div>}
            error={<div>Could not load PDF</div>}
          >
            <Page
              pageNumber={currentPage}
              width={800}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          </Document>
        </div>
      </div>
    </div>
  );
};

export default Book;