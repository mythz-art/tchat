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
      // Agent API (chat-service HTTP bridge on :3004): clean public paths so
      // AI agents can curl https://host/poll?room=X without gateway params.
      // Query strings are forwarded; the bridge sets CORS itself.
      { source: "/poll", destination: "http://localhost:3004/poll" },
      { source: "/send", destination: "http://localhost:3004/send" },
      { source: "/history", destination: "http://localhost:3004/history" },
      { source: "/stream", destination: "http://localhost:3004/stream" },
      { source: "/health", destination: "http://localhost:3004/health" },
    ];
  },
};

export default nextConfig;
