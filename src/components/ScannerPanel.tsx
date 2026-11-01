"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { analyzeImage } from "../client/api";
import type { Candidate } from "../contracts/types";
import { describeAnalysisError } from "./analysisError";

type Props = {
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
 */
export default function ScannerPanel({ onCandidate, onUnreadable, onExit, onManual }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  const stoppedRef = useRef(false);
  const emptyReadsRef = useRef(0);
  const [status, setStatus] = useState("Starting camera…");
  const [hasStream, setHasStream] = useState(false);
  const [busy, setBusy] = useState(false);

  const stopSampling = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    stopSampling();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [stopSampling]);

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
        stopCamera();
        onCandidate(candidate, previewUrl);
        return;
      }
      emptyReadsRef.current += 1;
      if (emptyReadsRef.current >= UNREADABLE_AFTER) {
        stoppedRef.current = true;
        stopCamera();
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
  }, [onCandidate, onUnreadable, stopCamera, stopSampling]);

  useEffect(() => {
    stoppedRef.current = false;
    emptyReadsRef.current = 0;
    let cancelled = false;
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus(
          window.isSecureContext === false
            ? "Camera needs a secure connection (HTTPS). Open this page over HTTPS, upload a photo, or enter values manually."
            : "No camera is available on this device. You can upload a photo or enter values manually.",
        );
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setHasStream(true);
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setStatus("Point the camera at the product and its shelf price. Photos are checked automatically.");
        timerRef.current = setInterval(() => void sample(), SAMPLE_MS);
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof DOMException ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setStatus("Camera permission was denied. You can upload a photo or enter values manually instead.");
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setStatus("No camera was found on this device. You can upload a photo or enter values manually instead.");
        } else {
          setStatus("The camera could not be started. You can upload a photo or enter values manually instead.");
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
      stopCamera();
    };
  }, [sample, stopCamera]);

  return (
    <section aria-labelledby="scanner-heading" className="scanner">
      <h2 id="scanner-heading">Scan with camera</h2>
      <video ref={videoRef} className="scanner-video" playsInline muted autoPlay aria-label="Camera preview" />
      <canvas ref={canvasRef} hidden aria-hidden="true" />
      <p role="status" aria-live="polite" className="scanner-status">
        {status}
      </p>
      <div className="action-row">
        <button type="button" className="button button-primary" onClick={() => void sample()} disabled={!hasStream || busy}>
          {busy ? "Checking photo…" : "Capture now"}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            stoppedRef.current = true;
            stopCamera();
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
            stopCamera();
            onManual();
          }}
        >
          Enter manually instead
        </button>
      </div>
    </section>
  );
}
