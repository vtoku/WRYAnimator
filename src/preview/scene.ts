import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { bindWorldPositions, type ConvertedClip } from "../convert/clip.ts";
import { buildBodyData } from "../convert/body.ts";
import { augmentFaceForVrm } from "../convert/vrmFaceMap.ts";
import { buildBodyMeshes } from "./body.ts";
import { EFFECTORS, effectorColor, type EffectorId } from "../rig/rig.ts";
import type { FramePose } from "../convert/fk.ts";
import type { Quat, Vec3 } from "../wanim/parse.ts";

export type BodyMode = "human" | "none";
import { FaceOverlay } from "./face.ts";
import { BODY_HEAD_HEIGHT_M, BODY_HEAD_LIFT_M, BODY_HEAD_JOINT_Y } from "../convert/meshExport.ts";

const BG = 0x0e1014;
/** DIO's green — the ghost overlay's identity color (fill, rim, lines). */
const GHOST_GREEN = 0x3fd97a;

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
  /** Pole-vector (knee/elbow) drag on a limb's end effector. */
  onPoleStart(effector: EffectorId): boolean;
  onPoleMove(effector: EffectorId, pos: Vec3): void;
  onPoleEnd(): void;
  /** Right-click on a handle (screen coords) — the app pops a context menu. */
  onContext?(effector: EffectorId, x: number, y: number): void;
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

  // Ghost overlay: a second, grey stick figure + translucent body mesh
  // playing a reference clip (the uncleaned recording) in lockstep — the
  // "before" is visible WHILE editing. Independent of the main clip so
  // recleans don't tear it down.
  private ghostClip: ConvertedClip | null = null;
  private ghostNodes: THREE.Bone[] = [];
  private ghostRoot: THREE.Group | null = null;
  private ghostLines: THREE.LineSegments | null = null;
  private ghostLinks: Array<[number, number]> = [];
  private ghostBody: THREE.Group | null = null;
  private ghostMats: THREE.Material[] = [];

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
  /** Pole-vector handles keyed by the limb's end effector. */
  private poleHandles = new Map<EffectorId, THREE.Mesh>();
  private poleDrag: { effector: EffectorId; plane: THREE.Plane; startX: number; startY: number; active: boolean } | null = null;
  private rigSelected: EffectorId | null = null;
  private rigHovered: EffectorId | null = null;
  private gizmo: TransformControls | null = null;
  private gizmoSpace: "local" | "world" = "local";
  private gizmoProxy = new THREE.Object3D();
  private gizmoDragging = false;
  private rigCbs: RigCallbacks | null = null;
  private poseOverride: FramePose | null = null;
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  /** Poser-style direct drag: grab the handle itself, move in the view plane. */
  private directDrag: {
    effector: EffectorId;
    plane: THREE.Plane;
    startRot: Quat;
    startX: number;
    startY: number;
    active: boolean;
  } | null = null;

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

    // Studio environment map: the semi-gloss metallic avatar finish needs
    // something to reflect (metals render near-black without one). Lights
    // are dialed down to compensate — the env carries most of the fill.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    // Soft key light: shadowless even fill was half of the "waxy" read —
    // a gentle direction gives the form light/dark sides again.
    const key = new THREE.DirectionalLight(0xfff2e0, 1.1);
    key.position.set(2.5, 3.5, 2.0);
    this.scene.add(
      key,
      new THREE.HemisphereLight(0xffffff, 0x40404c, 0.55),
      new THREE.AmbientLight(0xffffff, 0.15),
    );
    this.scene.add(new THREE.GridHelper(10, 20, 0x2a2f3a, 0x1b1f27));

    // Rig picking: hovering a handle (or the gizmo) parks OrbitControls so
    // the click selects/drags instead of tumbling the camera.
    this.renderer.domElement.addEventListener("pointermove", (ev) => {
      if (this.gizmoDragging) return;
      if (this.poleDrag) { this.movePoleDrag(ev); return; }
      if (this.directDrag) { this.moveDirectDrag(ev); return; }
      const hover = this.pickHandle(ev);
      const overPole = !hover && !!this.pickPole(ev);
      if (hover !== this.rigHovered) {
        this.rigHovered = hover;
        this.restyleHandles();
      }
      const overGizmo = !!(this.gizmo && (this.gizmo as unknown as { axis: string | null }).axis);
      this.controls.enabled = !hover && !overPole && !overGizmo;
    });
    this.renderer.domElement.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.gizmoDragging) return;
      const hit = this.pickHandle(ev);
      if (!hit) {
        // Pole-vector handle: arm a plane drag that swings the bend plane.
        const pole = this.pickPole(ev);
        if (pole) {
          const w = this.polePosition(pole);
          if (w) {
            const n = new THREE.Vector3();
            this.camera.getWorldDirection(n);
            this.poleDrag = {
              effector: pole,
              plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...w)),
              startX: ev.clientX, startY: ev.clientY, active: false,
            };
            this.controls.enabled = false;
          }
        }
        return;
      }
      // The gizmo keeps clicks on its own parts — but only for the effector
      // it's attached to. A DIFFERENT handle under the gizmo wins, otherwise
      // parts near the current selection are unreachable.
      const overGizmo = !!(this.gizmo && (this.gizmo as unknown as { axis: string | null }).axis);
      if (overGizmo && hit === this.rigSelected) return;
      this.selectEffector(hit);
      // Arm a direct drag: moving past a few px grabs the part itself,
      // translating it in the camera plane (Poser style — no gizmo needed).
      const w = this.getEffectorWorld(hit);
      if (!w) return;
      const n = new THREE.Vector3();
      this.camera.getWorldDirection(n);
      this.directDrag = {
        effector: hit,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...w.pos)),
        startRot: w.rot,
        startX: ev.clientX,
        startY: ev.clientY,
        active: false,
      };
      this.controls.enabled = false;
    });
    this.renderer.domElement.addEventListener("contextmenu", (ev) => {
      const hit = this.pickHandle(ev);
      if (hit && this.rigCbs?.onContext) {
        ev.preventDefault();
        this.selectEffector(hit);
        this.rigCbs.onContext(hit, ev.clientX, ev.clientY);
      }
    });
    window.addEventListener("pointerup", () => {
      if (this.poleDrag) {
        const wasActive = this.poleDrag.active;
        this.poleDrag = null;
        this.restyleHandles();
        if (wasActive) this.rigCbs?.onPoleEnd();
        return;
      }
      if (!this.directDrag) return;
      const wasActive = this.directDrag.active;
      this.directDrag = null;
      this.restyleHandles();
      if (wasActive) this.rigCbs?.onDragEnd();
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    // Moving the window to a differently-scaled monitor changes
    // devicePixelRatio without necessarily resizing the container — the
    // window resize event catches it (resize() re-reads the ratio).
    window.addEventListener("resize", this.onWindowResize);
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
    if (this.ghostClip) this.attachGhostBody(this.ghostClip);
  }

  /** Rebuild the body mesh (e.g. after the body source changed). */
  refreshBody() {
    if (this.clip) this.attachBody(this.clip);
    if (this.ghostClip) this.attachGhostBody(this.ghostClip);
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

  private onWindowResize = () => this.resize();

  private resize() {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  private locate(clip: ConvertedClip, time: number): { i: number; frac: number } {
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

  /** Sample a clip's local transforms at `time` into a bone-node array. */
  private sampleClipInto(clip: ConvertedClip, nodes: THREE.Bone[], time: number) {
    const { i, frac } = this.locate(clip, time);
    const qa = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    for (let b = 0; b < nodes.length; b++) {
      const pa = clip.localPos[b][i];
      const pb = clip.localPos[b][i + 1] ?? pa;
      const node = nodes[b];
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

  private sampleInto(time: number) {
    if (!this.clip) return;
    this.sampleClipInto(this.clip, this.boneNodes, time);
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
    this.updateGhost(time); // the ghost tracks the playhead even mid-drag
    if (this.poseOverride) return; // live drag owns the pose right now
    this.sampleInto(time);
    this.redrawOverlays();

    // Drive the face blendshapes from the recorded weights at this time.
    if (this.faceWeights && this.clip?.face) {
      const { i, frac } = this.locate(this.clip, time);
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

  // ---- ghost overlay -------------------------------------------------------

  /**
   * Show/hide a grey reference skeleton playing `clip` at the same playhead
   * (e.g. the uncleaned recording). Survives setClip — recleans re-point it.
   */
  setGhost(clip: ConvertedClip | null) {
    this.clearGhost();
    this.ghostClip = clip;
    if (!clip) return;
    const nodes: THREE.Bone[] = clip.names.map((name) => {
      const o = new THREE.Bone();
      o.name = name;
      return o;
    });
    const root = new THREE.Group();
    clip.parents.forEach((p, i) => {
      if (p >= 0) nodes[p].add(nodes[i]);
      else root.add(nodes[i]);
    });
    this.ghostNodes = nodes;
    this.ghostRoot = root;
    this.scene.add(root);

    this.ghostLinks = [];
    clip.parents.forEach((p, i) => {
      if (p >= 0) this.ghostLinks.push([p, i]);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(this.ghostLinks.length * 6), 3),
    );
    this.ghostLines = new THREE.LineSegments(
      geo,
      // Overlay like the ghost body: always visible, never z-fighting.
      new THREE.LineBasicMaterial({ color: GHOST_GREEN, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }),
    );
    this.ghostLines.renderOrder = 8;
    this.ghostLines.frustumCulled = false;
    this.scene.add(this.ghostLines);
    this.attachGhostBody(clip);
    this.updateGhost(this.time);
  }

  /** Translucent body mesh skinned to the GHOST skeleton (same builder as
   *  the main body, materials swapped for one flat ghost material). */
  private attachGhostBody(clip: ConvertedClip) {
    this.clearGhostBody();
    if (this.bodyMode === "none") return;
    const nodes = this.ghostNodes;
    const bindWorld = bindWorldPositions(clip.parents, clip.bindPos);
    void buildBodyData(clip.parents, clip.bindPos, clip.names)
      .then((data) => {
        // The ghost may have changed/cleared while the body data loaded.
        if (this.ghostClip !== clip || this.ghostNodes !== nodes || this.bodyMode !== "human") return;
        this.clearGhostBody();
        const group = buildBodyMeshes(data.meshes, nodes, bindWorld);
        // One flat, unlit, translucent material for the whole ghost —
        // silhouette only (textures/lighting would read as a second person).
        // A true OVERLAY: no depth test, drawn after the body — coplanar
        // surfaces would otherwise z-fight whenever the poses coincide.
        // Faint fill: with no depth test every surface layer stacks, so the
        // opacity must be tiny — the RIM outline carries the ghost's identity.
        const fill = new THREE.MeshBasicMaterial({
          color: GHOST_GREEN,
          transparent: true,
          opacity: 0.045,
          depthWrite: false,
          depthTest: false,
          side: THREE.FrontSide,
        });
        // Rim outline: fresnel — opaque at the silhouette from ANY view,
        // transparent face-on. (An inverted hull can't do this without depth
        // testing: with depth off, BackSide shows the whole far surface.)
        const outline = new THREE.ShaderMaterial({
          transparent: true,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            rimColor: { value: new THREE.Color(GHOST_GREEN) },
            rimOpacity: { value: 0.9 },
          },
          vertexShader: /* glsl */ `
            #include <common>
            #include <skinning_pars_vertex>
            varying float vRim;
            void main() {
              #include <skinbase_vertex>
              #include <beginnormal_vertex>
              #include <skinnormal_vertex>
              #include <begin_vertex>
              #include <skinning_vertex>
              #include <project_vertex>
              vec3 vn = normalize(normalMatrix * objectNormal);
              vec3 vv = normalize(-mvPosition.xyz);
              vRim = pow(1.0 - abs(dot(vn, vv)), 2.5);
            }`,
          fragmentShader: /* glsl */ `
            uniform vec3 rimColor;
            uniform float rimOpacity;
            varying float vRim;
            void main() {
              gl_FragColor = vec4(rimColor, rimOpacity * vRim);
            }`,
        });
        const orphaned = new Set<THREE.Material>();
        const shells: THREE.SkinnedMesh[] = [];
        group.traverse((o) => {
          const mesh = o as THREE.SkinnedMesh;
          if (!mesh.isMesh) return;
          orphaned.add(mesh.material as THREE.Material);
          mesh.material = fill;
          mesh.renderOrder = 8; // above the scene, below rig handles (10) / gizmo (20)
          if (mesh.isSkinnedMesh) {
            const shell = new THREE.SkinnedMesh(mesh.geometry, outline);
            shell.bind(mesh.skeleton, mesh.bindMatrix);
            shell.frustumCulled = false;
            shell.renderOrder = 9; // the rim draws over the fill
            shells.push(shell);
          }
        });
        for (const shell of shells) group.add(shell);
        for (const m of orphaned) m.dispose();
        this.ghostMats = [fill, outline];
        this.ghostBody = group;
        this.scene.add(group);
        this.updateGhost(this.time);
      })
      .catch((err) => console.warn("ghost body unavailable:", err));
  }

  private clearGhostBody() {
    if (this.ghostBody) {
      this.scene.remove(this.ghostBody);
      this.ghostBody.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      this.ghostBody = null;
    }
    for (const m of this.ghostMats) m.dispose();
    this.ghostMats = [];
  }

  private updateGhost(time: number) {
    if (!this.ghostClip || !this.ghostRoot || !this.ghostLines) return;
    this.sampleClipInto(this.ghostClip, this.ghostNodes, time);
    this.ghostRoot.updateMatrixWorld(true);
    const pos = this.ghostLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const wp = new THREE.Vector3();
    this.ghostLinks.forEach(([a, b], k) => {
      this.ghostNodes[a].getWorldPosition(wp);
      pos.setXYZ(k * 2, wp.x, wp.y, wp.z);
      this.ghostNodes[b].getWorldPosition(wp);
      pos.setXYZ(k * 2 + 1, wp.x, wp.y, wp.z);
    });
    pos.needsUpdate = true;
  }

  private clearGhost() {
    this.clearGhostBody();
    if (this.ghostRoot) {
      this.scene.remove(this.ghostRoot);
      this.ghostRoot = null;
    }
    if (this.ghostLines) {
      this.scene.remove(this.ghostLines);
      this.ghostLines.geometry.dispose();
      (this.ghostLines.material as THREE.Material).dispose();
      this.ghostLines = null;
    }
    this.ghostNodes = [];
    this.ghostClip = null;
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

  /** Gizmo axes: "local" = aligned to the bone, "world" = scene axes. */
  setGizmoSpace(space: "local" | "world") {
    this.gizmoSpace = space;
    this.gizmo?.setSpace(space);
  }

  getGizmoSpace(): "local" | "world" {
    return this.gizmoSpace;
  }

  /** Effectors currently pinned (world-held) — styled solid so state reads. */
  private rigPinned = new Set<EffectorId>();
  /** End effectors whose limb is pure FK (blend 0) — their handle hides. */
  private rigFkOnly = new Set<EffectorId>();

  setPinned(ids: Iterable<EffectorId>) {
    this.rigPinned = new Set(ids);
    this.restyleHandles();
  }

  /** Hide the IK end-effector handles for limbs at IK/FK blend 0. */
  setFkOnlyLimbs(ids: Iterable<EffectorId>) {
    this.rigFkOnly = new Set(ids);
    if (this.rigSelected && this.rigFkOnly.has(this.rigSelected)) this.selectEffector(null);
    this.restyleHandles();
  }

  /** Handle look for every state: idle/hover/selected, dimmed while dragging. */
  private restyleHandles() {
    const dragging = this.gizmoDragging || !!this.directDrag?.active;
    for (const [id, mesh] of this.rigHandles) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      if (this.rigFkOnly.has(id)) { mesh.visible = false; continue; } // FK-only: no handle
      mesh.visible = true;
      const movable = EFFECTORS.find((e) => e.id === id)?.canMove;
      const sel = id === this.rigSelected;
      const hov = id === this.rigHovered;
      mat.opacity = dragging ? (sel ? 0.9 : 0.06) : sel ? 0.95 : hov ? 0.85 : movable ? 0.3 : 0.2;
      mesh.scale.setScalar(sel ? 1.3 : hov ? 1.2 : 1);
      if (this.rigPinned.has(id) && !dragging) {
        mat.opacity = Math.max(mat.opacity, 0.85);
        mesh.scale.setScalar(Math.max(sel ? 1.3 : 1.15, mesh.scale.x));
      }
    }
  }

  private moveDirectDrag(ev: PointerEvent) {
    const dd = this.directDrag;
    if (!dd || !this.rigCbs) return;
    if (!dd.active) {
      if (Math.hypot(ev.clientX - dd.startX, ev.clientY - dd.startY) < 5) return; // still a click
      if (!this.rigCbs.onDragStart(dd.effector)) {
        this.directDrag = null;
        return;
      }
      dd.active = true;
      this.pause();
      this.restyleHandles();
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(dd.plane, p)) return;
    this.rigCbs.onDragMove([p.x, p.y, p.z], dd.startRot);
  }

  getSelectedEffector(): EffectorId | null {
    return this.rigSelected;
  }

  getTime(): number {
    return this.time;
  }

  /** World transform of an effector's bone in the CURRENTLY displayed pose.
   *  The root handle lives on the GROUND under the hips (its drag pivot). */
  getEffectorWorld(effector: EffectorId): { pos: Vec3; rot: Quat } | null {
    const def = EFFECTORS.find((e) => e.id === effector);
    const node = def ? this.boneNodes[this.clip?.names.indexOf(def.bone) ?? -1] : null;
    if (!node) return null;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    node.getWorldPosition(p);
    node.getWorldQuaternion(q);
    if (effector === "root") p.y = 0;
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
    this.restyleHandles();
    if (effector && this.gizmo) {
      this.syncProxy();
      this.gizmo.attach(this.gizmoProxy);
    } else {
      this.gizmo?.detach();
    }
    this.rigCbs?.onSelect(effector);
  }

  private attachRig() {
    if (!this.rigEnabled || !this.clip) return;
    this.detachRig();
    for (const def of EFFECTORS) {
      if (def.hidden) continue; // finger FK effectors: gizmo-on-select, no handle
      const bone = this.clip.names.indexOf(def.bone);
      if (bone < 0 || !this.boneNodes[bone]) continue;
      // IK effectors (movable) are spheres; FK cells are smaller octahedra;
      // the root is a flat ring on the ground under the hips.
      // Small and faint so the mesh stays readable; hover brightens them.
      const geo =
        def.id === "root"
          ? new THREE.TorusGeometry(0.14, 0.01, 8, 40)
          : def.canMove
            ? new THREE.SphereGeometry(def.id === "hips" ? 0.034 : 0.024, 16, 12)
            : new THREE.OctahedronGeometry(0.016);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: effectorColor(def.id),
          transparent: true,
          opacity: def.canMove ? 0.3 : 0.2,
          depthTest: false,
        }),
      );
      if (def.id === "root") mesh.rotation.x = Math.PI / 2; // lie flat on the floor
      mesh.renderOrder = 10;
      mesh.userData.effector = def.id;
      this.scene.add(mesh);
      this.rigHandles.set(def.id, mesh);
    }
    // Pole-vector handles for the four IK limbs (knees/elbows).
    for (const def of EFFECTORS) {
      if (!def.chain) continue;
      if ([def.chain.root, def.chain.mid, def.bone].some((b) => this.clip!.names.indexOf(b) < 0)) continue;
      const mesh = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.02),
        new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.25, depthTest: false }),
      );
      mesh.renderOrder = 10;
      mesh.userData.pole = def.id;
      this.scene.add(mesh);
      this.poleHandles.set(def.id, mesh);
    }
    if (!this.gizmo) {
      this.scene.add(this.gizmoProxy);
      this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
      this.gizmo.size = 0.65;
      this.gizmo.setSpace(this.gizmoSpace);
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
        this.restyleHandles();
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
    for (const mesh of [...this.rigHandles.values(), ...this.poleHandles.values()]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.rigHandles.clear();
    this.poleHandles.clear();
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
      if (id === "root") wp.y = 0; // the trajectory ring stays on the floor
      mesh.position.copy(wp);
    }
    for (const [id, mesh] of this.poleHandles) {
      // No pole handle for a pure-FK limb (nothing to bend).
      mesh.visible = !this.rigFkOnly.has(id) && !(this.poleDrag && this.poleDrag.active && this.poleDrag.effector !== id);
      if (!mesh.visible) continue;
      const p = this.polePosition(id);
      if (p) mesh.position.set(p[0], p[1], p[2]);
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
    const pickable = [...this.rigHandles.values()].filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(pickable, false);
    return hits.length ? (hits[0].object.userData.effector as EffectorId) : null;
  }

  // ---- pole-vector handles -----------------------------------------------

  /** World position of a limb's pole handle in the CURRENTLY displayed pose. */
  private polePosition(effector: EffectorId): Vec3 | null {
    const def = EFFECTORS.find((e) => e.id === effector);
    if (!def?.chain || !this.clip) return null;
    const ri = this.clip.names.indexOf(def.chain.root);
    const mi = this.clip.names.indexOf(def.chain.mid);
    const ei = this.clip.names.indexOf(def.bone);
    const rn = this.boneNodes[ri], mn = this.boneNodes[mi], en = this.boneNodes[ei];
    if (!rn || !mn || !en) return null;
    const rp = new THREE.Vector3(), mp = new THREE.Vector3(), ep = new THREE.Vector3();
    rn.getWorldPosition(rp); mn.getWorldPosition(mp); en.getWorldPosition(ep);
    const limbLen = rp.distanceTo(mp) + mp.distanceTo(ep);
    const dir = mp.clone().sub(rp.clone().add(ep).multiplyScalar(0.5));
    if (dir.length() < 1e-4) return [mp.x, mp.y, mp.z];
    dir.normalize().multiplyScalar(limbLen * 0.4);
    const p = mp.add(dir);
    return [p.x, p.y, p.z];
  }

  private pickPole(ev: PointerEvent): EffectorId | null {
    if (!this.poleHandles.size) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const pickable = [...this.poleHandles.values()].filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(pickable, false);
    return hits.length ? (hits[0].object.userData.pole as EffectorId) : null;
  }

  private movePoleDrag(ev: PointerEvent) {
    const pd = this.poleDrag;
    if (!pd || !this.rigCbs) return;
    if (!pd.active) {
      if (Math.hypot(ev.clientX - pd.startX, ev.clientY - pd.startY) < 5) return;
      if (!this.rigCbs.onPoleStart(pd.effector)) { this.poleDrag = null; return; }
      pd.active = true;
      this.pause();
      this.restyleHandles();
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(pd.plane, p)) return;
    this.rigCbs.onPoleMove(pd.effector, [p.x, p.y, p.z]);
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
      this.time += dt * this.rate;
      // Loop within the trim region (end inclusive).
      if (this.time >= this.trimEnd || this.time < this.trimStart) this.time = this.trimStart;
      this.applyPose(this.time);
      this.emitState();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // ---- playback controls -------------------------------------------------
  /** Review-speed multiplier — affects playback only, never the clip. */
  private rate = 1;

  setRate(r: number) {
    this.rate = Math.max(0.05, Math.min(4, r));
  }

  getRate(): number {
    return this.rate;
  }

  setOnState(cb: ((s: PlaybackState) => void) | null) {
    this.onState = cb;
  }

  /** Drop the clip and show the empty grid again (boot / "Load another"). */
  clear() {
    this.clearGhost();
    this.clearClip();
    this.onState = null; // the transport that owned the callback is gone
    this.time = 0;
    this.playing = false;
    this.trimStart = 0;
    this.trimEnd = 0;
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
    window.removeEventListener("resize", this.onWindowResize);
    this.gizmo?.dispose();
    this.gizmo = null;
    this.clearGhost();
    this.clearClip();
    this.face?.group.parent?.remove(this.face.group);
    this.face?.dispose();
    this.face = null;
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
