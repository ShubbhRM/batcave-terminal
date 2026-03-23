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

  // 2. Try loading onnxruntime-node
  try {
    const ort = await import('onnxruntime-node');
    info.ort_node_loaded = true;
    info.ort_node_version = (ort as any).env?.versions?.node ?? 'unknown';
  } catch (e) {
    info.ort_node_loaded = false;
    info.ort_node_error = String(e);
  }

  // 3. If model not on FS and VERCEL_URL present, test the CDN fetch
  if (!info.model_fs_exists && process.env.VERCEL_URL) {
    try {
      const url = `https://${process.env.VERCEL_URL}/hierarchical_moderator.onnx`;
      const res = await fetch(url, { method: 'HEAD' });
      info.model_cdn_url = url;
      info.model_cdn_status = res.status;
      info.model_cdn_ok = res.ok;
    } catch (e) {
      info.model_cdn_error = String(e);
    }
  }

  return NextResponse.json(info);
}
