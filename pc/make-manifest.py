# Lists every file of the assembled PC package (FruitFly-PC/FruitFly) with its SHA-256 and
# where to download it, so the desktop app can update itself by fetching only the files that
# changed (pc/FruitFly.ps1). Files copied unchanged from the repository are fetched from
# raw.githubusercontent.com at this build's commit; the few the build writes itself (the
# page with its local three.js import map, version.txt) are release assets.
#   python3 pc/make-manifest.py <package dir> <owner/repo> <commit> <version> > pc-manifest.json
import hashlib, json, os, sys

pkg, repo, sha, version = sys.argv[1:5]
raw = f"https://raw.githubusercontent.com/{repo}/{sha}/"
rel = f"https://github.com/{repo}/releases/download/pc-latest/"
# package path prefix -> repository path prefix
SOURCES = [("site/src/", "web/src/"), ("site/assets/", "web/assets/"), ("site/vendor/", "watch/phone/vendor/"),
           ("FruitFly.ps1", "pc/FruitFly.ps1"), ("fly.ico", "pc/fly.ico")]
# written by the build: published as release assets under these names
ASSETS = {"site/index.html": "pc-index.html", "version.txt": "pc-version.txt"}

files = []
for root, _, names in os.walk(pkg):
    for n in sorted(names):
        full = os.path.join(root, n)
        path = os.path.relpath(full, pkg).replace(os.sep, "/")
        data = open(full, "rb").read()
        url = None
        if path in ASSETS:
            url = rel + ASSETS[path]
        else:
            for p, src in SOURCES:
                if path.startswith(p):
                    url = raw + src + path[len(p):]
                    # only if the repository's copy is the same file
                    if not os.path.isfile(src + path[len(p):]) or open(src + path[len(p):], "rb").read() != data:
                        sys.exit(f"{path}: not the same as {src + path[len(p):]} in the repository")
                    break
        if not url:
            sys.exit(f"{path}: no download source")
        files.append({"path": path, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "url": url})
json.dump({"version": int(version), "commit": sha, "files": sorted(files, key=lambda f: f["path"])}, sys.stdout, indent=0)
