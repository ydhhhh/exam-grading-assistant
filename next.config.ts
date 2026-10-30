import type { NextConfig } from "next";

const isGitHubPages = process.env.NEXT_PUBLIC_DEPLOYMENT_TARGET === "github-pages";
const pagesBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/exam-grading-assistant";
if (isGitHubPages && pagesBasePath !== "" && (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(pagesBasePath))) {
  throw new Error("NEXT_PUBLIC_BASE_PATH must be empty or a slash-prefixed project path without a trailing slash.");
}

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : "standalone",
  poweredByHeader: false,
  ...(isGitHubPages
    ? { basePath: pagesBasePath, trailingSlash: true, images: { unoptimized: true } }
    : { outputFileTracingRoot: process.cwd() }),
};

export default nextConfig;
