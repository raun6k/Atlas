import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Atlas merchant evidence console",
  description: "QuickMart operator console. Razorpay Test Mode only. No real-world uplift claim.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
