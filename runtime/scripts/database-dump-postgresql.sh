#!/bin/sh
# Managed by Borg Backup UI. Shipped and maintained by the plugin (#591).
# Local changes may be overwritten by the next plugin update.
# Verwaltet durch Borg Backup UI. Auslieferung und Pflege durch das Plugin.
# Lokale Aenderungen koennen beim naechsten Plugin-Update ueberschrieben werden.
# Configure this feature in Settings > Database backups; do not assign this
# internal helper as a custom Pre/Post hook. Use Templates for custom scripts.
# Konfiguration: Einstellungen > Datenbank-Sicherungen. Kein eigener Pre/Post-Hook.
#
# Purpose and scope
# -----------------
# List connectable non-template databases, probe versions/extensions, export ONE
# database in pg_restore custom format, or export optional cluster global objects.
# Globals omit role password hashes. Database and global exports do not share a
# cluster-wide snapshot; application files and external dependencies are separate.
# Requires psql, pg_dump, pg_restore, sh, stat, id and readlink in the container;
# globals additionally requires pg_dumpall. Provision suitable database privileges.
#
# Protocol 1 (database_backup.py supervisor, inside Docker under setsid)
# ------------------------------------------------------------------
# $1 action: discover | probe | dump | globals
# $2 absolute private pgpass file (current UID, mode 0400 or 0600)
# $3 TCP port on 127.0.0.1; $4 login role; $5 selected database
# Caller validates connection values. Discovery connects to the postgres database.
# stdout: discover = one database per line; probe = server/client versions then
#         extension names; dump = binary custom archive; globals = SQL text.
# stderr: native diagnostics, suppressed by the host supervisor, never a UI log.
# Exits: 0 success, 20 unsupported action, 21 unsafe credential file;
#        other nonzero statuses are shell/native-client failures.
# --no-password forbids interactive prompts. PGPASSFILE points to $2; psql ignores
# user startup files. No password is supplied as an argument or printed by this helper.
# No server mutations or local dump files. The host owns staging, verification and
# retention; the supervisor owns credential removal and process-group cancellation.

set -eu

# Validate the credential file and its parents before invoking a native client.
# Reads global cred. Returns 0 on acceptance; exits 21 for unsafe paths/ownership/
# modes. Does not change any permissions. /dev/shm's root-owned sticky 1777 mode
# is allowed, while the per-operation directory below it remains private.
validate_credentials() {
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
}

# Dispatch the five protocol arguments after credential validation.
# Native export commands use exec so the supervisor tracks their actual lifetime.
# Unknown actions fail; this function never schedules or launches a Borg backup.
main() {
    [ "$#" -eq 5 ] || exit 20
    act=$1; cred=$2; port=$3; dbuser=$4; database=$5
    validate_credentials
    export PGPASSFILE="$cred"
    command -v pg_dump >/dev/null
    command -v pg_restore >/dev/null
    command -v psql >/dev/null
    case "$act" in
     discover)
       exec psql --no-password --host=127.0.0.1 --port="$port" --username="$dbuser" --dbname=postgres --no-psqlrc --tuples-only --no-align \
         --command='SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname;'
       ;;
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
}

main "$@"
