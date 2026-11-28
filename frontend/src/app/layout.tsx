import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import "./globals.css";
import { CONSENT_MARK_SCRIPT } from "@/lib/consentMark";
import { paletteCssText } from "@/lib/paletteCssVariables";
import { translate } from "@/i18n/config";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: translate("common.appName"),
  description: "ロードバイク向け周回ルート生成アプリ[プロトタイプ]",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // `<html>` の印（data-consented）は、描く前に下のスクリプトが付けるので、ハイドレーションで食い違いを言わせない。
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: CONSENT_MARK_SCRIPT }} />
        <style>{paletteCssText()}</style>
      </head>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
