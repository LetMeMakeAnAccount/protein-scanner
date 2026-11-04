"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { analyzeImage } from "../client/api";
import type { Candidate } from "../contracts/types";
import { describeAnalysisError } from "./analysisError";

type Props = {
  /** Stream obtained by the tap that opened this view, so iOS keeps the user gesture. */
  stream: MediaStream;
  onCandidate: (candidate: Candidate, previewUrl: string | null) => void;
  onUnreadable: () => void;
  onExit: () => void;
  onManual: () => void;
};

const SAMPLE_MS = 2500;
const UNREADABLE_AFTER = 4;

/**
 * Live camera sampling. Frames are drawn to a canvas and re-encoded as JPEG
 * (which strips metadata) before anything leaves the device. At most one
 * analysis request is in flight and no frames are queued. Sampling stops as
 * soon as anything readable comes back, or after a short run of empty reads.
 *
 * The camera stream is owned by the parent, which requested it inside the
 * user's tap. This panel never calls getUserMedia, so no permission prompt
 * depends on an effect. Tracks are stopped by the parent when scanning ends.
 */
export default function ScannerPanel({ stream, onCandidate, onUnreadable, onExit, onManual }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  const stoppedRef = useRef(false);
  const emptyReadsRef = useRef(0);
  const [status, setStatus] = useState("Starting camera…");
  const [busy, setBusy] = useState(false);

  const stopSampling = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const sample = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (inFlightRef.current || stoppedRef.current || !video || !canvas || !streamRef.current) return;
    if (!video.videoWidth || !video.videoHeight) {
      setStatus("Camera is still starting…");
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const previewUrl = canvas.toDataURL("image/jpeg", 0.85);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || stoppedRef.current) return;

    inFlightRef.current = true;
    setBusy(true);
    try {
      const { candidate } = await analyzeImage(blob);
      if (stoppedRef.current) return;
      if (candidate.item || candidate.price) {
        stoppedRef.current = true;
        stopSampling();
        onCandidate(candidate, previewUrl);
        return;
      }
      emptyReadsRef.current += 1;
      if (emptyReadsRef.current >= UNREADABLE_AFTER) {
        stoppedRef.current = true;
        stopSampling();
        onUnreadable();
        return;
      }
      setStatus("No item or price found yet — keep the product and its shelf price in view. Checking again…");
    } catch (error) {
      if (stoppedRef.current) return;
      stopSampling();
      setStatus(`Analysis stopped: ${describeAnalysisError(error)} Tap “Capture now” to try again, or enter the values yourself.`);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [onCandidate, onUnreadable, stopSampling]);

  useEffect(() => {
    stoppedRef.current = false;
    emptyReadsRef.current = 0;
    streamRef.current = stream;
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      void video.play().catch(() => undefined);
    }
    setStatus("Point the camera at the product and its shelf price. Photos are checked automatically.");
    timerRef.current = setInterval(() => void sample(), SAMPLE_MS);
    return () => {
      stoppedRef.current = true;
      stopSampling();
      streamRef.current = null;
      if (video) video.srcObject = null;
      // The stream belongs to the parent; it stops the tracks when scanning ends.
    };
  }, [stream, sample, stopSampling]);

  return (
    <section aria-labelledby="scanner-heading" className="scanner">
      <h2 id="scanner-heading">Scan with camera</h2>
      <video ref={videoRef} className="scanner-video" playsInline muted autoPlay aria-label="Camera preview" />
      <canvas ref={canvasRef} hidden aria-hidden="true" />
      <p role="status" aria-live="polite" className="scanner-status">
        {status}
      </p>
      <div className="action-row">
        <button type="button" className="button button-primary" onClick={() => void sample()} disabled={busy}>
          {busy ? "Checking photo…" : "Capture now"}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            stoppedRef.current = true;
            stopSampling();
            onExit();
          }}
        >
          Stop
        </button>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            stoppedRef.current = true;
            stopSampling();
            onManual();
          }}
        >
          Enter manually instead
        </button>
      </div>
    </section>
  );
}
