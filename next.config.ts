import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  // Loaded at runtime from node_modules, never bundled: the Daytona SDK reaches
  // for some of its dependencies (busboy, for multipart file transfers) with a
  // dynamic require, which a bundler cannot resolve — bundling it makes every
  // file download fail with `Module "busboy" is not available`.
  serverExternalPackages: ["@daytonaio/sdk"],
  experimental: {
    // A page captured with the snapshot extension inlines its images and fonts, and routinely
    // passes the 10MB Next buffers for requests that go through proxy.ts.
    proxyClientMaxBodySize: "50mb",
  },
};

export default nextConfig;
