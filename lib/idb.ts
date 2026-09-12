import { openDB } from "idb";

export function getDB() {
  return openDB("books-db", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", {
          keyPath: "id",
        });
      }
    },
  });
}