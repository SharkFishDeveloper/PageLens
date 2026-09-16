'use client'
import { Book } from "@/interface"
import { useEffect, useState } from "react";
import { extractTextFromPage, PageTextResult } from "./ocrPage";

export type Prop = {
  book: Book,
  pageNumber: number,
  lang: string,
  aiLang: string
  pdfDoc: any;
  numPages: number
}

export type PagesProps = {
  currPageNo: number,
  prevCurrPageNo: null | number,
  nextPageNo: null | number,
  prevNextPageNo: null | number
}

const BookOcrTextComponent = ({ book, pageNumber, lang, aiLang, pdfDoc, numPages }: Prop) => {
  const [text, setText] = useState<PageTextResult[]>([]);
  const [left, setLeft] = useState<number | null>(-1);
  const [right, setRight] = useState<number | null>(-1);
  const [allPageNo, setAllPageNo] = useState<PagesProps>({
    currPageNo: pageNumber,
    prevCurrPageNo: null,
    nextPageNo: null,
    prevNextPageNo: null
  })

  useEffect(() => {
    let currPageNo = pageNumber;
    let forwardPageNoInParallel: number | null = pageNumber + 2;
    if (forwardPageNoInParallel > numPages) {
      forwardPageNoInParallel = null;
    }
    let currPageNoPrevPage = currPageNo - 1;
    let forwardPageNoInParallelPrevPage = forwardPageNoInParallel ? forwardPageNoInParallel - 1 : null;
    setAllPageNo({
      currPageNo: pageNumber,
      prevCurrPageNo: currPageNoPrevPage,
      nextPageNo: forwardPageNoInParallel,
      prevNextPageNo: forwardPageNoInParallelPrevPage
    })
    // 1-3     ,2-4
    // null - 2,1-3 
  }, [pageNumber])

  useEffect(() => {
    if (!pdfDoc) return;
    const extractText = async () => {
      const extractedText = await extractTextFromPage(
        pdfDoc,
        allPageNo,
        lang,
      );
      setText(extractedText);
    };
    extractText();
  }, [pdfDoc, pageNumber, allPageNo, lang]);

  return (
    <div className="h-full overflow-auto whitespace-pre-wrap p-6">
      {text
        .filter((m) => m.pageNumber === pageNumber)
        .map((m) => m.text)
        .join("\n")}
    </div>
  );
};

export default BookOcrTextComponent;