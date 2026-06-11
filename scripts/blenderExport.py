import bpy
import sys

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.export_scene.fbx(filepath=out, bake_anim=True)
print("exported", out)
