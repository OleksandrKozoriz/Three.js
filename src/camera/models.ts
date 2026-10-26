/**
 * Lens / camera models, following OpenCV (and COLMAP / nerfstudio) conventions.
 *
 * Camera frame here is the OpenCV one: +X right, +Y DOWN, +Z forward (into the scene).
 * three.js cameras use OpenGL axes (+Y up, looking down -Z); convert with (x, -y, -z).
 *
 * Pixel coordinates are continuous with the top-left corner of the image at (0, 0),
 * so the center of pixel (i, j) is (i + 0.5, j + 0.5).
 */

export type LensType = 'pinhole' | 'fisheye';

export interface LensConfig {
  type: LensType;
  /** Pinhole: vertical FOV of the undistorted model. Fisheye: full angle of the image circle. */
  fovDeg: number;
  /** Radial distortion (both models). */
  k1: number;
  k2: number;
  /** Pinhole only: tangential (decentering) distortion. */
  p1: number;
  p2: number;
  /** Fisheye only: higher-order radial terms. */
  k3: number;
  k4: number;
}

export interface CameraModel {
  type: LensType;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** OpenCV coefficient order: pinhole [k1, k2, p1, p2] ("OPENCV"), fisheye [k1, k2, k3, k4] ("OPENCV_FISHEYE"). */
  dist: [number, number, number, number];
  /** Largest valid angle between a ray and the optical axis (radians). */
  maxTheta: number;
  /** cos(maxTheta), cached for the validity test. */
  cosMaxTheta: number;
}

export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
const _check: Vec2 = { x: 0, y: 0 };

/** θ_d = θ (1 + k1 θ² + k2 θ⁴ + k3 θ⁶ + k4 θ⁸) — Kannala–Brandt / OpenCV fisheye. */
function fisheyeThetaD(theta: number, d: CameraModel['dist']): number {
  const t2 = theta * theta;
  return theta * (1 + t2 * (d[0] + t2 * (d[1] + t2 * (d[2] + t2 * d[3]))));
}

/**
 * Largest normalized radius r up to which the radial distortion r (1 + k1 r² + k2 r⁴)
 * keeps increasing. Past that point barrel distortion "folds" the image back on itself
 * and the projection is no longer one-to-one, so rays beyond it are treated as invalid.
 */
function monotonicRadius(k1: number, k2: number, limit: number): number {
  const step = 1e-3;
  for (let r = step; r < limit; r += step) {
    const r2 = r * r;
    if (1 + 3 * k1 * r2 + 5 * k2 * r2 * r2 <= 0) return r - step;
  }
  return limit;
}

export function buildModel(lens: LensConfig, width: number, height: number): CameraModel {
  let model: CameraModel;
  if (lens.type === 'pinhole') {
    const fov = Math.min(Math.max(lens.fovDeg, 1), 170) * DEG;
    const fy = height / 2 / Math.tan(fov / 2);
    const fx = fy;
    // Image corners bound the useful field; allow a margin and stop where distortion folds.
    const cornerR = Math.hypot(width / 2 / fx, height / 2 / fy) * 1.5;
    const rMax = monotonicRadius(lens.k1, lens.k2, cornerR);
    model = {
      type: 'pinhole',
      width,
      height,
      fx,
      fy,
      cx: width / 2,
      cy: height / 2,
      dist: [lens.k1, lens.k2, lens.p1, lens.p2],
      maxTheta: Math.atan(rMax),
      cosMaxTheta: 0,
    };
  } else {
    const maxTheta = (Math.min(Math.max(lens.fovDeg, 10), 240) * DEG) / 2;
    const dist: CameraModel['dist'] = [lens.k1, lens.k2, lens.k3, lens.k4];
    // The image circle (θ = maxTheta) exactly fits the image height.
    const f = height / 2 / fisheyeThetaD(maxTheta, dist);
    model = { type: 'fisheye', width, height, fx: f, fy: f, cx: width / 2, cy: height / 2, dist, maxTheta, cosMaxTheta: 0 };
  }
  model.cosMaxTheta = Math.cos(model.maxTheta);
  return model;
}

/**
 * Projects a point in the OpenCV camera frame to continuous pixel coordinates.
 * Returns false if the point is outside the lens' field of view or outside the image.
 */
export function project(m: CameraModel, x: number, y: number, z: number, out: Vec2): boolean {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!(len > 0) || z < len * m.cosMaxTheta) return false;
  const d = m.dist;
  let xd: number;
  let yd: number;
  if (m.type === 'pinhole') {
    const xn = x / z;
    const yn = y / z;
    const r2 = xn * xn + yn * yn;
    const radial = 1 + r2 * (d[0] + r2 * d[1]);
    xd = xn * radial + 2 * d[2] * xn * yn + d[3] * (r2 + 2 * xn * xn);
    yd = yn * radial + d[2] * (r2 + 2 * yn * yn) + 2 * d[3] * xn * yn;
  } else {
    const r = Math.sqrt(x * x + y * y);
    if (r < 1e-12) {
      xd = 0;
      yd = 0;
    } else {
      const s = fisheyeThetaD(Math.atan2(r, z), d) / r;
      xd = x * s;
      yd = y * s;
    }
  }
  out.x = m.fx * xd + m.cx;
  out.y = m.fy * yd + m.cy;
  return out.x >= 0 && out.y >= 0 && out.x < m.width && out.y < m.height;
}

/**
 * Inverts `project`: continuous pixel coordinates → unit ray in the OpenCV camera frame.
 * Distortion has no closed-form inverse, so it is solved iteratively.
 */
export function unproject(m: CameraModel, u: number, v: number, out: Vec3): boolean {
  const xd = (u - m.cx) / m.fx;
  const yd = (v - m.cy) / m.fy;
  const d = m.dist;
  if (m.type === 'pinhole') {
    // Fixed-point iteration (as in OpenCV's undistortPoints).
    let x = xd;
    let y = yd;
    for (let i = 0; i < 30; i++) {
      const r2 = x * x + y * y;
      const radial = 1 + r2 * (d[0] + r2 * d[1]);
      const dx = 2 * d[2] * x * y + d[3] * (r2 + 2 * x * x);
      const dy = d[2] * (r2 + 2 * y * y) + 2 * d[3] * x * y;
      x = (xd - dx) / radial;
      y = (yd - dy) / radial;
    }
    const n = Math.sqrt(x * x + y * y + 1);
    out.x = x / n;
    out.y = y / n;
    out.z = 1 / n;
  } else {
    const thetaD = Math.sqrt(xd * xd + yd * yd);
    if (thetaD < 1e-12) {
      out.x = 0;
      out.y = 0;
      out.z = 1;
      return true;
    }
    // Newton's method on f(θ) = θ_d(θ) − θ_d.
    let theta = Math.min(thetaD, m.maxTheta * 1.2);
    for (let i = 0; i < 20; i++) {
      const t2 = theta * theta;
      const f = fisheyeThetaD(theta, d) - thetaD;
      const df = 1 + t2 * (3 * d[0] + t2 * (5 * d[1] + t2 * (7 * d[2] + t2 * 9 * d[3])));
      theta -= f / df;
    }
    if (!(theta >= 0) || theta > m.maxTheta) return false;
    const s = Math.sin(theta) / thetaD;
    out.x = xd * s;
    out.y = yd * s;
    out.z = Math.cos(theta);
  }
  if (out.z < m.cosMaxTheta - 1e-9) return false;
  // Reject pixels where the iteration did not converge (e.g. beyond a distortion fold).
  if (!project(m, out.x, out.y, out.z, _check)) return false;
  return Math.abs(_check.x - u) < 1e-3 && Math.abs(_check.y - v) < 1e-3;
}

/**
 * Unit ray for the center of every pixel, row-major with the top row first.
 * 4 floats per pixel: (x, y, z) in the OpenCV camera frame, and 1 = valid / 0 = outside the lens.
 */
export function rayMap(m: CameraModel): Float32Array {
  const out = new Float32Array(m.width * m.height * 4);
  const r = { x: 0, y: 0, z: 0 };
  for (let v = 0; v < m.height; v++) {
    for (let u = 0; u < m.width; u++) {
      const i = (v * m.width + u) * 4;
      if (unproject(m, u + 0.5, v + 0.5, r)) {
        out[i] = r.x;
        out[i + 1] = r.y;
        out[i + 2] = r.z;
        out[i + 3] = 1;
      }
    }
  }
  return out;
}

export interface LensPreset {
  name: string;
  lens: LensConfig;
}

/** Generic lenses, roughly modeled on common hardware classes (not exact calibrations). */
export const LENS_PRESETS: LensPreset[] = [
  { name: 'Ideal pinhole 70°', lens: { type: 'pinhole', fovDeg: 70, k1: 0, k2: 0, p1: 0, p2: 0, k3: 0, k4: 0 } },
  { name: 'Webcam (~60°, mild barrel)', lens: { type: 'pinhole', fovDeg: 60, k1: -0.08, k2: 0.02, p1: 0.0005, p2: -0.0003, k3: 0, k4: 0 } },
  { name: 'Wide module (~80° v, strong barrel)', lens: { type: 'pinhole', fovDeg: 80, k1: -0.22, k2: 0.05, p1: 0.0008, p2: 0.0004, k3: 0, k4: 0 } },
  { name: 'Action cam fisheye 160°', lens: { type: 'fisheye', fovDeg: 160, k1: 0.02, k2: -0.005, p1: 0, p2: 0, k3: 0.001, k4: 0 } },
  { name: '360 cam fisheye 200°', lens: { type: 'fisheye', fovDeg: 200, k1: 0.01, k2: -0.002, p1: 0, p2: 0, k3: 0, k4: 0 } },
];
