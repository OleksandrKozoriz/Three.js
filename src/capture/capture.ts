import * as THREE from 'three';
import type { Intrinsics } from '../rig/CameraRig';

/**
 * One image captured by one rig camera. Pixel arrays are row-major with row 0
 * at the TOP of the image (standard image convention, matches exported PNGs).
 */
export interface CaptureFrame {
  index: number;
  name: string;
  intrinsics: Intrinsics;
  near: number;
  far: number;
  /** Camera-to-world transform (OpenGL convention: camera looks down -Z, +Y up). */
  cameraToWorld: THREE.Matrix4;
  /** Linear-RGB color, 3 floats per pixel, clamped to [0, 1]. */
  color: Float32Array;
  /** sRGB RGBA8 image, ready for a canvas / PNG. */
  image: ImageData;
  /** View-space depth along the optical axis in meters; 0 = no surface hit. */
  depth: Float32Array;
}

/** Writes positive view-space Z (distance along the optical axis) into the red channel. */
function createDepthMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying float vViewZ;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vViewZ;
      void main() {
        gl_FragColor = vec4(vViewZ, 0.0, 0.0, 1.0);
      }`,
  });
}

function linearToSrgbByte(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/**
 * Renders color + depth for every rig camera into float render targets and reads
 * them back to the CPU. Float targets keep both depth (meters) and linear color
 * at full precision.
 */
export class Capturer {
  private colorTarget?: THREE.WebGLRenderTarget;
  private depthTarget?: THREE.WebGLRenderTarget;
  private readonly depthMaterial = createDepthMaterial();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float is not supported: float render targets are required for capture.');
    }
  }

  capture(scene: THREE.Scene, cameras: THREE.PerspectiveCamera[], intrinsics: Intrinsics): CaptureFrame[] {
    const { width: w, height: h } = intrinsics;
    this.ensureTargets(w, h);
    const renderer = this.renderer;

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;

    const rgba = new Float32Array(w * h * 4);
    const frames: CaptureFrame[] = [];
    scene.updateMatrixWorld(true);

    cameras.forEach((camera, index) => {
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();

      // Color pass.
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(this.colorTarget!);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(this.colorTarget!, 0, 0, w, h, rgba);

      const color = new Float32Array(w * h * 3);
      const image = new ImageData(w, h);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w; // GL rows start at the bottom
        for (let x = 0; x < w; x++) {
          const s = (src + x) * 4;
          const d = y * w + x;
          for (let c = 0; c < 3; c++) {
            const v = Math.min(1, Math.max(0, rgba[s + c]));
            color[d * 3 + c] = v;
            image.data[d * 4 + c] = linearToSrgbByte(v);
          }
          image.data[d * 4 + 3] = 255;
        }
      }

      // Depth pass (background must stay empty so "no hit" reads as 0).
      scene.overrideMaterial = this.depthMaterial;
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.depthTarget!);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(this.depthTarget!, 0, 0, w, h, rgba);

      const depth = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w;
        for (let x = 0; x < w; x++) depth[y * w + x] = rgba[(src + x) * 4];
      }

      frames.push({
        index,
        name: camera.name,
        intrinsics: { ...intrinsics },
        near: camera.near,
        far: camera.far,
        cameraToWorld: camera.matrixWorld.clone(),
        color,
        image,
        depth,
      });
    });

    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
    return frames;
  }

  dispose(): void {
    this.colorTarget?.dispose();
    this.depthTarget?.dispose();
    this.depthMaterial.dispose();
  }

  private ensureTargets(w: number, h: number): void {
    if (this.colorTarget && this.colorTarget.width === w && this.colorTarget.height === h) return;
    this.colorTarget?.dispose();
    this.depthTarget?.dispose();
    const opts = {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    } as const;
    this.colorTarget = new THREE.WebGLRenderTarget(w, h, opts);
    this.depthTarget = new THREE.WebGLRenderTarget(w, h, opts);
  }
}
