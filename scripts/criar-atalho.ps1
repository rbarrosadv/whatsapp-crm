# Cria atalhos do Barros Associados na Área de Trabalho e no Menu Iniciar
# (abrem o app direto, sem janela preta do Prompt de Comando).
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'assets\icon.ico'
$shell = New-Object -ComObject WScript.Shell
$places = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
)
foreach ($dir in $places) {
  # o atalho "WhatsApp CRM" (app antigo, WhatsApp pessoal) fica: são programas separados
  try {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Barros Associados.lnk'))
    $lnk.TargetPath = $exe
    $lnk.Arguments = '"' + $root + '"'
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = $icon
    $lnk.Description = 'Barros Associados'
    $lnk.Save()
    Write-Host "Atalho criado em: $dir"
  } catch {
    Write-Host "Nao foi possivel criar o atalho em: $dir"
  }
}
