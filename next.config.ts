import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Ultra-short one-liner endpoints (content-type preserved from the target file):
  //   /c -> Node CLI client   (curl -fsSL https://host/c | node)
  //   /g -> POSIX shell client, no Node needed (curl -fsSL https://host/g | bash)
  //   /p -> PowerShell client, no Node needed (iex (iwr https://host/p -UseB).Content)
  async rewrites() {
    return [
      { source: "/c", destination: "/chat.cjs" },
      { source: "/g", destination: "/g.sh" },
      { source: "/p", destination: "/p.txt" },
    ];
  },
};

export default nextConfig;
