import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ── Keep onnxruntime-web external so Vercel bundles its full dist/ dir ────────
  serverExternalPackages: ['onnxruntime-web'],

  // ── Ensure ONNX model + WASM files are included in every function bundle ──────
  outputFileTracingIncludes: {
    '**': [
      './public/*.onnx',
      './node_modules/onnxruntime-web/dist/*.wasm',
    ],
  },
};

export default nextConfig;
