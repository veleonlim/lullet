import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // The dev badge sits over the leftmost tab of the phone tab bar, where it hides the link and
  // intercepts taps (and the Playwright clicks that stand in for them).
  devIndicators: false,
};

export default nextConfig;
