import * as THREE from 'three';
import { computeLayout, type RigLayoutParams } from './layouts';

export interface RigConfig extends RigLayoutParams {
  centerX: number;
  centerY: number;
  centerZ: number;
  /** Vertical field of view (degrees). */
  fovDeg: number;
  width: number;
  height: number;
  near: number;
  far: number;
}

/** Pinhole intrinsics in pixels, OpenCV-style (origin at the top-left pixel corner). */
export interface Intrinsics {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** Layer used for debug geometry (frustums, point cloud) that capture cameras must not see. */
export const HELPER_LAYER = 1;

export function cameraColor(index: number, count: number): THREE.Color {
  return new THREE.Color().setHSL(index / Math.max(1, count), 0.85, 0.55);
}

export function intrinsicsFor(config: Pick<RigConfig, 'fovDeg' | 'width' | 'height'>): Intrinsics {
  const fy = config.height / 2 / Math.tan((config.fovDeg * Math.PI) / 360);
  return { width: config.width, height: config.height, fx: fy, fy, cx: config.width / 2, cy: config.height / 2 };
}

/** Small frustum pyramid drawn in camera-local space. */
function frustumLines(config: RigConfig, color: THREE.Color, length: number): THREE.LineSegments {
  const k = intrinsicsFor(config);
  const hx = ((k.width / 2) / k.fx) * length;
  const hy = ((k.height / 2) / k.fy) * length;
  const z = -length;
  const c = [
    [-hx, -hy, z],
    [hx, -hy, z],
    [hx, hy, z],
    [-hx, hy, z],
  ];
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    v.push(0, 0, 0, ...c[i]);
    v.push(...c[i], ...c[(i + 1) % 4]);
  }
  // "Up" tick so orientation is readable.
  v.push(-hx * 0.4, hy, z, 0, hy * 1.4, z, 0, hy * 1.4, z, hx * 0.4, hy, z);
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

  get intrinsics(): Intrinsics {
    return intrinsicsFor(this.config);
  }

  rebuild(config: RigConfig): void {
    this.config = { ...config };
    this.disposeChildren();

    const poses = computeLayout(config, this.center);
    this.cameras = poses.map((pose, i) => {
      const cam = new THREE.PerspectiveCamera(config.fovDeg, config.width / config.height, config.near, config.far);
      cam.name = `cam_${String(i).padStart(3, '0')}`;
      cam.position.copy(pose.position);
      cam.quaternion.copy(pose.quaternion);
      cam.add(frustumLines(config, cameraColor(i, poses.length), this.helperLength));
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
