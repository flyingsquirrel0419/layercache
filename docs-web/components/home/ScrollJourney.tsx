"use client";

import { useEffect, useRef } from "react";
import styles from "./home.module.css";

interface LayerSpec {
  id: string;
  label: string;
  latency: string;
  y: number;
  width: number;
  depth: number;
  height: number;
  color: number;
  opacity: number;
}

const LAYERS: LayerSpec[] = [
  { id: "l1", label: "L1 · memory", latency: "~0.1 ms", y: 1.35, width: 5.4, depth: 3.3, height: 0.22, color: 0x7cd7e6, opacity: 0.3 },
  { id: "l2", label: "L2 · redis", latency: "~1 ms", y: 0.25, width: 5.8, depth: 3.55, height: 0.22, color: 0x5f86d8, opacity: 0.26 },
  { id: "l3", label: "L3 · disk", latency: "~5 ms", y: -0.85, width: 6.2, depth: 3.8, height: 0.22, color: 0x3d5ba8, opacity: 0.22 },
  { id: "origin", label: "origin · db", latency: "50+ ms", y: -2.15, width: 7.4, depth: 4.6, height: 0.14, color: 0x16203a, opacity: 0.92 },
];

/** Scroll chapters. `focus` is the LAYERS index the camera settles on;
    -1 = free hero view, 4 = backfill finale. Windows are scroll-progress ranges. */
interface Chapter {
  id: string;
  window: [number, number];
  focus: number;
  side: "left" | "right" | "center";
  step: string;
  title: string;
  latency: string;
  body: string;
}

const CHAPTERS: Chapter[] = [
  {
    id: "l1",
    window: [0.13, 0.3],
    focus: 0,
    side: "right",
    step: "read path · 1 of 4",
    title: "L1 · Memory",
    latency: "~0.1 ms",
    body: "An in-process LRU answers hot keys without leaving the Node.js process. Most reads stop here and never go deeper.",
  },
  {
    id: "l2",
    window: [0.3, 0.47],
    focus: 1,
    side: "left",
    step: "read path · 2 of 4",
    title: "L2 · Redis",
    latency: "~1 ms",
    body: "Shared across every instance. A miss takes a single-flight lease — one caller runs the fetcher while the rest wait for its result.",
  },
  {
    id: "l3",
    window: [0.47, 0.63],
    focus: 2,
    side: "right",
    step: "read path · 3 of 4",
    title: "L3 · Disk",
    latency: "~5 ms",
    body: "Survives restarts and serves stale fallback when the layers above are cold or a fetch fails.",
  },
  {
    id: "origin",
    window: [0.63, 0.83],
    focus: 3,
    side: "left",
    step: "read path · 4 of 4",
    title: "Origin · your database",
    latency: "50+ ms",
    body: "The layer you're protecting. Watch the stampede: every few seconds 14 concurrent requests fall — exactly one reaches the database.",
  },
  {
    id: "backfill",
    window: [0.83, 1.01],
    focus: 4,
    side: "center",
    step: "then, on the way up",
    title: "The result backfills every layer",
    latency: "",
    body: "One origin call refills disk, Redis, and memory on its way back — so the next read stops at L1 in a tenth of a millisecond.",
  },
];

interface CameraKey {
  p: number;
  pos: [number, number, number];
  look: [number, number, number];
  spread: number;
}

const CAMERA_KEYS: CameraKey[] = [
  { p: 0.0, pos: [4.6, 2.6, 8.8], look: [0, -0.3, 0], spread: 0 },
  { p: 0.21, pos: [3.4, 1.95, 5.6], look: [0, 1.35, 0], spread: 0.5 },
  { p: 0.38, pos: [-3.6, 0.75, 5.2], look: [0, 0.25, 0], spread: 0.65 },
  { p: 0.55, pos: [3.0, -0.35, 5.0], look: [0, -0.85, 0], spread: 0.75 },
  { p: 0.72, pos: [-3.4, -1.45, 6.0], look: [0, -1.9, 0], spread: 0.85 },
  { p: 0.9, pos: [0.2, 3.6, 9.8], look: [0, -0.4, 0], spread: 0.25 },
  { p: 1.0, pos: [2.4, 2.9, 9.2], look: [0, -0.3, 0], spread: 0.15 },
];

const HOT = 0xffb347;
const ICE = 0x7cd7e6;
const VOID = 0x050810;
const BEAM_POOL = 48;
const STAMPEDE_SIZE = 14;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function ScrollJourney() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const requestsRef = useRef<HTMLSpanElement>(null);
  const originRef = useRef<HTMLSpanElement>(null);
  const hitRateRef = useRef<HTMLSpanElement>(null);
  const stampedeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !viewport || !canvas) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    import("three").then((THREE) => {
      if (disposed) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      } catch {
        viewport.dataset.fallback = "true";
        return;
      }

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(VOID, 0.038);

      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
      const camPos = new THREE.Vector3(...CAMERA_KEYS[0].pos);
      const camLook = new THREE.Vector3(...CAMERA_KEYS[0].look);
      camera.position.copy(camPos);
      camera.lookAt(camLook);

      scene.add(new THREE.AmbientLight(0x8090c0, 0.55));
      const keyLight = new THREE.DirectionalLight(0xdfe8ff, 1.1);
      keyLight.position.set(4, 7, 5);
      scene.add(keyLight);
      const emberLight = new THREE.PointLight(HOT, 14, 12, 2);
      emberLight.position.set(0, -3.1, 0);
      scene.add(emberLight);

      const stack = new THREE.Group();
      scene.add(stack);

      const disposables: { dispose(): void }[] = [];
      const track = <T extends { dispose(): void }>(d: T): T => {
        disposables.push(d);
        return d;
      };

      const slabs = LAYERS.map((spec) => {
        const geo = track(new THREE.BoxGeometry(spec.width, spec.height, spec.depth));
        const mat = track(
          new THREE.MeshStandardMaterial({
            color: spec.color,
            transparent: true,
            opacity: spec.opacity,
            roughness: 0.35,
            metalness: 0.1,
            emissive: spec.color,
            emissiveIntensity: 0.12,
            depthWrite: false,
          }),
        );
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = spec.y;

        const edgeGeo = track(new THREE.EdgesGeometry(geo));
        const edgeMat = track(
          new THREE.LineBasicMaterial({ color: spec.color, transparent: true, opacity: 0.85 }),
        );
        mesh.add(new THREE.LineSegments(edgeGeo, edgeMat));

        stack.add(mesh);
        return { spec, mesh, mat, edgeMat, pulse: 0 };
      });

      const dustCount = 260;
      const dustPos = new Float32Array(dustCount * 3);
      for (let i = 0; i < dustCount; i++) {
        dustPos[i * 3] = (Math.random() - 0.5) * 18;
        dustPos[i * 3 + 1] = (Math.random() - 0.5) * 12;
        dustPos[i * 3 + 2] = (Math.random() - 0.5) * 14;
      }
      const dustGeo = track(new THREE.BufferGeometry());
      dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
      const dustMat = track(
        new THREE.PointsMaterial({ color: 0x9bb4ff, size: 0.025, transparent: true, opacity: 0.4 }),
      );
      scene.add(new THREE.Points(dustGeo, dustMat));

      const flareCanvas = document.createElement("canvas");
      flareCanvas.width = flareCanvas.height = 64;
      const fctx = flareCanvas.getContext("2d");
      if (fctx) {
        const grad = fctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        fctx.fillStyle = grad;
        fctx.fillRect(0, 0, 64, 64);
      }
      const flareTexture = track(new THREE.CanvasTexture(flareCanvas));

      interface Flare {
        sprite: import("three").Sprite;
        mat: import("three").SpriteMaterial;
        life: number;
        maxLife: number;
        baseScale: number;
      }
      const flares: Flare[] = [];
      const spawnFlare = (x: number, y: number, z: number, color: number, scale: number) => {
        const mat = new THREE.SpriteMaterial({
          map: flareTexture,
          color,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.set(x, y, z);
        sprite.scale.setScalar(scale * 0.4);
        stack.add(sprite);
        flares.push({ sprite, mat, life: 0, maxLife: 0.55, baseScale: scale });
      };

      interface Beam {
        mesh: import("three").Mesh;
        mat: import("three").MeshBasicMaterial;
        active: boolean;
        phase: "down" | "up";
        targetLayer: number;
        speed: number;
        riser: boolean;
        lastY: number;
      }
      const beamGeo = track(new THREE.CylinderGeometry(0.016, 0.016, 0.85, 6));
      const beams: Beam[] = [];
      for (let i = 0; i < BEAM_POOL; i++) {
        const mat = track(
          new THREE.MeshBasicMaterial({
            color: ICE,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        const mesh = new THREE.Mesh(beamGeo, mat);
        mesh.visible = false;
        stack.add(mesh);
        beams.push({ mesh, mat, active: false, phase: "down", targetLayer: 0, speed: 4.5, riser: false, lastY: 0 });
      }

      const counters = { requests: 0, originCalls: 0, hits: 0 };
      const paintCounters = () => {
        if (requestsRef.current) requestsRef.current.textContent = String(counters.requests);
        if (originRef.current) originRef.current.textContent = String(counters.originCalls);
        if (hitRateRef.current) {
          const rate = counters.requests === 0 ? 100 : (counters.hits / counters.requests) * 100;
          hitRateRef.current.textContent = `${rate.toFixed(1)}%`;
        }
      };

      const pickAmbientLayer = () => {
        const r = Math.random();
        if (r < 0.7) return 0;
        if (r < 0.88) return 1;
        if (r < 0.96) return 2;
        return 3;
      };

      const launchBeam = (opts?: { x?: number; z?: number; target?: number }) => {
        const beam = beams.find((b) => !b.active);
        if (!beam) return;
        const layer = opts?.target ?? pickAmbientLayer();
        const spec = LAYERS[layer];
        beam.active = true;
        beam.phase = "down";
        beam.riser = false;
        beam.targetLayer = layer;
        beam.speed = 4.2 + Math.random() * 1.4;
        beam.mesh.visible = true;
        beam.mat.color.setHex(ICE);
        beam.mat.opacity = 0.9;
        beam.mesh.position.set(
          opts?.x ?? (Math.random() - 0.5) * (spec.width - 1),
          3.4 + Math.random() * 0.8,
          opts?.z ?? (Math.random() - 0.5) * (spec.depth - 1),
        );
      };

      const launchRiser = () => {
        const beam = beams.find((b) => !b.active);
        if (!beam) return;
        beam.active = true;
        beam.phase = "up";
        beam.riser = true;
        beam.targetLayer = 3;
        beam.speed = 2.6;
        beam.mesh.visible = true;
        beam.mat.color.setHex(HOT);
        beam.mat.opacity = 0.95;
        const x = (Math.random() - 0.5) * 3.5;
        const z = (Math.random() - 0.5) * 2.2;
        beam.mesh.position.set(x, LAYERS[3].y + 0.2, z);
        beam.lastY = beam.mesh.position.y;
        spawnFlare(x, LAYERS[3].y + 0.12, z, HOT, 1.1);
      };

      const settleBeam = (beam: Beam, layerIndex: number) => {
        const slab = slabs[layerIndex];
        const isOrigin = slab.spec.id === "origin";
        counters.requests += 1;
        if (isOrigin) counters.originCalls += 1;
        else counters.hits += 1;
        paintCounters();
        spawnFlare(
          beam.mesh.position.x,
          slab.mesh.position.y + slab.spec.height / 2 + 0.03,
          beam.mesh.position.z,
          HOT,
          isOrigin ? 1.6 : 0.75,
        );
        slab.pulse = 1;
        beam.phase = "up";
        beam.mat.color.setHex(HOT);
      };

      const runStampede = () => {
        const cx = (Math.random() - 0.5) * 2.5;
        const cz = (Math.random() - 0.5) * 1.6;
        for (let i = 0; i < STAMPEDE_SIZE; i++) {
          launchBeam({
            x: cx + (Math.random() - 0.5) * 0.9,
            z: cz + (Math.random() - 0.5) * 0.9,
            target: i === 0 ? 3 : 0,
          });
        }
        const badge = stampedeRef.current;
        if (badge) {
          badge.textContent = `stampede · ${STAMPEDE_SIZE} requests → 1 origin fetch`;
          badge.dataset.live = "true";
          window.setTimeout(() => {
            if (badge.isConnected) badge.dataset.live = "false";
          }, 3200);
        }
      };

      // --- scroll progress ---
      let progress = 0;
      const readProgress = () => {
        const rect = wrapper.getBoundingClientRect();
        const span = rect.height - window.innerHeight;
        if (span <= 0) return 0;
        return clamp01(-rect.top / span);
      };

      const chapterAt = (p: number): Chapter | null => {
        for (const chapter of CHAPTERS) {
          if (p >= chapter.window[0] && p < chapter.window[1]) return chapter;
        }
        return null;
      };

      // --- camera path ---
      const keyPos = new THREE.Vector3();
      const keyLook = new THREE.Vector3();
      const nextPos = new THREE.Vector3();
      const nextLook = new THREE.Vector3();
      const sampleCamera = (p: number, out: { pos: import("three").Vector3; look: import("three").Vector3; spread: number }) => {
        let a = CAMERA_KEYS[0];
        let b = CAMERA_KEYS[CAMERA_KEYS.length - 1];
        for (let i = 0; i < CAMERA_KEYS.length - 1; i++) {
          if (p >= CAMERA_KEYS[i].p && p <= CAMERA_KEYS[i + 1].p) {
            a = CAMERA_KEYS[i];
            b = CAMERA_KEYS[i + 1];
            break;
          }
        }
        const span = b.p - a.p || 1;
        const t = smootherstep(clamp01((p - a.p) / span));
        keyPos.set(...a.pos);
        nextPos.set(...b.pos);
        keyLook.set(...a.look);
        nextLook.set(...b.look);
        out.pos.copy(keyPos).lerp(nextPos, t);
        out.look.copy(keyLook).lerp(nextLook, t);
        out.spread = a.spread + (b.spread - a.spread) * t;
        if (camera.aspect < 1.1) {
          out.pos.multiplyScalar(1.4);
          // Narrow screens keep the stack centered; the hero copy sits below it.
          out.look.x *= 0.25;
        }
      };
      const camTarget = { pos: new THREE.Vector3(), look: new THREE.Vector3(), spread: 0 };
      let spread = 0;

      // --- overlay DOM driving ---
      let activeChapterId: string | null = null;
      const driveOverlays = (p: number) => {
        const intro = introRef.current;
        if (intro) intro.dataset.hidden = p > 0.1 ? "true" : "false";
        const hint = hintRef.current;
        if (hint) hint.dataset.hidden = p > 0.03 ? "true" : "false";

        const chapter = chapterAt(p);
        const id = chapter?.id ?? null;
        if (id !== activeChapterId) {
          activeChapterId = id;
          CHAPTERS.forEach((c, i) => {
            const el = panelRefs.current[i];
            if (el) el.dataset.active = c.id === id ? "true" : "false";
          });
        }
      };

      // --- layer labels ---
      const anchor = new THREE.Vector3();
      const placeLabels = () => {
        const { clientWidth: w, clientHeight: h } = viewport;
        slabs.forEach((slab, i) => {
          const el = labelRefs.current[i];
          if (!el) return;
          anchor.set(slab.spec.width / 2 + 0.25, slab.mesh.position.y, slab.spec.depth / 2 - 0.6);
          stack.localToWorld(anchor);
          anchor.project(camera);
          const x = (anchor.x * 0.5 + 0.5) * w;
          const y = (-anchor.y * 0.5 + 0.5) * h;
          const visible = anchor.z < 1 && x > 0 && x < w - 120;
          el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
          el.style.opacity = visible ? "1" : "0";
        });
      };

      const resize = () => {
        const w = viewport.clientWidth;
        const h = viewport.clientHeight;
        if (w === 0 || h === 0) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const resizeObserver = new ResizeObserver(() => {
        resize();
        if (reducedMotion) {
          sampleCamera(0, camTarget);
          camera.position.copy(camTarget.pos);
          camera.lookAt(camTarget.look);
          renderer.render(scene, camera);
          placeLabels();
        }
      });
      resizeObserver.observe(wrapper);

      const pointer = { x: 0, y: 0 };
      const onPointerMove = (event: PointerEvent) => {
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
      };
      if (!reducedMotion) window.addEventListener("pointermove", onPointerMove, { passive: true });

      let inView = true;
      let pageVisible = document.visibilityState === "visible";
      const intersection = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
      });
      intersection.observe(wrapper);
      const onVisibility = () => {
        pageVisible = document.visibilityState === "visible";
      };
      document.addEventListener("visibilitychange", onVisibility);

      let raf = 0;
      let last = performance.now();
      let ambientTimer = 0;
      let demoTimer = 0;
      let lastFocus = -1;

      const step = (dt: number, t: number) => {
        progress = readProgress();
        driveOverlays(progress);

        sampleCamera(progress, camTarget);
        const k = 1 - Math.exp(-6 * dt);
        camPos.lerp(camTarget.pos, k);
        camLook.lerp(camTarget.look, k);
        spread += (camTarget.spread - spread) * k;
        camera.position.copy(camPos);
        camera.lookAt(camLook);

        stack.rotation.y += (pointer.x * 0.09 - stack.rotation.y) * dt * 3;
        stack.rotation.x += (-pointer.y * 0.035 - stack.rotation.x) * dt * 3;

        const chapter = chapterAt(progress);
        const focus = chapter ? chapter.focus : -1;

        slabs.forEach((slab, i) => {
          const drift = Math.sin(t * 0.6 + i * 1.7) * 0.04;
          slab.mesh.position.y = slab.spec.y + drift + (1.5 - i) * spread;
          slab.pulse = Math.max(0, slab.pulse - dt * 2.2);
          const focused = focus === i;
          const dimmed = focus >= 0 && focus <= 3 && !focused;
          const targetEmissive = (focused ? 0.4 : dimmed ? 0.06 : 0.12) + slab.pulse * 0.5;
          slab.mat.emissiveIntensity += (targetEmissive - slab.mat.emissiveIntensity) * Math.min(dt * 4, 1);
          const targetEdge = focused ? 1 : dimmed ? 0.3 : 0.85;
          slab.edgeMat.opacity += (targetEdge - slab.edgeMat.opacity) * Math.min(dt * 4, 1);
        });

        if (focus !== lastFocus) {
          lastFocus = focus;
          demoTimer = 0.3;
        }

        // Ambient rain in the hero and finale; sparse elsewhere
        ambientTimer -= dt;
        if (ambientTimer <= 0 && (focus === -1 || focus === 4)) {
          launchBeam();
          ambientTimer = focus === -1 ? 0.3 + Math.random() * 0.5 : 1.6;
        }

        // Chapter demos
        demoTimer -= dt;
        if (demoTimer <= 0) {
          if (focus === 0) {
            launchBeam({ target: 0 });
            demoTimer = 0.55;
          } else if (focus === 1) {
            const cx = (Math.random() - 0.5) * 2.4;
            const cz = (Math.random() - 0.5) * 1.4;
            for (let i = 0; i < 3; i++) {
              launchBeam({ target: 1, x: cx + (Math.random() - 0.5) * 0.5, z: cz + (Math.random() - 0.5) * 0.5 });
            }
            demoTimer = 1.5;
          } else if (focus === 2) {
            launchBeam({ target: 2 });
            demoTimer = 1.3;
          } else if (focus === 3) {
            runStampede();
            demoTimer = 4.6;
          } else if (focus === 4) {
            launchRiser();
            demoTimer = 1.1;
          } else {
            demoTimer = 0.4;
          }
        }

        for (const beam of beams) {
          if (!beam.active) continue;
          if (beam.phase === "down") {
            const slab = slabs[beam.targetLayer];
            const surfaceY = slab.mesh.position.y + slab.spec.height / 2;
            beam.mesh.position.y -= beam.speed * dt;
            if (beam.mesh.position.y <= surfaceY + 0.4) {
              settleBeam(beam, beam.targetLayer);
            }
          } else {
            beam.lastY = beam.mesh.position.y;
            beam.mesh.position.y += beam.speed * (beam.riser ? 1 : 1.25) * dt;
            if (beam.riser) {
              for (let i = 0; i < 3; i++) {
                const slabY = slabs[i].mesh.position.y;
                if (beam.lastY < slabY && beam.mesh.position.y >= slabY) {
                  spawnFlare(beam.mesh.position.x, slabY + 0.08, beam.mesh.position.z, HOT, 0.8);
                  slabs[i].pulse = 1;
                }
              }
            } else {
              beam.mat.opacity = Math.min(beam.mat.opacity, Math.max(0, (4.2 - beam.mesh.position.y) / 1.2 + 0.4));
            }
            if (beam.mesh.position.y > (beam.riser ? 2.6 : 4.4)) {
              beam.active = false;
              beam.mesh.visible = false;
            }
          }
        }

        for (let i = flares.length - 1; i >= 0; i--) {
          const flare = flares[i];
          flare.life += dt;
          const fk = flare.life / flare.maxLife;
          if (fk >= 1) {
            stack.remove(flare.sprite);
            flare.mat.dispose();
            flares.splice(i, 1);
            continue;
          }
          flare.sprite.scale.setScalar(flare.baseScale * (0.4 + fk * 1.4));
          flare.mat.opacity = 1 - fk;
        }
      };

      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        if (!inView || !pageVisible) return;
        step(dt, now / 1000);
        renderer.render(scene, camera);
        placeLabels();
      };

      if (reducedMotion) {
        for (let i = 0; i < 7; i++) launchBeam();
        for (const beam of beams) {
          if (beam.active) beam.mesh.position.y = 0.6 + Math.random() * 2.4;
        }
        counters.requests = 128;
        counters.hits = 124;
        counters.originCalls = 4;
        paintCounters();
        renderer.render(scene, camera);
        placeLabels();
      } else {
        raf = requestAnimationFrame(frame);
      }

      cleanup = () => {
        cancelAnimationFrame(raf);
        resizeObserver.disconnect();
        intersection.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pointermove", onPointerMove);
        for (const flare of flares) flare.mat.dispose();
        for (const d of disposables) d.dispose();
        renderer.dispose();
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    <div ref={wrapperRef} className={styles.journey}>
      <div ref={viewportRef} className={styles.journeyViewport}>
        <canvas ref={canvasRef} className={styles.sceneCanvas} aria-hidden="true" />

        {LAYERS.map((layer, i) => (
          <div
            key={layer.id}
            ref={(el) => {
              labelRefs.current[i] = el;
            }}
            className={styles.layerLabel}
            aria-hidden="true"
          >
            <span className={styles.layerName}>{layer.label}</span>
            <span className={styles.layerLatency}>{layer.latency}</span>
          </div>
        ))}

        <div className={styles.journeyIntro} data-hidden="false" ref={introRef}>
          <p className={styles.introEyebrow}>how a read travels</p>
          <p className={styles.introTitle}>
            100 concurrent requests. <em>One</em> database call.
          </p>
        </div>

        {CHAPTERS.map((chapter, i) => (
          <div
            key={chapter.id}
            ref={(el) => {
              panelRefs.current[i] = el;
            }}
            className={styles.chapterPanel}
            data-side={chapter.side}
            data-active="false"
          >
            <p className={styles.chapterStep}>{chapter.step}</p>
            <div className={styles.chapterHead}>
              <h2 className={styles.chapterTitle}>{chapter.title}</h2>
              {chapter.latency && <span className={styles.chapterLatency}>{chapter.latency}</span>}
            </div>
            <p className={styles.chapterBody}>{chapter.body}</p>
          </div>
        ))}

        <div className={styles.telemetry}>
          <div className={styles.telemetryItem}>
            <span className={styles.telemetryValue} ref={requestsRef}>0</span>
            <span className={styles.telemetryKey}>requests</span>
          </div>
          <div className={styles.telemetryItem}>
            <span className={styles.telemetryValue} ref={hitRateRef}>100%</span>
            <span className={styles.telemetryKey}>hit rate</span>
          </div>
          <div className={styles.telemetryItem}>
            <span className={`${styles.telemetryValue} ${styles.telemetryHot}`} ref={originRef}>0</span>
            <span className={styles.telemetryKey}>origin calls</span>
          </div>
        </div>
        <div className={styles.stampedeBadge} ref={stampedeRef} data-live="false" />

        <div className={styles.scrollHint} ref={hintRef} data-hidden="false" aria-hidden="true">
          <span>scroll to follow a read</span>
          <span className={styles.scrollHintArrow}>↓</span>
        </div>
      </div>
    </div>
  );
}
