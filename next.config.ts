import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: securityHeaders({ development: process.env.NODE_ENV === "development" }),
      },
    ]);
  },
};

export default nextConfig;
