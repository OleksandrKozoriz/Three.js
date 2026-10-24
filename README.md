# Inside-out reconstruction testbed (three.js)

A virtual environment for testing **inside-out 3D scene reconstruction**: a rig of cameras sits *inside* a space, each camera looks outward, and the captured images are turned back into a 3D model of the surroundings.

Before building real hardware, this app lets you:

1. Put a configurable camera rig (ring, sphere, or cube layout; any number of cameras) inside a procedural room.
2. **Capture** color and depth images from every camera.
3. **Reconstruct** a colored point cloud by back-projecting the depth images (depth fusion).
4. **Evaluate** the result against the ground-truth room geometry (precision, completeness, F-score).
5. **Export** the dataset (images, depth, camera poses in NeRF/nerfstudio `transforms.json` format, point cloud PLY) for external tools.

## Running

```bash
npm install
npm run dev        # open the printed URL
npm run build      # type-check + production build into dist/
npm run test:smoke # headless end-to-end check (needs Playwright + Chromium)
```

Requires a browser with WebGL2 and `EXT_color_buffer_float` (all current desktop browsers).

## Using it

- **▶ Capture + reconstruct + evaluate** runs the whole pipeline with the current settings.
- **Camera rig**: layout, number of cameras, rig radius (distance of each lens from the rig center), ring pitch, rig yaw, rig position in the room, vertical FOV, image resolution, near/far planes. Changing any of these rebuilds the rig. Re-run capture afterwards.
- **Reconstruction**: pixel stride, simulated depth noise (constant σ plus a term ∝ z², like stereo depth error), voxel merging, max depth.
- **Evaluation**: distance threshold τ and number of ground-truth surface samples.
- **View**: hide the room or make it translucent to compare the point cloud with the real geometry, toggle camera frustums, color points by RGB or by the camera that saw them (useful for checking overlap between neighbouring cameras).
- The sidebar shows the metrics and a thumbnail of every captured image.

The app is exposed as `window.app` for experiments from the devtools console:

```js
Object.assign(app.settings.rig, { preset: 'sphere', count: 24, fovDeg: 80 });
app.rebuildRig();
app.runAll(); // → { precision, completeness, fscore, meanError, ... }
```

## Metrics

With threshold τ (default 5 cm):

| Metric | Meaning |
| --- | --- |
| Precision | Fraction of reconstructed points within τ of the ground-truth surface. Should be ~100% without noise; a drop means wrong geometry. |
| Completeness | Fraction of ground-truth surface samples within τ of the reconstruction. Limited by what the rig can see: surfaces behind furniture or under the table are occluded from a single rig position. |
| F-score | Harmonic mean of the two. |
| Mean error | Mean distance from inlier points to the nearest ground-truth *sample*. It includes the spacing of the random surface samples (~15 mm at 300k samples), so compare it between runs rather than reading it as absolute error. |

Example (default room, rig at 1.4 m height, 320×240 images, no noise):

| Rig | Precision | Completeness | F-score |
| --- | --- | --- | --- |
| ring, 4 cams, 70° | 99.99% | 56.0% | 71.8% |
| ring, 8 cams, 70° | 99.98% | 62.9% | 77.2% |
| cube, 6 cams, 90° | 99.98% | 75.3% | 85.9% |
| sphere, 20 cams, 70° | 99.98% | 77.3% | 87.2% |

## How it works

```
src/
  main.ts               App: renderer, viewer, wiring between steps, sidebar
  scene/room.ts         Procedural textured room (walls, furniture, lights) = ground truth
  rig/layouts.ts        Camera poses for ring / Fibonacci sphere / cube layouts
  rig/CameraRig.ts      PerspectiveCameras + frustum helpers, pinhole intrinsics
  capture/capture.ts    Renders each camera into float render targets, reads back
                        linear RGB and view-space depth (meters)
  recon/depthFusion.ts  Back-projection to world space, depth noise, voxel merging
  recon/PointCloudView.ts  THREE.Points display
  eval/metrics.ts       Area-weighted surface sampling, spatial hash, precision/completeness
  export/export.ts      Zip with PNGs, raw depth, transforms.json, PLY
  ui/gui.ts             lil-gui panel
scripts/smoke-test.mjs  Headless run of several rig configs with pass/fail on precision
```

**Camera model.** Pinhole, square pixels, principal point at the image center:
`fy = (h/2) / tan(fovY/2)`, `fx = fy`, `cx = w/2`, `cy = h/2`. Pixel `(u, v)` is counted from the top-left corner.

**Back-projection.** For a pixel with depth `z` (distance along the optical axis):

```
p_cam   = ((u + 0.5 - cx) · z / fx,  (cy - (v + 0.5)) · z / fy,  -z)   // OpenGL camera: looks down -Z, +Y up
p_world = cameraToWorld · p_cam
```

**Export format** (`inside-out-capture.zip`):

- `images/cam_XXX.png`: sRGB color images.
- `depth/cam_XXX.f32`: raw little-endian float32, row-major, top row first, view-space depth in meters, 0 = no hit.
- `transforms.json`: shared intrinsics (`fl_x`, `fl_y`, `cx`, `cy`, `w`, `h`) and per-frame 4×4 camera-to-world `transform_matrix` in the OpenGL convention used by NeRF / instant-ngp / nerfstudio, plus the rig settings.
- `pointcloud.ply`: binary PLY of the current reconstruction.

## Roadmap

Depth fusion uses perfect rendered depth, so it validates the rig geometry and gives an upper bound. Next steps toward real cameras:

- **RGB-only reconstruction**: estimate depth from the color images alone (plane-sweep stereo between overlapping neighbours, or feature matching + triangulation), and compare against this baseline.
- **Pose estimation**: perturb the rig calibration and recover it (bundle adjustment).
- **More realistic cameras**: fisheye / equirectangular models, lens distortion, sensor noise, exposure differences.
- **Multiple rig positions**: move the rig through the room to fill occluded areas.
- **Surface reconstruction**: TSDF fusion + marching cubes to produce a mesh.
- More scenes (other room layouts, outdoor), loaded from glTF.
