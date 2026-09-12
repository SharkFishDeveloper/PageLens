// import OpenAI from "openai";
// import { NextResponse } from "next/server";

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });

// export async function POST(request: Request) {
//   try {
//     if (!process.env.OPENAI_API_KEY) {
//       console.error("CRITICAL: OPENAI_API_KEY is not defined in environment variables.");
//       return NextResponse.json(
//         { error: "Server configuration error: Missing API Key" },
//         { status: 500 }
//       );
//     }

//     const { prompt } = await request.json();

//     if (!prompt || typeof prompt !== "string") {
//       return NextResponse.json(
//         { error: "A valid string prompt is required" },
//         { status: 400 }
//       );
//     }

//     const response = await openai.chat.completions.create({
//       model: "gpt-4o-mini", // Reliable, standard, fast model name
//       messages: [
//         {
//           role: "system",
//           content:
//             "You are an accurate multilingual reading assistant. Strictly follow instructions and always wrap your final output inside <artifact>...</artifact> tags.",
//         },
//         {
//           role: "user",
//           content: prompt,
//         },
//       ],
//       temperature: 0.3,
//     });

//     const outputText = response.choices[0]?.message?.content ?? "";

//     return NextResponse.json({
//       text: outputText,
//     });
//   } catch (error: any) {
//     console.error("AI Route Error:", error);

//     return NextResponse.json(
//       { error: error?.message || "Failed to generate AI response" },
//       { status: 500 }
//     );
//   }
// }

import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export async function POST(request: Request) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "Server configuration error: Missing API Key" },
        { status: 500 }
      );
    }

    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "A valid string prompt is required" },
        { status: 400 }
      );
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",

      contents: prompt,

      config: {
        systemInstruction:
          "You are an accurate multilingual reading assistant. Strictly follow instructions and always wrap your final output inside <artifact>...</artifact> tags.",

        temperature: 0.3,
      },
    });

    const outputText = response.text ?? "";

    return NextResponse.json({
      text: outputText,
    });
  } catch (error: any) {
    console.error("Gemini AI Route Error:", error);

    return NextResponse.json(
      {
        error: error?.message || "Failed to generate AI response",
      },
      { status: 500 }
    );
  }
}