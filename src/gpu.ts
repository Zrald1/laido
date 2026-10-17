/* gpu — detect what the WebView2 is actually rendering on.
 *
 * WebView2 composites on GPU by default and our env flags force it even
 * on blocklisted drivers — but a machine with NO GPU (or a driver that
 * refuses raster) still falls back to SwiftShader, and widget code needs
 * to know: a GPU scene on a software raster is SLOWER than plain DOM.
 *
 * Tiers:
 *   webgpu    — navigator.gpu adapter on real hardware → Pixi/GPU scenes
 *   webgl     — WebGL works but WebGPU refused → Pixi's WebGL fallback
 *   software  — SwiftShader/llvmpipe/no adapters → keep DOM renderers
 */
import { addActivity } from "./log.js";

export type GpuTier = "webgpu" | "webgl" | "software";
export interface GpuInfo {
  tier: GpuTier;
  renderer: string;
  webgpu: boolean;
}

const SOFT = /swiftshader|llvmpipe|software|basic render/i;
let info: GpuInfo | null = null;

export async function probeGpu(): Promise<GpuInfo> {
  if (info) return info;
  let renderer = "";
  try {
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl2") ?? cv.getContext("webgl");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String(
        (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "",
      );
      /* context loss on a probing canvas is normal — let it go quietly */
      cv.addEventListener("webglcontextlost", (e) => e.preventDefault());
    }
  } catch {
    /* no WebGL at all */
  }
  let webgpu = false;
  try {
    const nav = navigator as Navigator & {
      gpu?: {
        requestAdapter: () => Promise<{ isFallbackAdapter?: boolean } | null>;
      };
    };
    if (nav.gpu) {
      const a = await nav.gpu.requestAdapter();
      webgpu = !!a && !a.isFallbackAdapter;
    }
  } catch {
    /* adapter refused */
  }
  const tier: GpuTier =
    SOFT.test(renderer) ? "software" : webgpu ? "webgpu" : renderer ? "webgl" : "software";
  info = { tier, renderer: renderer || "none", webgpu };
  (window as unknown as { __gpuInfo?: GpuInfo }).__gpuInfo = info;
  return info;
}

export function reportGpu(i: GpuInfo): void {
  addActivity(
    i.tier === "software"
      ? "GPU: software raster — heavy widgets stay on DOM"
      : `GPU: ${i.renderer.slice(0, 60)} (${i.tier})`,
  );
}
