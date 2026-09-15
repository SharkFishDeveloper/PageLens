"use client";

import { Book } from "@/interface";
import { getDB } from "@/lib/idb";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BookOpen,
  Check,
  Pencil,
  Trash2,
  X,
} from "lucide-react";

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
  const title = book.name.replace(/\.pdf$/i, "");
  const sizeInMB = (book.size / 1024 / 1024).toFixed(2);

  const [rename, setRename] = useState(false);
  const [renameText, setRenameText] = useState(title);
  const [deleting, setDeleting] = useState(false);

  const [PDFComponents, setPDFComponents] = useState<{
    Document: any;
    Page: any;
  } | null>(null);

  useEffect(() => {
    import("react-pdf").then(({ Document, Page, pdfjs }) => {
      pdfjs.GlobalWorkerOptions.workerSrc =
        `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

      setPDFComponents({ Document, Page });
    });
  }, []);

  const handleRename = async () => {
    const newName = renameText.trim();
    if (!newName) return;

    const exists = allBooks.some(
      (b) =>
        b.id !== book.id &&
        b.name.replace(/\.pdf$/i, "").toLowerCase() ===
          newName.toLowerCase()
    );

    if (exists) {
      alert("A book with this name already exists");
      return;
    }

    const updatedBook: Book = {
      ...book,
      name: `${newName}.pdf`,
    };

    const db = await getDB();
    await db.put("books", updatedBook);

    setAllBooks((books) =>
      books.map((b) => (b.id === book.id ? updatedBook : b))
    );

    setRename(false);
  };

  const deleteTranslations = async () => {
    if (deleting) return;

    if (!confirm(`Delete all translations for "${title}"?`)) {
      return;
    }

    setDeleting(true);

    try {
      const db = await getDB();

      if (!db.objectStoreNames.contains("ai_translations")) {
        return;
      }

      const keys = await db.getAllKeys("ai_translations");
      const prefix = `page_ai_${book.name}_`;

      for (const key of keys) {
        if (
          typeof key === "string" &&
          key.startsWith(prefix)
        ) {
          await db.delete("ai_translations", key);
        }
      }
    } catch (error) {
      console.error("Failed to delete translations:", error);
      alert("Could not delete translations.");
    } finally {
      setDeleting(false);
    }
  };

  const Document = PDFComponents?.Document;
  const Page = PDFComponents?.Page;

  return (
    <div className="group overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-xl">
      <div className="flex h-72 items-center justify-center overflow-hidden bg-gray-100">
        {!Document || !Page ? (
          <span className="text-sm text-gray-400">
            Loading cover...
          </span>
        ) : (
          <Document
            file={book.file}
            loading={
              <span className="text-sm text-gray-400">
                Loading PDF...
              </span>
            }
            error={
              <span className="text-sm text-red-500">
                Could not load PDF
              </span>
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

      <div className="p-5">
        {rename ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") setRename(false);
              }}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500"
            />

            <button
              onClick={handleRename}
              className="rounded-lg bg-gray-900 p-2 text-white hover:bg-gray-700"
              title="Save"
            >
              <Check size={17} />
            </button>

            <button
              onClick={() => setRename(false)}
              className="rounded-lg border border-gray-200 p-2 text-gray-600 hover:bg-gray-50"
              title="Cancel"
            >
              <X size={17} />
            </button>
          </div>
        ) : (
          <h2 className="truncate text-lg font-semibold text-gray-900">
            {title}
          </h2>
        )}

        <p className="mt-2 text-sm text-gray-500">
          PDF · {sizeInMB} MB
        </p>

        <div className="mt-5 flex gap-2">
          <Link
            href={`/book/${encodeURIComponent(book.name)}`}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            <BookOpen size={16} />
            Open
          </Link>

          {!rename && (
            <button
              onClick={() => setRename(true)}
              className="rounded-xl border border-gray-200 p-2.5 text-gray-600 hover:bg-gray-50"
              title="Rename book"
            >
              <Pencil size={17} />
            </button>
          )}

          <button
            onClick={deleteTranslations}
            disabled={deleting}
            className="rounded-xl border border-red-200 p-2.5 text-red-500 hover:bg-red-50 disabled:opacity-50"
            title="Delete translations"
          >
            <Trash2 size={17} />
          </button>
        </div>

        <p className="mt-4 text-xs text-gray-400">
          Added{" "}
          {new Date(book.uploadedAt).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
};

export default BookCard;