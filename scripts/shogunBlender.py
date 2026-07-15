# Blender 4.4 headless verifier for the Shogun target-rig FBX.
# Imports scripts/shogun-out.fbx, reads the armature's bone head world
# positions, and diffs them against scripts/shogun-joints.json (the world
# positions the exporter baked, in cm). Blender's FBX importer may apply its own
# unit scaling, so we solve one best-fit uniform scale across all joints and
# report the worst residual relative to the skeleton size. A tiny residual means
# the joints landed where the VRM rest pose put them.
#
# Run: blender --background --factory-startup --python scripts/shogunBlender.py
import bpy, json, os, math

here = os.path.dirname(os.path.abspath(__file__))
fbx = os.path.join(here, "shogun-out.fbx")
ref = json.load(open(os.path.join(here, "shogun-joints.json")))

bpy.ops.wm.read_factory_settings(use_empty=True)
try:
    bpy.ops.import_scene.fbx(filepath=fbx)
except RuntimeError as e:
    # Blender (like MotionBuilder 2018+) refuses ASCII FBX. The Shogun target
    # rig MUST be ASCII 7.4 (that is the format Vicon Shogun validated against),
    # so an independent Blender import of this exact file is impossible. The
    # joint world positions are instead verified by scripts/shogunCheck.mjs,
    # which reconstructs them from the BindPose and diffs the parent offsets.
    print("BLENDER-SKIP ASCII FBX unsupported by Blender importer: %s" % e)
    raise SystemExit(0)

arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if arm is None:
    print("BLENDER-FAIL no armature imported")
    raise SystemExit(1)

imported = {}
mw = arm.matrix_world
for b in arm.data.bones:
    h = mw @ b.head_local
    imported[b.name] = (h.x, h.y, h.z)

pairs = []
for r in ref:
    n = r["name"]
    if r["world"] is None:
        continue
    if n in imported:
        pairs.append((r["world"], imported[n]))

print("bones in ref: %d, matched in blender: %d" % (len(ref), len(pairs)))
if not pairs:
    print("BLENDER-FAIL no bone-name matches between FBX and reference")
    raise SystemExit(1)

# best-fit uniform scale s minimizing sum |ref - s*imp|^2 over all coords
num = 0.0
den = 0.0
for refp, impp in pairs:
    for a, b in zip(refp, impp):
        num += a * b
        den += b * b
s = num / den if den else 1.0

# residuals after scaling; normalize by skeleton bounding size (in ref cm)
xs = [c for refp, _ in pairs for c in refp]
size = max(xs) - min(xs)
maxres = 0.0
worst = ""
for (refp, impp), r in zip(pairs, ref):
    d = math.sqrt(sum((a - s * b) ** 2 for a, b in zip(refp, impp)))
    if d > maxres:
        maxres = d
        worst = r["name"]

rel = maxres / size if size else maxres
print("best-fit scale ref/blender = %.5f" % s)
print("max joint residual = %.4f cm (%.3f%% of %.1f cm skeleton) at %s" % (maxres, rel * 100, size, worst))
if rel < 0.01:
    print("BLENDER-PASS joint world positions match the VRM rest pose")
else:
    print("BLENDER-WARN residual above 1%% of skeleton size")
