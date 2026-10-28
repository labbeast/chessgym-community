param([int]$Port = 8765, [switch]$NoBrowser, [ValidateRange(0,16)][int]$ImportWorkers = 0, [ValidateRange(64,4096)][int]$ImportCacheMB = 256)
# Zero selects a modest automatic budget; explicit values remain unchanged.
if ($ImportWorkers -eq 0) { $ImportWorkers = [Math]::Max(1, [Math]::Min(4, [Environment]::ProcessorCount)) }
$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$pythonExecutable = Join-Path $projectDir '.venv\Scripts\python.exe'
$localUrl = "http://127.0.0.1:$Port"
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'Python local absent. Voir le fichier LIRE-MOI.md pour installer ChessGym.' }
$running = $false
try { $status = Invoke-RestMethod -Uri "$localUrl/api/status" -TimeoutSec 2; $running = $null -ne $status.setup_required -and $null -ne $status.authenticated } catch {}
if (-not $running) {
    $dataDir = Join-Path $projectDir 'data'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $env:CHESSGYM_PORT = "$Port"
    $env:CHESSGYM_HOST = '127.0.0.1'
    $env:CHESSGYM_IMPORT_WORKERS = "$ImportWorkers"
    $env:CHESSGYM_IMPORT_CACHE_MB = "$ImportCacheMB"
    $serverArguments = '"' + (Join-Path $projectDir 'run.py') + '"'
    $serverProcess = Start-Process -FilePath $pythonExecutable -ArgumentList $serverArguments -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.out.log') -RedirectStandardError (Join-Path $dataDir 'server.err.log') -PassThru
    Set-Content -LiteralPath (Join-Path $dataDir 'server.pid') -Value $serverProcess.Id
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { $status = Invoke-RestMethod -Uri "$localUrl/api/status" -TimeoutSec 1; $running = $null -ne $status.setup_required; if ($running) { break } } catch {}
        Start-Sleep -Milliseconds 300
    }
    if (-not $running) { throw 'Le serveur ne répond pas. Consulter data/server.err.log.' }
}
Write-Host "ChessGym : $localUrl"
if (-not $NoBrowser) { Start-Process $localUrl }
