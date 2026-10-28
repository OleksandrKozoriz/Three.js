import { Matrix4, Quaternion, Vector3 } from 'three';

export type RigPreset = 'ring' | 'sphere' | 'cube' | 'eyes';

export interface RigLayoutParams {
  preset: RigPreset;
  /** Number of cameras; for `eyes`, the number of eye pairs. Ignored for `cube`, which always has 6. */
  count: number;
  /** Distance of each camera's optical center (each eye pair's midpoint for `eyes`) from the rig center (m). */
  radius: number;
  /** Ring and eyes: tilt of every camera, positive looks up (degrees). */
  pitchDeg: number;
  /** Eyes only: distance between the two cameras of a pair (m); human eyes are ~0.065. */
  eyeSeparation: number;
  /** Eyes only: toe-in of each camera toward the pair's center line (degrees); 0 = parallel. */
  vergenceDeg: number;
  /** Rotation of the whole rig around the vertical axis (degrees). */
  yawDeg: number;
}

export interface CameraPose {
  position: Vector3;
  quaternion: Quaternion;
  /** Unit viewing direction in world space (the camera's -Z axis). */
  direction: Vector3;
}

const DEG = Math.PI / 180;

/** Viewing directions and their offset directions from the rig center. */
interface Ray {
  view: Vector3;
  offset: Vector3;
}

function ringRays(count: number, pitchDeg: number): Ray[] {
  const rays: Ray[] = [];
  const pitch = pitchDeg * DEG;
  for (let i = 0; i < count; i++) {
    const yaw = (2 * Math.PI * i) / count;
    const offset = new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
    const view = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    rays.push({ view, offset });
  }
  return rays;
}

/** Near-uniform directions on the unit sphere (Fibonacci / golden-angle spiral). */
export function fibonacciDirections(count: number): Vector3[] {
  const dirs: Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    dirs.push(new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r));
  }
  return dirs;
}

/**
 * Pairs of cameras side by side like eyes: pair i faces the i-th ring direction, and its
 * two cameras sit ±separation/2 along the pair's horizontal "right" axis, so their images
 * overlap almost completely (short-baseline stereo, like a human head).
 */
function eyeRays(pairs: number, pitchDeg: number, separation: number, radius: number, vergenceDeg: number): (Ray & { shift: Vector3 })[] {
  const out: (Ray & { shift: Vector3 })[] = [];
  const toeIn = Math.tan(vergenceDeg * DEG);
  for (const { view, offset } of ringRays(pairs, pitchDeg)) {
    const right = new Vector3().crossVectors(offset, UP).normalize();
    for (const side of [-1, 1]) {
      out.push({
        // Toe-in turns each eye toward the other one's side.
        view: view.clone().addScaledVector(right, -side * toeIn).normalize(),
        offset: offset.clone().multiplyScalar(radius),
        shift: right.clone().multiplyScalar((side * separation) / 2),
      });
    }
  }
  return out;
}

function cubeRays(): Ray[] {
  return [
    new Vector3(0, 0, -1),
    new Vector3(1, 0, 0),
    new Vector3(0, 0, 1),
    new Vector3(-1, 0, 0),
    new Vector3(0, 1, 0),
    new Vector3(0, -1, 0),
  ].map((d) => ({ view: d, offset: d.clone() }));
}

const _m = new Matrix4();
const _target = new Vector3();
const UP = new Vector3(0, 1, 0);
const UP_POLE = new Vector3(0, 0, -1);

/** Orientation whose -Z axis points along `direction`, keeping world +Y up where possible. */
export function lookAlong(position: Vector3, direction: Vector3): Quaternion {
  const up = Math.abs(direction.y) > 0.999 ? UP_POLE : UP;
  _target.copy(position).add(direction);
  _m.lookAt(position, _target, up);
  return new Quaternion().setFromRotationMatrix(_m);
}

export function computeLayout(params: RigLayoutParams, center: Vector3): CameraPose[] {
  const yaw = new Quaternion().setFromAxisAngle(UP, params.yawDeg * DEG);
  if (params.preset === 'eyes') {
    const eyes = eyeRays(Math.max(1, Math.round(params.count)), params.pitchDeg, params.eyeSeparation, params.radius, params.vergenceDeg);
    return eyes.map(({ view, offset, shift }) => {
      const direction = view.clone().applyQuaternion(yaw).normalize();
      const position = offset.clone().add(shift).applyQuaternion(yaw).add(center);
      return { position, quaternion: lookAlong(position, direction), direction };
    });
  }

  let rays: Ray[];
  switch (params.preset) {
    case 'ring':
      rays = ringRays(Math.max(1, Math.round(params.count)), params.pitchDeg);
      break;
    case 'sphere':
      rays = fibonacciDirections(Math.max(1, Math.round(params.count))).map((d) => ({ view: d, offset: d.clone() }));
      break;
    case 'cube':
      rays = cubeRays();
      break;
  }

  return rays.map(({ view, offset }) => {
    const direction = view.clone().applyQuaternion(yaw).normalize();
    const position = offset.clone().applyQuaternion(yaw).multiplyScalar(params.radius).add(center);
    return { position, quaternion: lookAlong(position, direction), direction };
  });
}
