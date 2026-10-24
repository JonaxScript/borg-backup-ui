#!/bin/sh
# Managed by Borg Backup UI. Shipped and maintained by the plugin (#591).
# Local changes may be overwritten by the next plugin update.
# Configure database backups in Settings > Database backups.
# For custom behavior, create a separate user-managed copy.
# Verwaltet durch Borg Backup UI. Auslieferung und Pflege durch das Plugin.
# Lokale Aenderungen koennen beim naechsten Plugin-Update ueberschrieben werden.
# Konfiguration: Einstellungen > Datenbank-Sicherungen.
# Eigene Anpassungen nur in einer separaten benutzerverwalteten Kopie.
# Protocol 1: invoked inside Docker by database_backup.py under setsid.
# Arguments: action (discover/probe/dump), credential file, port, user, database.
# stdout: probe metadata or dump bytes; stderr is never forwarded to UI/logs.
# Exit 0: complete; 21: credentials; 22: nontransactional tables; other: failure.
# Reads protected credentials; writes dump only to stdout. No server mutations.
set -eu
act=$1; cred=$2; port=$3; dbuser=$4; database=$5
[ -f "$cred" ] && [ ! -L "$cred" ] || exit 21
[ "$(readlink -f "$cred")" = "$cred" ] || exit 21
parent=${cred%/*}
while [ -n "$parent" ]; do
    owner=$(stat -c %u "$parent"); mode=$(stat -c %a "$parent")
    [ "$owner" = 0 ] || [ "$owner" = "$(id -u)" ] || exit 21
    # The owned 0700 run directory is beneath the system's sticky /dev/shm.
    [ "$parent" = /dev/shm ] && [ "$mode" = 1777 ] || [ "$((0$mode & 022))" = 0 ] || exit 21
    parent=${parent%/*}
done
[ "$(stat -c %u "$cred")" = "$(id -u)" ] || exit 21
case "$(stat -c %a "$cred")" in 400|600) ;; *) exit 21;; esac
# Reject option groups/includes that could silently alter the dump scope.
while IFS= read -r line || [ -n "$line" ]; do
    line=${line#"${line%%[![:space:]]*}"}
    case "$line" in
      ''|'#'*|';'*|'[client]'|user=*|password=*|ssl-ca=*|ssl-cert=*|ssl-key=*|ssl-verify-server-cert*) ;;
      *) exit 21;;
    esac
done < "$cred"
# --defaults-file must be the first client option; connection overrides are explicit.
client() { mariadb --defaults-file="$cred" --protocol=tcp --host=127.0.0.1 --port="$port" --batch --skip-column-names "$@"; }
command -v mariadb-dump >/dev/null
command -v mariadb >/dev/null
if [ "$act" = discover ]; then
    exec mariadb --defaults-file="$cred" --protocol=tcp --host=127.0.0.1 --port="$port" --batch --skip-column-names --raw \
      --execute="SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY schema_name"
fi
# Names are restricted by the caller; no arbitrary SQL or command text is accepted.
case "$database" in *[!a-zA-Z0-9_.-]*|'') exit 20;; esac
count=$(client --execute="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$database' AND table_type='BASE TABLE' AND engine <> 'InnoDB'")
[ "$count" = 0 ] || exit 22
client --database="$database" --execute='SELECT 1' >/dev/null
case "$act" in
 probe)
   client --execute='SELECT VERSION()'
   mariadb-dump --version
   ;;
 dump)
   exec mariadb-dump --defaults-file="$cred" --protocol=tcp --host=127.0.0.1 --port="$port" \
     --skip-force --single-transaction --quick --skip-lock-tables --routines --events --triggers --hex-blob --databases "$database"
   ;;
 *) exit 20;;
esac
