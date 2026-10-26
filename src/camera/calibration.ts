import * as THREE from 'three';
import { gaussian } from '../util/random';
import type { CameraModel } from './models';

/**
 * Real rigs are never calibrated perfectly. Reconstruction only knows the *estimated*
 * calibration, while the images were formed by the true one. These are the errors
 * between the two.
 */
export interface CalibrationError {
  /** σ of camera position error per axis (mm). */
  positionMm: number;
  /** σ of camera rotation error (degrees, random axis). */
  rotationDeg: number;
  /** σ of focal length error (% of focal length). */
  focalPct: number;
  /** σ of principal point error (pixels). */
  principalPx: number;
}

export const PERFECT_CALIBRATION: CalibrationError = { positionMm: 0, rotationDeg: 0, focalPct: 0, principalPx: 0 };

export function perturbPose(cameraToWorld: THREE.Matrix4, err: CalibrationError, rand: () => number): THREE.Matrix4 {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  cameraToWorld.decompose(pos, quat, scale);
  const s = err.positionMm / 1000;
  pos.x += gaussian(rand) * s;
  pos.y += gaussian(rand) * s;
  pos.z += gaussian(rand) * s;
  const axis = new THREE.Vector3(gaussian(rand), gaussian(rand), gaussian(rand)).normalize();
  const angle = gaussian(rand) * err.rotationDeg * (Math.PI / 180);
  quat.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  return new THREE.Matrix4().compose(pos, quat, scale);
}

export function perturbModel(model: CameraModel, err: CalibrationError, rand: () => number): CameraModel {
  const f = 1 + (gaussian(rand) * err.focalPct) / 100;
  return {
    ...model,
    dist: [...model.dist],
    fx: model.fx * f,
    fy: model.fy * f,
    cx: model.cx + gaussian(rand) * err.principalPx,
    cy: model.cy + gaussian(rand) * err.principalPx,
  };
}
