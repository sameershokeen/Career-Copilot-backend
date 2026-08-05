import pdfParse from "pdf-parse";

/** Extracts plain text from a base64-encoded PDF buffer. */
export async function extractTextFromPdfBase64(pdfBase64: string): Promise<string> {
  const buffer = Buffer.from(pdfBase64, "base64");
  const result = await pdfParse(buffer);
  const text = result.text?.trim();
  if (!text) {
    throw new Error("[ai-layer] PDF contained no extractable text (likely a scanned image).");
  }
  return text;
}
