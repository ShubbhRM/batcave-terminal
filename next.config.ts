import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ── Native Node addons: don't try to webpack-bundle onnxruntime-node ─────────
  serverExternalPackages: ['onnxruntime-node'],

  // ── Make the ONNX model file reachable from serverless functions ──────────────
  outputFileTracingIncludes: {
    '**': ['./public/*.onnx'],
  },
};

export default nextConfig;
