import { openDB, DBSchema, IDBPDatabase } from "idb";
import { Book } from "@/interface";
import { AITranslation, PageExtraction } from "@/types/db";

interface BooksDBSchema extends DBSchema {
  books: {
    key: string;
    value: Book;
  };
  page_extractions: {
    key: string;
    value: PageExtraction;
  };
  ai_task: {
    key: string;
    value: AITranslation;
  };
}

let dbPromise: Promise<IDBPDatabase<BooksDBSchema>> | null = null;

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<BooksDBSchema>("books-db", 2, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains("books")) {
          db.createObjectStore("books", {
            keyPath: "id",
          });
        }
        // Added in v2: page-level extraction cache (OCR / pdf-text results).
        if (!db.objectStoreNames.contains("page_extractions")) {
          db.createObjectStore("page_extractions");
        }
        // Added in v2: per-page, per-language AI translation/explanation cache.
        if (!db.objectStoreNames.contains("ai_task")) {
          db.createObjectStore("ai_task");
        }
      },
    });
  }
  return dbPromise;
}