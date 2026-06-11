import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { bindWorldPositions, type ConvertedClip } from "../convert/clip.ts";
import { buildBodyData } from "../convert/body.ts";
import { buildBodyMeshes } from "./body.ts";
import { FaceOverlay } from "./face.ts";
import { YBOT_HEAD_HEIGHT_M, YBOT_HEAD_LIFT_M, YBOT_HEAD_JOINT_Y } from "../convert/meshExport.ts";

const BG = 0x0e1014;

export interface PlaybackState {
  time: number;
  duration: number;
  playing: boolean;
  trimStart: number;
  trimEnd: number;
}

/**
 * Animated stick-figure preview of a ConvertedClip. Builds an Object3D bone
 * hierarchy, drives it per-frame from the recorded local transforms, and draws
 * each parent→child link as a line plus a joint dot. Playback runs in real time
 * against the clip's recorded (variable-rate) timestamps.
 */
export class PreviewScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock = new THREE.Clock();

  private clip: ConvertedClip | null = null;
  private boneNodes: THREE.Bone[] = [];
  private boneRoot: THREE.Group | null = null;
  private body: THREE.Group | null = null;
  private links: Array<[number, number]> = [];
  private lines: THREE.LineSegments | null = null;
  private joints: THREE.Points | null = null;

  private face: FaceOverlay | null = null;
  private headIndex = -1;
  private faceWeights: Float32Array | null = null;

  private time = 0;
  private playing = false;
  private trimStart = 0;
  private trimEnd = 0;
  private onState: ((s: PlaybackState) => void) | null = null;

  private ro: ResizeObserver;
  private rafId = 0;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(0, 1.2, 3);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1.0, 0);

    this.scene.add(
      new THREE.HemisphereLight(0xffffff, 0x40404c, 1.4),
      new THREE.AmbientLight(0xffffff, 0.6),
    );
    this.scene.add(new THREE.GridHelper(10, 20, 0x2a2f3a, 0x1b1f27));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.animate();

    // Load the ARKit face head in the background; attach once the clip is ready.
    FaceOverlay.load()
      .then((f) => {
        this.face = f;
        this.attachFace();
      })
      .catch((err) => console.warn("face overlay unavailable:", err));
  }

  private attachBody(clip: ConvertedClip) {
    if (this.body) {
      this.scene.remove(this.body);
      this.body = null;
    }
    const root = this.boneRoot;
    void buildBodyData(clip.parents, clip.bindPos, clip.names)
      .then((data) => {
        // The clip may have been replaced while loading.
        if (this.clip !== clip || this.boneRoot !== root || !root) return;
        const bindWorld = bindWorldPositions(clip.parents, clip.bindPos);
        this.body = buildBodyMeshes(data, this.boneNodes, bindWorld);
        // At the scene root: the bones' world matrices already include the
        // boneRoot display flip, so the skinned mesh must not inherit it too.
        this.scene.add(this.body);
      })
      .catch((err) => console.warn("body mesh unavailable:", err));
  }

  private attachFace() {
    const face = this.face;
    if (!face || !this.clip || this.headIndex < 0 || !this.clip.face || !face.hasMorphs()) return;
    const head = this.boneNodes[this.headIndex];
    if (!head) return;
    face.group.parent?.remove(face.group);
    head.add(face.group);
    // Seat the head proportionally to the skeleton's head-joint height,
    // matching Ybot's original head (0.267 m tall, centered 0.076 m above the
    // joint, at 1.596 m). No rotation: facecap and skeleton both face +Z.
    const headWorldY = bindWorldPositions(this.clip.parents, this.clip.bindPos)[this.headIndex][1];
    const k = headWorldY / YBOT_HEAD_JOINT_Y;
    face.group.scale.setScalar(YBOT_HEAD_HEIGHT_M * k);
    face.group.position.set(0, YBOT_HEAD_LIFT_M * k, 0);
    face.group.rotation.set(0, 0, 0);
    face.bindNames(this.clip.face.names);
    this.faceWeights = new Float32Array(this.clip.face.names.length);
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setClip(clip: ConvertedClip) {
    this.clearClip();
    this.clip = clip;

    // Build the bone hierarchy (THREE.Bone so SkinnedMeshes can bind to it).
    const nodes: THREE.Bone[] = clip.names.map((name) => {
      const o = new THREE.Bone();
      o.name = name;
      return o;
    });
    const root = new THREE.Group();
    // The converted clip already faces +Z (the HIK convention), which is also
    // toward the preview camera — no display rotation needed.
    clip.parents.forEach((p, i) => {
      if (p >= 0) nodes[p].add(nodes[i]);
      else root.add(nodes[i]);
    });
    this.boneNodes = nodes;
    this.boneRoot = root;
    this.headIndex = clip.names.indexOf("Head");
    this.scene.add(root);

    // Links = every parent→child pair (skip the root, which has no parent).
    this.links = [];
    clip.parents.forEach((p, i) => {
      if (p >= 0) this.links.push([p, i]);
    });

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(this.links.length * 6), 3),
    );
    this.lines = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0x7fb2ff }),
    );
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);

    const jointGeo = new THREE.BufferGeometry();
    jointGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(nodes.length * 3), 3),
    );
    this.joints = new THREE.Points(
      jointGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false }),
    );
    this.joints.frustumCulled = false;
    this.scene.add(this.joints);

    this.faceWeights = null;
    this.attachFace();
    this.attachBody(clip);

    this.trimStart = 0;
    this.trimEnd = clip.duration;
    this.time = 0;
    this.playing = true;
    this.applyPose(0);
    this.frameCamera();
    this.emitState();
  }

  /** Restrict playback looping to [start, end] (seconds). Scrubbing is unaffected. */
  setTrim(start: number, end: number) {
    if (!this.clip) return;
    this.trimStart = Math.max(0, Math.min(this.clip.duration, start));
    this.trimEnd = Math.max(this.trimStart, Math.min(this.clip.duration, end));
    if (this.time < this.trimStart || this.time > this.trimEnd) this.seek(this.trimStart);
  }

  /** Map a playback time (seconds from clip start) to a frame index + fraction. */
  private locate(time: number): { i: number; frac: number } {
    const clip = this.clip!;
    const times = clip.times;
    const t = times[0] + Math.max(0, Math.min(clip.duration, time));
    let i = 0;
    while (i < times.length - 2 && times[i + 1] < t) i++;
    const ta = times[i];
    const tb = times[i + 1] ?? ta;
    const span = tb - ta;
    const frac = span > 1e-9 ? Math.max(0, Math.min(1, (t - ta) / span)) : 0;
    return { i, frac };
  }

  private sampleInto(time: number) {
    const clip = this.clip;
    if (!clip) return;
    const { i, frac } = this.locate(time);

    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    for (let b = 0; b < this.boneNodes.length; b++) {
      const pa = clip.localPos[b][i];
      const pb = clip.localPos[b][i + 1] ?? pa;
      const node = this.boneNodes[b];
      node.position.set(
        pa[0] + (pb[0] - pa[0]) * frac,
        pa[1] + (pb[1] - pa[1]) * frac,
        pa[2] + (pb[2] - pa[2]) * frac,
      );
      const ra = clip.localQuat[b][i];
      const rb = clip.localQuat[b][i + 1] ?? ra;
      qa.set(ra[0], ra[1], ra[2], ra[3]);
      qb.set(rb[0], rb[1], rb[2], rb[3]);
      qa.slerp(qb, frac);
      node.quaternion.copy(qa);
    }
  }

  private applyPose(time: number) {
    if (!this.boneRoot || !this.lines || !this.joints) return;
    this.sampleInto(time);
    this.boneRoot.updateMatrixWorld(true);

    const linePos = this.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const wp = new THREE.Vector3();
    this.links.forEach(([a, b], k) => {
      this.boneNodes[a].getWorldPosition(wp);
      linePos.setXYZ(k * 2, wp.x, wp.y, wp.z);
      this.boneNodes[b].getWorldPosition(wp);
      linePos.setXYZ(k * 2 + 1, wp.x, wp.y, wp.z);
    });
    linePos.needsUpdate = true;

    const jointPos = this.joints.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.boneNodes.length; i++) {
      this.boneNodes[i].getWorldPosition(wp);
      jointPos.setXYZ(i, wp.x, wp.y, wp.z);
    }
    jointPos.needsUpdate = true;

    // Drive the face blendshapes from the recorded weights at this time.
    if (this.face && this.faceWeights && this.clip?.face) {
      const { i, frac } = this.locate(time);
      const tracks = this.clip.face.tracks;
      for (let n = 0; n < tracks.length; n++) {
        const a = tracks[n][i];
        const b = tracks[n][i + 1] ?? a;
        this.faceWeights[n] = a + (b - a) * frac;
      }
      this.face.applyWeights(this.faceWeights);
    }
  }

  private frameCamera() {
    if (!this.boneRoot) return;
    const box = new THREE.Box3().setFromObject(this.boneRoot);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * 1.6;
    this.controls.target.set(0, center.y, 0);
    this.camera.position.set(0, center.y, dist);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private animate = () => {
    this.rafId = requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();
    if (this.clip && this.playing) {
      this.time += dt;
      // Loop within the trim region (end inclusive).
      if (this.time >= this.trimEnd || this.time < this.trimStart) this.time = this.trimStart;
      this.applyPose(this.time);
      this.emitState();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ---- playback controls -------------------------------------------------
  setOnState(cb: (s: PlaybackState) => void) {
    this.onState = cb;
  }

  private emitState() {
    this.onState?.({
      time: this.time,
      duration: this.clip?.duration ?? 0,
      playing: this.playing,
      trimStart: this.trimStart,
      trimEnd: this.trimEnd,
    });
  }

  play() {
    if (this.clip && (this.time < this.trimStart || this.time >= this.trimEnd)) {
      this.time = this.trimStart;
    }
    this.playing = true;
    this.emitState();
  }

  pause() {
    this.playing = false;
    this.emitState();
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
  }

  seek(time: number) {
    if (!this.clip) return;
    this.time = Math.max(0, Math.min(this.clip.duration, time));
    this.applyPose(this.time);
    this.emitState();
  }

  private clearClip() {
    if (this.body) {
      this.scene.remove(this.body);
      this.body.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      this.body = null;
    }
    if (this.boneRoot) {
      this.scene.remove(this.boneRoot);
      this.boneRoot = null;
    }
    if (this.lines) {
      this.scene.remove(this.lines);
      this.lines.geometry.dispose();
      (this.lines.material as THREE.Material).dispose();
      this.lines = null;
    }
    if (this.joints) {
      this.scene.remove(this.joints);
      this.joints.geometry.dispose();
      (this.joints.material as THREE.Material).dispose();
      this.joints = null;
    }
    this.boneNodes = [];
    this.clip = null;
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.ro.disconnect();
    this.clearClip();
    this.face?.group.parent?.remove(this.face.group);
    this.face?.dispose();
    this.face = null;
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
