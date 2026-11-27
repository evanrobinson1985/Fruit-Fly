# Build the clover-patch filler (web/assets/env/clover-patch.glb, and env/hd/ with 2048-pixel maps)
# from "Clovers - Plants / Foliage" by Studio Lab (CC BY 4.0): its detail levels as meshes
# "lod1", "lod2", centred, ground at y = 0, in arena millimetres, textures resized.
#   python3 tools/assets/build_clover_patch.py in.glb out.glb 1024 1,2     (env/hd: 2048 1,2)
import json, struct, io, sys, numpy as np
from PIL import Image
src, dst, TEX, LODS = sys.argv[1], sys.argv[2], int(sys.argv[3]), [int(x) for x in sys.argv[4].split(",")]
d = open(src, 'rb').read(); l = struct.unpack('<I', d[12:16])[0]; j = json.loads(d[20:20+l]); b0 = 20 + l + 8
def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; o = b0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]; dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a['componentType']]
    x = np.frombuffer(d, dt, a['count'] * n, o); return (x.reshape(-1, n) if n > 1 else x).astype(np.float64 if dt == np.float32 else np.int64)
def mat(n): return np.array(n['matrix']).reshape(4, 4).T if 'matrix' in n else np.eye(4)
# world matrix of each mesh node, without the row offsets that set the four levels apart
parent = {c: i for i, n in enumerate(j['nodes']) for c in n.get('children', [])}
def world(i, skip_offsets=True):
    m = np.eye(4); k = i
    while k is not None:
        mk = mat(j['nodes'][k])
        if skip_offsets and j['nodes'][k].get('name', '').startswith('D01_0'): mk = mk.copy(); mk[:3, 3] = 0
        m = mk @ m; k = parent.get(k)
    return m
MM = 174.0  # m -> arena mm: its clover leaves come out the size of the arena's clovers
meshes = {}
for i, n in enumerate(j['nodes']):
    if 'mesh' not in n: continue
    lod = int(n['name'][5]) if n['name'].startswith('D01_0') else 0
    pr = j['meshes'][n['mesh']]['primitives'][0]
    W = world(i)
    P = acc(pr['attributes']['POSITION']); N = acc(pr['attributes']['NORMAL']); UV = acc(pr['attributes']['TEXCOORD_0']); I = acc(pr['indices'])
    P = (np.c_[P, np.ones(len(P))] @ W.T)[:, :3]; N = N @ W[:3, :3].T; N /= np.maximum(1e-9, np.linalg.norm(N, axis=1))[:, None]
    meshes[lod] = [P, N, UV, I]
# common placement: centred on lod0's footprint, its lowest point on the ground
P0 = meshes[0][0]; cx, cz = (P0[:, 0].min() + P0[:, 0].max()) / 2, (P0[:, 2].min() + P0[:, 2].max()) / 2; gy = P0[:, 1].min()
for k in meshes: meshes[k][0] = (meshes[k][0] - [cx, gy, cz]) * MM
print({k: (len(v[0]), v[0].min(0).round(1).tolist(), v[0].max(0).round(1).tolist()) for k, v in meshes.items()})
# textures
def img(ix, px, kind):
    im_ = j['images'][j['textures'][ix]['source']]; bv = j['bufferViews'][im_['bufferView']]
    im = Image.open(io.BytesIO(d[b0 + bv.get('byteOffset', 0): b0 + bv.get('byteOffset', 0) + bv['byteLength']]))
    if im.width > px: im = im.resize((px, px * im.height // im.width), Image.LANCZOS)
    b = io.BytesIO()
    if kind == 'png': im.convert('RGBA').save(b, 'PNG', optimize=True); return b.getvalue(), 'image/png'
    im.convert('RGB').save(b, 'JPEG', quality=88); return b.getvalue(), 'image/jpeg'
M = j['materials'][0]
texs = [img(M['pbrMetallicRoughness']['baseColorTexture']['index'], TEX, 'png'),
        img(M['pbrMetallicRoughness']['metallicRoughnessTexture']['index'], TEX // 2, 'jpg'),
        img(M['normalTexture']['index'], TEX, 'jpg')]
buf = bytearray(); views, accs = [], []
def add(arr, comp, typ, target=None, minmax=False):
    global buf
    while len(buf) % 4: buf += b'\0'
    data = arr.astype({5126: np.float32, 5125: np.uint32}[comp]).tobytes()
    views.append({'buffer': 0, 'byteOffset': len(buf), 'byteLength': len(data), **({'target': target} if target else {})}); buf += data
    a = {'bufferView': len(views) - 1, 'componentType': comp, 'count': len(arr), 'type': typ}
    if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a); return len(accs) - 1
out_m, nodes = [], []
for k in LODS:
    P, N, UV, I = meshes[k]
    out_m.append({'name': f'lod{k}', 'primitives': [{'attributes': {'POSITION': add(P, 5126, 'VEC3', 34962, True), 'NORMAL': add(N, 5126, 'VEC3', 34962), 'TEXCOORD_0': add(UV, 5126, 'VEC2', 34962)},
        'indices': add(I, 5125, 'SCALAR', 34963), 'material': 0}]})
    nodes.append({'name': f'lod{k}', 'mesh': len(out_m) - 1})
images = []
for data, mime in texs:
    while len(buf) % 4: buf += b'\0'
    views.append({'buffer': 0, 'byteOffset': len(buf), 'byteLength': len(data)}); buf += data
    images.append({'bufferView': len(views) - 1, 'mimeType': mime})
mat_ = {'name': 'clovers', 'alphaMode': 'MASK', 'alphaCutoff': 0.4, 'doubleSided': True, 'normalTexture': {'index': 2},
        'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicRoughnessTexture': {'index': 1}, 'metallicFactor': 0.0}}
gl = {'asset': {'version': '2.0', 'generator': 'Fruit-Fly clover patch build', 'extras': j['asset'].get('extras', {})}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}],
      'nodes': nodes, 'meshes': out_m, 'materials': [mat_], 'textures': [{'source': i} for i in range(3)], 'images': images,
      'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(buf)}]}
js = json.dumps(gl, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
while len(buf) % 4: buf += b'\0'
open(dst, 'wb').write(struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(buf)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(buf), 0x004E4942) + bytes(buf))
print('wrote', dst, len(js) + len(buf) >> 10, 'KB')
