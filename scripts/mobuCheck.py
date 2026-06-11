# Headless MotionBuilder import check.
# Run inside MotionBuilder:  motionbuilder.exe -batch scripts/mobuCheck.py
# or standalone:             mobupy.exe scripts/mobuCheck.py <file.fbx>
import os
import sys

import pyfbsdk

if hasattr(pyfbsdk, "initialize") and not hasattr(pyfbsdk, "FBApplication"):
    if not pyfbsdk.initialize():
        sys.stderr.write("pyfbsdk.initialize() failed (license?)\n")
        sys.exit(2)

from pyfbsdk import (
    FBApplication,
    FBSystem,
    FBModelSkeleton,
    FBModelNull,
)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mobu-result.txt")
_lines = []


def emit(*args):
    line = " ".join(str(a) for a in args)
    _lines.append(line)
    print(line)

# NOTE: extra CLI args make motionbuilder.exe auto-open them as files and skip
# the script, so the target path comes from the WANIM_FBX env var instead.
default_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample-bin.fbx")
path = os.environ.get("WANIM_FBX") or (sys.argv[1] if len(sys.argv) > 1 else default_path)

app = FBApplication()
ok = app.FileOpen(path, False)
emit("FileOpen ok:", ok)

system = FBSystem()
scene = system.Scene

emit("takes:", len(scene.Takes))
for t in scene.Takes:
    span = t.LocalTimeSpan
    emit(
        "  take '%s'  %.3fs .. %.3fs"
        % (t.Name, span.GetStart().GetSecondDouble(), span.GetStop().GetSecondDouble())
    )

skeletons = []
nulls = []
for comp in scene.Components:
    if isinstance(comp, FBModelSkeleton):
        skeletons.append(comp)
    elif isinstance(comp, FBModelNull):
        nulls.append(comp)
emit("skeleton nodes:", len(skeletons))
emit("null nodes:", [n.Name for n in nulls])

hips = next((s for s in skeletons if s.Name == "Hips"), None)
if hips is not None:
    parent = hips.Parent
    emit("Hips parent:", parent.Name if parent else "scene root")

if scene.Takes and hips is not None:
    system.CurrentTake = scene.Takes[0]
    for prop_name in ("Translation", "Rotation"):
        prop = getattr(hips, prop_name)
        node = prop.GetAnimationNode()
        if node is None:
            emit("Hips %s: NO animation node" % prop_name)
            continue
        counts = []
        for sub in node.Nodes:
            fc = sub.FCurve
            counts.append(len(fc.Keys) if fc is not None else 0)
        emit("Hips %s keys per axis: %s" % (prop_name, counts))

    limb = next((s for s in skeletons if s.Name in ("LeftArm", "LeftUpperArm")), None)
    if limb is not None:
        node = limb.Rotation.GetAnimationNode()
        counts = [len(sub.FCurve.Keys) if sub.FCurve else 0 for sub in node.Nodes] if node else None
        emit("%s Rotation keys: %s" % (limb.Name, counts))

# All models with their concrete pyfbsdk classes (diagnoses mesh-vs-null).
from pyfbsdk import FBModel  # noqa: E402

models = [c for c in scene.Components if isinstance(c, FBModel) and not isinstance(c, FBModelSkeleton)]
emit("models:", ", ".join("%s<%s>" % (m.Name, type(m).__name__) for m in models[:12]))

face = None
for comp in scene.Components:
    if isinstance(comp, FBModel) and comp.Name == "FaceMesh":
        face = comp
        break
if face is not None:
    animated = []
    for prop in face.PropertyList:
        try:
            if prop.IsAnimated():
                an = prop.GetAnimationNode()
                keys = len(an.FCurve.Keys) if an and an.FCurve else 0
                animated.append("%s(%d)" % (prop.Name, keys))
        except Exception:
            pass
    emit("FaceMesh found; animated props: %d" % len(animated))
    emit("  sample: %s" % ", ".join(animated[:6]))
else:
    emit("FaceMesh: not present (skeleton-only file)")

emit("DONE")
with open(OUT, "w") as f:
    f.write("\n".join(_lines) + "\n")
app.FileExit()
