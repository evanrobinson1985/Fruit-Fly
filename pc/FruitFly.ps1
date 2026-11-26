# Fruit Fly for Windows: serves the website from this folder on http://localhost and opens it
# in its own window (Microsoft Edge in app mode; your default browser if Edge isn't there).
# Everything is local: the 3D fly, its 165,122-neuron brain, the frogs, the pond, three.js.
# Closing the Edge window stops the server. Started by the "Fruit Fly" desktop shortcut.
# At each start it checks GitHub for a newer build and installs it first (offline: skipped).
param([int]$Port = 47812, [switch]$NoUpdate)

# ---------- updates: from the pc-latest release (.github/workflows/pc-package.yml) ----------
$release = 'https://github.com/evanrobinson1985/Fruit-Fly/releases/download/pc-latest'
function Get-Text($u) {
  $c = (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 6).Content
  if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
  return "$c".Trim()
}
function Install-Update {
  Add-Type -AssemblyName System.Windows.Forms
  $form = New-Object Windows.Forms.Form
  $form.Text = 'Fruit Fly'; $form.Width = 380; $form.Height = 130; $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'; $form.ControlBox = $false; $form.TopMost = $true
  $label = New-Object Windows.Forms.Label
  $label.Text = 'Downloading the latest Fruit Fly...'; $label.AutoSize = $true; $label.Left = 20; $label.Top = 18
  $bar = New-Object Windows.Forms.ProgressBar
  $bar.Left = 20; $bar.Top = 48; $bar.Width = 325; $bar.Style = 'Marquee'
  $form.Controls.AddRange(@($label, $bar))
  $form.Show(); [Windows.Forms.Application]::DoEvents()
  try {
    $tmp = Join-Path $env:TEMP 'FruitFly-update'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item $tmp -ItemType Directory -Force | Out-Null
    $zip = Join-Path $tmp 'FruitFly-PC.zip'
    $wc = New-Object Net.WebClient
    $task = $wc.DownloadFileTaskAsync("$release/FruitFly-PC.zip", $zip)
    while (-not $task.IsCompleted) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
    if ($task.IsFaulted) { throw $task.Exception }
    $label.Text = 'Installing...'; [Windows.Forms.Application]::DoEvents()
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Join-Path $tmp 'FruitFly-PC\FruitFly'
    if (-not (Test-Path (Join-Path $src 'FruitFly.ps1'))) { throw 'The update package is incomplete.' }
    robocopy $src $PSScriptRoot /MIR /XD browser /NFL /NDL /NJH /NJS /NP | Out-Null
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $form.Close()
    # Start the new version (without checking again).
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'FruitFly.ps1')`"", '-NoUpdate')
    exit
  } catch {
    $form.Close()
    # Couldn't update: carry on with the installed version.
  }
}
if (-not $NoUpdate) {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $local = (Get-Content (Join-Path $PSScriptRoot 'version.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)
    $latest = Get-Text "$release/pc-version.txt"
    if ($latest -match '^\d+$' -and "$latest" -ne "$local") { Install-Update }
  } catch { }  # offline, or GitHub unreachable: start the installed version
}

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
    "--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--start-maximized', '--force_high_performance_gpu',
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
