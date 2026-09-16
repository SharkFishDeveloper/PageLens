type OcrWord = {
  text: string;
  confidence: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
};

const detectDirection = (text: string): "rtl" | "ltr" => {
  const arabicPattern = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
  return arabicPattern.test(text) ? "rtl" : "ltr";
};

export function arrangeOcrWords(words: OcrWord[]): string {
  if (!words || words.length === 0) return "";

  const validWords = words.filter(
    (word) => word.text.trim().length > 0
  );

  if (validWords.length === 0) return "";

  const combinedText = validWords.map((word) => word.text).join(" ");
  const direction = detectDirection(combinedText);

  // Sort top-to-bottom using vertical center
  const sortedWords = [...validWords].sort((a, b) => {
    const aCenter = (a.bbox.y0 + a.bbox.y1) / 2;
    const bCenter = (b.bbox.y0 + b.bbox.y1) / 2;
    return aCenter - bCenter;
  });

  const lines: OcrWord[][] = [];

  for (const word of sortedWords) {
    const wordCenterY = (word.bbox.y0 + word.bbox.y1) / 2;
    const wordHeight = word.bbox.y1 - word.bbox.y0;

    let matchedLine: OcrWord[] | undefined;

    for (const line of lines) {
      const lineCenterY =
        line.reduce(
          (sum, w) => sum + (w.bbox.y0 + w.bbox.y1) / 2,
          0
        ) / line.length;

      const averageHeight =
        line.reduce(
          (sum, w) => sum + (w.bbox.y1 - w.bbox.y0),
          0
        ) / line.length;

      const tolerance = Math.max(
        5,
        Math.min(wordHeight, averageHeight) * 0.5
      );

      if (Math.abs(lineCenterY - wordCenterY) <= tolerance) {
        matchedLine = line;
        break;
      }
    }

    if (matchedLine) {
      matchedLine.push(word);
    } else {
      lines.push([word]);
    }
  }

  // Top-to-bottom
  lines.sort((a, b) => {
    const aY = Math.min(...a.map((w) => w.bbox.y0));
    const bY = Math.min(...b.map((w) => w.bbox.y0));
    return aY - bY;
  });

  // Left-to-right or right-to-left
  return lines
    .map((line) => {
      line.sort((a, b) =>
        direction === "rtl"
          ? b.bbox.x0 - a.bbox.x0
          : a.bbox.x0 - b.bbox.x0
      );

      return line.map((word) => word.text.trim()).join(" ");
    })
    .join("\n");
}