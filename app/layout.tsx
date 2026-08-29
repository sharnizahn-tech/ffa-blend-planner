import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FFA Blend Planner",
  description: "CPO tank blending calculations and engineer decision support.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
