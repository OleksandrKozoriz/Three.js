# Inside-out reconstruction testbed (three.js)

A virtual environment for testing **inside-out 3D scene reconstruction**: a rig of cameras sits *inside* a space, each camera looks outward, and the captured images are turned back into a 3D model of the surroundings.

Before building real hardware, this app lets you:

1. Put a configurable camera rig (ring, sphere, or cube layout; any number of cameras) inside a procedural room.
2. **Capture** images the way real cameras would: pinhole or fisheye lenses with distortion, a sensor model (blur, vignetting, exposure and white-balance mismatch, noise, 8-bit output), and an imperfect calibration.
3. **Reconstruct** a colored point cloud, with depth either from an ideal depth sensor (upper bound) or estimated from the **images only** with multi-view stereo.
4. **Evaluate** the result against the ground-truth room geometry (precision, completeness, F-score), plus per-pixel stereo accuracy.
5. **Export** the dataset (images, range maps, calibration in nerfstudio/COLMAP-style `transforms.json`, ground truth, point cloud PLY) for external tools.

## Running

```bash
npm install
npm run dev        # open the printed URL
npm run build      # type-check + production build into dist/
npm run test:smoke # headless end-to-end check (needs Playwright + Chromium)
```

Requires a browser with WebGL2 and `EXT_color_buffer_float` (all current desktop browsers).

## Using it

- **▶ Capture + reconstruct + evaluate** runs the whole pipeline. **depth from** picks the ideal depth sensor or stereo (images only).
- **Camera rig**: layout, number of cameras, rig radius (distance of each lens from the rig center), ring pitch, rig yaw, rig position, image resolution, near/far.
- **Lens**: presets (ideal pinhole, webcam, wide module with strong barrel distortion, 160° action-cam fisheye, 200° 360-cam fisheye) or manual model, FOV and OpenCV distortion coefficients.
- **Sensor**: `ideal` or `realistic` preset, or tune blur, vignetting, exposure, per-camera exposure / white-balance mismatch, full-well capacity (shot noise) and read noise.
- **Calibration error**: `perfect` or `typical` preset, or set the σ of position, rotation, focal length and principal-point errors. Images are formed with the true calibration; reconstruction only gets the perturbed one, as with a real rig.
- **Reconstruction**: pixel stride, ideal-sensor noise, voxel merging, max range.
- **Stereo matching**: neighbour views, depth planes (0 = automatic), range limits, NCC window, score and texture thresholds, geometric-consistency check.
- **View**: hide the room or make it translucent, toggle frustums, color points by RGB or by source camera, show images / sensor depth / stereo depth as thumbnails.

The app is exposed as `window.app` for experiments from the devtools console:

```js
Object.assign(app.settings.rig, { preset: 'ring', count: 12, radius: 0.3 });
app.settings.fusion.source = 'stereo';
app.rebuildRig();
await app.runAll(); // → { precision, completeness, fscore, meanError, ... }
app.stereoStats;    // → { density, medianRelError, within5pct }
```

## Metrics

With threshold τ (default 5 cm):

| Metric | Meaning |
| --- | --- |
| Precision | Fraction of reconstructed points within τ of the ground-truth surface. ~100% with the ideal sensor; a drop there means wrong geometry. |
| Completeness | Fraction of ground-truth surface samples within τ of the reconstruction. Limited by occlusion from a single rig position, and for stereo by how many pixels get a confident match. |
| F-score | Harmonic mean of the two. |
| Mean error | Mean distance from inlier points to the nearest ground-truth *sample*; includes the ~15 mm spacing of the samples, so compare between runs. |
| Stereo density | Fraction of pixels with a stereo range estimate. |
| Stereo median error | Median of \|stereo − true\| / true range per pixel. |
| Stereo within 5% | Fraction of estimated pixels within 5% of the true range. |

### Results (default room, rig at 1.4 m, 320×240 images)

Ideal depth sensor — validates the lens and rig geometry:

| Rig | Lens | Precision | Completeness | F-score |
| --- | --- | --- | --- | --- |
| ring, 8 cams | pinhole 70° | 100.0% | 64.2% | 78.2% |
| ring, 8 cams | wide, strong barrel | 100.0% | 70.6% | 82.7% |
| ring, 2 cams | fisheye 200° | 100.0% | 71.1% | 83.1% |
| cube, 6 cams | fisheye 200° | 100.0% | 76.9% | 86.9% |

Stereo from images only (ideal sensor, perfect calibration unless noted):

| Rig | Precision | Completeness | Density | Median range error |
| --- | --- | --- | --- | --- |
| ring, 8 cams, r = 0.1 m, pinhole 70° | 52.4% | 24.9% | 39.7% | 1.8% |
| ring, 12 cams, r = 0.3 m, pinhole 70° | 79.4% | 40.8% | 50.5% | 0.8% |
| cube, 6 cams, r = 0.3 m, fisheye 200° | 73.4% | 21.7% | 25.0% | 1.6% |
| ring, 12 cams, r = 0.3 m, realistic sensor + typical calibration | 8.2% | 6.2% | 24.7% | 39.4% |

What this shows:

- **Baseline is everything.** Stereo depth comes from disparity `d = f · B / r`. With the lenses only `B` = 8–15 cm apart, a wall 3 m away shifts just 4–9 px between neighbouring cameras, so every pixel of matching error is several percent of range error. A larger rig radius helps directly.
- **Image quality barely matters, calibration does.** Blur, vignetting, exposure/white-balance mismatch and noise each change the median error by < 1 percentage point (NCC is insensitive to gain and offset). A principal-point error of σ = 0.5 px alone raises the median error to 5–9%; all "typical" calibration errors together give 9–46% depending on the random draw. A real inside-out rig therefore needs very accurate calibration, ideally refined from the captured images themselves (bundle adjustment).
- **Overlap limits density.** Stereo only works where neighbouring views overlap; the cube rig with 200° fisheyes has the widest coverage per camera but less overlap at the image edges, where fisheye resolution is lowest.

## How it works

```
src/
  main.ts                 App: renderer, viewer, wiring between steps, sidebar
  scene/room.ts           Procedural textured room (walls, furniture, lights) = ground truth
  rig/layouts.ts          Camera poses for ring / Fibonacci sphere / cube layouts
  rig/CameraRig.ts        Camera poses + lens-aware frustum helpers
  camera/models.ts        Pinhole (OpenCV) and fisheye (Kannala–Brandt) project / unproject, presets
  camera/sensor.ts        Blur, vignetting, exposure, white balance, shot + read noise, 8-bit sRGB
  camera/calibration.ts   Calibration error (pose and intrinsics perturbation)
  capture/capture.ts      Cube-map render per camera → lens resampling → sensor model
  recon/depthFusion.ts    Back-projection along lens rays, voxel merging
  recon/stereo.ts         Plane-sweep multi-view stereo with NCC + geometric consistency
  recon/PointCloudView.ts THREE.Points display
  eval/metrics.ts         Area-weighted surface sampling, spatial hash, precision/completeness
  export/export.ts        Zip with PNGs, range maps, transforms.json, ground_truth.json, PLY
  ui/gui.ts               lil-gui panel
  util/random.ts          Seeded PRNG, Gaussian samples
scripts/smoke-test.mjs    Headless run of rig / lens / stereo configs, fails if lens geometry is off
```

**Conventions.** Lens models use the OpenCV camera frame (+X right, +Y down, +Z forward) and continuous pixel coordinates with the top-left image corner at (0, 0), so the center of pixel (i, j) is (i + 0.5, j + 0.5). three.js cameras use OpenGL axes (+Y up, looking down −Z); convert with (x, −y, −z).

**Lens models.**

- Pinhole with OpenCV distortion: `x = X/Z, y = Y/Z, r² = x² + y²`,
  `x_d = x(1 + k1 r² + k2 r⁴) + 2 p1 x y + p2 (r² + 2x²)` (similarly for y), `u = fx x_d + cx`.
  `fy = (h/2) / tan(fovY/2)` for the undistorted model. Rays beyond the point where barrel distortion folds back are invalid.
- Fisheye (OpenCV fisheye / Kannala–Brandt): `θ = atan2(√(X² + Y²), Z)`, `θ_d = θ(1 + k1 θ² + k2 θ⁴ + k3 θ⁶ + k4 θ⁸)`, `u = fx θ_d X/√(X² + Y²) + cx`. The image circle (θ = FOV/2) fits the image height, so it works beyond 180°.
- Unprojection inverts these iteratively (fixed-point iteration for pinhole, Newton's method on θ for fisheye).

**Capture.** For every camera, the scene is rendered into a cube map (6 perspective views) of linear color and of range (distance from the optical center), from the camera's true position. A full-screen shader then looks up each output pixel's lens ray in the cube maps, which produces any lens model, including > 180° fisheye. Range uses nearest-texel lookup so foreground and background distances are never blended. The sensor model then runs on the CPU: Gaussian blur, vignetting `1 − v·r²`, exposure gain `2^(EV + N(0, σ))`, per-channel white-balance gain, shot noise `N(e, √e)` in electrons plus read noise, clipping and 8-bit sRGB quantization.

**Back-projection.** `p_cam = range · ray(u, v)` with the ray from the *calibrated* lens model, converted to OpenGL axes, then `p_world = cameraToWorld · p_cam` with the calibrated pose.

**Stereo (plane sweep).** For each reference camera, neighbours are the cameras that see most of its view at a typical range (and are not at the same position). Range hypotheses are spaced uniformly in 1/r so each step shifts the image by ≤ 0.5 px (automatic plane count). For each hypothesis, every reference pixel is placed at that range along its ray, projected into each neighbour and sampled bilinearly; zero-mean normalized cross-correlation over a (2R+1)² window, computed with box filters, scores the match and is averaged over neighbours. The best hypothesis is refined with a parabola fit; low-score, low-texture and sweep-boundary pixels are rejected. A final geometric-consistency check keeps a pixel only if enough neighbours' own estimates agree within a relative tolerance.

**Export format** (`inside-out-capture.zip`):

- `images/cam_XXX.png`: 8-bit sRGB images as the sensor produced them.
- `depth/cam_XXX.f32`, `depth_stereo/cam_XXX.f32`: raw little-endian float32, row-major, top row first: **range along the pixel ray** in meters (not z-depth), 0 = no value.
- `transforms.json`: the *calibrated* (perturbed) intrinsics per frame (`camera_model` `OPENCV` or `OPENCV_FISHEYE`, `fl_x`, `fl_y`, `cx`, `cy`, `w`, `h`, distortion) and 4×4 camera-to-world `transform_matrix` in the OpenGL convention used by nerfstudio.
- `ground_truth.json`: the true intrinsics and poses, plus all simulation settings.
- `pointcloud.ply`: binary PLY of the current reconstruction.

## Roadmap

- **Calibration refinement**: bundle adjustment on feature matches between the captured images, to recover from calibration error (the dominant error source above).
- **Multiple rig positions**: move the rig through the room for longer baselines and to fill occluded areas.
- **GPU stereo**: move the plane sweep into shaders for higher resolutions and more cameras.
- **Rolling shutter, motion blur, HDR / auto-exposure** for a moving rig.
- **Surface reconstruction**: TSDF fusion + marching cubes to produce a mesh.
- More scenes (other room layouts, outdoor), loaded from glTF.
