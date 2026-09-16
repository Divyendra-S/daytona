import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Loaded from node_modules at runtime rather than bundled: the Daytona SDK
  // reaches for `form-data` and `busboy` with a dynamic require when it uploads
  // a file, and a bundler cannot trace those — bundled, every file write fails
  // with `Module "form-data" is not available`. A Worker has no node_modules to
  // load it from, which is the open problem with running this on Cloudflare.
  serverExternalPackages: ["@daytonaio/sdk"],
  experimental: {
    // A page captured with the snapshot extension inlines its images and fonts, and routinely
    // passes the 10MB Next buffers for requests that go through proxy.ts.
    proxyClientMaxBodySize: "50mb",
  },
};

export default nextConfig;

// Gives `next dev` the same bindings and environment the deployed Worker has.
void initOpenNextCloudflareForDev();
