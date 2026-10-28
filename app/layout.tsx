import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "阅卷助手 · 统一批改工作台",
  description: "上传试题、答案和评分细则，选择本地答卷，自动生成建议成绩。按学号可选复核。",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
