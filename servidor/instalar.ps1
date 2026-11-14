# Instala ou atualiza o ModUpdate Servidor no FraNerdServer.
# Uso (PowerShell como Administrador):  .\instalar.ps1 -Commit <sha ou main>
param([string]$Commit = 'main', [string]$Repo = 'Franerd/ModUpdate')
$ErrorActionPreference = 'Stop'
$Base = 'C:\ProgramData\ModUpdateServidor'
$App = Join-Path $Base 'app'
$Tarefa = 'ModUpdate Servidor'
$Porta = 8791
$Node = (Get-Command node.exe).Source

Write-Host "Instalando ModUpdate Servidor ($Commit) em $Base"
foreach ($p in 'app', 'dados', 'versoes', 'logs') { New-Item -ItemType Directory -Force (Join-Path $Base $p) | Out-Null }

# 1) codigo do repositorio (publico)
$tmp = Join-Path $env:TEMP "modupdate-servidor-$Commit"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory $tmp | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest "https://api.github.com/repos/$Repo/zipball/$Commit" -Headers @{ 'User-Agent' = 'ModUpdate-Instalador' } -OutFile "$tmp\codigo.zip" -UseBasicParsing
Expand-Archive "$tmp\codigo.zip" "$tmp\x"
$src = (Get-ChildItem "$tmp\x" -Directory)[0].FullName

# 2) para a tarefa (se existir) antes de trocar os arquivos
if (Get-ScheduledTask -TaskName $Tarefa -EA SilentlyContinue) { Stop-ScheduledTask -TaskName $Tarefa; Start-Sleep 2 }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like "*ModUpdateServidor*servidor.js*" } | % { Stop-Process -Id $_.ProcessId -Force }
if (Test-Path "$App\servidor") { Remove-Item "$App\servidor" -Recurse -Force }
Copy-Item "$src\servidor" "$App\servidor" -Recurse
Set-Content "$App\versao.txt" $Commit

# 3) pasta de dados (hash da chave de administrador): so SYSTEM e Administradores
#    (SIDs fixos: S-1-5-18 = SYSTEM, S-1-5-32-544 = Administradores)
$saida = & icacls "$Base\dados" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' 2>&1
if ($LASTEXITCODE -ne 0) { throw "icacls falhou: $saida" }

# 4) tarefa agendada: ao ligar o Windows, como SYSTEM, sem janela; reinicia se cair
$acao = New-ScheduledTaskAction -Execute $Node -Argument "`"$App\servidor\servidor.js`"" -WorkingDirectory "$App\servidor"
$gatilhos = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$conf = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$quem = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $Tarefa -Action $acao -Trigger $gatilhos -Settings $conf -Principal $quem `
  -Description "ModUpdate Servidor: versao oficial do app ModUpdate (porta $Porta, so local)." -Force | Out-Null
Start-ScheduledTask -TaskName $Tarefa
Start-Sleep 4

try { $s = Invoke-RestMethod "http://127.0.0.1:$Porta/v1/saude" -TimeoutSec 5; Write-Host "OK: servidor $($s.servidor) respondendo na $Porta" }
catch { Write-Host "ATENCAO: nao respondeu na $Porta. Veja $Base\logs"; exit 1 }
Remove-Item $tmp -Recurse -Force
