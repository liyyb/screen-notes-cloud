param([int]$StandalonePort = 0)

function New-NotesWindow([string]$url) {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  if (-not ('ScreenNotesMainWindow' -as [type])) {
    $sdk = Join-Path $PSScriptRoot 'webview2'
    $env:Path = "$sdk;$env:Path"
    $core = Join-Path $sdk 'Microsoft.Web.WebView2.Core.dll'
    $forms = Join-Path $sdk 'Microsoft.Web.WebView2.WinForms.dll'
    $null = [Reflection.Assembly]::LoadFrom($core)
    $null = [Reflection.Assembly]::LoadFrom($forms)
    $refs = @($core, $forms, 'System.Windows.Forms.dll', 'System.Drawing.dll')
    Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'main-window.cs'))) -ReferencedAssemblies $refs
  }
  $data = $env:SCREEN_NOTES_DATA_DIR
  if (-not $data) { $data = Join-Path (Split-Path -Parent $PSScriptRoot) 'data' }
  $profile = [IO.Path]::GetFullPath((Join-Path $data 'webview'))
  return [ScreenNotesMainWindow]::new($url, $profile, (Join-Path $PSScriptRoot 'icon.ico'))
}

if ($StandalonePort) {
  $ErrorActionPreference = 'Stop'
  $window = New-NotesWindow "http://127.0.0.1:$StandalonePort/?view=main"
  [System.Windows.Forms.Application]::Run($window)
  $window.Dispose()
}
