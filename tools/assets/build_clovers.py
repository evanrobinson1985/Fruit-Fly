# Build web/assets/env/clovers.glb from the 4-leaf clover model: "clover4" (the model, stood up
# with its stalk into the ground, at arena size, its blossom simplified) and "clover3"
# (identical, one leaflet removed and the other three spaced 120 degrees apart).
#   python3 tools/assets/build_clovers.py "4 Leaf Clover.glb" web/assets/env/clovers.glb   (NumPy, Pillow)
import json, struct, io, sys, numpy as np
from collections import defaultdict
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
d = open(src, 'rb').read(); l = struct.unpack('<I', d[12:16])[0]; j = json.loads(d[20:20+l]); b0 = 20 + l + 8
def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; o = b0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[a['type']]; dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a['componentType']]
    x = np.frombuffer(d, dt, a['count'] * n, o)
    return (x.reshape(-1, n) if n > 1 else x).astype(np.float64 if dt == np.float32 else np.int64)
pr = j['meshes'][2]['primitives'][0]
P, N, UV, I = acc(pr['attributes']['POSITION']), acc(pr['attributes']['NORMAL']), acc(pr['attributes']['TEXCOORD_0']), acc(pr['indices']).reshape(-1, 3)
blos = [(acc(j['meshes'][k]['primitives'][0]['attributes']['POSITION']), acc(j['meshes'][k]['primitives'][0]['indices']).reshape(-1, 3)) for k in (0, 1)]
B0 = blos[0][0]
c = np.array([(B0[:, 0].min() + B0[:, 0].max()) / 2, 0.0, (B0[:, 2].min() + B0[:, 2].max()) / 2])
# components (welding split vertices): the leaves, and the stalk
par = list(range(len(P)))
def f(x):
    while par[x] != x: par[x] = par[par[x]]; x = par[x]
    return x
for t in I: par[f(t[0])] = f(t[1]); par[f(t[1])] = f(t[2])
pos = defaultdict(list)
for i, v in enumerate(P): pos[tuple(np.round(v, 6))].append(i)
for vs in pos.values():
    for v in vs[1:]: par[f(v)] = f(vs[0])
roots = defaultdict(list)
for i in range(len(P)): roots[f(i)].append(i)
comps = sorted(roots.values(), key=len)
stemV = set(comps[0])
# the stalk: from where it meets the leaves straight down, shortened to the arena clovers' height
S = 250.0                    # m -> mm, and to arena size (7.5 mm across)
LEAF_H = 3.5                 # mm: leaves above the ground
sv = np.array(sorted(stemV))
A = P[sv][np.argmin(np.hypot(P[sv, 0] - c[0], P[sv, 2] - c[2]))]
far = P[sv][np.argmax(np.linalg.norm(P[sv] - A, axis=1))]
dvec = (far - A) / np.linalg.norm(far - A); down = np.array([0, -1.0, 0])
ax = np.cross(dvec, down); sn = np.linalg.norm(ax); cs = np.dot(dvec, down)
K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
R = np.eye(3) + K + K @ K * ((1 - cs) / (sn * sn)) if sn > 1e-9 else np.eye(3)
stemLen = np.linalg.norm(far - A)
k = (LEAF_H / S) / stemLen
P2, N2 = P.copy(), N.copy()
for i in sv:
    q = R @ (P[i] - A); q[1] *= k; q[0] *= 0.6; q[2] *= 0.6  # (thinner too, at the shorter length)
    P2[i] = A + q
    N2[i] = R @ N[i]
ground = A[1] - LEAF_H / S
def place(p): return (p - np.array([c[0], ground, c[2]])) * S
def rotY(v, a, about):
    ca, sa = np.cos(a), np.sin(a); x, z = v[..., 0] - about[0], v[..., 2] - about[2]
    out = v.copy(); out[..., 0] = about[0] + ca * x + sa * z; out[..., 2] = about[2] - sa * x + ca * z; return out
# leaflets by angle about the centre (gaps between them at -110, -20, 70, 160 degrees)
cent = P[I].mean(1)
ang = np.degrees(np.arctan2(cent[:, 2] - c[2], cent[:, 0] - c[0]))
def sector(a): return 0 if -110 <= a < -20 else 1 if -20 <= a < 70 else 2 if 70 <= a < 160 else 3
lobe = {0: -65, 1: 25, 2: 115, 3: -155}
def leaves(three):
    # three: drop lobe 3 (-155 degrees); lobe 0 (-65) turns by -30 and lobe 2 (115) by +30.
    # Each vertex turns by its leaflet's angle, eased in from the hub (none at the centre, all of
    # it outside RC1), so the centre where the leaflets meet stays whole.
    turn = {0: -30, 1: 0, 2: 30, 3: 0}
    RC0, RC1 = 0.0025, 0.0060
    va = np.degrees(np.arctan2(P2[:, 2] - c[2], P2[:, 0] - c[0])); vr = np.hypot(P2[:, 0] - c[0], P2[:, 2] - c[2])
    vs = np.array([sector(x) for x in va])
    # each leaflet is its own piece once the hub where they meet is cut out: label them so
    # (the angle alone mislabels the curved edges of a leaflet)
    HUB = 0.0055
    lp = list(range(len(P2)))
    def lf(x):
        while lp[x] != x: lp[x] = lp[lp[x]]; x = lp[x]
        return x
    out = lambda i: vr[i] >= HUB and i not in stemV
    for t in I:
        for a_, b_ in ((t[0], t[1]), (t[1], t[2]), (t[0], t[2])):
            if out(a_) and out(b_): lp[lf(a_)] = lf(b_)
    for vs_ in pos.values():
        ok = [v for v in vs_ if out(v)]
        for v in ok[1:]: lp[lf(v)] = lf(ok[0])
    groups = defaultdict(list)
    for i in range(len(P2)):
        if out(i): groups[lf(i)].append(i)
    for g in groups.values():
        if len(g) < 30: continue
        mean = np.degrees(np.arctan2((P2[g, 2] - c[2]).sum(), (P2[g, 0] - c[0]).sum()))
        vs[g] = sector(mean)
    w = np.clip((vr - RC0) / (RC1 - RC0), 0, 1); w = w * w * (3 - 2 * w)
    keep = np.ones(len(I), bool)
    if three:
        gone = (vs == 3) & (vr > 0.0038) & np.array([i not in stemV for i in range(len(P2))])
        keep = ~gone[I].any(1)
    Pn, Nn = P2.copy(), N2.copy()
    if three:
        for i in range(len(P2)):
            if i in stemV: continue
            a = np.radians(turn[vs[i]] * w[i])
            if a: Pn[i] = rotY(P2[i], -a, c); Nn[i] = rotY(N2[i], -a, np.zeros(3))
    Ik = I[keep]
    used = np.unique(Ik); remap = -np.ones(len(P2), int); remap[used] = np.arange(len(used))
    return place(Pn[used]), Nn[used], UV[used], remap[Ik]
# the blossom, simplified (vertex clustering on a 0.25 mm grid of the model)
def cluster(Pb, Ib, cell=0.00022):
    key = np.floor((Pb - Pb.min(0)) / cell).astype(np.int64)
    k1 = key[:, 0] * 1000003 + key[:, 1] * 1009 + key[:, 2]
    uniq, inv = np.unique(k1, return_inverse=True)
    sums = np.zeros((len(uniq), 3)); np.add.at(sums, inv, Pb); cnt = np.bincount(inv)
    Pc = sums / cnt[:, None]; Ic = inv[Ib]
    Ic = Ic[(Ic[:, 0] != Ic[:, 1]) & (Ic[:, 1] != Ic[:, 2]) & (Ic[:, 0] != Ic[:, 2])]
    Ic = np.unique(np.sort(Ic, 1), axis=0) if False else Ic
    return Pc, Ic
bp, bi, off = [], [], 0
for Pb, Ib in blos:
    Pc, Ic = cluster(Pb, Ib); bp.append(Pc); bi.append(Ic + off); off += len(Pc)
BP = place(np.vstack(bp)); BI = np.vstack(bi)
def normals(Pv, Iv):
    n = np.zeros_like(Pv); fn = np.cross(Pv[Iv[:, 1]] - Pv[Iv[:, 0]], Pv[Iv[:, 2]] - Pv[Iv[:, 0]])
    for kk in range(3): np.add.at(n, Iv[:, kk], fn)
    return n / np.maximum(1e-12, np.linalg.norm(n, axis=1))[:, None]
BN = normals(BP, BI)
# the leaf texture, at 1024 px
img = j['images'][0]; bv = j['bufferViews'][img['bufferView']]
im = Image.open(io.BytesIO(d[b0 + bv.get('byteOffset', 0): b0 + bv.get('byteOffset', 0) + bv['byteLength']])).convert('RGB')
if im.width > 1024: im = im.resize((1024, 1024 * im.height // im.width), Image.LANCZOS)
jb = io.BytesIO(); im.save(jb, 'JPEG', quality=88); tex = jb.getvalue()
# ---------- write the GLB ----------
buf = bytearray(); views, accs = [], []
def add(arr, comp, typ, target=None, minmax=False):
    global buf
    while len(buf) % 4: buf += b'\0'
    data = arr.astype({5126: np.float32, 5125: np.uint32}[comp]).tobytes()
    views.append({'buffer': 0, 'byteOffset': len(buf), 'byteLength': len(data), **({'target': target} if target else {})})
    buf += data
    a = {'bufferView': len(views) - 1, 'componentType': comp, 'count': len(arr), 'type': typ}
    if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a); return len(accs) - 1
meshes, nodes = [], []
bpA, bnA, biA = add(BP, 5126, 'VEC3', 34962, True), add(BN, 5126, 'VEC3', 34962), add(BI.reshape(-1), 5125, 'SCALAR', 34963)
for name, three in (("clover4", False), ("clover3", True)):
    Pl, Nl, Ul, Il = leaves(three)
    prims = [{'attributes': {'POSITION': add(Pl, 5126, 'VEC3', 34962, True), 'NORMAL': add(Nl, 5126, 'VEC3', 34962), 'TEXCOORD_0': add(Ul, 5126, 'VEC2', 34962)},
              'indices': add(Il.reshape(-1), 5125, 'SCALAR', 34963), 'material': 0},
             {'attributes': {'POSITION': bpA, 'NORMAL': bnA}, 'indices': biA, 'material': 1}]
    meshes.append({'name': name, 'primitives': prims}); nodes.append({'name': name, 'mesh': len(meshes) - 1})
    print(name, "leaf verts", len(Pl), "blossom verts", len(BP), "size", Pl.min(0).round(2), Pl.max(0).round(2))
while len(buf) % 4: buf += b'\0'
views.append({'buffer': 0, 'byteOffset': len(buf), 'byteLength': len(tex)}); buf += tex
gl = {'asset': {'version': '2.0', 'generator': 'Fruit-Fly clover build', 'extras': j['asset'].get('extras', {})},
      'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes,
      'materials': [{'name': 'CloverLeaves', 'doubleSided': True, 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 0.6}},
                    {'name': 'Blossoms', 'doubleSided': True, 'pbrMetallicRoughness': {'baseColorFactor': [0.865667, 0.361016, 0.824661, 1.0], 'metallicFactor': 0, 'roughnessFactor': 0.6}}],
      'textures': [{'source': 0}], 'images': [{'bufferView': len(views) - 1, 'mimeType': 'image/jpeg'}],
      'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(buf)}]}
js = json.dumps(gl, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
while len(buf) % 4: buf += b'\0'
out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(buf), 0x004E4942) + bytes(buf)
open(dst, 'wb').write(out)
print("wrote", dst, len(out) // 1024, "KB")
