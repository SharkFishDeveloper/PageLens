"use client";

import { useEffect, useState } from "react";

import { Book } from "@/interface";
import UploadBook from "@/components/UploadBooks";
import BookCard from "@/components/BookCard";
import { getDB } from "@/lib/idb";

const Home = () => {
  const [allBooks, setAllBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadBooks() {
      const db = await getDB();

      const books = await db.getAll("books");

      setAllBooks(books);
      setLoading(false);
    }

    loadBooks();
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 p-6 md:p-10">

      {/* Header */}
      <div className="mx-auto max-w-6xl">

        <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">

          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              My Library
            </h1>

            <p className="mt-1 text-gray-500">
              {allBooks.length} {allBooks.length === 1 ? "book" : "books"} in your library
            </p>
          </div>

          <UploadBook
            allBooks={allBooks}
            setAllBooks={setAllBooks}
          />

        </div>

        {/* Loading */}
        {loading && (
          <p className="text-gray-500">
            Loading books...
          </p>
        )}

        {/* Empty state */}
        {!loading && allBooks.length === 0 && (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-20 text-center">

            <div className="text-5xl">
              📚
            </div>

            <h2 className="mt-4 text-xl font-semibold">
              Your library is empty
            </h2>

            <p className="mt-2 text-gray-500">
              Upload a PDF to start building your library.
            </p>

          </div>
        )}

        {/* Books Grid */}
        {allBooks.length > 0 && (
          <div
            className="
              grid
              grid-cols-1
              gap-5
              sm:grid-cols-2
              lg:grid-cols-3
              xl:grid-cols-4
            "
          >
            {allBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                allBooks={allBooks}
                setAllBooks={setAllBooks}
              />
            ))}
          </div>
        )}

      </div>

    </main>
  );
};

export default Home;