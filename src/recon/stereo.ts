import * as THREE from 'three';
import type { CaptureFrame } from '../capture/capture';
import { project, type Vec2 } from '../camera/models';
import { frameRays } from './depthFusion';

/**
 * Plane-sweep multi-view stereo: estimates a range for every pixel of every camera from
 * the images alone (no rendered depth), using only the calibration the rig believes in.
 *
 * For each reference camera and each candidate range r (sampled uniformly in 1/r):
 *   1. put every reference pixel at distance r along its lens ray,
 *   2. project that 3D point into each neighbouring camera and sample its image there,
 *   3. score how well the reference image matches the warped neighbour image with
 *      zero-mean normalized cross-correlation (NCC) over a small window.
 * The range with the best score wins (refined to sub-plane precision), then weak,
 * textureless and geometrically inconsistent pixels are discarded.
 */
export interface StereoParams {
  /** Neighbouring cameras compared with each reference camera. */
  neighbors: number;
  /** Number of range hypotheses (planes) swept; 0 = automatic (≤ 0.5 px disparity step). */
  planes: number;
  minRange: number;
  maxRange: number;
  /** NCC window is (2·radius + 1)² pixels. */
  windowRadius: number;
  /** Minimum NCC score in [-1, 1] to accept a match. */
  minScore: number;
  /** Minimum standard deviation of the reference window (0–1 gray) — rejects flat, ambiguous areas. */
  minTexture: number;
  /** Minimum number of neighbours whose own estimate must agree (0 disables the check). */
  consistencyViews: number;
  /** Relative range difference allowed for two estimates to agree. */
  consistencyTol: number;
}

export type ProgressFn = (done: number, total: number) => void;

interface Neighbor {
  index: number;
  overlap: number;
  baseline: number;
}

/** Gray value in [0, 1] from the 8-bit sRGB image (what a real pipeline would match on). */
function grayImage(frame: CaptureFrame): Float32Array {
  const { width: w, height: h } = frame.model;
  const d = frame.image.data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  return g;
}

/** Bilinear sample with pixel centers at (i + 0.5, j + 0.5). Returns NaN outside the image. */
function sampleBilinear(img: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return NaN;
  const ax = fx - x0;
  const ay = fy - y0;
  const i = y0 * w + x0;
  const top = img[i] + (img[i + 1] - img[i]) * ax;
  const bottom = img[i + w] + (img[i + w + 1] - img[i + w]) * ax;
  return top + (bottom - top) * ay;
}

/** Sum over a (2r+1)² window around each pixel (separable running sums, zero outside the image). */
function boxSum(src: Float32Array, w: number, h: number, r: number, tmp: Float32Array, out: Float32Array): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      const add = x + r + 1;
      const sub = x - r;
      if (add < w) s += src[row + add];
      if (sub >= 0) s -= src[row + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      const add = y + r + 1;
      const sub = y - r;
      if (add < h) s += tmp[add * w + x];
      if (sub >= 0) s -= tmp[sub * w + x];
    }
  }
}

function cameraCenter(frame: CaptureFrame): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(frame.cameraToWorld);
}

/**
 * Picks the cameras that see the most of the reference view (tested on a grid of rays
 * placed at a typical range) and are not at the same position (zero baseline = no depth).
 */
export function selectNeighbors(frames: CaptureFrame[], ref: CaptureFrame, params: StereoParams): Neighbor[] {
  const rays = frameRays(ref);
  const { width: w, height: h } = ref.model;
  const probeRange = Math.sqrt(params.minRange * params.maxRange);
  const refCenter = cameraCenter(ref);
  const out: Neighbor[] = [];
  const p = new THREE.Vector3();
  const pix: Vec2 = { x: 0, y: 0 };
  for (const other of frames) {
    if (other === ref) continue;
    const baseline = cameraCenter(other).distanceTo(refCenter);
    if (baseline < 1e-3) continue;
    const worldToOther = other.cameraToWorld.clone().invert();
    let seen = 0;
    let total = 0;
    for (let v = 4; v < h; v += Math.max(1, Math.floor(h / 16))) {
      for (let u = 4; u < w; u += Math.max(1, Math.floor(w / 16))) {
        const i = (v * w + u) * 4;
        if (!rays[i + 3]) continue;
        total++;
        p.set(rays[i] * probeRange, -rays[i + 1] * probeRange, -rays[i + 2] * probeRange)
          .applyMatrix4(ref.cameraToWorld)
          .applyMatrix4(worldToOther);
        if (project(other.model, p.x, -p.y, -p.z, pix)) seen++;
      }
    }
    const overlap = total ? seen / total : 0;
    if (overlap > 0.05) out.push({ index: other.index, overlap, baseline });
  }
  out.sort((a, b) => b.overlap - a.overlap);
  return out.slice(0, params.neighbors);
}

/**
 * Planes needed so neighbouring hypotheses shift the image by at most half a pixel:
 * disparity ≈ f · B · (1/r), so the sweep spans f · B · (1/r_min − 1/r_max) pixels.
 */
export function planeCount(ref: CaptureFrame, neighbors: Neighbor[], params: StereoParams): number {
  if (params.planes > 0) return Math.max(3, Math.round(params.planes));
  const baseline = Math.max(0, ...neighbors.map((n) => n.baseline));
  const span = ref.model.fx * baseline * (1 / params.minRange - 1 / params.maxRange);
  return Math.min(256, Math.max(16, Math.ceil(span / 0.5)));
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Plane sweep for one reference camera. Returns the raw (unfiltered by consistency) range map. */
async function sweep(
  frames: CaptureFrame[],
  grays: Float32Array[],
  ref: CaptureFrame,
  neighbors: Neighbor[],
  params: StereoParams,
  onPlane: () => void,
): Promise<Float32Array> {
  const { width: w, height: h } = ref.model;
  const n = w * h;
  const rays = frameRays(ref);
  const range = new Float32Array(n);
  if (!neighbors.length) return range;

  const R = params.windowRadius;
  const area = (2 * R + 1) ** 2;
  const D = planeCount(ref, neighbors, params);
  const invNear = 1 / params.minRange;
  const invFar = 1 / params.maxRange;
  const invRange = (k: number) => invFar + ((invNear - invFar) * k) / (D - 1);

  // Reference window statistics.
  const I = grays[ref.index];
  const tmp = new Float32Array(n);
  const sumI = new Float32Array(n);
  const sumII = new Float32Array(n);
  boxSum(I, w, h, R, tmp, sumI);
  boxSum(I.map((x) => x * x), w, h, R, tmp, sumII);
  const meanI = new Float32Array(n);
  const stdI = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    meanI[p] = sumI[p] / area;
    stdI[p] = Math.sqrt(Math.max(0, sumII[p] / area - meanI[p] * meanI[p]));
  }

  // Per neighbour: p_other(r) = r · A + t, where A is the reference ray in the other camera's GL frame.
  const setups = neighbors.map((nb) => {
    const other = frames[nb.index];
    const M = other.cameraToWorld.clone().invert().multiply(ref.cameraToWorld);
    const e = M.elements;
    const A = new Float32Array(n * 3);
    for (let p = 0; p < n; p++) {
      const x = rays[p * 4];
      const y = -rays[p * 4 + 1];
      const z = -rays[p * 4 + 2];
      A[p * 3] = e[0] * x + e[4] * y + e[8] * z;
      A[p * 3 + 1] = e[1] * x + e[5] * y + e[9] * z;
      A[p * 3 + 2] = e[2] * x + e[6] * y + e[10] * z;
    }
    return { other, A, t: [e[12], e[13], e[14]] };
  });

  const volume = new Float32Array(D * n).fill(-2);
  const warped = new Float32Array(n);
  const validW = new Float32Array(n);
  const prod = new Float32Array(n);
  const sq = new Float32Array(n);
  const sumW = new Float32Array(n);
  const sumWW = new Float32Array(n);
  const sumIW = new Float32Array(n);
  const count = new Float32Array(n);
  const scoreSum = new Float32Array(n);
  const scoreN = new Uint8Array(n);
  const pix: Vec2 = { x: 0, y: 0 };

  for (let k = 0; k < D; k++) {
    const r = 1 / invRange(k);
    scoreSum.fill(0);
    scoreN.fill(0);
    for (const { other, A, t } of setups) {
      const g = grays[other.index];
      const { width: ow, height: oh } = other.model;
      for (let p = 0; p < n; p++) {
        warped[p] = 0;
        validW[p] = 0;
        if (!rays[p * 4 + 3]) continue;
        const x = r * A[p * 3] + t[0];
        const y = r * A[p * 3 + 1] + t[1];
        const z = r * A[p * 3 + 2] + t[2];
        if (!project(other.model, x, -y, -z, pix)) continue;
        const s = sampleBilinear(g, ow, oh, pix.x, pix.y);
        if (s !== s) continue; // NaN
        warped[p] = s;
        validW[p] = 1;
      }
      for (let p = 0; p < n; p++) {
        prod[p] = I[p] * warped[p];
        sq[p] = warped[p] * warped[p];
      }
      boxSum(warped, w, h, R, tmp, sumW);
      boxSum(sq, w, h, R, tmp, sumWW);
      boxSum(prod, w, h, R, tmp, sumIW);
      boxSum(validW, w, h, R, tmp, count);
      for (let p = 0; p < n; p++) {
        if (count[p] < area - 0.5) continue; // window must be fully visible in the neighbour
        const mW = sumW[p] / area;
        const sW = Math.sqrt(Math.max(0, sumWW[p] / area - mW * mW));
        const denom = stdI[p] * sW;
        if (denom < 1e-6) continue;
        scoreSum[p] += (sumIW[p] / area - meanI[p] * mW) / denom;
        scoreN[p]++;
      }
    }
    for (let p = 0; p < n; p++) if (scoreN[p]) volume[k * n + p] = scoreSum[p] / scoreN[p];
    onPlane();
    if (k % 4 === 3) await yieldToBrowser();
  }

  // Winner-take-all with parabolic sub-plane refinement (in inverse range).
  for (let p = 0; p < n; p++) {
    if (stdI[p] < params.minTexture) continue;
    let best = -2;
    let kb = -1;
    for (let k = 0; k < D; k++) {
      const s = volume[k * n + p];
      if (s > best) {
        best = s;
        kb = k;
      }
    }
    if (kb <= 0 || kb >= D - 1 || best < params.minScore) continue; // at the sweep's ends = probably out of range
    const s0 = volume[(kb - 1) * n + p];
    const s2 = volume[(kb + 1) * n + p];
    const curv = s0 - 2 * best + s2;
    const offset = curv < 0 && s0 > -2 && s2 > -2 ? Math.max(-0.5, Math.min(0.5, (0.5 * (s0 - s2)) / curv)) : 0;
    range[p] = 1 / invRange(kb + offset);
  }
  return range;
}

/**
 * Geometric consistency (as in COLMAP): keep a pixel only if, for enough neighbours, the
 * neighbour's own estimate at the projected location agrees with the reference point.
 */
function consistencyFilter(frames: CaptureFrame[], raw: Float32Array[], neighbors: Neighbor[][], params: StereoParams): Float32Array[] {
  const out: Float32Array[] = [];
  const p = new THREE.Vector3();
  const pix: Vec2 = { x: 0, y: 0 };
  for (const ref of frames) {
    const { width: w, height: h } = ref.model;
    const rays = frameRays(ref);
    const src = raw[ref.index];
    const dst = new Float32Array(w * h);
    const others = neighbors[ref.index].map((nb) => {
      const f = frames[nb.index];
      return { f, inv: f.cameraToWorld.clone().invert(), center: cameraCenter(f) };
    });
    for (let i = 0; i < w * h; i++) {
      const r = src[i];
      if (!(r > 0)) continue;
      if (params.consistencyViews <= 0) {
        dst[i] = r;
        continue;
      }
      const world = new THREE.Vector3(rays[i * 4] * r, -rays[i * 4 + 1] * r, -rays[i * 4 + 2] * r).applyMatrix4(ref.cameraToWorld);
      let agree = 0;
      for (const { f, inv, center } of others) {
        p.copy(world).applyMatrix4(inv);
        if (!project(f.model, p.x, -p.y, -p.z, pix)) continue;
        const j = Math.floor(pix.y) * f.model.width + Math.floor(pix.x);
        const rj = raw[f.index][j];
        if (!(rj > 0)) continue;
        const expected = world.distanceTo(center);
        if (Math.abs(rj - expected) <= params.consistencyTol * expected) agree++;
      }
      if (agree >= params.consistencyViews) dst[i] = r;
    }
    out.push(dst);
  }
  return out;
}

/** Runs multi-view stereo for all frames and stores the result in `frame.stereoRange`. */
export async function estimateStereo(frames: CaptureFrame[], params: StereoParams, onProgress?: ProgressFn): Promise<void> {
  const grays = frames.map(grayImage);
  const neighbors = frames.map((f) => selectNeighbors(frames, f, params));
  const total = frames.reduce((sum, f) => sum + planeCount(f, neighbors[f.index], params), 0);
  let done = 0;
  const raw: Float32Array[] = [];
  for (const ref of frames) {
    raw.push(
      await sweep(frames, grays, ref, neighbors[ref.index], params, () => {
        done++;
        onProgress?.(done, total);
      }),
    );
  }
  consistencyFilter(frames, raw, neighbors, params).forEach((r, i) => (frames[i].stereoRange = r));
}
