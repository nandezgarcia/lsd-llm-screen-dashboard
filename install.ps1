# LSD (LLM Screen Dashboard) — instalador para Windows.
#
# El dashboard depende de GNU Screen, que NO existe en Windows nativo, así que
# la instalación real se hace dentro de WSL2 (Ubuntu). Este script:
#   1. Comprueba/instala WSL2.
#   2. Localiza este proyecto dentro de WSL.
#   3. Ejecuta install.sh dentro de WSL (instalación interactiva).
#
# Uso (PowerShell):
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Recomendación: para mejor rendimiento, copia la carpeta del proyecto al
# sistema de ficheros de WSL (p.ej. \\wsl$\Ubuntu\home\<usuario>\) y ejecuta
# install.sh directamente allí. Desde /mnt/c funciona, pero npm es más lento.

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[AVISO] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[ERROR] $m" -ForegroundColor Red }

function Confirm($q, $default = 'y') {
    $prompt = if ($default -eq 'y') { '[Y/n]' } else { '[y/N]' }
    $ans = Read-Host "$q $prompt"
    if ([string]::IsNullOrWhiteSpace($ans)) { $ans = $default }
    return $ans -match '^[yYsS]'
}

Write-Host "=============================================================="
Write-Host " LSD (LLM Screen Dashboard) - instalador para Windows (via WSL2)"
Write-Host "=============================================================="

# --- 1. WSL disponible ------------------------------------------------------
$wslOk = $false
try { wsl.exe --status | Out-Null; $wslOk = ($LASTEXITCODE -eq 0) } catch { $wslOk = $false }

if (-not $wslOk) {
    Warn "WSL2 no está instalado (o no responde)."
    if (Confirm "¿Instalar WSL2 con Ubuntu? (requiere admin y un REINICIO)") {
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) {
            Err "Ejecuta PowerShell como Administrador y vuelve a lanzar este script."
            exit 1
        }
        wsl.exe --install -d Ubuntu
        Write-Host ""
        Warn "WSL se está instalando. REINICIA el equipo, abre Ubuntu una vez para crear"
        Warn "tu usuario de Linux, y vuelve a ejecutar este script."
        exit 0
    } else {
        Err "Sin WSL2 no se puede instalar: GNU Screen no existe en Windows nativo."
        exit 1
    }
}

$distros = (wsl.exe -l -q) -replace "`0", '' | Where-Object { $_.Trim() -ne '' }
if (-not $distros) {
    Warn "WSL está instalado pero no hay ninguna distribución."
    if (Confirm "¿Instalar Ubuntu?") {
        wsl.exe --install -d Ubuntu
        Warn "Abre Ubuntu una vez para crear tu usuario y vuelve a ejecutar este script."
        exit 0
    } else { Err "Se necesita una distribución de WSL."; exit 1 }
}
Ok "WSL2 disponible (distros: $($distros -join ', '))"

# --- 2. Ruta del proyecto dentro de WSL -------------------------------------
$winPath = $PSScriptRoot
$wslPath = (& wsl.exe -e wslpath -a "$winPath").Trim()
if (-not $wslPath) { Err "No se pudo traducir la ruta $winPath a WSL."; exit 1 }
Info "Proyecto en WSL: $wslPath"

if ($wslPath -like '/mnt/*') {
    Warn "El proyecto está en el disco de Windows ($wslPath)."
    Warn "Funcionará, pero npm y node-pty irán MUCHO más rápidos si copias la carpeta"
    Warn "dentro del sistema de ficheros de Linux (p.ej. ~/llm-screen-dashboard) y"
    Warn "ejecutas 'bash install.sh' allí."
    if (-not (Confirm "¿Continuar de todas formas desde $wslPath?")) { exit 0 }
}

# --- 3. Lanzar el instalador de Linux dentro de WSL -------------------------
# Los editores de Windows pueden guardar install.sh con finales CRLF, que bash
# no acepta: se normaliza a LF antes de ejecutarlo.
Info "Normalizando finales de línea de install.sh…"
wsl.exe -e bash -c "sed -i 's/\r$//' '$wslPath/install.sh'"

Info "Ejecutando install.sh dentro de WSL (te hará unas preguntas)…"
Write-Host ""
wsl.exe -e bash "$wslPath/install.sh"
if ($LASTEXITCODE -ne 0) { Err "El instalador de Linux terminó con errores."; exit $LASTEXITCODE }

Write-Host ""
Ok "Instalación terminada."
Info "Arranque manual:  wsl -e bash -c 'cd $wslPath && npm start'"
Info "La web quedará accesible desde Windows en http://localhost:3000"
Info "(el reenvío localhost de WSL2 funciona aunque HOST=127.0.0.1)."
Info "Ojo: al apagar Windows o cerrar WSL ('wsl --shutdown') el servidor se para;"
Info "en el próximo arranque, recovery restaurará las sesiones activas con 'kimi -c'."
