/**
 * GET /api/healthz
 * Diagnostic endpoint — checks onnxruntime-node and model file availability.
 */
import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';

export async function GET() {
  const info: Record<string, unknown> = {
    cwd: process.cwd(),
    vercel_url: process.env.VERCEL_URL ?? null,
    node_version: process.version,
    platform: process.platform,
  };

  // 1. Check ONNX model on filesystem
  const modelPath = path.join(process.cwd(), 'public', 'hierarchical_moderator.onnx');
  info.model_fs_exists = fs.existsSync(modelPath);

  // 2. Try loading onnxruntime-web (WASM — what inference routes now use)
  try {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths  = path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist') + '/';
    info.ort_web_loaded = true;

    // Try actually creating a session if model is present
    if (info.model_fs_exists) {
      try {
        const session = await ort.InferenceSession.create(modelPath);
        info.ort_web_session = true;
        info.ort_web_inputs  = session.inputNames;
        info.ort_web_outputs = session.outputNames;
      } catch (e) {
        info.ort_web_session = false;
        info.ort_web_session_error = String(e);
      }
    }
  } catch (e) {
    info.ort_web_loaded = false;
    info.ort_web_error = String(e);
  }

  return NextResponse.json(info);
}
