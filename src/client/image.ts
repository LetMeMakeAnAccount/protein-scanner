/**
 * Prepares a chosen photo for analysis.
 *
 * Phone photos can be HEIC and many megapixels. Browsers disagree about which
 * formats they can decode, so try the fast bitmap path, then fall back to an
 * <img> element + canvas (which is how iOS Safari decodes HEIC). The decoded
 * pixels are always re-encoded as a small JPEG so the request is accepted
 * everywhere and stays well inside the server's size limit.
 */

export const MAX_PHOTO_EDGE = 1024;
const JPEG_QUALITY = 0.85;

export const UNSUPPORTED_PHOTO_MESSAGE =
  "That photo format isn't supported on this device. Take a new photo with the camera, or enter the values yourself.";

/** Raised when no decode path or the JPEG re-encode can handle this file. */
export class UnsupportedPhotoError extends Error {
  constructor() {
    super(UNSUPPORTED_PHOTO_MESSAGE);
    this.name = "UnsupportedPhotoError";
  }
}

type DecodedPhoto = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release?: () => void;
};

async function decodeWithBitmap(file: File): Promise<DecodedPhoto> {
  if (typeof createImageBitmap !== "function") throw new Error("createImageBitmap is unavailable");
  const bitmap = await createImageBitmap(file);
  if (!bitmap.width || !bitmap.height) {
    bitmap.close();
    throw new Error("The photo has no pixels");
  }
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
}

/** Safari decodes HEIC in an <img>; other browsers fail here and we report it. */
function decodeWithImageElement(file: File): Promise<DecodedPhoto> {
  return new Promise((resolve, reject) => {
    if (typeof URL.createObjectURL !== "function") {
      reject(new Error("Local photo URLs are unavailable"));
      return;
    }
    let settled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      image.onload = null;
      image.onerror = null;
      settle();
    };
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        finish(() => reject(new Error("The photo has no pixels")));
        return;
      }
      finish(() =>
        resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight }),
      );
    };
    image.onerror = () => finish(() => reject(new Error("The photo could not be decoded")));
    image.src = url;
  });
}

function scaledSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function encodeJpeg(photo: DecodedPhoto): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const size = scaledSize(photo.width, photo.height);
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new UnsupportedPhotoError();
  // Photos are opaque, but PNG labels may not be; JPEG has no alpha.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(photo.source, 0, 0, canvas.width, canvas.height);
  if (typeof canvas.toBlob !== "function") throw new UnsupportedPhotoError();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob || blob.type !== "image/jpeg") throw new UnsupportedPhotoError();
  return blob;
}

/**
 * Decodes the chosen file and returns a JPEG capped at MAX_PHOTO_EDGE on its
 * long edge. The original bytes are never returned: if neither decoder works,
 * this throws UnsupportedPhotoError so the UI can ask for a different photo.
 */
export async function prepareImageForUpload(file: File): Promise<Blob> {
  let photo: DecodedPhoto | null = null;
  for (const decode of [decodeWithBitmap, decodeWithImageElement]) {
    try {
      photo = await decode(file);
      break;
    } catch {
      // Try the next decoder; some browsers reject HEIC bitmaps but render it in an <img>.
    }
  }
  if (!photo) throw new UnsupportedPhotoError();
  try {
    return await encodeJpeg(photo);
  } finally {
    photo.release?.();
  }
}
