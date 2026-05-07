import { Body, Controller, HttpException, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian",
  pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", cs: "Czech",
  el: "Greek", tr: "Turkish", ro: "Romanian", hu: "Hungarian", bg: "Bulgarian",
  hr: "Croatian", sk: "Slovak", sl: "Slovenian", et: "Estonian", lv: "Latvian",
  lt: "Lithuanian", sr: "Serbian", ca: "Catalan", ga: "Irish", is: "Icelandic",
  fa: "Persian", ar: "Arabic", ja: "Japanese", ko: "Korean", zh: "Chinese",
};

@Controller("translate")
@UseGuards(AuthGuard)
export class TranslateController {
  @Post()
  async translate(
    @Body() body: { text: string; targetLanguage: string; sourceLanguage?: string },
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new HttpException("Gemini API key not configured", HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const { text, targetLanguage, sourceLanguage } = body;
    if (!text || !targetLanguage) {
      throw new HttpException("Text and target language are required", HttpStatus.BAD_REQUEST);
    }

    const targetName = LANGUAGE_NAMES[targetLanguage] || targetLanguage;
    const sourceName = sourceLanguage ? (LANGUAGE_NAMES[sourceLanguage] || sourceLanguage) : "the source language";

    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `You are a professional translator. Translate the given text from ${sourceName} to ${targetName}. Only return the translated text, nothing else. Keep the same tone and style. If it's a menu item name or description, make it sound natural and appetizing in the target language.`,
              },
            ],
          },
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Gemini API error:", err);
      throw new HttpException("Translation failed", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const translatedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!translatedText) {
      throw new HttpException("No translation received", HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return { translatedText };
  }
}
