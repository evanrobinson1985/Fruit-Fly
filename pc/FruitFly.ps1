# Fruit Fly for Windows: serves the website from this folder on http://localhost and opens it
# in its own window (Microsoft Edge in app mode; your default browser if Edge isn't there).
# Everything is local: the 3D fly, its 165,122-neuron brain, the frogs, the pond, three.js.
# Closing the Edge window stops the server. Started by the "Fruit Fly" desktop shortcut.
# At each start it checks GitHub for a newer build and installs it first (offline: skipped):
# only the files that changed are downloaded (pc-manifest.json lists every file's SHA-256).
param([int]$Port = 47812, [switch]$NoUpdate)

# ---------- updates: from the pc-latest release (.github/workflows/pc-package.yml) ----------
$release = 'https://github.com/evanrobinson1985/Fruit-Fly/releases/download/pc-latest'
function Get-Text($u) {
  $c = (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 6).Content
  if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
  return "$c".Trim()
}
# The progress window shown while updating.
function New-UpdateWindow($text) {
  Add-Type -AssemblyName System.Windows.Forms
  $form = New-Object Windows.Forms.Form
  $form.Text = 'Fruit Fly'; $form.Width = 400; $form.Height = 130; $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'; $form.ControlBox = $false; $form.TopMost = $true
  $label = New-Object Windows.Forms.Label
  $label.Text = $text; $label.AutoSize = $true; $label.Left = 20; $label.Top = 18
  $bar = New-Object Windows.Forms.ProgressBar
  $bar.Left = 20; $bar.Top = 48; $bar.Width = 345; $bar.Maximum = 1000
  $form.Controls.AddRange(@($label, $bar))
  $form.Show(); [Windows.Forms.Application]::DoEvents()
  return @{ Form = $form; Label = $label; Bar = $bar }
}

# Just the changed files: compare each file with the new build's list (by SHA-256; files the
# last update recorded in manifest.json and that haven't changed size aren't re-hashed),
# download the ones that differ, check them, then put them in place.
function Update-ChangedFiles {
  $manifest = (Get-Text "$release/pc-manifest.json") | ConvertFrom-Json
  $known = @{}
  $old = Join-Path $PSScriptRoot 'manifest.json'
  if (Test-Path $old) { try { foreach ($f in (Get-Content $old -Raw | ConvertFrom-Json).files) { $known[$f.path] = $f.sha256 } } catch { } }
  $need = @()
  foreach ($f in $manifest.files) {
    $local = Join-Path $PSScriptRoot ($f.path -replace '/', '\')
    if (Test-Path -LiteralPath $local -PathType Leaf) {
      $item = Get-Item -LiteralPath $local
      if ($item.Length -eq $f.size) {
        if ($known[$f.path] -eq $f.sha256) { continue }
        if ((Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -eq $f.sha256.ToUpper()) { continue }
      }
    }
    $need += $f
  }
  $total = ($need | Measure-Object -Property size -Sum).Sum
  if (-not $total) { $total = 0 }
  $ui = $null
  $tmp = Join-Path $env:TEMP 'FruitFly-update'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item $tmp -ItemType Directory -Force | Out-Null
  try {
    if ($need.Count) {
      $ui = New-UpdateWindow ("Updating Fruit Fly: {0} changed file(s), {1:N1} MB" -f $need.Count, ($total / 1MB))
      $done = 0
      foreach ($f in $need) {
        $dest = Join-Path $tmp ($f.path -replace '/', '\')
        New-Item (Split-Path $dest) -ItemType Directory -Force | Out-Null
        $wc = New-Object Net.WebClient
        $task = $wc.DownloadFileTaskAsync($f.url, $dest)
        while (-not $task.IsCompleted) {
          $got = 0; if (Test-Path $dest) { $got = (Get-Item $dest).Length }
          if ($total -gt 0) { $ui.Bar.Value = [Math]::Min(1000, [int](1000 * ($done + $got) / $total)) }
          [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50
        }
        if ($task.IsFaulted) { throw $task.Exception }
        if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -ne $f.sha256.ToUpper()) { throw "Bad download: $($f.path)" }
        $done += $f.size
      }
      $ui.Label.Text = 'Installing...'; [Windows.Forms.Application]::DoEvents()
      # Everything is downloaded and checked: now replace the files.
      foreach ($f in $need) {
        $dest = Join-Path $PSScriptRoot ($f.path -replace '/', '\')
        New-Item (Split-Path $dest) -ItemType Directory -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $tmp ($f.path -replace '/', '\')) -Destination $dest -Force
      }
    }
    # Files the new build no longer has (in the site folder only).
    $keep = @{}; foreach ($f in $manifest.files) { $keep[($f.path -replace '/', '\').ToLowerInvariant()] = 1 }
    $site = Join-Path $PSScriptRoot 'site'
    Get-ChildItem $site -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      $relPath = $_.FullName.Substring($PSScriptRoot.Length).TrimStart('\').ToLowerInvariant()
      if (-not $keep.ContainsKey($relPath)) { Remove-Item -LiteralPath $_.FullName -Force }
    }
    $manifest | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $old -Encoding UTF8
  } finally {
    if ($ui) { $ui.Form.Close() }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  return ($need | Where-Object { $_.path -eq 'FruitFly.ps1' }).Count -gt 0
}

# The whole package (only if the file-by-file update can't be done).
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
    robocopy $src $PSScriptRoot /MIR /XD browser my-assets /NFL /NDL /NJH /NJS /NP | Out-Null
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
    if ($latest -match '^\d+$' -and "$latest" -ne "$local") {
      $relaunch = $false
      try { $relaunch = Update-ChangedFiles } catch { Install-Update }
      if ($relaunch) {
        # this script itself was updated: start the new one
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'FruitFly.ps1')`"", '-NoUpdate')
        exit
      }
    }
  } catch { }  # offline, or GitHub unreachable: start the installed version
}

$root = Join-Path $PSScriptRoot 'site'
# Your own files, kept through updates: models too big for the download (put
# "2 Realistic Frogs Rigged.glb" here for the full-resolution frogs). Served at /my-assets/.
$mine = Join-Path $PSScriptRoot 'my-assets'
New-Item $mine -ItemType Directory -Force | Out-Null
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
  $base = $root
  if ($rel -like 'my-assets/*') { $base = $mine; $rel = $rel.Substring(10) }
  $full = [IO.Path]::GetFullPath((Join-Path $base $rel))
  if ($full.StartsWith([IO.Path]::GetFullPath($base)) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
    Send-File $ctx $full
  } else {
    $ctx.Response.StatusCode = 404
    $ctx.Response.Close()
  }
}
