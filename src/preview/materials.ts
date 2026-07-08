import * as THREE from "three";

/**
 * The avatar finish, shared by the mannequin body and the facecap head:
 * a MATCAP (ZBrush-style baked sphere shading) imitating SprintRay MoonRay
 * printer resin — rich orange core, glowing amber subsurface rim, soft dual
 * highlights. The texture is generated procedurally (license-clean); if
 * `public/matcap.png` exists (e.g. the real Moonray Resin matcap exported
 * from ZBrush), it replaces the procedural one at load.
 *
 * Matcaps ignore scene lights entirely — the shading is baked into the
 * sphere texture, which is what gives sculpting-app renders their look.
 */
let matcapTexture: THREE.Texture | null = null;

function resinMatcap(): THREE.Texture {
  if (matcapTexture) return matcapTexture;
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const rg = (x: number, y: number, r0: number, r1: number, stops: Array<[number, string]>) => {
    const gr = g.createRadialGradient(x * S, y * S, r0 * S, x * S, y * S, r1 * S);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    return gr;
  };
  // Base resin body: warm orange, darkening toward the lower-right shadow.
  g.fillStyle = rg(0.42, 0.4, 0, 0.85, [
    [0, "#f98c22"],
    [0.45, "#ef7413"],
    [0.75, "#c1560a"],
    [1, "#8f3c05"],
  ]);
  g.fillRect(0, 0, S, S);
  // Subsurface rim glow — translucent resin brightens at grazing angles.
  g.fillStyle = rg(0.5, 0.5, 0.62, 1.0, [
    [0, "rgba(255,180,80,0)"],
    [0.72, "rgba(255,178,74,0.42)"],
    [0.92, "rgba(255,205,110,0.75)"],
    [1, "rgba(255,215,130,0.8)"],
  ]);
  g.fillRect(0, 0, S, S);
  // Broad soft key highlight, upper-left.
  g.fillStyle = rg(0.36, 0.32, 0, 0.4, [
    [0, "rgba(255,242,220,0.68)"],
    [0.55, "rgba(255,220,170,0.25)"],
    [1, "rgba(255,220,170,0)"],
  ]);
  g.fillRect(0, 0, S, S);
  // Tight hot specular.
  g.fillStyle = rg(0.34, 0.3, 0, 0.09, [
    [0, "rgba(255,255,252,0.95)"],
    [1, "rgba(255,255,252,0)"],
  ]);
  g.fillRect(0, 0, S, S);
  // Faint warm bounce, lower area.
  g.fillStyle = rg(0.6, 0.82, 0, 0.3, [
    [0, "rgba(255,160,70,0.28)"],
    [1, "rgba(255,160,70,0)"],
  ]);
  g.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  matcapTexture = tex;

  // Async override: the real matcap, if the user dropped one in public/.
  new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}matcap.png`,
    (real) => {
      real.colorSpace = THREE.SRGBColorSpace;
      matcapTexture = real;
      for (const m of issued) {
        m.matcap = real;
        m.needsUpdate = true;
      }
    },
    undefined,
    () => { /* no override present — keep the procedural one */ },
  );
  return tex;
}

/** Every material handed out, so a late-loading override retrofits them. */
const issued: THREE.MeshMatcapMaterial[] = [];

export function makeAvatarMaterial(): THREE.MeshMatcapMaterial {
  const mat = new THREE.MeshMatcapMaterial({
    matcap: resinMatcap(),
    side: THREE.DoubleSide, // VRM skirts/hair are single-sided planes
  });
  issued.push(mat);
  return mat;
}
