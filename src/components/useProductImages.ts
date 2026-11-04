"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadImages } from "../client/images";

/** Photos start loading a little before a row scrolls into view. */
export const IMAGE_ROOT_MARGIN = "200px";

export type ProductImages = Record<string, string | null>;

export type Observe = (element: Element, code: string) => () => void;

/**
 * Owns one IntersectionObserver for every product row on the panel. Only rows
 * that intersect the 200px margin ask for a photo, and all codes in one
 * observer callback make a single batched request (the loader caps it at 12).
 */
export function useProductImages(): {
  images: ProductImages;
  observe: Observe;
  request: (codes: readonly string[]) => void;
} {
  const [images, setImages] = useState<ProductImages>({});
  const observerRef = useRef<IntersectionObserver | null>(null);
  const codeByElement = useRef(new WeakMap<Element, string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const request = useCallback((codes: readonly string[]) => {
    const wanted = codes.map((code) => code.trim()).filter(Boolean);
    if (wanted.length === 0) return;
    void loadImages(wanted).then((loaded) => {
      if (!mountedRef.current) return;
      setImages((current) => {
        let changed = false;
        const next: ProductImages = { ...current };
        for (const [code, url] of Object.entries(loaded)) {
          if (next[code] !== url) {
            next[code] = url;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
  }, []);

  const observe = useCallback<Observe>(
    (element, code) => {
      const trimmed = code.trim();
      if (!trimmed || typeof IntersectionObserver === "undefined") return () => undefined;

      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            const codes: string[] = [];
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const observed = codeByElement.current.get(entry.target);
              if (observed) codes.push(observed);
              codeByElement.current.delete(entry.target);
              observerRef.current?.unobserve(entry.target);
            }
            if (codes.length > 0) request(codes);
          },
          { rootMargin: IMAGE_ROOT_MARGIN },
        );
      }

      codeByElement.current.set(element, trimmed);
      observerRef.current.observe(element);
      return () => {
        codeByElement.current.delete(element);
        observerRef.current?.unobserve(element);
      };
    },
    [request],
  );

  return { images, observe, request };
}
