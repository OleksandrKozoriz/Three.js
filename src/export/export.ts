import type * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import type { CaptureFrame } from '../capture/capture';
import type { PointCloud } from '../recon/depthFusion';
import type { RigConfig } from '../rig/CameraRig';
import type { CameraModel } from '../camera/models';
import { linearToSrgbByte } from '../camera/sensor';
import type { Settings } from '../ui/gui';

function download(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Binary little-endian PLY with float xyz and uchar sRGB colors. */
export function pointCloudToPly(cloud: PointCloud): Uint8Array {
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${cloud.count}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const head = strToU8(header);
  const stride = 15;
  const out = new Uint8Array(head.length + cloud.count * stride);
  out.set(head);
  const view = new DataView(out.buffer, head.length);
  for (let i = 0; i < cloud.count; i++) {
    const o = i * stride;
    view.setFloat32(o, cloud.positions[i * 3], true);
    view.setFloat32(o + 4, cloud.positions[i * 3 + 1], true);
    view.setFloat32(o + 8, cloud.positions[i * 3 + 2], true);
    view.setUint8(o + 12, linearToSrgbByte(cloud.colors[i * 3]));
    view.setUint8(o + 13, linearToSrgbByte(cloud.colors[i * 3 + 1]));
    view.setUint8(o + 14, linearToSrgbByte(cloud.colors[i * 3 + 2]));
  }
  return out;
}

async function imageToPng(image: ImageData): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** Row-major 4x4 (as used by NeRF / nerfstudio transforms.json). */
function rowMajor(m: THREE.Matrix4): number[][] {
  const e = m.elements;
  return [0, 1, 2, 3].map((r) => [e[r], e[r + 4], e[r + 8], e[r + 12]]);
}

/** Intrinsics in nerfstudio / COLMAP naming. */
function intrinsicsJson(m: CameraModel) {
  const [a, b, c, d] = m.dist;
  return {
    camera_model: m.type === 'pinhole' ? 'OPENCV' : 'OPENCV_FISHEYE',
    fl_x: m.fx,
    fl_y: m.fy,
    cx: m.cx,
    cy: m.cy,
    w: m.width,
    h: m.height,
    ...(m.type === 'pinhole' ? { k1: a, k2: b, p1: c, p2: d } : { k1: a, k2: b, k3: c, k4: d }),
  };
}

/**
 * nerfstudio-compatible `transforms.json` with the calibration a real rig would have
 * (including the simulated calibration error). Poses use the OpenGL camera convention.
 * Range maps are raw little-endian float32, row-major, top row first: distance in meters
 * from the optical center along each pixel's ray (not z-depth), 0 = no value.
 */
export function buildTransforms(frames: CaptureFrame[], rig: RigConfig) {
  return {
    ...intrinsicsJson(frames[0].model),
    units: 'meters',
    depth_format: 'float32 little-endian, row-major, top row first, range along the pixel ray in meters, 0 = no value',
    rig,
    frames: frames.map((f) => ({
      file_path: `images/${f.name}.png`,
      depth_file_path: `depth/${f.name}.f32`,
      ...(f.stereoRange ? { stereo_depth_file_path: `depth_stereo/${f.name}.f32` } : {}),
      camera_index: f.index,
      ...intrinsicsJson(f.model),
      transform_matrix: rowMajor(f.cameraToWorld),
    })),
  };
}

/** The true calibration the images were rendered with, plus all simulation settings. */
export function buildGroundTruth(frames: CaptureFrame[], settings: Settings) {
  return {
    note: 'True camera parameters used to render the images. A real rig would not know these.',
    settings,
    frames: frames.map((f) => ({
      name: f.name,
      ...intrinsicsJson(f.trueModel),
      transform_matrix: rowMajor(f.trueCameraToWorld),
    })),
  };
}

export async function downloadDataset(frames: CaptureFrame[], rig: RigConfig, settings: Settings, cloud?: PointCloud): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  for (const f of frames) {
    files[`images/${f.name}.png`] = await imageToPng(f.image);
    files[`depth/${f.name}.f32`] = new Uint8Array(f.range.buffer.slice(0));
    if (f.stereoRange) files[`depth_stereo/${f.name}.f32`] = new Uint8Array(f.stereoRange.buffer.slice(0));
  }
  files['transforms.json'] = strToU8(JSON.stringify(buildTransforms(frames, rig), null, 2));
  files['ground_truth.json'] = strToU8(JSON.stringify(buildGroundTruth(frames, settings), null, 2));
  if (cloud) files['pointcloud.ply'] = pointCloudToPly(cloud);
  download(zipSync(files, { level: 6 }) as BlobPart, 'inside-out-capture.zip', 'application/zip');
}

export function downloadPly(cloud: PointCloud): void {
  download(pointCloudToPly(cloud) as BlobPart, 'pointcloud.ply', 'application/octet-stream');
}
