import type { CaptureFrame } from '../capture/capture';
import { rayMap } from '../camera/models';
import { gaussian } from '../util/random';

/** Where per-pixel distances come from. */
export type DepthSource = 'sensor' | 'stereo';

export interface FusionParams {
  /** 'sensor' = ideal rendered depth (upper bound), 'stereo' = estimated from the images only. */
  source: DepthSource;
  /** Use every n-th pixel in x and y. */
  stride: number;
  /** Sensor source only: σ of Gaussian range noise in meters (simulates a depth camera). */
  noiseSigma: number;
  /** Sensor source only: additional noise proportional to range² (1/m), like stereo depth error. */
  noiseQuadratic: number;
  /** Merge points into voxels of this size (m). 0 disables. */
  voxelSize: number;
  /** Ignore ranges beyond this distance (m). */
  maxDepth: number;
}

export interface PointCloud {
  count: number;
  positions: Float32Array;
  /** Linear RGB. */
  colors: Float32Array;
  /** Index of the camera that produced each point. */
  cameraIds: Uint16Array;
}

const rayCache = new WeakMap<CaptureFrame, Float32Array>();

/** Unit rays (OpenCV camera frame) of the frame's *calibrated* model, cached per frame. */
export function frameRays(frame: CaptureFrame): Float32Array {
  let rays = rayCache.get(frame);
  if (!rays) {
    rays = rayMap(frame.model);
    rayCache.set(frame, rays);
  }
  return rays;
}

/**
 * Back-projects every (strided) pixel with a known range into world space using the
 * calibration the reconstruction believes in:
 *   p_cv    = range · ray(u, v)                  (ray from the lens model, OpenCV axes)
 *   p_gl    = (p_cv.x, -p_cv.y, -p_cv.z)         (three.js camera axes)
 *   p_world = cameraToWorld · p_gl
 */
export function backProject(frames: CaptureFrame[], params: FusionParams): PointCloud {
  const stride = Math.max(1, Math.round(params.stride));
  let capacity = 0;
  for (const f of frames) capacity += Math.ceil(f.model.width / stride) * Math.ceil(f.model.height / stride);

  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const cameraIds = new Uint16Array(capacity);
  let n = 0;
  const addNoise = params.source === 'sensor' && (params.noiseSigma > 0 || params.noiseQuadratic > 0);

  for (const f of frames) {
    const ranges = params.source === 'stereo' ? f.stereoRange : f.range;
    if (!ranges) continue;
    const rays = frameRays(f);
    const { width: w, height: h } = f.model;
    const e = f.cameraToWorld.elements; // column-major
    const rMax = Math.min(params.maxDepth, f.far * 0.999);
    for (let v = 0; v < h; v += stride) {
      for (let u = 0; u < w; u += stride) {
        const i = v * w + u;
        let r = ranges[i];
        if (!(r > 0) || r >= rMax || rays[i * 4 + 3] === 0) continue;
        if (addNoise) {
          r += gaussian() * (params.noiseSigma + params.noiseQuadratic * r * r);
          if (r <= f.near) continue;
        }
        const xc = rays[i * 4] * r;
        const yc = -rays[i * 4 + 1] * r;
        const zc = -rays[i * 4 + 2] * r;
        positions[n * 3] = e[0] * xc + e[4] * yc + e[8] * zc + e[12];
        positions[n * 3 + 1] = e[1] * xc + e[5] * yc + e[9] * zc + e[13];
        positions[n * 3 + 2] = e[2] * xc + e[6] * yc + e[10] * zc + e[14];
        colors[n * 3] = f.color[i * 3];
        colors[n * 3 + 1] = f.color[i * 3 + 1];
        colors[n * 3 + 2] = f.color[i * 3 + 2];
        cameraIds[n] = f.index;
        n++;
      }
    }
  }

  return { count: n, positions: positions.slice(0, n * 3), colors: colors.slice(0, n * 3), cameraIds: cameraIds.slice(0, n) };
}

const OFFSET = 1 << 16;
const SPAN = 1 << 17;

/** Integer voxel key; exact in a double (< 2^51) for |index| < 2^16 per axis. */
export function voxelKey(ix: number, iy: number, iz: number): number {
  return (ix + OFFSET) + (iy + OFFSET) * SPAN + (iz + OFFSET) * SPAN * SPAN;
}

/** Averages position and color of all points that fall into the same voxel. */
export function voxelDownsample(cloud: PointCloud, voxelSize: number): PointCloud {
  if (!(voxelSize > 0)) return cloud;
  const inv = 1 / voxelSize;
  const slot = new Map<number, number>();
  const sums = new Float64Array(cloud.count * 7); // x y z r g b count, upper bound on voxels
  const ids = new Uint16Array(cloud.count);
  let m = 0;
  const p = cloud.positions;
  const c = cloud.colors;
  for (let i = 0; i < cloud.count; i++) {
    const key = voxelKey(Math.floor(p[i * 3] * inv), Math.floor(p[i * 3 + 1] * inv), Math.floor(p[i * 3 + 2] * inv));
    let s = slot.get(key);
    if (s === undefined) {
      s = m++;
      slot.set(key, s);
      ids[s] = cloud.cameraIds[i];
    }
    const o = s * 7;
    sums[o] += p[i * 3];
    sums[o + 1] += p[i * 3 + 1];
    sums[o + 2] += p[i * 3 + 2];
    sums[o + 3] += c[i * 3];
    sums[o + 4] += c[i * 3 + 1];
    sums[o + 5] += c[i * 3 + 2];
    sums[o + 6] += 1;
  }
  const positions = new Float32Array(m * 3);
  const colors = new Float32Array(m * 3);
  for (let s = 0; s < m; s++) {
    const o = s * 7;
    const k = 1 / sums[o + 6];
    for (let a = 0; a < 3; a++) {
      positions[s * 3 + a] = sums[o + a] * k;
      colors[s * 3 + a] = sums[o + 3 + a] * k;
    }
  }
  return { count: m, positions, colors, cameraIds: ids.slice(0, m) };
}

export function reconstruct(frames: CaptureFrame[], params: FusionParams): PointCloud {
  return voxelDownsample(backProject(frames, params), params.voxelSize);
}
