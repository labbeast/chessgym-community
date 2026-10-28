$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$pidFile = Join-Path $projectDir 'data\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'Aucun serveur lancé par ChessGym.'; exit }
$serverId = [int](Get-Content -LiteralPath $pidFile)
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId"
$expectedScript = Join-Path $projectDir 'run.py'
if ($serverProcess -and $serverProcess.CommandLine -and $serverProcess.CommandLine.Contains($expectedScript)) {
    # Follow only descendants running this exact ChessGym entry point. The local
    # update supervisor and Windows venv redirectors can add more than one level.
    $pendingParents = @($serverId)
    $workerIds = @()
    while ($pendingParents.Count -gt 0) {
        $nextParents = @()
        foreach ($parentId in $pendingParents) {
            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId" | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -and $_.CommandLine.Contains($expectedScript) }
            foreach ($worker in $children) {
                if ($workerIds -notcontains $worker.ProcessId) { $workerIds += $worker.ProcessId; $nextParents += $worker.ProcessId }
            }
        }
        $pendingParents = $nextParents
    }
    [array]::Reverse($workerIds)
    foreach ($workerId in $workerIds) { Stop-Process -Id $workerId -ErrorAction SilentlyContinue }
    if (Get-Process -Id $serverId -ErrorAction SilentlyContinue) { Stop-Process -Id $serverId -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pidFile
    Write-Host 'ChessGym arrêté.'
}
elseif (-not $serverProcess) { Remove-Item -LiteralPath $pidFile; Write-Host 'ChessGym est déjà arrêté.' }
else { throw 'Le numéro de processus appartient à une autre application; aucune action effectuée.' }
