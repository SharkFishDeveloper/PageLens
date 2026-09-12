import OpenAI from "openai";
import { NextResponse } from "next/server";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: Request) {
  try {
    const { prompt } = await request.json();

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required" },
        { status: 400 }
      );
    }

    const response = await openai.responses.create({
      model: "gpt-5.5",
      input: prompt,
    });

    return NextResponse.json({
      text: response.output_text,
    });

  } catch (error) {
    console.error("AI Error:", error);

    return NextResponse.json(
      { error: "Failed to generate AI response" },
      { status: 500 }
    );
  }
}