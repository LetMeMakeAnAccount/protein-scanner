import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";

const UNSUPPORTED_PHOTO =
  "That photo format isn't supported on this device. Take a new photo with the camera, or enter the values yourself.";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeStream(stop = vi.fn()) {
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  return { stream, stop };
}

function installMediaDevices(getUserMedia: (constraints?: MediaStreamConstraints) => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}

function stubVideoPlayback() {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 480 });
}

function stubObjectUrls() {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:local-photo"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
}

/** Safari-style decoder: an <img> that loads the local file and reports its pixel size. */
function stubImageElement(width: number, height: number) {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = width;
    naturalHeight = height;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
    get src() {
      return "";
    }
  }
  vi.stubGlobal("Image", FakeImage);
}

function stubFailingImageElement() {
  class BrokenImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_value: string) {
      this.onerror?.();
    }
    get src() {
      return "";
    }
  }
  vi.stubGlobal("Image", BrokenImage);
}

type CanvasSize = { width: number; height: number };

function stubCanvasEncoder(encoded: Blob) {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    fillRect: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  const size: CanvasSize = { width: 0, height: 0 };
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    size.width = this.width;
    size.height = this.height;
    callback(encoded);
  });
  return { drawImage, size };
}

const decodedCandidate = {
  item: "HEIC bars",
  barcode: null,
  price: null,
  labelNutrition: null,
  uncertainties: [],
};

describe("camera permission from the tap", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requests the stream inside the click and keeps the home screen until it resolves", async () => {
    const { stream } = makeStream();
    let releaseCamera: (value: MediaStream) => void = () => undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          releaseCamera = resolve;
        }),
    );
    installMediaDevices(getUserMedia);
    stubVideoPlayback();

    render(<Home />);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));

    // Requested synchronously by the tap, before any scanner effect could run.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /scan with camera/i })).not.toBeInTheDocument();

    await act(async () => {
      releaseCamera(stream);
    });

    expect(await screen.findByRole("heading", { name: /scan with camera/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^start$/i })).not.toBeInTheDocument();
  });

  it("stays on home with the permission message when the tap is rejected", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    installMediaDevices(getUserMedia);

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Camera permission was denied. You can upload a photo or enter values manually instead.",
    );
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /scan with camera/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter manually/i })).toBeInTheDocument();
  });

  it("keeps the insecure-connection message on home when the camera API is missing", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Camera needs a secure connection (HTTPS). Open this page over HTTPS, upload a photo, or enter values manually.",
    );
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /scan with camera/i })).not.toBeInTheDocument();
  });

  it("keeps the no-camera message on home when no device has a camera", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("no camera", "NotFoundError");
    });
    installMediaDevices(getUserMedia);

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No camera was found on this device. You can upload a photo or enter values manually instead.",
    );
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();
  });

  it("releases every camera track when the user stops the scanner", async () => {
    const { stream, stop } = makeStream();
    const getUserMedia = vi.fn(async () => stream);
    installMediaDevices(getUserMedia);
    stubVideoPlayback();

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    expect(await screen.findByRole("heading", { name: /scan with camera/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();
  });
});

describe("photo upload decoding", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to an image element and canvas when createImageBitmap is unavailable, sending a capped JPEG", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    stubImageElement(4032, 3024);
    stubObjectUrls();
    const encoded = new Blob(["re-encoded-jpeg"], { type: "image/jpeg" });
    const { drawImage, size } = stubCanvasEncoder(encoded);

    const sentBodies: FormData[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(init?.body as FormData);
      return jsonResponse({ ok: true, data: { candidate: decodedCandidate } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    fireEvent.change(screen.getByLabelText(/upload photo/i), {
      target: { files: [new File(["raw-heic-bytes-not-sent"], "IMG_0001.HEIC", { type: "image/heic" })] },
    });

    expect(await screen.findByDisplayValue("HEIC bars")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/HEIC bars/)).toBeInTheDocument();

    // The canvas path decoded the 12 MP photo and capped its long edge at 1024 px.
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(size).toEqual({ width: 1024, height: 768 });

    const image = sentBodies[0].get("image");
    expect(image).toBeInstanceOf(Blob);
    expect((image as Blob).type).toBe("image/jpeg");
    expect((image as Blob).size).toBe(encoded.size);
    expect((image as Blob).size).not.toBe(new File(["raw-heic-bytes-not-sent"], "IMG_0001.HEIC").size);
  });

  it("shows the unsupported-photo message and makes no analysis call when every decode path fails", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    stubFailingImageElement();
    stubObjectUrls();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    fireEvent.change(screen.getByLabelText(/upload photo/i), {
      target: { files: [new File(["undecodable"], "IMG_0002.HEIC", { type: "image/heic" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(UNSUPPORTED_PHOTO);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter manually/i })).toBeInTheDocument();
  });
});
