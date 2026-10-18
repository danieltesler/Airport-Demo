import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Inter } from "next/font/google";
import "./globals.css";

// Inter for text and UI, a light humanist grotesque for display type (the ElevenLabs look, with free fonts).
const fontBody = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body", display: "swap" });
const fontDisplay = Hanken_Grotesk({ subsets: ["latin"], weight: ["300", "400"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Airport Investment Intelligence Agent",
  description:
    "Conversational analysis assistant for airport-investment analysts.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fafafa",
  // Chrome Android 108+ overlays the keyboard by default; this resizes the layout so the composer stays above it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${fontBody.variable} ${fontDisplay.variable}`}>
      <body>{children}</body>
    </html>
  );
}
