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
# Arguments: action (probe/dump/globals), credential file, port, user, database.
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
    [ "$((0$mode & 022))" = 0 ] || exit 21
    parent=${parent%/*}
done
[ "$(stat -c %u "$cred")" = "$(id -u)" ] || exit 21
case "$(stat -c %a "$cred")" in 400|600) ;; *) exit 21;; esac
export PGPASSFILE="$cred"
command -v pg_dump >/dev/null
command -v pg_restore >/dev/null
command -v psql >/dev/null
case "$act" in
 probe)
   psql --no-password --host=127.0.0.1 --port="$port" --username="$dbuser" --dbname="$database" --no-psqlrc --tuples-only --no-align --command='SHOW server_version;'
   pg_dump --version
   psql --no-password --host=127.0.0.1 --port="$port" --username="$dbuser" --dbname="$database" --no-psqlrc --tuples-only --no-align --command='SELECT extname FROM pg_extension ORDER BY extname;'
   ;;
 dump)
   exec pg_dump --no-password --host=127.0.0.1 --port="$port" --username="$dbuser" --dbname="$database" --format=custom --compress=0
   ;;
 globals)
   exec pg_dumpall --no-password --host=127.0.0.1 --port="$port" --username="$dbuser" --database="$database" --globals-only --no-role-passwords
   ;;
 *) exit 20;;
esac
