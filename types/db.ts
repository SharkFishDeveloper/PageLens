import { openDB, DBSchema, IDBPDatabase } from "idb";
import { Book } from "@/interface";

export type PageDataType =
  | "ocr"
  | "explanation"
  | "summary";

export interface PageExtraction {
  id: string;
  bookId: string;
  pageNumber: number;
  type: PageDataType;
  lang: string;
  text: string;
}

export interface AITranslation {
  id: string;
  bookId: string;
  pageNumber: number;
  type: "explanation" | "summary";
  lang: string;
  text: string;
}