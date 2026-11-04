import "server-only";
import sharp from "sharp";
import type { ImageInput } from "../contracts/types";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
// Bounded output keeps re-encoding fast and model token use small; never upscales.
const MAX_OUTPUT_EDGE = 768;
const OUTPUT_QUALITY = 80;
const formats: Record<string, string> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };

// Decode and re-encode in memory only, stripping metadata before transmission.
export async function sanitizeImage(input: ImageInput): Promise<ImageInput> {
  const format = formats[input?.mediaType];
  if (!format || !(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Invalid image");
  try {
    const bytes = Buffer.from(input.bytes);
    const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning", animated: false }).metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages ?? 1) !== 1) throw new Error("Invalid image");
    const output = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning", animated: false }).rotate()
      .resize({ width: MAX_OUTPUT_EDGE, height: MAX_OUTPUT_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: OUTPUT_QUALITY }).toBuffer();
    if (!output.length || output.length > MAX_IMAGE_BYTES) throw new Error("Invalid image");
    return { bytes: output, mediaType: "image/jpeg" };
  } catch { throw new Error("Invalid image"); }
}
