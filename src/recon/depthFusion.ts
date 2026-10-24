import type { CaptureFrame } from '../capture/capture';

export interface FusionParams {
  /** Use every n-th pixel in x and y. */
  stride: number;
  /** Std-dev of Gaussian depth noise in meters (simulates an imperfect depth estimate). */
  noiseSigma: number;
  /** Additional noise proportional to depth² (m⁻¹), like stereo depth error. 0 disables. */
  noiseQuadratic: number;
  /** Merge points into voxels of this size (m). 0 disables. */
  voxelSize: number;
  /** Ignore depths beyond this distance (m). */
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

/** Standard normal sample (Box–Muller). */
function gaussian(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * Back-projects every (strided) pixel with a valid depth into world space:
 *   p_cam = ((u - cx) z / fx, -(v - cy) z / fy, -z)     (OpenGL camera axes)
 *   p_world = cameraToWorld · p_cam
 */
export function backProject(frames: CaptureFrame[], params: FusionParams): PointCloud {
  const stride = Math.max(1, Math.round(params.stride));
  let capacity = 0;
  for (const f of frames) capacity += Math.ceil(f.intrinsics.width / stride) * Math.ceil(f.intrinsics.height / stride);

  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const cameraIds = new Uint16Array(capacity);
  let n = 0;

  for (const f of frames) {
    const { width: w, height: h, fx, fy, cx, cy } = f.intrinsics;
    const e = f.cameraToWorld.elements; // column-major
    const zMax = Math.min(params.maxDepth, f.far * 0.999);
    for (let v = 0; v < h; v += stride) {
      for (let u = 0; u < w; u += stride) {
        const i = v * w + u;
        let z = f.depth[i];
        if (!(z > 0) || z >= zMax) continue;
        if (params.noiseSigma > 0 || params.noiseQuadratic > 0) {
          z += gaussian() * (params.noiseSigma + params.noiseQuadratic * z * z);
          if (z <= f.near) continue;
        }
        const xc = ((u + 0.5 - cx) * z) / fx;
        const yc = ((cy - (v + 0.5)) * z) / fy;
        const zc = -z;
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
