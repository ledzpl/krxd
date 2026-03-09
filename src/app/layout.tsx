import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "KStock Dashboard",
  description:
    "Public Korean stock dashboard scaffold with validated environment configuration.",
};

type RootLayoutProps = {
  children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
