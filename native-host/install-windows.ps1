<#
  Registers the yt-dlp bridge helper with Firefox for the current user.

  This script does ONE thing: it writes the Native Messaging registration that
  Firefox requires (a manifest JSON file plus the HKCU value that points at it).
  It does not install Python, yt-dlp, FFmpeg or anything else, it does not touch
  PATH, Defender or any other system setting, and it needs no administrator
  rights. Install those tools yourself first - see docs/SETUP.md.

  Usage:  double-click install.bat
  Remove: powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$HostName     = 'com.kcgamingtech.ytdlp_bridge'
$ExtensionId  = 'ytdlp-bridge@kcgamingtech'
$Dir          = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher     = Join-Path $Dir 'run-host.bat'
$ManifestPath = Join-Path $Dir 'manifest.json'
$RegPath      = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

function Say($ok, $label, $detail) {
  Write-Host ("{0} {1,-10} {2}" -f $(if ($ok) { '[ok]' } else { '[--]' }), $label, $detail)
}

if ($Uninstall) {
  if (Test-Path $RegPath) { Remove-Item $RegPath -Force }
  if (Test-Path $ManifestPath) { Remove-Item $ManifestPath -Force }
  Write-Host 'Registration removed. Restart Firefox.'
  exit 0
}

if (-not (Test-Path $Launcher)) { throw "run-host.bat is missing from $Dir" }

# Report what is present. Nothing is installed by this script.
$python = Get-Command python.exe, pythonw.exe, py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($python) { Say $true 'python' $python.Source }
else {
  Say $false 'python' 'not found - install Python 3.9+ and tick "Add to PATH", then run this again'
  exit 1
}

@{ name               = $HostName
   description        = 'Runs the locally installed yt-dlp for the yt-dlp bridge extension.'
   path               = $Launcher
   type               = 'stdio'
   allowed_extensions = @($ExtensionId)
} | ConvertTo-Json -Depth 3 | Set-Content -Path $ManifestPath -Encoding UTF8
Say $true 'manifest' $ManifestPath

New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name '(default)' -Value $ManifestPath
Say $true 'registered' 'current user only'

foreach ($tool in 'yt-dlp', 'ffmpeg') {
  $found = Get-Command $tool -ErrorAction SilentlyContinue
  if ($found) { Say $true $tool $found.Source }
  else { Say $false $tool 'not found - install it, or set its full path in the extension settings' }
}

Write-Host ''
Write-Host 'Done. Restart Firefox.'
