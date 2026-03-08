import type { NextConfig } from "next";

import { validateEnv } from "./src/lib/env";

validateEnv();

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
