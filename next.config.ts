import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // This branch runs on an ordinary Node.js server. PDF assets are served locally.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
