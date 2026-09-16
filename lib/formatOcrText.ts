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

  // Remove empty words
  const validWords = words.filter((word) => word.text.trim().length > 0);

  const combinedText = validWords.map((word) => word.text).join(" ");
  const direction = detectDirection(combinedText);

  // Sort words from top to bottom
  const sortedWords = [...validWords].sort(
    (a, b) => a.bbox.y0 - b.bbox.y0
  );

  // Group words into lines based on their vertical position
  const lines: OcrWord[][] = [];

  for (const word of sortedWords) {
    const wordCenterY = (word.bbox.y0 + word.bbox.y1) / 2;
    const wordHeight = word.bbox.y1 - word.bbox.y0;

    // Tolerance adapts to the word's height
    const tolerance = Math.max(10, wordHeight * 0.5);

    let matchedLine: OcrWord[] | undefined;

    for (const line of lines) {
      const firstWord = line[0];

      const firstCenterY =
        (firstWord.bbox.y0 + firstWord.bbox.y1) / 2;

      if (Math.abs(firstCenterY - wordCenterY) <= tolerance) {
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

  // Sort lines from top to bottom
  lines.sort((a, b) => {
    const aY = Math.min(...a.map((word) => word.bbox.y0));
    const bY = Math.min(...b.map((word) => word.bbox.y0));

    return aY - bY;
  });

  // Arrange words within each line
  const formattedLines = lines.map((line) => {
    line.sort((a, b) => {
      return direction === "rtl"
        ? b.bbox.x0 - a.bbox.x0
        : a.bbox.x0 - b.bbox.x0;
    });

    return line.map((word) => word.text.trim()).join(" ");
  });

  return formattedLines.join("\n");
}