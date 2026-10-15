"""Export the FlyBody 3D fly (Vaxenburg et al. 2025, Nature; Apache-2.0) for the web viewer.

Needs `pip install flygym` (flygym brings MuJoCo). flygym
normally downloads the full-size FlyBody meshes from datasets.epfl.ch; if that
host is unreachable, pass --flybody-repo pointing at a clone of
https://github.com/TuragaLab/flybody and the meshes are taken from there.

Writes web/assets/fly.json (skeleton, materials, neutral pose, recorded step
cycles) and web/assets/fly.png (all 272k mesh triangles in body frames, with
vertex positions quantized to 16 bits within each part's bounding box; the
bytes are stored in a grayscale PNG, see pngpack.py).

    python web/tools/export_body.py --flybody-repo ../flybody
"""
from __future__ import annotations

import argparse
import io
import json
import re
import shutil
from importlib.resources import files
from pathlib import Path

import mujoco
import numpy as np
import yaml

import pngpack

OUT = Path(__file__).resolve().parents[1] / "assets"
LEGS = ["lf", "lm", "lh", "rf", "rm", "rh"]


def seed_mesh_cache(repo: Path):
    """Copy FlyBody OBJ meshes into flygym's cache under flygym's naming."""
    import flygym
    from flygym.compose.fly.flybody import FLYBODY_FULLSIZE_MESH_DIR
    from flygym.utils.assets_lazy_loading import get_cache_root

    dst = get_cache_root() / FLYBODY_FULLSIZE_MESH_DIR
    if dst.is_dir():
        return
    src = repo / "flybody/fruitfly/assets"
    suffixes = yaml.safe_load(open(Path(flygym.__file__).parent / "assets/model/flybody/all_geom_suffixes.yaml"))
    side, seg = {"l": "left", "r": "right"}, {"f": "T1", "m": "T2", "h": "T3"}

    def flybody_name(name, s):
        if m := re.fullmatch(r"c_abdomen(\d)", name):
            return f"abdomen_{m.group(1)}_{s}"
        if name.startswith("c_"):
            return f"{name[2:]}_{s}"
        if m := re.fullmatch(r"([lr])_(\w+)", name):
            return f"{m.group(2)}_{side[m.group(1)]}_{s}"
        m = re.fullmatch(r"([lr])([fmh])_(\w+)", name)
        sd, T, part = side[m.group(1)], seg[m.group(2)], m.group(3)
        part = "femur" if part == "trochanterfemur" else part
        if part == "tarsus5":
            return f"tarsal_claw_{T}_{sd}_{s}"
        if mt := re.fullmatch(r"tarsus(\d)", part):
            return f"tarsus_{T}_{mt.group(1)}_{sd}_{s}"
        return f"{part}_{T}_{sd}_{s}"

    dst.mkdir(parents=True)
    for name, sfx in suffixes.items():
        for s in sfx:
            shutil.copy(src / f"{flybody_name(name, s)}.obj", dst / f"{name}_{s}.obj")


def build_model():
    from flygym.compose import KinematicPosePreset
    from flygym.compose.fly import FlyBody
    from flygym.flybody import FlyBodyAxisOrder, FlyBodyJointPreset, FlyBodySkeleton

    fly = FlyBody(name="flybody")
    fly.add_joints(FlyBodySkeleton(axis_order=FlyBodyAxisOrder.YAW_ROLL_PITCH,
                                   joint_preset=FlyBodyJointPreset.ALL_BIOLOGICAL),
                   KinematicPosePreset.FLYBODY_NEUTRAL)
    return fly.mjcf_root.compile()


def qmul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2])


def qrot(q, v):
    return qmul(qmul(q, np.r_[0, v]), q * [1, -1, -1, -1])[1:]


def forward_kinematics(sk, qpos):
    """Same algorithm as the browser (web/src/fly.js): body poses in the root frame."""
    pos, quat = {}, {}
    for b in sk["bodies"]:
        p = b["parent"]
        pp, pq = (np.zeros(3), np.array([1.0, 0, 0, 0])) if p < 0 else (pos[p], quat[p])
        q = qmul(pq, b["quat"])
        for j in b["joints"]:
            th = qpos[j["qpos"]]
            q = qmul(q, np.r_[np.cos(th / 2), np.sin(th / 2) * np.array(j["axis"])])
        pos[b["id"]], quat[b["id"]] = pp + qrot(pq, b["pos"]), q
    return pos, quat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flybody-repo", type=Path)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    if a.flybody_repo:
        seed_mesh_cache(a.flybody_repo)
    m = build_model()
    name = lambda t, i: mujoco.mj_id2name(m, t, i)
    OB = mujoco.mjtObj

    # Skeleton: bodies in tree order (MuJoCo guarantees parent id < child id); body 0 is the world.
    bodies = []
    for b in range(1, m.nbody):
        joints = [{"name": name(OB.mjOBJ_JOINT, j), "axis": m.jnt_axis[j].tolist(), "qpos": int(m.jnt_qposadr[j])}
                  for j in range(m.body_jntadr[b], m.body_jntadr[b] + m.body_jntnum[b])]
        assert all(m.jnt_type[m.body_jntadr[b] + k] == mujoco.mjtJoint.mjJNT_HINGE for k in range(m.body_jntnum[b]))
        assert not np.any(m.jnt_pos[m.body_jntadr[b]:m.body_jntadr[b] + m.body_jntnum[b]])
        bodies.append({"id": b - 1, "name": name(OB.mjOBJ_BODY, b), "parent": int(m.body_parentid[b]) - 1,
                       "pos": m.body_pos[b].tolist(), "quat": m.body_quat[b].tolist(), "joints": joints})
    sk = {"bodies": bodies, "nq": int(m.nq), "neutral": m.qpos_spring.tolist()}

    # Check the browser FK algorithm against MuJoCo on random poses.
    d = mujoco.MjData(m)
    rng = np.random.default_rng(0)
    for _ in range(5):
        d.qpos[:] = m.qpos_spring + rng.uniform(-0.5, 0.5, m.nq)
        mujoco.mj_kinematics(m, d)
        pos, quat = forward_kinematics(sk, d.qpos)
        root_p, root_q = d.xpos[1], d.xquat[1]
        for b in range(1, m.nbody):
            want = qrot(root_q * [1, -1, -1, -1], d.xpos[b] - root_p)
            assert np.allclose(pos[b - 1] - pos[0], want, atol=1e-6), name(OB.mjOBJ_BODY, b)
    print("FK matches MuJoCo")

    # Meshes, transformed into their body's frame. (Decimating them tears the
    # surface, so all triangles are kept and positions are quantized instead.)
    visuals = yaml.safe_load(open(files("flygym") / "assets/model/flybody/visuals.yaml"))
    rgba = {v["apply_to"].lstrip("*"): v["material"] for v in visuals.values()}  # "_body" -> material
    geoms = [g for g in range(m.ngeom) if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH]
    blob, parts = io.BytesIO(), []
    kept = 0
    for g in geoms:
        k = m.geom_dataid[g]
        v = m.mesh_vert[m.mesh_vertadr[k]:m.mesh_vertadr[k] + m.mesh_vertnum[k]].astype(np.float64)
        f = m.mesh_face[m.mesh_faceadr[k]:m.mesh_faceadr[k] + m.mesh_facenum[k]]
        v = np.array([qrot(m.geom_quat[g], x) for x in v]) + m.geom_pos[g]
        lo, hi = v.min(0), v.max(0)
        scale = np.maximum(hi - lo, 1e-9) / 65535
        mesh = name(OB.mjOBJ_MESH, k)
        mat = rgba["_" + mesh.rsplit("_", 1)[1]]
        idx_type = np.uint16 if len(v) <= 65536 else np.uint32
        off = blob.tell()
        blob.write(np.round((v - lo) / scale).astype(np.uint16).tobytes())
        blob.write(b"\0" * (-blob.tell() % 4))
        ioff = blob.tell()
        blob.write(np.asarray(f, idx_type).tobytes())
        blob.write(b"\0" * (-blob.tell() % 4))
        parts.append({"mesh": mesh, "body": int(m.geom_bodyid[g]) - 1, "rgba": mat["rgba"],
                      "shininess": mat.get("shininess", 0.5), "offset": off, "index_offset": ioff,
                      "index32": idx_type == np.uint32, "min": lo.tolist(), "scale": scale.tolist(),
                      "nv": len(v), "nf": len(f)})
        kept += len(f)
    print(f"meshes: {len(parts)} parts, {kept} triangles")

    # Recorded single-step cycles (flygym_demo, from a real fly walking on a ball, retargeted to FlyBody).
    steps = np.load(files("flygym_demo.complex_terrain") / "assets/single_steps_flybody.npz")
    dofs = [("c_thorax", "coxa", "pitch"), ("c_thorax", "coxa", "roll"), ("c_thorax", "coxa", "yaw"),
            ("coxa", "trochanterfemur", "pitch"), ("coxa", "trochanterfemur", "roll"),
            ("trochanterfemur", "tibia", "pitch"), ("tibia", "tarsus1", "pitch")]
    qadr = {j["name"]: j["qpos"] for b in bodies for j in b["joints"]}
    leg_qpos = {leg: [qadr[(p if p == "c_thorax" else f"{leg}_{p}") + f"-{leg}_{c}-{ax}"] for p, c, ax in dofs]
                for leg in LEGS}
    sk["steps"] = {"angles": steps["joint_angles"].round(5).tolist(),  # [F,M,H][dof][phase bin]
                   "swing_fraction": steps["swing_fractions"].tolist(), "leg_qpos": leg_qpos,
                   "source": "flygym_demo single_steps_flybody.npz (NeuroMechFly walking-on-ball recording)"}
    sk["parts"] = parts
    sk["mesh_bytes"] = blob.tell()
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "fly.json").write_text(json.dumps(sk))
    png = pngpack.encode(blob.getvalue())
    (a.out / "fly.png").write_bytes(png)
    print(f"wrote {a.out / 'fly.json'} and fly.png ({len(png) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
