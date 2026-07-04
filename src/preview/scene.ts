import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { bindWorldPositions, type ConvertedClip } from "../convert/clip.ts";
import { buildBodyData } from "../convert/body.ts";
import { augmentFaceForVrm } from "../convert/vrmFaceMap.ts";
import { buildBodyMeshes } from "./body.ts";
import { EFFECTORS, type EffectorId } from "../rig/rig.ts";
import type { FramePose } from "../convert/fk.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";

export type BodyMode = "human" | "none";
import { FaceOverlay } from "./face.ts";
import { BODY_HEAD_HEIGHT_M, BODY_HEAD_LIFT_M, BODY_HEAD_JOINT_Y } from "../convert/meshExport.ts";

const BG = 0x0e1014;

export interface PlaybackState {
  time: number;
  duration: number;
  playing: boolean;
  trimStart: number;
  trimEnd: number;
}

/** Control-rig hooks: the app owns the layers; the scene owns picking/gizmo. */
export interface RigCallbacks {
  onSelect(effector: EffectorId | null): void;
  /** Return false to refuse the drag (e.g. no active layer). */
  onDragStart(effector: EffectorId): boolean;
  onDragMove(pos: Vec3, rot: Quat): void;
  onDragEnd(): void;
}

/**
 * Animated stick-figure preview of a ConvertedClip. Builds an Object3D bone
 * hierarchy, drives it per-frame from the recorded local transforms, and draws
 * each parent-child link as a line plus a joint dot. Playback runs in real time
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
  private bodyFace: { names: string[]; tracks: Float32Array[] } | null = null;
  private bodyFaceWeights: Float32Array | null = null;

  private time = 0;
  private playing = false;
  private trimStart = 0;
  private trimEnd = 0;
  private onState: ((s: PlaybackState) => void) | null = null;

  // ---- control rig -------------------------------------------------------
  private rigEnabled = false;
  private rigHandles = new Map<EffectorId, THREE.Mesh>();
  private rigSelected: EffectorId | null = null;
  private gizmo: TransformControls | null = null;
  private gizmoProxy = new THREE.Object3D();
  private gizmoDragging = false;
  private rigCbs: RigCallbacks | null = null;
  private poseOverride: FramePose | null = null;
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();

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

    // Rig picking: hovering a handle (or the gizmo) parks OrbitControls so
    // the click selects/drags instead of tumbling the camera.
    this.renderer.domElement.addEventListener("pointermove", (ev) => {
      if (this.gizmoDragging) return;
      const hover = this.pickHandle(ev);
      const overGizmo = !!(this.gizmo && (this.gizmo as unknown as { axis: string | null }).axis);
      this.controls.enabled = !hover && !overGizmo;
    });
    this.renderer.domElement.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.gizmoDragging) return;
      const hit = this.pickHandle(ev);
      if (hit) this.selectEffector(hit);
    });

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

  /** Which stand-in body to show. */
  bodyMode: BodyMode = "human";

  setBodyMode(mode: BodyMode) {
    if (this.bodyMode === mode) return;
    this.bodyMode = mode;
    if (this.clip) this.attachBody(this.clip);
  }

  /** Rebuild the body mesh (e.g. after the body source changed). */
  refreshBody() {
    if (this.clip) this.attachBody(this.clip);
  }

  private faceVisible = true;

  /** Hide/show the facecap overlay (hidden while a user VRM keeps its own head). */
  setFaceVisible(visible: boolean) {
    this.faceVisible = visible;
    if (this.face) this.face.group.visible = visible;
  }

  private clearBody() {
    if (!this.body) return;
    this.scene.remove(this.body);
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.body = null;
  }

  private attachBody(clip: ConvertedClip) {
    this.clearBody();
    if (this.bodyMode === "none") return;
    const bindWorld = bindWorldPositions(clip.parents, clip.bindPos);
    const root = this.boneRoot;
    const augFace = clip.face ? augmentFaceForVrm(clip.face) : null;
    void buildBodyData(clip.parents, clip.bindPos, clip.names, augFace?.names)
      .then((data) => {
        // The clip/mode may have changed while loading.
        if (this.clip !== clip || this.boneRoot !== root || !root || this.bodyMode !== "human") return;
        this.clearBody();
        this.bodyFace = augFace;
        this.bodyFaceWeights = augFace ? new Float32Array(augFace.names.length) : null;
        this.body = buildBodyMeshes(data.meshes, this.boneNodes, bindWorld);
        // At the scene root: the bones' world matrices already include any
        // root transform, so the skinned mesh must not inherit it too.
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
    // matching the bundled body's own head (see measureBodyHead.mjs).
    // No rotation: facecap and skeleton both face +Z.
    const headWorldY = bindWorldPositions(this.clip.parents, this.clip.bindPos)[this.headIndex][1];
    const k = headWorldY / BODY_HEAD_JOINT_Y;
    face.group.scale.setScalar(BODY_HEAD_HEIGHT_M * k);
    face.group.position.set(0, BODY_HEAD_LIFT_M * k, 0);
    face.group.rotation.set(0, 0, 0);
    face.group.visible = this.faceVisible;
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

  /**
   * Load a clip. `keepView` preserves the camera and playback position —
   * used when re-cleaning the SAME recording so toggling a filter doesn't
   * yank the view back to the framing shot.
   */
  setClip(clip: ConvertedClip, keepView = false) {
    const resume = keepView && this.clip ? { time: this.time, playing: this.playing } : null;
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
    // toward the preview camera - no display rotation needed.
    clip.parents.forEach((p, i) => {
      if (p >= 0) nodes[p].add(nodes[i]);
      else root.add(nodes[i]);
    });
    this.boneNodes = nodes;
    this.boneRoot = root;
    this.headIndex = clip.names.indexOf("Head");
    this.scene.add(root);

    // Links = every parent-child pair (skip the root, which has no parent).
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

    // Allocated whenever the clip has face tracks (drives the overlay AND
    // any body-mesh morphs), even if the overlay itself failed to load.
    this.faceWeights = clip.face ? new Float32Array(clip.face.names.length) : null;
    this.attachFace();
    this.attachBody(clip);
    this.attachRig();

    this.trimStart = 0;
    this.trimEnd = clip.duration;
    this.time = resume ? Math.min(resume.time, clip.duration) : 0;
    this.playing = resume ? resume.playing : true;
    this.applyPose(this.time);
    if (!resume) this.frameCamera();
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

  /** Redraw the stick figure + rig handles from the bones' current world state. */
  private redrawOverlays() {
    if (!this.boneRoot || !this.lines || !this.joints) return;
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
    this.updateRigHandles();
  }

  private applyPose(time: number) {
    if (!this.boneRoot || !this.lines || !this.joints) return;
    if (this.poseOverride) return; // live drag owns the pose right now
    this.sampleInto(time);
    this.redrawOverlays();

    // Drive the face blendshapes from the recorded weights at this time.
    if (this.faceWeights && this.clip?.face) {
      const { i, frac } = this.locate(time);
      const tracks = this.clip.face.tracks;
      for (let n = 0; n < tracks.length; n++) {
        const a = tracks[n][i];
        const b = tracks[n][i + 1] ?? a;
        this.faceWeights[n] = a + (b - a) * frac;
      }
      this.face?.applyWeights(this.faceWeights);
      // A user VRM's body meshes carry morphs named with the (augmented)
      // recorded names — drive them from the augmented tracks.
      if (this.body && this.bodyFace && this.bodyFaceWeights) {
        const bf = this.bodyFace;
        for (let n = 0; n < bf.tracks.length; n++) {
          const a = bf.tracks[n][i];
          const b = bf.tracks[n][i + 1] ?? a;
          this.bodyFaceWeights[n] = a + (b - a) * frac;
        }
        this.body.traverse((o) => {
          const sm = o as THREE.SkinnedMesh;
          if (!sm.isSkinnedMesh || !sm.morphTargetDictionary || !sm.morphTargetInfluences) return;
          for (let n = 0; n < bf.names.length; n++) {
            const mi = sm.morphTargetDictionary[bf.names[n]];
            if (mi !== undefined) sm.morphTargetInfluences[mi] = this.bodyFaceWeights![n];
          }
        });
      }
    }
  }

  // ---- control rig -------------------------------------------------------

  setRigCallbacks(cbs: RigCallbacks | null) {
    this.rigCbs = cbs;
  }

  /** Show/hide the effector handles (and lazily create the gizmo). */
  setRigEnabled(on: boolean) {
    if (this.rigEnabled === on) return;
    this.rigEnabled = on;
    if (on) {
      this.attachRig();
    } else {
      this.selectEffector(null);
      this.detachRig();
    }
  }

  setGizmoMode(mode: "translate" | "rotate") {
    this.gizmo?.setMode(mode);
  }

  getSelectedEffector(): EffectorId | null {
    return this.rigSelected;
  }

  getTime(): number {
    return this.time;
  }

  /** World transform of an effector's bone in the CURRENTLY displayed pose. */
  getEffectorWorld(effector: EffectorId): { pos: Vec3; rot: Quat } | null {
    const def = EFFECTORS.find((e) => e.id === effector);
    const node = def ? this.boneNodes[this.clip?.names.indexOf(def.bone) ?? -1] : null;
    if (!node) return null;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    node.getWorldPosition(p);
    node.getWorldQuaternion(q);
    return { pos: [p.x, p.y, p.z], rot: [q.x, q.y, q.z, q.w] };
  }

  /**
   * Show a hand-built single-frame pose (live IK while dragging) instead of
   * the clip's tracks. Pass null to fall back to the clip.
   */
  setPoseOverride(pose: FramePose | null) {
    this.poseOverride = pose;
    if (pose) {
      for (let b = 0; b < this.boneNodes.length; b++) {
        const node = this.boneNodes[b];
        node.position.set(pose.pos[b][0], pose.pos[b][1], pose.pos[b][2]);
        node.quaternion.set(pose.quat[b][0], pose.quat[b][1], pose.quat[b][2], pose.quat[b][3]);
      }
      this.redrawOverlays();
    } else {
      this.applyPose(this.time);
    }
  }

  selectEffector(effector: EffectorId | null) {
    if (this.rigSelected === effector) return;
    this.rigSelected = effector;
    for (const [id, mesh] of this.rigHandles) {
      const movable = EFFECTORS.find((e) => e.id === id)?.canMove;
      (mesh.material as THREE.MeshBasicMaterial).opacity = id === effector ? 1 : movable ? 0.55 : 0.4;
      mesh.scale.setScalar(id === effector ? 1.35 : 1);
    }
    if (effector && this.gizmo) {
      this.syncProxy();
      this.gizmo.attach(this.gizmoProxy);
    } else {
      this.gizmo?.detach();
    }
    this.rigCbs?.onSelect(effector);
  }

  private handleColor(id: EffectorId): number {
    if (id === "hips") return 0xffaa33;
    if (id === "head" || id === "neck" || id === "spine" || id === "chest") return 0xccee66;
    return id.startsWith("left") ? 0x5599ff : 0xff5588;
  }

  private attachRig() {
    if (!this.rigEnabled || !this.clip) return;
    this.detachRig();
    for (const def of EFFECTORS) {
      const bone = this.clip.names.indexOf(def.bone);
      if (bone < 0 || !this.boneNodes[bone]) continue;
      // IK effectors (movable) are spheres; FK rotate-only cells are smaller
      // octahedra so the main effectors stay easy to grab.
      const geo = def.canMove
        ? new THREE.SphereGeometry(def.id === "hips" ? 0.045 : 0.032, 16, 12)
        : new THREE.OctahedronGeometry(0.022);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: this.handleColor(def.id),
          transparent: true,
          opacity: def.canMove ? 0.55 : 0.4,
          depthTest: false,
        }),
      );
      mesh.renderOrder = 10;
      mesh.userData.effector = def.id;
      this.scene.add(mesh);
      this.rigHandles.set(def.id, mesh);
    }
    if (!this.gizmo) {
      this.scene.add(this.gizmoProxy);
      this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
      this.gizmo.size = 0.65;
      const helper = this.gizmo.getHelper();
      helper.renderOrder = 20;
      this.scene.add(helper);
      this.gizmo.addEventListener("dragging-changed", (e) => {
        const dragging = e.value as boolean;
        this.controls.enabled = !dragging;
        if (dragging) {
          if (this.rigSelected && this.rigCbs?.onDragStart(this.rigSelected)) {
            this.gizmoDragging = true;
            this.pause();
          } else {
            this.gizmo?.detach(); // refused — cancel the interaction
          }
        } else if (this.gizmoDragging) {
          this.gizmoDragging = false;
          this.rigCbs?.onDragEnd();
          if (this.rigSelected) this.gizmo?.attach(this.gizmoProxy);
        }
      });
      this.gizmo.addEventListener("objectChange", () => {
        if (!this.gizmoDragging) return;
        const p = this.gizmoProxy.position;
        const q = this.gizmoProxy.quaternion;
        this.rigCbs?.onDragMove([p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
      });
    }
    // Re-select across a setClip rebuild.
    if (this.rigSelected && this.rigHandles.has(this.rigSelected)) {
      const sel = this.rigSelected;
      this.rigSelected = null;
      this.selectEffector(sel);
    }
    this.updateRigHandles();
  }

  private detachRig() {
    for (const mesh of this.rigHandles.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.rigHandles.clear();
    this.gizmo?.detach();
  }

  /** Keep handles + gizmo proxy glued to the displayed skeleton. */
  private updateRigHandles() {
    if (!this.rigHandles.size || !this.clip) return;
    const wp = new THREE.Vector3();
    for (const [id, mesh] of this.rigHandles) {
      const def = EFFECTORS.find((e) => e.id === id)!;
      const node = this.boneNodes[this.clip.names.indexOf(def.bone)];
      if (!node) continue;
      node.getWorldPosition(wp);
      mesh.position.copy(wp);
    }
    if (!this.gizmoDragging) this.syncProxy();
  }

  private syncProxy() {
    if (!this.rigSelected) return;
    const w = this.getEffectorWorld(this.rigSelected);
    if (!w) return;
    this.gizmoProxy.position.set(w.pos[0], w.pos[1], w.pos[2]);
    this.gizmoProxy.quaternion.set(w.rot[0], w.rot[1], w.rot[2], w.rot[3]);
  }

  private pickHandle(ev: PointerEvent): EffectorId | null {
    if (!this.rigHandles.size) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.rigHandles.values()], false);
    return hits.length ? (hits[0].object.userData.effector as EffectorId) : null;
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
    this.detachRig();
    this.poseOverride = null;
    this.clearBody();
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
    this.gizmo?.dispose();
    this.gizmo = null;
    this.clearClip();
    this.face?.group.parent?.remove(this.face.group);
    this.face?.dispose();
    this.face = null;
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
