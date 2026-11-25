# Fruit Fly for Windows: serves the website from this folder on http://localhost and opens it
# in its own window (Microsoft Edge in app mode; your default browser if Edge isn't there).
# Everything is local: the 3D fly, its 165,122-neuron brain, the frogs, the pond, three.js.
# Closing the Edge window stops the server. Started by the "Fruit Fly" desktop shortcut.
param([int]$Port = 47812)

$root = Join-Path $PSScriptRoot 'site'
$url = "http://localhost:$Port/index.html"
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json'; '.css' = 'text/css'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'; '.glb' = 'model/gltf-binary'; '.wasm' = 'application/wasm'
  '.ktx2' = 'image/ktx2'; '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  # Already running (another window): just open it.
  Start-Process $url
  exit
}

# Its own window: Edge in app mode with its own profile (so closing it ends this server).
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$window = $null
if ($edge) {
  $profileDir = Join-Path $env:LOCALAPPDATA 'FruitFly\browser'
  $window = Start-Process -FilePath $edge -PassThru -ArgumentList @(
    "--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--start-maximized',
    '--autoplay-policy=no-user-gesture-required')
} else {
  Start-Process $url
}

function Send-File($ctx, $path) {
  $res = $ctx.Response
  try {
    $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
    $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
    $res.AddHeader('Cache-Control', 'no-cache')
    $fs = [IO.File]::OpenRead($path)
    try { $res.ContentLength64 = $fs.Length; $fs.CopyTo($res.OutputStream) } finally { $fs.Dispose() }
  } catch { } finally { try { $res.Close() } catch { } }
}

while ($listener.IsListening) {
  $pending = $listener.BeginGetContext($null, $null)
  while (-not $pending.AsyncWaitHandle.WaitOne(500)) {
    if ($window -and $window.HasExited) { $listener.Stop(); exit }
  }
  try { $ctx = $listener.EndGetContext($pending) } catch { break }
  $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
  if ($rel -eq '') { $rel = 'index.html' }
  $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
  if ($full.StartsWith([IO.Path]::GetFullPath($root)) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
    Send-File $ctx $full
  } else {
    $ctx.Response.StatusCode = 404
    $ctx.Response.Close()
  }
}
