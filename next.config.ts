import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  // A native module: loaded at runtime from node_modules, never bundled.
  serverExternalPackages: ["node-pty"],
  experimental: {
    // A page captured with the snapshot extension inlines its images and fonts, and routinely
    // passes the 10MB Next buffers for requests that go through proxy.ts.
    proxyClientMaxBodySize: "50mb",
  },
};

export default nextConfig;
