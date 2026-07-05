import type { Vec3, Quat } from "../wanim/parse.ts";

/** Hamilton product a*b for (x,y,z,w) quaternions. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotate vector v by quaternion q. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** Spherical linear interpolation; assumes inputs roughly normalized. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let dot = quatDot(a, b);
  let bb = b;
  if (dot < 0) {
    bb = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    // nearly parallel — linear interpolate and renormalize
    return quatNormalize([
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ]);
  }
  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sin0 = Math.sin(theta0);
  const s0 = Math.sin(theta0 - theta) / sin0;
  const s1 = Math.sin(theta) / sin0;
  return [
    a[0] * s0 + bb[0] * s1,
    a[1] * s0 + bb[1] * s1,
    a[2] * s0 + bb[2] * s1,
    a[3] * s0 + bb[3] * s1,
  ];
}

/**
 * Quaternion → intrinsic ZYX Euler angles (radians), matching three.js
 * `Euler` order 'ZYX'. three's FBXLoader maps FBX's default RotationOrder
 * (eEulerXYZ) onto this extraction, so emitting these into Lcl Rotation with
 * the default RotationOrder round-trips through FBX-SDK-based importers.
 * Returns [x, y, z].
 */
export function quatToEulerZYX(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  // rotation matrix elements (row, col)
  const m11 = 1 - (yy + zz);
  const m12 = xy - wz;
  const m21 = xy + wz;
  const m22 = 1 - (xx + zz);
  const m31 = xz - wy;
  const m32 = yz + wx;
  const m33 = 1 - (xx + yy);

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const ey = Math.asin(-clamp(m31));
  let ex: number, ez: number;
  if (Math.abs(m31) < 0.9999999) {
    ex = Math.atan2(m32, m33);
    ez = Math.atan2(m21, m11);
  } else {
    ex = 0;
    ez = Math.atan2(-m12, m22);
  }
  return [ex, ey, ez];
}

export const RAD2DEG = 180 / Math.PI;

/**
 * Intrinsic ZYX Euler (radians) → quaternion; exact inverse of
 * quatToEulerZYX (q = qz ⊗ qy ⊗ qx). Used by the curve editor to expose
 * rotation deltas as editable per-axis angles.
 */
export function eulerZYXToQuat(e: Vec3): Quat {
  const cx = Math.cos(e[0] / 2), sx = Math.sin(e[0] / 2);
  const cy = Math.cos(e[1] / 2), sy = Math.sin(e[1] / 2);
  const cz = Math.cos(e[2] / 2), sz = Math.sin(e[2] / 2);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}
