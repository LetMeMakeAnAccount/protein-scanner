import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Protein Scanner — protein per dollar, checked by you",
  description:
    "Scan a packaged food and its shelf price, check the numbers, and compare protein per dollar and per 100 kcal. Diary stays on your device.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
