import * as THREE from 'three';
import { HELPER_LAYER, cameraColor } from '../rig/CameraRig';
import type { PointCloud } from './depthFusion';

export type ColorMode = 'rgb' | 'camera';

export class PointCloudView {
  readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;
  private cloud?: PointCloud;
  private cameraCount = 1;

  constructor() {
    this.material = new THREE.PointsMaterial({ size: 0.02, vertexColors: true, sizeAttenuation: true });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.name = 'reconstruction';
    this.points.frustumCulled = false;
    this.points.layers.set(HELPER_LAYER);
  }

  set size(value: number) {
    this.material.size = value;
  }

  setCloud(cloud: PointCloud, cameraCount: number, mode: ColorMode): void {
    this.cloud = cloud;
    this.cameraCount = cameraCount;
    this.points.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cloud.count * 3), 3));
    this.points.geometry = geometry;
    this.setColorMode(mode);
  }

  setColorMode(mode: ColorMode): void {
    if (!this.cloud) return;
    const attr = this.points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    if (mode === 'rgb') {
      out.set(this.cloud.colors);
    } else {
      const palette = Array.from({ length: this.cameraCount }, (_, i) => cameraColor(i, this.cameraCount));
      for (let i = 0; i < this.cloud.count; i++) {
        const c = palette[this.cloud.cameraIds[i]] ?? palette[0];
        out[i * 3] = c.r;
        out[i * 3 + 1] = c.g;
        out[i * 3 + 2] = c.b;
      }
    }
    attr.needsUpdate = true;
  }

  get hasCloud(): boolean {
    return !!this.cloud;
  }
}
