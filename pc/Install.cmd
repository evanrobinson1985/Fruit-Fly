@echo off
rem Fruit Fly for Windows: installs the game into your user folder and puts a
rem "Fruit Fly" shortcut on the desktop. No administrator rights needed.
setlocal
set "DEST=%LOCALAPPDATA%\FruitFly"
echo Installing Fruit Fly to %DEST% ...
robocopy "%~dp0FruitFly" "%DEST%" /MIR /XD browser my-assets /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo Copying failed. & pause & exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = [Environment]::GetFolderPath('Desktop');" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Fruit Fly.lnk'));" ^
  "$s.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');" ^
  "$s.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%DEST%\FruitFly.ps1\"';" ^
  "$s.WorkingDirectory = '%DEST%';" ^
  "$s.IconLocation = '%DEST%\fly.ico';" ^
  "$s.Description = 'Fruit Fly: a fly driven by its whole connectome';" ^
  "$s.Save()"
echo Done. Starting Fruit Fly (next time, use the Fruit Fly icon on your desktop).
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%DEST%\FruitFly.ps1"
endlocal
