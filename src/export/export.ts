import { zipSync, strToU8 } from 'fflate';
import type { CaptureFrame } from '../capture/capture';
import type { PointCloud } from '../recon/depthFusion';
import type { RigConfig } from '../rig/CameraRig';

function download(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function srgbByte(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
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
    view.setUint8(o + 12, srgbByte(cloud.colors[i * 3]));
    view.setUint8(o + 13, srgbByte(cloud.colors[i * 3 + 1]));
    view.setUint8(o + 14, srgbByte(cloud.colors[i * 3 + 2]));
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
function rowMajor(frame: CaptureFrame): number[][] {
  const e = frame.cameraToWorld.elements;
  return [0, 1, 2, 3].map((r) => [e[r], e[r + 4], e[r + 8], e[r + 12]]);
}

/**
 * NeRF/nerfstudio-compatible `transforms.json` (OpenGL camera convention).
 * Depth maps are raw little-endian float32, row-major, top row first, meters along the optical axis.
 */
export function buildTransforms(frames: CaptureFrame[], rig: RigConfig) {
  const k = frames[0].intrinsics;
  return {
    camera_model: 'OPENCV',
    fl_x: k.fx,
    fl_y: k.fy,
    cx: k.cx,
    cy: k.cy,
    w: k.width,
    h: k.height,
    k1: 0,
    k2: 0,
    p1: 0,
    p2: 0,
    camera_angle_x: 2 * Math.atan(k.width / 2 / k.fx),
    camera_angle_y: 2 * Math.atan(k.height / 2 / k.fy),
    units: 'meters',
    depth_format: 'float32 little-endian, row-major, top row first, view-space z in meters, 0 = no hit',
    rig,
    frames: frames.map((f) => ({
      file_path: `images/${f.name}.png`,
      depth_file_path: `depth/${f.name}.f32`,
      camera_index: f.index,
      transform_matrix: rowMajor(f),
    })),
  };
}

export async function downloadDataset(frames: CaptureFrame[], rig: RigConfig, cloud?: PointCloud): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  for (const f of frames) {
    files[`images/${f.name}.png`] = await imageToPng(f.image);
    files[`depth/${f.name}.f32`] = new Uint8Array(f.depth.buffer.slice(0));
  }
  files['transforms.json'] = strToU8(JSON.stringify(buildTransforms(frames, rig), null, 2));
  if (cloud) files['pointcloud.ply'] = pointCloudToPly(cloud);
  download(zipSync(files, { level: 6 }) as BlobPart, 'inside-out-capture.zip', 'application/zip');
}

export function downloadPly(cloud: PointCloud): void {
  download(pointCloudToPly(cloud) as BlobPart, 'pointcloud.ply', 'application/octet-stream');
}
