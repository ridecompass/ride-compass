import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { paletteCssText } from "@/lib/paletteCssVariables";
import { APP_NAME } from "@/lib/screenNames";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "ロードバイク向け周回ルート生成アプリ[プロトタイプ]",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <style>{paletteCssText()}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
