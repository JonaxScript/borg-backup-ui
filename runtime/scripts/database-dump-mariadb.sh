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
# List schemas, probe server/client versions, or export ONE selected database.
# Dump includes CREATE DATABASE, tables/data, views, routines, events and triggers.
# Base tables must use InnoDB. Concurrent DDL and application files are outside
# the transaction guarantee. Server accounts/global grants are not exported.
# Requires mariadb, mariadb-dump, sh, stat, id and readlink inside the container.
# The configured account needs access to the selected schema and export objects.
#
# Protocol 1 (database_backup.py supervisor, inside Docker under setsid)
# ------------------------------------------------------------------
# $1 action: discover | probe | dump
# $2 absolute credential file: private [client] options; file owner = current UID
# $3 TCP port on 127.0.0.1; caller validates its numeric range
# $4 database user: reserved protocol field; MariaDB reads user from $2
# $5 database name: caller-validated; empty only for discovery
# stdout: discover = one schema per line; probe = server then client version;
#         dump = SQL stream. The host owns staging, hashing, retention and Borg.
# stderr: native diagnostics, suppressed by the host supervisor, never a UI log.
# Exits: 0 success, 20 unsupported action/name, 21 unsafe credential file,
#        22 non-InnoDB table, otherwise shell/native-client failure.
# The host gzip-compresses the stdout stream; this helper emits native raw bytes.
# No server mutations or local dump files. Credentials are read, never removed
# here: the supervisor owns their lifecycle and cancellation/process cleanup.

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

# Permit only the documented client option group and credential/TLS keys.
# Reads global cred. Returns 0 when accepted; exits 21 on an unsupported line.
# Includes and extra groups are rejected to prevent implicit scope changes.
validate_client_options() {
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line#"${line%%[![:space:]]*}"}
        case "$line" in
          ''|'#'*|';'*|'[client]'|user=*|password=*|ssl-ca=*|ssl-cert=*|ssl-key=*|ssl-verify-server-cert*) ;;
          *) exit 21;;
        esac
    done < "$cred"
}

# Run a read-only SQL query with fixed TCP endpoint and the protected option file.
# Arguments are native client options supplied below; stdout contains query rows.
# Reads cred/port and returns the MariaDB client's exit status. Never prints secrets.
client() {
    mariadb --defaults-file="$cred" --protocol=tcp --host=127.0.0.1 --port="$port" --batch --skip-column-names "$@"
}

# Dispatch the five protocol arguments after credential validation.
# Native export commands use exec so the supervisor tracks their actual lifetime.
# Unknown actions fail; this function never schedules or launches a Borg backup.
main() {
    [ "$#" -eq 5 ] || exit 20
    act=$1; cred=$2; port=$3; dbuser=$4; database=$5
    validate_credentials
    validate_client_options
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
}

main "$@"
