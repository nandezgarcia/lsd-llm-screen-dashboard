#!/usr/bin/env bash
# LSD (LLM Screen Dashboard) — instalador para Linux / macOS / WSL2.
# En Windows nativo NO funciona (GNU Screen no existe): usar install.ps1,
# que prepara WSL2 y acaba ejecutando este script dentro.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[AVISO]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

# confirm "pregunta" [y|n]  -> devuelve 0 si la respuesta es afirmativa (y/s)
confirm() {
  local q="$1" def="${2:-y}" ans prompt="[Y/n]"
  [ "$def" = n ] && prompt="[y/N]"
  read -r -p "$q $prompt " ans || true
  ans="${ans:-$def}"
  [[ "$ans" =~ ^[yYsS] ]]
}

# Valor actual de una clave del .env (vacío si no existe)
env_val() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

# --- Detección de plataforma y gestor de paquetes -------------------------
PKG=""
case "$(uname -s)" in
  Linux)
    if   command -v apt-get >/dev/null 2>&1; then PKG=apt
    elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
    elif command -v pacman  >/dev/null 2>&1; then PKG=pacman
    fi ;;
  Darwin) command -v brew >/dev/null 2>&1 && PKG=brew ;;
esac

IS_WSL=false
if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=true; fi

if [ ! -f package.json ] || ! grep -q 'lsd-llm-screen-dashboard' package.json; then
  err "Ejecuta este script desde la carpeta del proyecto (donde está package.json)."
  exit 1
fi

echo "=============================================================="
echo " LSD (LLM Screen Dashboard) — instalador"
echo "=============================================================="
$IS_WSL && info "Detectado WSL2: la web será accesible desde Windows en localhost."
[ -z "$PKG" ] && warn "Gestor de paquetes no reconocido: las dependencias del sistema habrá que instalarlas a mano."

need_sudo() {
  if [ -z "$SUDO" ] && [ "$(id -u)" -ne 0 ]; then
    err "Se necesita sudo para instalar paquetes del sistema y no está disponible."
    exit 1
  fi
}

# --- Node.js >= 20 ---------------------------------------------------------
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//; s/\..*//')" -ge 20 ] 2>/dev/null; }

if node_ok; then
  ok "Node.js $(node -v)"
else
  warn "Node.js >= 20 no encontrado."
  case "$PKG" in
    apt)
      if confirm "¿Instalar Node.js 20 desde NodeSource?"; then
        need_sudo
        curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
        $SUDO apt-get install -y nodejs
      fi ;;
    dnf)
      if confirm "¿Instalar Node.js con dnf?"; then
        need_sudo; $SUDO dnf install -y nodejs npm
      fi ;;
    pacman)
      if confirm "¿Instalar Node.js con pacman?"; then
        need_sudo; $SUDO pacman -S --needed --noconfirm nodejs npm
      fi ;;
    brew)
      if confirm "¿Instalar Node.js con Homebrew?"; then brew install node; fi ;;
  esac
  if ! node_ok; then
    err "Node.js >= 20 sigue sin estar disponible. Instálalo (https://nodejs.org o nvm) y vuelve a ejecutar el instalador."
    exit 1
  fi
  ok "Node.js $(node -v)"
fi

# --- GNU Screen ------------------------------------------------------------
if command -v screen >/dev/null 2>&1; then
  ok "GNU Screen $(screen -v 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9.]+' | head -1)"
else
  warn "GNU Screen no encontrado (es imprescindible)."
  if confirm "¿Instalar screen?"; then
    need_sudo
    case "$PKG" in
      apt)    $SUDO apt-get install -y screen ;;
      dnf)    $SUDO dnf install -y screen ;;
      pacman) $SUDO pacman -S --needed --noconfirm screen ;;
      brew)   brew install screen ;;
      *)      err "Instala 'screen' a mano y reintenta."; exit 1 ;;
    esac
  fi
  command -v screen >/dev/null 2>&1 || { err "screen sigue sin estar disponible."; exit 1; }
fi

# --- sshpass (publicación web con contraseña; opcional pero recomendado) -----
if command -v sshpass >/dev/null 2>&1; then
  ok "sshpass $(sshpass -V 2>&1 | head -1 | grep -oE '[0-9.]+' | head -1)"
else
  warn "sshpass no encontrado (lo necesita el botón 🌐 Publicar; sin él, solo clave SSH)."
  if confirm "¿Instalar sshpass?"; then
    need_sudo
    case "$PKG" in
      apt)    $SUDO apt-get install -y sshpass ;;
      dnf)    $SUDO dnf install -y sshpass ;;
      pacman) $SUDO pacman -S --needed --noconfirm sshpass ;;
      brew)   brew install hudochenkov/sshpass/sshpass ;;
      *)      warn "Instala 'sshpass' a mano si vas a usar Publicar." ;;
    esac
  fi
fi

# --- Herramientas de compilación (node-pty es nativo) ----------------------
build_tools_ok() { command -v make >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && { command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1; }; }

if build_tools_ok; then
  ok "Herramientas de compilación (make, C++, python3)"
else
  warn "Faltan herramientas de compilación (necesarias si node-pty no trae binario precompilado)."
  if confirm "¿Instalarlas?"; then
    need_sudo
    case "$PKG" in
      apt)    $SUDO apt-get install -y build-essential python3 ;;
      dnf)    $SUDO dnf install -y gcc-c++ make python3 ;;
      pacman) $SUDO pacman -S --needed --noconfirm base-devel python ;;
      brew)   xcode-select --install 2>/dev/null || warn "Acepta el diálogo de Xcode Command Line Tools si aparece." ;;
      *)      warn "Instálalas a mano si 'npm ci' falla compilando node-pty." ;;
    esac
  fi
fi

# --- Dependencias npm ------------------------------------------------------
info "Instalando dependencias npm (npm ci)…"
npm ci
ok "Dependencias npm instaladas"

# --- Configuración .env ----------------------------------------------------
write_env() {
  local key="$1" port="$2" host="$3" cli="$4"
  cat > .env <<EOF
# Generado por install.sh ($(date '+%Y-%m-%d %H:%M'))
DEEPSEEK_API_KEY=$key
DEEPSEEK_MODEL=deepseek-chat
# DEEPSEEK_BASE_URL=https://api.deepseek.com
KIMI_SESSION_MODEL=
# KIMI_SESSION_BASE_URL=https://api.deepseek.com/v1
SESSION_CLI=$cli
PORT=$port
HOST=$host
EOF
  chmod 600 .env
}

configure_env() {
  local cur_key cur_port cur_host cur_cli
  cur_key="$(env_val DEEPSEEK_API_KEY)"; cur_port="$(env_val PORT)"
  cur_host="$(env_val HOST)";           cur_cli="$(env_val SESSION_CLI)"

  local key port host cli
  read -r -p "API key de Deepseek${cur_key:+ [vacío = conservar la actual]}: " key
  key="${key:-$cur_key}"
  if [ -z "$key" ]; then
    warn "Sin DEEPSEEK_API_KEY el gestor no funcionará (podrás editar .env luego)."
  fi

  read -r -p "Puerto [${cur_port:-3000}]: " port
  port="${port:-${cur_port:-3000}}"

  echo
  warn "La web NO tiene autenticación. 127.0.0.1 = solo esta máquina (recomendado)."
  warn "0.0.0.0 = accesible desde toda la red (úsalo solo tras un proxy con auth)."
  read -r -p "Interfaz de escucha (HOST) [${cur_host:-127.0.0.1}]: " host
  host="${host:-${cur_host:-127.0.0.1}}"

  read -r -p "CLI de las sesiones (kimi/claude/codex…) [${cur_cli:-kimi}]: " cli
  cli="${cli:-${cur_cli:-kimi}}"

  write_env "$key" "$port" "$host" "$cli"
  ok ".env configurado (permisos 600)"
}

if [ -f .env ]; then
  ok ".env ya existe"
  if confirm "¿Reconfigurarlo?" n; then configure_env; fi
else
  configure_env
fi

# --- CLIs de agente ---------------------------------------------------------
SESSION_CLI_V="$(env_val SESSION_CLI)"; SESSION_CLI_V="${SESSION_CLI_V:-kimi}"
if command -v "$SESSION_CLI_V" >/dev/null 2>&1; then
  ok "CLI de sesiones '$SESSION_CLI_V' encontrado en el PATH"
else
  warn "El CLI '$SESSION_CLI_V' no está en el PATH. Las sesiones no arrancarán hasta instalarlo y autenticarlo con ESTE usuario."
fi
found_others=""
for c in kimi claude codex; do
  [ "$c" = "$SESSION_CLI_V" ] && continue
  command -v "$c" >/dev/null 2>&1 && found_others="$found_others $c"
done
[ -n "$found_others" ] && info "Otros CLIs detectados:$found_others (seleccionables al crear sesiones)"

# --- Servicio systemd (opcional) -------------------------------------------
STARTED_BY_SERVICE=false
if [ "$(ps -p 1 -o comm= 2>/dev/null || true)" = "systemd" ]; then
  if confirm "¿Crear un servicio systemd para que arranque solo con el equipo?" n; then
    need_sudo
    NODE_BIN="$(command -v node)"
    PORT_V="$(env_val PORT)"; PORT_V="${PORT_V:-3000}"
    $SUDO tee /etc/systemd/system/lsd.service >/dev/null <<EOF
[Unit]
Description=LSD - LLM Screen Dashboard
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now lsd.service
    ok "Servicio lsd.service creado y arrancado"
    STARTED_BY_SERVICE=true
  fi
elif [ "$(uname -s)" = "Darwin" ]; then
  info "macOS: para arranque automático puedes crear un LaunchAgent (no cubierto por este instalador)."
fi

# --- Resumen ---------------------------------------------------------------
PORT_V="$(env_val PORT)"; PORT_V="${PORT_V:-3000}"
HOST_V="$(env_val HOST)"; HOST_V="${HOST_V:-0.0.0.0}"
SHOWN_HOST="$HOST_V"; [ "$HOST_V" = "0.0.0.0" ] && SHOWN_HOST="localhost"

echo
echo "=============================================================="
echo " Instalación completada"
echo "=============================================================="
echo " URL:      http://$SHOWN_HOST:$PORT_V"
if $STARTED_BY_SERVICE; then
  echo " Servicio: systemctl status lsd   (logs: journalctl -u lsd -f)"
  echo " Parar:    sudo systemctl stop lsd"
else
  echo " Arrancar: npm start"
  echo " Parar:    ss -ltnp | grep ':$PORT_V'  y  kill <pid>   (NO uses pkill -f)"
fi
echo " Config:   edita .env o usa el botón ⚙ de la web"
[ "$HOST_V" = "0.0.0.0" ] && warn "Recuerda: la web no tiene auth y escucha en TODA la red."
echo "=============================================================="
