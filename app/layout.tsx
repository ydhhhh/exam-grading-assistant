import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "阅卷助手 · 国产 AI 版",
  description: "用 Kimi、DeepSeek 和 Qwen 分别整理评分规则、识别姓名学号并逐题初评、独立模型复核。",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
