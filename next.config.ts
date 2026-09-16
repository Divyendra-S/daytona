import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  devIndicators: false,
  experimental: {
    // A page captured with the snapshot extension inlines its images and fonts, and routinely
    // passes the 10MB Next buffers for requests that go through proxy.ts.
    proxyClientMaxBodySize: "50mb",
  },
};

export default nextConfig;

// Gives `next dev` the same bindings and environment the deployed Worker has.
void initOpenNextCloudflareForDev();
