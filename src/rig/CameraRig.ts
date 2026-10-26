import * as THREE from 'three';
import { computeLayout, type RigLayoutParams } from './layouts';
import { buildModel, unproject, type CameraModel, type LensConfig, type Vec3 } from '../camera/models';

export interface RigConfig extends RigLayoutParams {
  centerX: number;
  centerY: number;
  centerZ: number;
  lens: LensConfig;
  width: number;
  height: number;
  near: number;
  far: number;
}

/** Layer used for debug geometry (frustums, point cloud) that capture cameras must not see. */
export const HELPER_LAYER = 1;

export function cameraColor(index: number, count: number): THREE.Color {
  return new THREE.Color().setHSL(index / Math.max(1, count), 0.85, 0.55);
}

/**
 * Field-of-view outline drawn in camera-local (OpenGL) space: a pyramid through the image
 * corners for pinhole lenses, a cone at the image-circle angle for fisheye lenses.
 */
function frustumLines(model: CameraModel, color: THREE.Color, length: number): THREE.LineSegments {
  const edge: Vec3[] = [];
  const r: Vec3 = { x: 0, y: 0, z: 0 };
  if (model.type === 'pinhole') {
    const e = 0.5;
    for (const [u, v] of [[e, e], [model.width - e, e], [model.width - e, model.height - e], [e, model.height - e]]) {
      if (unproject(model, u, v, r)) edge.push({ ...r });
    }
  }
  if (edge.length < 4) {
    edge.length = 0;
    const t = model.maxTheta;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      edge.push({ x: Math.sin(t) * Math.cos(a), y: Math.sin(t) * Math.sin(a), z: Math.cos(t) });
    }
  }
  // OpenCV → OpenGL camera axes, scaled to `length`.
  const pts = edge.map((d) => [d.x * length, -d.y * length, -d.z * length]);
  const v: number[] = [];
  pts.forEach((p, i) => {
    if (pts.length === 4 || i % 3 === 0) v.push(0, 0, 0, ...p);
    v.push(...p, ...pts[(i + 1) % pts.length]);
  });
  // "Up" tick so orientation is readable.
  v.push(0, 0, 0, 0, length * 0.6, -length * 0.3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
  lines.layers.set(HELPER_LAYER);
  return lines;
}

export class CameraRig {
  readonly group = new THREE.Group();
  cameras: THREE.PerspectiveCamera[] = [];
  config!: RigConfig;
  private helperLength = 0.25;

  constructor(config: RigConfig) {
    this.group.name = 'camera-rig';
    this.rebuild(config);
  }

  get center(): THREE.Vector3 {
    return new THREE.Vector3(this.config.centerX, this.config.centerY, this.config.centerZ);
  }

  /** True lens model shared by all cameras. */
  get model(): CameraModel {
    return buildModel(this.config.lens, this.config.width, this.config.height);
  }

  rebuild(config: RigConfig): void {
    this.config = { ...config, lens: { ...config.lens } };
    this.disposeChildren();

    const poses = computeLayout(config, this.center);
    const model = this.model;
    this.cameras = poses.map((pose, i) => {
      // Pose holder (and handy for "look through camera" debugging); images are formed by the lens model.
      const fovDeg = (2 * Math.atan(config.height / 2 / model.fy) * 180) / Math.PI;
      const cam = new THREE.PerspectiveCamera(fovDeg, config.width / config.height, config.near, config.far);
      cam.name = `cam_${String(i).padStart(3, '0')}`;
      cam.position.copy(pose.position);
      cam.quaternion.copy(pose.quaternion);
      cam.add(frustumLines(model, cameraColor(i, poses.length), this.helperLength));
      this.group.add(cam);
      return cam;
    });

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.02, config.radius * 0.3), 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }),
    );
    marker.position.copy(this.center);
    marker.layers.set(HELPER_LAYER);
    this.group.add(marker);

    this.group.updateMatrixWorld(true);
  }

  setHelpersVisible(visible: boolean): void {
    this.group.traverse((o) => {
      if (o.layers.isEnabled(HELPER_LAYER) && o !== this.group) o.visible = visible;
    });
  }

  private disposeChildren(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.clear();
    this.cameras = [];
  }
}
