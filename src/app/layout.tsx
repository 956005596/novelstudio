import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NovelStudio — AI 演绎叙事引擎",
  description: "多 Agent 自主演绎 · Director 调度冲突 · 实时生成小说文本 · 任意时刻干预校准",
  keywords: ["NovelStudio", "AI 写作", "多 Agent", "演绎叙事", "Next.js"],
  authors: [{ name: "NovelStudio" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "NovelStudio",
    description: "AI 演绎叙事引擎",
    siteName: "NovelStudio",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NovelStudio",
    description: "AI 演绎叙事引擎",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
