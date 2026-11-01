import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { sanitizeImage } from "../../src/server/image";
vi.mock("server-only", () => ({}));

describe("image sanitization", () => {
  it("decodes and re-encodes JPEG, PNG and WebP while stripping metadata", async () => {
    for (const [format, mediaType] of [["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]] as const) {
      const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } }).withMetadata({ exif: { IFD0: { Artist: "private" } } }).toFormat(format).toBuffer();
      const output = await sanitizeImage({ bytes, mediaType });
      const metadata = await sharp(output.bytes).metadata();
      expect(output.mediaType).toBe("image/jpeg");
      expect(metadata.format).toBe("jpeg");
      expect(metadata.exif).toBeUndefined();
    }
  });
  it("rejects malformed, mislabeled and unsupported images", async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    await expect(sanitizeImage({ bytes: Buffer.from("not an image"), mediaType: "image/jpeg" })).rejects.toThrow();
    await expect(sanitizeImage({ bytes: png, mediaType: "image/jpeg" })).rejects.toThrow();
    await expect(sanitizeImage({ bytes: png, mediaType: "image/gif" })).rejects.toThrow();
  });
  it("rejects over 5 MiB and images above 20 megapixels", async () => {
    await expect(sanitizeImage({ bytes: new Uint8Array(5 * 1024 * 1024 + 1), mediaType: "image/png" })).rejects.toThrow();
    const large = await sharp({ create: { width: 5001, height: 4000, channels: 3, background: "red" } }).png().toBuffer();
    await expect(sanitizeImage({ bytes: large, mediaType: "image/png" })).rejects.toThrow();
  });
});
