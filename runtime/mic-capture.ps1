param([switch]$Probe)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'mic-capture.cs')
if ($Probe) { [Console]::WriteLine([SNMicrophone]::DeviceCount()); exit }
try { [SNMicrophone]::Run() } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
