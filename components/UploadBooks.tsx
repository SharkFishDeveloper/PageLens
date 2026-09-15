"use client";

import { Book } from "@/interface";
import { getDB } from "@/lib/idb";
import { Upload, X } from "lucide-react";
import { useRef, useState } from "react";

type UploadBookProps = {
  allBooks: Book[];
  setAllBooks: (
    value: Book[] | ((books: Book[]) => Book[])
  ) => void;
};

const UploadBook = ({
  allBooks,
  setAllBooks,
}: UploadBookProps) => {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];

    if (!file) return;

    setError(null);

    if (file.type !== "application/pdf") {
      setError("Please select a PDF file.");
      event.target.value = "";
      return;
    }

    const exists = allBooks.some(
      (book) => book.name.toLowerCase() === file.name.toLowerCase()
    );

    if (exists) {
      setError("A book with this name already exists.");
      event.target.value = "";
      return;
    }

    setUploading(true);

    try {
      const db = await getDB();

      const book: Book = {
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        size: file.size,
        file,
        uploadedAt: Date.now(),
      };

      await db.put("books", book);

      setAllBooks((books) => [...books, book]);
      event.target.value = "";
    } catch (err) {
      console.error("Upload failed:", err);
      setError("Could not upload the book. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        onChange={handleUpload}
        className="hidden"
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Upload size={17} />
        {uploading ? "Uploading..." : "Upload Book"}
      </button>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <span>{error}</span>

          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 hover:bg-red-50"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
};

export default UploadBook;