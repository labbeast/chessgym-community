param([string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not $Archive) {
    $picker = New-Object System.Windows.Forms.OpenFileDialog
    $picker.Title = 'Restaurer une sauvegarde personnelle ChessGym'
    $picker.Filter = 'Sauvegarde ChessGym (*.zip)|*.zip'
    $picker.InitialDirectory = Join-Path $PSScriptRoot 'data\backups'
    if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit }
    $Archive = $picker.FileName
}
$pythonExecutable = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$restoreScript = Join-Path $PSScriptRoot 'scripts\restore_backup.py'
& $pythonExecutable -X utf8 $restoreScript $Archive
if ($LASTEXITCODE -ne 0) { throw 'La sauvegarde ne peut pas être restaurée.' }
$answer = [System.Windows.Forms.MessageBox]::Show('Remplacer les données personnelles par cette sauvegarde ? ChessGym doit être arrêté. Une copie de sécurité sera conservée. Les grandes références existantes restent en place.', 'Restaurer ChessGym', 'YesNo', 'Warning')
if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit }
& $pythonExecutable -X utf8 $restoreScript $Archive --confirm
if ($LASTEXITCODE -ne 0) { throw 'Restauration refusée. Vérifie que ChessGym est arrêté.' }
[System.Windows.Forms.MessageBox]::Show('Données personnelles restaurées. Relance ChessGym et reconnecte-toi.', 'ChessGym') | Out-Null
