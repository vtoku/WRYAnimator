// Unity ground truth for the humanoid .anim exporter (src/anim/).
// Not part of the web app: copy into a scratch Unity project's Assets/Editor
// and run in batch mode — see scripts/animUnity.mjs.
//
//   Probe.Run     skeleton + poses (ANIM_PROBE_IN) → Unity's HumanPose for each (ANIM_PROBE_OUT),
//                 plus the avatar's per-bone muscle axes, limits and a reference .anim written by Unity.
//   Probe.Verify  import our .anim (ANIM_PROBE_CLIP, inside Assets/), sample it on the same avatar
//                 and write the resulting bone rotations (ANIM_PROBE_OUT) for comparison with the source.
using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

public static class AnimProbe
{
    [Serializable] class Pose { public float[] hips; public float[] q; }
    [Serializable] class Input { public string[] names; public int[] parents; public float[] bind; public bool[] present; public Pose[] poses; public string[] labels; }
    [Serializable] class OutPose { public float[] bodyPos; public float[] bodyRot; public float[] muscles; public float[] worldPos; }
    [Serializable] class Output
    {
        public string unity; public float humanScale; public string[] muscleNames; public float[] muscleMin; public float[] muscleMax;
        public int[] muscleFromBone; public float[] preQ; public float[] postQ; public float[] sign; public float[] axisLength;
        public string[] boneNames; public OutPose[] poses;
    }
    [Serializable] class Sample { public float t; public float[] hips; public float[] q; }
    [Serializable] class VerifyOut { public float length; public float frameRate; public bool isHuman; public int bindings; public Sample[] samples; }

    static Transform[] bones;
    static GameObject root;

    static Avatar Build(Input inp)
    {
        int B = inp.names.Length;
        root = new GameObject("Root");
        bones = new Transform[B];
        for (int b = 0; b < B; b++) bones[b] = new GameObject(inp.names[b]).transform;
        for (int b = 0; b < B; b++)
        {
            bones[b].SetParent(inp.parents[b] < 0 ? root.transform : bones[inp.parents[b]], false);
            bones[b].localPosition = new Vector3(inp.bind[b * 3], inp.bind[b * 3 + 1], inp.bind[b * 3 + 2]);
            bones[b].localRotation = Quaternion.identity;
        }
        var human = new List<HumanBone>();
        for (int b = 0; b < B; b++)
        {
            if (!inp.present[b]) continue;
            var hb = new HumanBone { boneName = inp.names[b], humanName = HumanTrait.BoneName[b] };
            hb.limit.useDefaultValues = true;
            human.Add(hb);
        }
        var skel = new List<SkeletonBone>();
        skel.Add(new SkeletonBone { name = "Root", position = Vector3.zero, rotation = Quaternion.identity, scale = Vector3.one });
        for (int b = 0; b < B; b++)
            skel.Add(new SkeletonBone { name = inp.names[b], position = bones[b].localPosition, rotation = Quaternion.identity, scale = Vector3.one });
        var desc = new HumanDescription
        {
            human = human.ToArray(), skeleton = skel.ToArray(),
            upperArmTwist = 0.5f, lowerArmTwist = 0.5f, upperLegTwist = 0.5f, lowerLegTwist = 0.5f,
            armStretch = 0.05f, legStretch = 0.05f, feetSpacing = 0f, hasTranslationDoF = false,
        };
        var avatar = AvatarBuilder.BuildHumanAvatar(root, desc);
        avatar.name = "ProbeAvatar";
        if (!avatar.isValid || !avatar.isHuman) throw new Exception("avatar is not a valid humanoid");
        return avatar;
    }

    static void SetPose(Input inp, Pose p)
    {
        int B = inp.names.Length;
        for (int b = 0; b < B; b++)
            bones[b].localRotation = new Quaternion(p.q[b * 4], p.q[b * 4 + 1], p.q[b * 4 + 2], p.q[b * 4 + 3]);
        bones[0].localPosition = new Vector3(p.hips[0], p.hips[1], p.hips[2]);
    }

    static object Call(Avatar a, string name, params object[] args)
    {
        var m = typeof(Avatar).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
        return m == null ? null : m.Invoke(a, args);
    }

    public static void Run()
    {
        var inp = JsonUtility.FromJson<Input>(File.ReadAllText(Environment.GetEnvironmentVariable("ANIM_PROBE_IN")));
        var avatar = Build(inp);
        int B = inp.names.Length;
        var scaleAnimator = root.AddComponent<Animator>();
        scaleAnimator.avatar = avatar;
        var o = new Output { unity = Application.unityVersion, humanScale = scaleAnimator.humanScale, boneNames = HumanTrait.BoneName };
        int M = HumanTrait.MuscleCount;
        o.muscleNames = HumanTrait.MuscleName;
        o.muscleMin = new float[M]; o.muscleMax = new float[M];
        for (int m = 0; m < M; m++) { o.muscleMin[m] = HumanTrait.GetMuscleDefaultMin(m); o.muscleMax[m] = HumanTrait.GetMuscleDefaultMax(m); }
        o.muscleFromBone = new int[B * 3]; o.preQ = new float[B * 4]; o.postQ = new float[B * 4]; o.sign = new float[B * 3]; o.axisLength = new float[B];
        for (int b = 0; b < B; b++)
        {
            for (int d = 0; d < 3; d++) o.muscleFromBone[b * 3 + d] = HumanTrait.MuscleFromBone(b, d);
            var pre = Call(avatar, "GetPreRotation", b); var post = Call(avatar, "GetPostRotation", b); var sg = Call(avatar, "GetLimitSign", b);
            var al = Call(avatar, "GetAxisLength", b);
            if (pre != null) { var q = (Quaternion)pre; o.preQ[b * 4] = q.x; o.preQ[b * 4 + 1] = q.y; o.preQ[b * 4 + 2] = q.z; o.preQ[b * 4 + 3] = q.w; }
            if (post != null) { var q = (Quaternion)post; o.postQ[b * 4] = q.x; o.postQ[b * 4 + 1] = q.y; o.postQ[b * 4 + 2] = q.z; o.postQ[b * 4 + 3] = q.w; }
            if (sg != null) { var v = (Vector3)sg; o.sign[b * 3] = v.x; o.sign[b * 3 + 1] = v.y; o.sign[b * 3 + 2] = v.z; }
            if (al != null) o.axisLength[b] = (float)al;
        }

        var handler = new HumanPoseHandler(avatar, root.transform);
        var hp = new HumanPose();
        o.poses = new OutPose[inp.poses.Length];
        for (int i = 0; i < inp.poses.Length; i++)
        {
            SetPose(inp, inp.poses[i]);
            handler.GetHumanPose(ref hp);
            var op = new OutPose
            {
                bodyPos = new[] { hp.bodyPosition.x, hp.bodyPosition.y, hp.bodyPosition.z },
                bodyRot = new[] { hp.bodyRotation.x, hp.bodyRotation.y, hp.bodyRotation.z, hp.bodyRotation.w },
                muscles = (float[])hp.muscles.Clone(), worldPos = new float[B * 3],
            };
            for (int b = 0; b < B; b++) { var w = bones[b].position; op.worldPos[b * 3] = w.x; op.worldPos[b * 3 + 1] = w.y; op.worldPos[b * 3 + 2] = w.z; }
            o.poses[i] = op;
        }
        File.WriteAllText(Environment.GetEnvironmentVariable("ANIM_PROBE_OUT"), JsonUtility.ToJson(o));

        // A reference humanoid clip written by Unity itself (format reference for our YAML writer).
        var clip = new AnimationClip { name = "UnityReference", frameRate = 60 };
        SetPose(inp, inp.poses[inp.poses.Length - 1]); handler.GetHumanPose(ref hp);
        for (int m = 0; m < M; m++)
            AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("", typeof(Animator), HumanTrait.MuscleName[m]), AnimationCurve.Linear(0, hp.muscles[m], 1, hp.muscles[m]));
        string[] rt = { "RootT.x", "RootT.y", "RootT.z" }; string[] rq = { "RootQ.x", "RootQ.y", "RootQ.z", "RootQ.w" };
        for (int k = 0; k < 3; k++) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("", typeof(Animator), rt[k]), AnimationCurve.Linear(0, hp.bodyPosition[k], 1, hp.bodyPosition[k]));
        for (int k = 0; k < 4; k++) AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("", typeof(Animator), rq[k]), AnimationCurve.Linear(0, hp.bodyRotation[k], 1, hp.bodyRotation[k]));
        AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("Face", typeof(SkinnedMeshRenderer), "blendShape.jawOpen"), AnimationCurve.Linear(0, 0, 1, 100));
        AssetDatabase.CreateAsset(clip, "Assets/UnityReference.anim");
        AssetDatabase.SaveAssets();
        Debug.Log("ANIMPROBE run ok: " + inp.poses.Length + " poses, humanScale " + o.humanScale);
    }

    [Serializable] class FwdIn { public int n; public float[] muscles; public float[] bodyPos; public float[] bodyRot; }
    [Serializable] class FwdOut { public int n; public float[] q; public float[] hips; public float[] worldPos; }

    // Muscles → bones: Unity's own SetHumanPose on the probe avatar (ANIM_PROBE_FWD in, ANIM_PROBE_OUT out).
    public static void Forward()
    {
        var inp = JsonUtility.FromJson<Input>(File.ReadAllText(Environment.GetEnvironmentVariable("ANIM_PROBE_IN")));
        var fin = JsonUtility.FromJson<FwdIn>(File.ReadAllText(Environment.GetEnvironmentVariable("ANIM_PROBE_FWD")));
        var avatar = Build(inp);
        int B = inp.names.Length; int M = HumanTrait.MuscleCount;
        var handler = new HumanPoseHandler(avatar, root.transform);
        var hp = new HumanPose { muscles = new float[M] };
        var fo = new FwdOut { n = fin.n, q = new float[fin.n * B * 4], hips = new float[fin.n * 3], worldPos = new float[fin.n * B * 3] };
        for (int i = 0; i < fin.n; i++)
        {
            for (int m = 0; m < M; m++) hp.muscles[m] = fin.muscles[i * M + m];
            hp.bodyPosition = new Vector3(fin.bodyPos[i * 3], fin.bodyPos[i * 3 + 1], fin.bodyPos[i * 3 + 2]);
            hp.bodyRotation = new Quaternion(fin.bodyRot[i * 4], fin.bodyRot[i * 4 + 1], fin.bodyRot[i * 4 + 2], fin.bodyRot[i * 4 + 3]);
            handler.SetHumanPose(ref hp);
            var h = bones[0].position; fo.hips[i * 3] = h.x; fo.hips[i * 3 + 1] = h.y; fo.hips[i * 3 + 2] = h.z;
            for (int b = 0; b < B; b++)
            {
                var q = b == 0 ? bones[0].rotation : bones[b].localRotation;
                int k = (i * B + b) * 4; fo.q[k] = q.x; fo.q[k + 1] = q.y; fo.q[k + 2] = q.z; fo.q[k + 3] = q.w;
                var w = bones[b].position; int k3 = (i * B + b) * 3; fo.worldPos[k3] = w.x; fo.worldPos[k3 + 1] = w.y; fo.worldPos[k3 + 2] = w.z;
            }
        }
        File.WriteAllText(Environment.GetEnvironmentVariable("ANIM_PROBE_OUT"), JsonUtility.ToJson(fo));
        Debug.Log("ANIMPROBE forward ok: " + fin.n + " poses");
    }

    public static void Verify()
    {
        var inp = JsonUtility.FromJson<Input>(File.ReadAllText(Environment.GetEnvironmentVariable("ANIM_PROBE_IN")));
        var avatar = Build(inp);
        string path = Environment.GetEnvironmentVariable("ANIM_PROBE_CLIP");
        AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
        var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(path);
        if (clip == null) throw new Exception("could not load " + path);
        var animator = root.AddComponent<Animator>();
        animator.avatar = avatar; animator.applyRootMotion = true;
        int B = inp.names.Length;
        int n = Mathf.Max(2, int.Parse(Environment.GetEnvironmentVariable("ANIM_PROBE_SAMPLES") ?? "60"));
        var vo = new VerifyOut { length = clip.length, frameRate = clip.frameRate, isHuman = clip.isHumanMotion, bindings = AnimationUtility.GetCurveBindings(clip).Length, samples = new Sample[n] };
        for (int i = 0; i < n; i++)
        {
            float t = clip.length * i / (n - 1);
            root.transform.localPosition = Vector3.zero; root.transform.localRotation = Quaternion.identity;
            clip.SampleAnimation(root, t);
            var s = new Sample { t = t, q = new float[B * 4] };
            // Hips relative to the scene, whatever the sampler did with the root object.
            var hp = bones[0].position; s.hips = new[] { hp.x, hp.y, hp.z };
            for (int b = 0; b < B; b++)
            {
                var q = b == 0 ? bones[0].rotation : bones[b].localRotation;
                s.q[b * 4] = q.x; s.q[b * 4 + 1] = q.y; s.q[b * 4 + 2] = q.z; s.q[b * 4 + 3] = q.w;
            }
            vo.samples[i] = s;
        }
        File.WriteAllText(Environment.GetEnvironmentVariable("ANIM_PROBE_OUT"), JsonUtility.ToJson(vo));
        Debug.Log("ANIMPROBE verify ok: " + n + " samples, isHuman " + clip.isHumanMotion + ", length " + clip.length);
    }
}
