import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ── Native Node addons: don't try to webpack-bundle onnxruntime-node ─────────
  serverExternalPackages: ['onnxruntime-node'],

  // ── Make the ONNX model file reachable from serverless functions ──────────────
  // Moved to top-level in Next.js 15+ (was experimental.outputFileTracingIncludes)
  outputFileTracingIncludes: {
    '/api/simulate': ['./public/*.onnx'],
    '/api/paper':    ['./public/*.onnx'],
  },
};

export default nextConfig;
