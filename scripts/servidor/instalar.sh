#!/usr/bin/env bash
# Instala (ou reinstala) o sistema Barros Associados num servidor Ubuntu
# (feito para a Oracle Cloud gratuita, funciona em qualquer Ubuntu 22.04/24.04).
#
# Instala o Node.js e o Caddy (que cuida do HTTPS sozinho), baixa o sistema do
# GitHub, cria o serviço que liga sozinho (e religa se cair), abre as portas
# 80/443 no firewall do Ubuntu e mostra o endereço e o código de primeiro acesso.
#
# Uso (como root):  TOKEN=<token do GitHub> [RAMO=main] [DOMINIO=sistema.exemplo.adv.br] bash instalar.sh
# Sem DOMINIO, usa um endereço gratuito com o IP do servidor: <ip>.sslip.io
set -euo pipefail

REPO="rbarrosadv/whatsapp-crm"
RAMO_PEDIDO="${RAMO:-}"
APP=/opt/barros
DADOS=/var/lib/barros
CONF=/etc/barros
PORTA=3210

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[ERRO] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Rode como administrador: coloque 'sudo' antes do comando."
mkdir -p "$CONF"
chmod 700 "$CONF"
# na reinstalação/atualização, reaproveita o que já foi informado
if [ -f "$CONF/instalacao.env" ]; then . "$CONF/instalacao.env"; fi
TOKEN="${TOKEN:-${SALVO_TOKEN:-}}"
RAMO="${RAMO_PEDIDO:-${RAMO:-main}}"
[ -n "$TOKEN" ] || die "Falta o token do GitHub (TOKEN=...)."

say "Atualizando o Ubuntu e instalando o básico"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https tar

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "Instalando o Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a===22 && b<13) process.exit(1)' \
  || die "Node.js $(node -v) é antigo demais (precisa 22.13 ou mais novo)."

if ! command -v caddy >/dev/null; then
  say "Instalando o Caddy (HTTPS automático)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Baixando o sistema do GitHub ($REPO, ramo $RAMO)"
TMP="$(mktemp -d)"
baixou=0
# ramo com "/" no nome: tenta como está e, se não der, codificado
for REF in "$RAMO" "${RAMO//\//%2F}"; do
  if curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/tarball/$REF" -o "$TMP/sistema.tgz"; then baixou=1; break; fi
done
[ "$baixou" = 1 ] || die "Não consegui baixar do GitHub. Confira o token (precisa de acesso de leitura ao repositório) e o ramo."
mkdir -p "$TMP/app"
tar xzf "$TMP/sistema.tgz" -C "$TMP/app" --strip-components=1
( cd "$TMP/app" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund )

say "Instalando em $APP"
id barros >/dev/null 2>&1 || useradd --system --home-dir "$DADOS" --shell /usr/sbin/nologin barros
mkdir -p "$DADOS"
chown barros:barros "$DADOS"
chmod 750 "$DADOS"
systemctl stop barros 2>/dev/null || true
rm -rf "$APP.antigo"
[ -d "$APP" ] && mv "$APP" "$APP.antigo"
mv "$TMP/app" "$APP"
rm -rf "$TMP"
chown -R root:root "$APP"

if [ -z "${DOMINIO:-}" ]; then
  DOMINIO="${SALVO_DOMINIO:-}"
fi
if [ -z "$DOMINIO" ]; then
  IP="$(curl -fsS https://api.ipify.org || true)"
  [ -n "$IP" ] || die "Não descobri o IP público do servidor. Rode de novo com DOMINIO=..."
  DOMINIO="${IP//./-}.sslip.io"
fi

cat > "$CONF/instalacao.env" <<CONFIG
SALVO_TOKEN='$TOKEN'
RAMO='$RAMO'
SALVO_DOMINIO='$DOMINIO'
CONFIG
chmod 600 "$CONF/instalacao.env"

say "Criando o serviço (liga sozinho com o servidor e religa se cair)"
cat > /etc/systemd/system/barros.service <<UNIT
[Unit]
Description=Barros Associados - sistema do escritório
After=network-online.target
Wants=network-online.target

[Service]
User=barros
Group=barros
WorkingDirectory=$APP
Environment=CRM_DATA_DIR=$DADOS
Environment=CRM_RESTARTABLE=1
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server/server.js --port $PORTA --host 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DADOS

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMINIO {
	encode gzip
	reverse_proxy 127.0.0.1:$PORTA
}
CADDY

say "Abrindo as portas 80 e 443 no firewall do Ubuntu"
for P in 80 443; do
  iptables -C INPUT -m state --state NEW -p tcp --dport "$P" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -m state --state NEW -p tcp --dport "$P" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi

# comando para atualizar depois:  sudo barros-atualizar
cat > /usr/local/bin/barros-atualizar <<'UPD'
#!/usr/bin/env bash
set -e
. /etc/barros/instalacao.env
curl -fsSL -H "Authorization: Bearer $SALVO_TOKEN" -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/rbarrosadv/whatsapp-crm/contents/scripts/servidor/instalar.sh?ref=$RAMO" -o /tmp/instalar-barros.sh
RAMO="$RAMO" bash /tmp/instalar-barros.sh
UPD
chmod 755 /usr/local/bin/barros-atualizar

systemctl daemon-reload
systemctl enable --now barros
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Esperando o sistema ligar"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORTA/auth/state" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORTA/auth/state" >/dev/null 2>&1 || die "O sistema não ligou. Veja o erro com: sudo journalctl -u barros -n 50"

printf '\n\033[1;32m============================================================\033[0m\n'
printf '\033[1;32m  Pronto! O sistema está no ar.\033[0m\n'
printf '\033[1;32m============================================================\033[0m\n\n'
printf '  Endereço:  https://%s\n\n' "$DOMINIO"
if [ -f "$DADOS/codigo-primeiro-acesso.txt" ]; then
  printf '  Código de primeiro acesso:  \033[1m%s\033[0m\n' "$(cat "$DADOS/codigo-primeiro-acesso.txt")"
  printf '  (use na tela "Primeiro acesso" para criar a conta do sócio)\n\n'
fi
printf '  Se o endereço não abrir em 2 minutos, confira se as portas 80 e 443\n'
printf '  foram liberadas na "Security List" da Oracle (passo do guia).\n\n'
printf '  Para atualizar o sistema no futuro:  sudo barros-atualizar\n\n'
