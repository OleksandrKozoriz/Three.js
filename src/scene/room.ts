import * as THREE from 'three';

/**
 * Procedural test room. Everything is in meters, the floor is at y = 0 and the
 * room is centered on the origin in x/z. Every mesh that represents a real
 * surface is returned in `surfaces` so it can be used as ground truth.
 */
export interface Room {
  group: THREE.Group;
  surfaces: THREE.Mesh[];
  bounds: THREE.Box3;
  /** Set opacity of all room materials (1 = opaque). Used for "ghost" overlay. */
  setOpacity(opacity: number): void;
}

export interface RoomOptions {
  width?: number; // x
  depth?: number; // z
  height?: number; // y
  seed?: number;
}

/** Small deterministic PRNG so the room looks the same on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  repeat = 1,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

function floorTexture(rand: () => number): THREE.CanvasTexture {
  return canvasTexture(512, (ctx, s) => {
    const planks = 8;
    const h = s / planks;
    for (let i = 0; i < planks; i++) {
      const offset = rand() * s;
      for (let k = -1; k < 2; k++) {
        const l = 30 + rand() * 15;
        ctx.fillStyle = `hsl(28, ${45 + rand() * 15}%, ${l}%)`;
        ctx.fillRect(offset + k * s * 0.6, i * h, s * 0.6, h);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(offset + k * s * 0.6, i * h, 2, h);
      }
      for (let g = 0; g < 40; g++) {
        ctx.strokeStyle = `rgba(60,30,10,${0.05 + rand() * 0.1})`;
        ctx.beginPath();
        const y = i * h + rand() * h;
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(s * 0.3, y + rand() * 4 - 2, s * 0.6, y + rand() * 4 - 2, s, y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, i * h, s, 2);
    }
  }, 4);
}

function wallTexture(hue: number, rand: () => number): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = `hsl(${hue}, 25%, 72%)`;
    ctx.fillRect(0, 0, s, s);
    // Wallpaper: vertical stripes plus a small diamond pattern. Texture gives
    // future RGB-only stereo something to match on.
    for (let x = 0; x < s; x += 32) {
      ctx.fillStyle = `hsl(${hue}, 30%, 64%)`;
      ctx.fillRect(x, 0, 10, s);
    }
    for (let y = 16; y < s; y += 32) {
      for (let x = 21; x < s; x += 32) {
        ctx.fillStyle = `hsl(${(hue + 30 + rand() * 20) % 360}, 35%, 55%)`;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.fill();
      }
    }
  }, 6);
}

function paintingTexture(rand: () => number): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, s) => {
    const baseHue = rand() * 360;
    ctx.fillStyle = `hsl(${baseHue}, 50%, 80%)`;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 25; i++) {
      ctx.fillStyle = `hsla(${(baseHue + rand() * 180) % 360}, ${50 + rand() * 40}%, ${30 + rand() * 50}%, 0.85)`;
      if (rand() < 0.5) {
        ctx.fillRect(rand() * s, rand() * s, rand() * s * 0.4, rand() * s * 0.4);
      } else {
        ctx.beginPath();
        ctx.arc(rand() * s, rand() * s, rand() * s * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

function rugTexture(): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#7a1f2b';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#e8c27a';
    ctx.lineWidth = 6;
    for (let i = 1; i < 5; i++) {
      const m = i * 22;
      ctx.strokeRect(m, m, s - 2 * m, s - 2 * m);
    }
    ctx.fillStyle = '#1f3a7a';
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, 20, 0, Math.PI * 2);
    ctx.fill();
  });
}

export function createRoom(options: RoomOptions = {}): Room {
  const W = options.width ?? 8;
  const D = options.depth ?? 6;
  const H = options.height ?? 3;
  const rand = mulberry32(options.seed ?? 1234);

  const group = new THREE.Group();
  group.name = 'room';
  const surfaces: THREE.Mesh[] = [];
  const materials: THREE.Material[] = [];

  const std = (params: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.8, ...params });
    materials.push(m);
    return m;
  };

  const add = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
    parent: THREE.Object3D = group,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    parent.add(mesh);
    surfaces.push(mesh);
    return mesh;
  };

  const box = (
    size: [number, number, number],
    material: THREE.Material,
    position: [number, number, number],
    parent: THREE.Object3D = group,
  ) => add(new THREE.BoxGeometry(...size), material, position, [0, 0, 0], parent);

  // --- Shell: inward-facing planes -----------------------------------------
  const floorMat = std({ map: floorTexture(rand), roughness: 0.6 });
  add(new THREE.PlaneGeometry(W, D), floorMat, [0, 0, 0], [-Math.PI / 2, 0, 0]);
  floorMat.map!.repeat.set(W / 2, D / 2);

  const ceilingMat = std({ color: 0xf2f0ea, roughness: 0.95 });
  add(new THREE.PlaneGeometry(W, D), ceilingMat, [0, H, 0], [Math.PI / 2, 0, 0]);

  const wallA = std({ map: wallTexture(200, rand) });
  const wallB = std({ map: wallTexture(35, rand) });
  add(new THREE.PlaneGeometry(W, H), wallA, [0, H / 2, -D / 2]); // back (-z)
  add(new THREE.PlaneGeometry(W, H), wallA, [0, H / 2, D / 2], [0, Math.PI, 0]); // front (+z)
  add(new THREE.PlaneGeometry(D, H), wallB, [-W / 2, H / 2, 0], [0, Math.PI / 2, 0]); // left (-x)
  add(new THREE.PlaneGeometry(D, H), wallB, [W / 2, H / 2, 0], [0, -Math.PI / 2, 0]); // right (+x)

  // Skirting boards.
  const skirting = std({ color: 0xffffff, roughness: 0.5 });
  box([W, 0.1, 0.02], skirting, [0, 0.05, -D / 2 + 0.01]);
  box([W, 0.1, 0.02], skirting, [0, 0.05, D / 2 - 0.01]);
  box([0.02, 0.1, D], skirting, [-W / 2 + 0.01, 0.05, 0]);
  box([0.02, 0.1, D], skirting, [W / 2 - 0.01, 0.05, 0]);

  // --- Door and window -----------------------------------------------------
  const doorMat = std({ color: 0x6b4226, roughness: 0.55 });
  box([0.95, 2.05, 0.05], doorMat, [-1.5, 1.025, D / 2 - 0.025]);
  const knob = std({ color: 0xd4af37, metalness: 0.9, roughness: 0.3 });
  add(new THREE.SphereGeometry(0.035, 16, 12), knob, [-1.15, 1.0, D / 2 - 0.07]);

  const windowMat = std({ color: 0xbfe3ff, emissive: 0x9fd0ff, emissiveIntensity: 0.9, roughness: 0.1 });
  add(new THREE.PlaneGeometry(1.8, 1.2), windowMat, [W / 2 - 0.01, 1.6, -0.8], [0, -Math.PI / 2, 0]);
  const frameMat = std({ color: 0xffffff, roughness: 0.4 });
  box([0.06, 0.06, 1.9], frameMat, [W / 2 - 0.03, 2.22, -0.8]);
  box([0.06, 0.06, 1.9], frameMat, [W / 2 - 0.03, 0.98, -0.8]);
  box([0.06, 1.3, 0.06], frameMat, [W / 2 - 0.03, 1.6, -1.72]);
  box([0.06, 1.3, 0.06], frameMat, [W / 2 - 0.03, 1.6, 0.12]);
  box([0.06, 1.2, 0.04], frameMat, [W / 2 - 0.03, 1.6, -0.8]);

  // --- Paintings -----------------------------------------------------------
  const painting = (w: number, h: number, pos: [number, number, number], rotY: number) => {
    const g = new THREE.Group();
    g.position.set(...pos);
    g.rotation.y = rotY;
    group.add(g);
    box([w + 0.08, h + 0.08, 0.03], std({ color: 0x3b2a1a }), [0, 0, 0.015], g);
    add(new THREE.PlaneGeometry(w, h), std({ map: paintingTexture(rand), roughness: 0.9 }), [0, 0, 0.031], [0, 0, 0], g);
  };
  painting(1.2, 0.8, [1.5, 1.7, -D / 2 + 0.005], 0);
  painting(0.7, 0.9, [W / 2 - 0.005, 1.6, 1.8], -Math.PI / 2);
  painting(1.0, 0.7, [1.6, 1.6, D / 2 - 0.005], Math.PI);
  painting(0.6, 0.6, [-W / 2 + 0.005, 2.0, 0.6], Math.PI / 2);

  // --- Rug + table + chairs ------------------------------------------------
  const rugMat = std({ map: rugTexture(), roughness: 1 });
  box([2.5, 0.01, 1.8], rugMat, [1.45, 0.005, 0.6]);

  const wood = std({ color: 0x8b5a2b, roughness: 0.5 });
  const tableX = 1.4;
  const tableZ = 0.6;
  box([1.6, 0.05, 0.9], wood, [tableX, 0.75, tableZ]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box([0.06, 0.72, 0.06], wood, [tableX + sx * 0.72, 0.36, tableZ + sz * 0.38]);
    }
  }
  const chair = (x: number, z: number, rotY: number) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    group.add(g);
    const m = std({ color: 0x2f4f6f, roughness: 0.7 });
    box([0.45, 0.05, 0.45], m, [0, 0.45, 0], g);
    box([0.45, 0.5, 0.04], m, [0, 0.72, -0.2], g);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box([0.04, 0.45, 0.04], m, [sx * 0.2, 0.225, sz * 0.2], g);
  };
  chair(tableX, tableZ - 0.75, 0);
  chair(tableX, tableZ + 0.75, Math.PI);
  chair(tableX + 1.05, tableZ, -Math.PI / 2);

  // Objects on the table.
  add(new THREE.TorusKnotGeometry(0.1, 0.035, 96, 12), std({ color: 0xe0533d, roughness: 0.35 }), [tableX - 0.4, 0.92, tableZ]);
  add(new THREE.SphereGeometry(0.12, 32, 16), std({ color: 0x3dbbe0, roughness: 0.2, metalness: 0.1 }), [tableX + 0.35, 0.895, tableZ + 0.15]);
  add(new THREE.CylinderGeometry(0.05, 0.04, 0.12, 24), std({ color: 0xffffff, roughness: 0.3 }), [tableX + 0.1, 0.835, tableZ - 0.2]);
  box([0.3, 0.04, 0.22], std({ color: 0x225533 }), [tableX - 0.05, 0.795, tableZ + 0.2]);

  // --- Bookshelf against the back wall --------------------------------------
  {
    const g = new THREE.Group();
    g.position.set(-2.0, 0, -D / 2 + 0.2);
    group.add(g);
    const shelfMat = std({ color: 0x5c3b1e, roughness: 0.6 });
    const sw = 1.6;
    const sh = 2.0;
    const sd = 0.35;
    box([0.04, sh, sd], shelfMat, [-sw / 2, sh / 2, 0], g);
    box([0.04, sh, sd], shelfMat, [sw / 2, sh / 2, 0], g);
    box([sw, sh, 0.02], shelfMat, [0, sh / 2, -sd / 2 + 0.01], g);
    const levels = 5;
    for (let i = 0; i <= levels; i++) {
      const y = 0.02 + (i * (sh - 0.04)) / levels;
      box([sw, 0.03, sd], shelfMat, [0, y, 0], g);
      if (i === levels) break;
      // Books on this shelf.
      let x = -sw / 2 + 0.04;
      while (x < sw / 2 - 0.12) {
        const bw = 0.03 + rand() * 0.05;
        const bh = 0.2 + rand() * 0.14;
        const bd = 0.2 + rand() * 0.08;
        const bookMat = std({ color: new THREE.Color().setHSL(rand(), 0.5 + rand() * 0.4, 0.3 + rand() * 0.3) });
        box([bw, bh, bd], bookMat, [x + bw / 2, y + 0.015 + bh / 2, 0.02], g);
        x += bw + 0.003;
        if (rand() < 0.08) x += 0.1;
      }
    }
  }

  // --- Sofa against the left wall --------------------------------------------
  {
    const g = new THREE.Group();
    g.position.set(-W / 2 + 0.5, 0, 0.6);
    g.rotation.y = Math.PI / 2;
    group.add(g);
    const fabric = std({ color: 0x6d8f4e, roughness: 0.95 });
    box([2.0, 0.42, 0.9], fabric, [0, 0.21, 0], g);
    box([2.0, 0.5, 0.2], fabric, [0, 0.67, -0.35], g);
    box([0.2, 0.25, 0.9], fabric, [-0.9, 0.545, 0], g);
    box([0.2, 0.25, 0.9], fabric, [0.9, 0.545, 0], g);
    const cushion = std({ color: 0xd9c27a, roughness: 1 });
    box([0.4, 0.35, 0.12], cushion, [-0.55, 0.62, -0.2], g);
    box([0.4, 0.35, 0.12], cushion, [0.55, 0.62, -0.2], g);
  }

  // --- Floor lamp, plant, crates -------------------------------------------------
  {
    const metal = std({ color: 0x333333, metalness: 0.8, roughness: 0.35 });
    add(new THREE.CylinderGeometry(0.18, 0.18, 0.03, 32), metal, [-3.4, 0.015, -2.4]);
    add(new THREE.CylinderGeometry(0.015, 0.015, 1.5, 12), metal, [-3.4, 0.78, -2.4]);
    add(
      new THREE.CylinderGeometry(0.15, 0.25, 0.3, 32, 1, true),
      std({ color: 0xfff1c9, emissive: 0xffd27a, emissiveIntensity: 0.6, side: THREE.DoubleSide }),
      [-3.4, 1.6, -2.4],
    );
  }
  {
    const pot = std({ color: 0xb5643c, roughness: 0.9 });
    add(new THREE.CylinderGeometry(0.2, 0.15, 0.4, 24), pot, [3.4, 0.2, 2.4]);
    const leaves = std({ color: 0x2e7d32, roughness: 0.8, flatShading: true });
    add(new THREE.IcosahedronGeometry(0.38, 1), leaves, [3.4, 0.75, 2.4]);
    add(new THREE.IcosahedronGeometry(0.25, 1), leaves, [3.3, 1.1, 2.3]);
  }
  {
    const crate = std({ color: 0xc8a165, roughness: 0.9 });
    box([0.6, 0.6, 0.6], crate, [3.3, 0.3, -2.4]);
    box([0.5, 0.5, 0.5], crate, [3.2, 0.85, -2.45]);
    box([0.4, 0.4, 0.4], std({ color: 0x4a6fa5, roughness: 0.6 }), [2.6, 0.2, -2.6]);
  }

  // Ceiling light panel.
  box([1.2, 0.04, 0.6], std({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1 }), [0, H - 0.02, 0]);

  // --- Lights (not geometry) ---------------------------------------------------------
  group.add(new THREE.HemisphereLight(0xffffff, 0x8a7560, 1.2));
  const ceilingLight = new THREE.PointLight(0xfff4e0, 12, 0, 1.6);
  ceilingLight.position.set(0, H - 0.2, 0);
  group.add(ceilingLight);
  const lampLight = new THREE.PointLight(0xffd27a, 3, 0, 1.8);
  lampLight.position.set(-3.4, 1.5, -2.4);
  group.add(lampLight);
  const windowLight = new THREE.DirectionalLight(0xcfe8ff, 0.8);
  windowLight.position.set(W, 2.5, -0.8);
  group.add(windowLight);

  const bounds = new THREE.Box3(new THREE.Vector3(-W / 2, 0, -D / 2), new THREE.Vector3(W / 2, H, D / 2));

  const originalTransparent = new Map(materials.map((m) => [m, m.transparent]));
  const setOpacity = (opacity: number) => {
    for (const m of materials) {
      m.opacity = opacity;
      m.transparent = opacity < 1 || originalTransparent.get(m)!;
      m.depthWrite = opacity >= 1;
    }
  };

  group.updateMatrixWorld(true);
  return { group, surfaces, bounds, setOpacity };
}
