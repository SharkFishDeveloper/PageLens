import { PagesProps } from "./BookOcrTextComponent";
import { getOcrText } from "./coreOcr";

export type PageTextResult = {
  pageNumber: number;
  text: string | null;
  extractable: boolean;
  method: "pdf-text" | "ocr" | "failed" | "cache";
};


export const extractTextFromPage = async (
  pdfDoc: any,
  allPageNo: PagesProps,
  lang:string
): Promise<PageTextResult[]> => {
  const pageNumbers = [
    allPageNo.currPageNo,
    allPageNo.prevCurrPageNo,
    allPageNo.nextPageNo,
    allPageNo.prevNextPageNo,
  ].filter(
    (pageNumber): pageNumber is number =>
      pageNumber !== null && pageNumber > 0
  );

  // STEP 1: Extract PDF text in parallel
  const results = await Promise.all(
    pageNumbers.map(async (pageNumber) => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        const textContent = await page.getTextContent();

        const extractedText = textContent.items
          .map((item: any) => item.str)
          .join(" ")
          .trim();

        return {
          pageNumber,
          text: extractedText,
          extractable: extractedText.length > 0,
          method: extractedText.length > 0
            ? "pdf-text" as const
            : "failed" as const,
        };
      } catch (error) {
        return {
          pageNumber,
          text: null,
          extractable: false,
          method: "failed" as const,
        };
      }
    })
  );

  // STEP 2: Run OCR ONLY on failed pages, in parallel
  const failedPages = results.filter(
    (result) => !result.extractable
  );

  const ocrResults = await Promise.all(
    failedPages.map(async (result) => {
      try {
        const ocrText = await getOcrText(
          pdfDoc,
          result.pageNumber,
          lang,
        );

        return {
          pageNumber: result.pageNumber,
          text: ocrText,
          extractable: ocrText.trim().length > 0,
          method: ocrText.trim().length > 0
            ? "ocr" as const
            : "failed" as const,
        };
      } catch (error) {
        return {
          pageNumber: result.pageNumber,
          text: null,
          extractable: false,
          method: "failed" as const,
        };
      }
    })
  );

  // STEP 3: Combine normal text + OCR results
  const ocrMap = new Map(
    ocrResults.map((result) => [
      result.pageNumber,
      result,
    ])
  );

  return results.map((result) => {
    return ocrMap.get(result.pageNumber) ?? result;
  });
};