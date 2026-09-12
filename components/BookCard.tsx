"use client";

import { Book } from "@/interface";
import { getDB } from "@/lib/idb";
import Link from "next/link";
import { useState, useEffect } from "react";

type BookCardProps = {
  book: Book;
  allBooks: Book[];
  setAllBooks: (
    value: Book[] | ((books: Book[]) => Book[])
  ) => void;
};

const BookCard = ({
  book,
  allBooks,
  setAllBooks,
}: BookCardProps) => {
  const sizeInMB = (book.size / 1024 / 1024).toFixed(2);

  const title = book.name.replace(/\.pdf$/i, "");

  const [rename, setRename] = useState(false);
  const [renameText, setRenameText] = useState(title);

  // Load PDF components only in browser
  const [PDFComponents, setPDFComponents] = useState<{
    Document: any;
    Page: any;
  } | null>(null);

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

  const handleRename = async () => {
    const newName = renameText.trim();

    if (!newName) return;

    // Check duplicate name
    const alreadyExists = allBooks.some(
      (b) =>
        b.id !== book.id &&
        b.name.replace(/\.pdf$/i, "").toLowerCase() ===
          newName.toLowerCase()
    );

    if (alreadyExists) {
      alert("A book with this name already exists");
      return;
    }

    // Create updated book
    const updatedBook: Book = {
      ...book,
      name: `${newName}.pdf`,
    };

    // Update IndexedDB
    const db = await getDB();
    await db.put("books", updatedBook);

    // Update Home state
    setAllBooks((books) =>
      books.map((b) =>
        b.id === book.id ? updatedBook : b
      )
    );

    setRename(false);
  };

  const Document = PDFComponents?.Document;
  const Page = PDFComponents?.Page;

  return (
    <div
      className="
        group
        overflow-hidden
        rounded-2xl
        border
        border-gray-200
        bg-white
        shadow-sm
        transition-all
        hover:-translate-y-1
        hover:shadow-xl
      "
    >
      {/* PDF FIRST PAGE / COVER */}
      <div
        className="
          flex
          h-72
          items-center
          justify-center
          overflow-hidden
          bg-gray-100
        "
      >
        {!Document || !Page ? (
          <div className="text-sm text-gray-400">
            Loading cover...
          </div>
        ) : (
          <Document
            file={book.file}
            loading={
              <div className="text-sm text-gray-400">
                Loading PDF...
              </div>
            }
            error={
              <div className="text-sm text-red-500">
                Could not load PDF
              </div>
            }
          >
            <Page
              pageNumber={1}
              width={230}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          </Document>
        )}
      </div>

      {/* BOOK INFORMATION */}
      <div className="p-5">
        {!rename ? (
          <h2 className="truncate text-lg font-semibold text-gray-900">
            {title}
          </h2>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              className="
                min-w-0
                flex-1
                rounded-lg
                border
                border-gray-300
                px-3
                py-2
                text-sm
                outline-none
              "
              autoFocus
            />

            <button
              onClick={handleRename}
              className="
                rounded-lg
                bg-blue-600
                px-3
                text-sm
                text-white
              "
            >
              Save
            </button>
          </div>
        )}

        <p className="mt-2 text-sm text-gray-500">
          PDF · {sizeInMB} MB
        </p>

        {/* ACTIONS */}
        <div className="mt-5 flex gap-2">
          <button
            className="
              flex-1
              rounded-xl
              bg-gray-900
              px-4
              py-2.5
              text-sm
              font-medium
              text-white
              transition
              hover:bg-gray-700
            "
          >
            <Link href={`/book/${book.name}`}>Open Book</Link>
          </button>

          {!rename && (
            <button
              onClick={() => setRename(true)}
              className="
                rounded-xl
                border
                border-gray-200
                px-4
                py-2.5
                text-sm
                font-medium
                text-gray-600
                hover:bg-gray-50
              "
            >
              Rename
            </button>
          )}
        </div>

        <p className="mt-4 text-xs text-gray-400">
          Added {new Date(book.uploadedAt).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
};

export default BookCard;