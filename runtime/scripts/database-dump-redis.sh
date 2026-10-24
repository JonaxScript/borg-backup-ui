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
# Stream a native RDB snapshot of the entire standalone Redis instance via its
# replication protocol. ALL logical databases are included; no per-index filter.
# Requires redis-cli, sed and standard supervisor utilities. ACL permissions must
# permit PING, INFO and replication/SYNC. Redis Cluster is rejected: one node is
# not a complete cluster backup. The RDB excludes server config and ACL secrets.
# Restoring requires a compatible Redis server and the documented AOF procedure.
#
# Protocol 1: action, private password file, port, ACL username (empty=no auth),
# database selector (must be "all"). stdout = selection, two version lines or RDB.
# redis-cli --rdb - streams binary bytes; diagnostics go to stderr. REDISCLI_AUTH
# carries the password in the child environment, never command-line arguments.
# Exits: 20 invalid scope, 21 unsafe credentials, otherwise native client failure.
set -eu

# Accept only an owned private credential file, without changing permissions.
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

# Invoke a fixed local endpoint; ACL username is optional and never a password.
client() {
    if [ -n "$dbuser" ]; then
        redis-cli -e --raw -h 127.0.0.1 -p "$port" --user "$dbuser" "$@"
    else
        redis-cli -e --raw -h 127.0.0.1 -p "$port" "$@"
    fi
}

# Dispatch only complete standalone snapshots and read-only metadata commands.
main() {
    [ "$#" -eq 5 ] || exit 20
    act=$1; cred=$2; port=$3; dbuser=$4; database=$5
    validate_credentials
    command -v redis-cli >/dev/null || exit 24
    if [ -n "$dbuser" ]; then
        IFS= read -r REDISCLI_AUTH < "$cred"
        export REDISCLI_AUTH
    fi
    [ "$(client PING)" = PONG ] || exit 20
    cluster=$(client INFO cluster | tr -d '\r')
    case "$cluster" in *cluster_enabled:0*) ;; *) exit 20;; esac
    case "$act" in
      discover) printf 'all\n' ;;
      probe)
        client INFO server | tr -d '\r' | sed -n 's/^redis_version://p'
        redis-cli --version
        ;;
      dump) [ "$database" = all ] || exit 20; client --rdb - ;;
      *) exit 20;;
    esac
}
main "$@"
