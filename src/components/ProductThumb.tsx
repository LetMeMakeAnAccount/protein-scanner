"use client";

import React, { useState } from "react";

type ProductThumbProps = {
  name: string;
  image?: string | null;
};

/**
 * A small product photo beside a food name. The name is always next to it, so
 * the image is decorative. When the photo is missing or fails, the same slot
 * shows the name's first letter so rows never jump or show a broken image.
 */
export default function ProductThumb({ name, image }: ProductThumbProps) {
  const src = typeof image === "string" ? image.trim() : "";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const initial = name.trim().charAt(0).toUpperCase();

  if (!src || failedSrc === src) {
    return (
      <span className="product-thumb product-thumb-fallback" aria-hidden="true">
        {initial || "?"}
      </span>
    );
  }

  return (
    <img
      className="product-thumb"
      src={src}
      alt=""
      width={44}
      height={44}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
    />
  );
}
