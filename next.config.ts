import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ── Native Node addons: don't try to webpack-bundle onnxruntime-node ─────────
  // (it ships pre-built platform binaries that can't be bundled)
  serverExternalPackages: ['onnxruntime-node'],

  // ── Make the ONNX model file reachable from serverless functions ──────────────
  // Without this Vercel's file-tracing step won't copy public/*.onnx into the
  // function bundle, so path.join(process.cwd(),'public','…onnx') would 404.
  experimental: {
    outputFileTracingIncludes: {
      '/api/simulate': ['./public/*.onnx'],
      '/api/paper':    ['./public/*.onnx'],
    },
  },
};

export default nextConfig;
