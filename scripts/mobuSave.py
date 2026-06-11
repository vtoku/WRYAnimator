# Open our FBX in MotionBuilder and save it back out — produces a known-good
# reference file from the same engine, for byte-level comparison.
import os
import sys

import pyfbsdk

if hasattr(pyfbsdk, "initialize") and not hasattr(pyfbsdk, "FBApplication"):
    pyfbsdk.initialize()

from pyfbsdk import FBApplication

here = os.path.dirname(os.path.abspath(__file__))
src = os.environ.get("WANIM_FBX") or (sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "sample-bin.fbx"))
dst = os.environ.get("WANIM_OUT") or os.path.join(here, "mobu-saved.fbx")

app = FBApplication()
print("open:", app.FileOpen(src, False))
print("save:", app.FileSave(dst))
app.FileExit()
