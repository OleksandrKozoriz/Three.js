import * as THREE from 'three';
import { voxelKey } from '../recon/depthFusion';

/**
 * Samples `count` points uniformly (by area) over the world-space surface of all meshes.
 */
export function sampleSurface(meshes: THREE.Mesh[], count: number, rand: () => number = Math.random): Float32Array {
  const tris: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }

  const triTotal = tris.length / 9;
  const cdf = new Float64Array(triTotal);
  const tri = new THREE.Triangle();
  let total = 0;
  for (let t = 0; t < triTotal; t++) {
    const o = t * 9;
    tri.a.set(tris[o], tris[o + 1], tris[o + 2]);
    tri.b.set(tris[o + 3], tris[o + 4], tris[o + 5]);
    tri.c.set(tris[o + 6], tris[o + 7], tris[o + 8]);
    total += tri.getArea();
    cdf[t] = total;
  }

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = rand() * total;
    let lo = 0;
    let hi = triTotal - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    let u = rand();
    let v = rand();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const o = lo * 9;
    for (let k = 0; k < 3; k++) {
      out[i * 3 + k] = tris[o + k] + u * (tris[o + 3 + k] - tris[o + k]) + v * (tris[o + 6 + k] - tris[o + k]);
    }
  }
  return out;
}

/** Uniform grid (CSR layout) for radius-limited nearest-neighbor queries. */
export class SpatialHash {
  private readonly cellOf = new Map<number, number>();
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;
  private readonly inv: number;

  constructor(private readonly points: Float32Array, private readonly cellSize: number) {
    this.inv = 1 / cellSize;
    const n = points.length / 3;
    const cellIds = new Uint32Array(n);
    const counts: number[] = [];
    for (let i = 0; i < n; i++) {
      const key = this.key(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
      let cell = this.cellOf.get(key);
      if (cell === undefined) {
        cell = counts.length;
        this.cellOf.set(key, cell);
        counts.push(0);
      }
      counts[cell]++;
      cellIds[i] = cell;
    }
    this.start = new Uint32Array(counts.length + 1);
    for (let c = 0; c < counts.length; c++) this.start[c + 1] = this.start[c] + counts[c];
    const fill = this.start.slice(0, counts.length);
    this.items = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.items[fill[cellIds[i]]++] = i;
  }

  private key(x: number, y: number, z: number): number {
    return voxelKey(Math.floor(x * this.inv), Math.floor(y * this.inv), Math.floor(z * this.inv));
  }

  /** Distance to the nearest point if it is within `cellSize`, otherwise Infinity. */
  nearest(x: number, y: number, z: number): number {
    const ix = Math.floor(x * this.inv);
    const iy = Math.floor(y * this.inv);
    const iz = Math.floor(z * this.inv);
    let best = this.cellSize * this.cellSize;
    let found = false;
    const p = this.points;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = this.cellOf.get(voxelKey(ix + dx, iy + dy, iz + dz));
          if (cell === undefined) continue;
          for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
            const j = this.items[k] * 3;
            const ddx = p[j] - x;
            const ddy = p[j + 1] - y;
            const ddz = p[j + 2] - z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 <= best) {
              best = d2;
              found = true;
            }
          }
        }
      }
    }
    return found ? Math.sqrt(best) : Infinity;
  }
}

export interface Metrics {
  threshold: number;
  reconPoints: number;
  gtPoints: number;
  /** Fraction of reconstructed points within `threshold` of the ground-truth surface. */
  precision: number;
  /** Fraction of ground-truth surface samples within `threshold` of the reconstruction. */
  completeness: number;
  fscore: number;
  /** Mean distance recon → GT samples, over points within threshold (includes GT sampling spacing). */
  meanError: number;
}

/** Tanks-and-Temples style precision / completeness / F-score at a distance threshold. */
export function evaluate(recon: Float32Array, gt: Float32Array, threshold: number): Metrics {
  const gtHash = new SpatialHash(gt, threshold);
  const nr = recon.length / 3;
  let inliers = 0;
  let errSum = 0;
  for (let i = 0; i < nr; i++) {
    const d = gtHash.nearest(recon[i * 3], recon[i * 3 + 1], recon[i * 3 + 2]);
    if (d <= threshold) {
      inliers++;
      errSum += d;
    }
  }

  const reconHash = new SpatialHash(recon, threshold);
  const ng = gt.length / 3;
  let covered = 0;
  for (let i = 0; i < ng; i++) {
    if (reconHash.nearest(gt[i * 3], gt[i * 3 + 1], gt[i * 3 + 2]) <= threshold) covered++;
  }

  const precision = nr ? inliers / nr : 0;
  const completeness = ng ? covered / ng : 0;
  const fscore = precision + completeness > 0 ? (2 * precision * completeness) / (precision + completeness) : 0;
  return {
    threshold,
    reconPoints: nr,
    gtPoints: ng,
    precision,
    completeness,
    fscore,
    meanError: inliers ? errSum / inliers : NaN,
  };
}
