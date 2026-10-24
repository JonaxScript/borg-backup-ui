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
# Export the complete MongoDB replica-set member with oplog for online consistency.
# Requires mongosh and MongoDB Database Tools >=100.3 (config-file support),
# an initialized non-sharded replica set, and full backup/oplog privileges.
# Standalone, mongos and shard/config-server members are rejected. No server stops,
# write pauses, fsync locks or replica-set reconfiguration are performed.
# All databases plus users/roles (including credential hashes) are included;
# protect the archive accordingly. Restore with mongorestore --archive --oplogReplay.
# Concurrent ordinary writes are supported. Avoid DDL, user/role/FCV changes;
# native export errors (including oplog rollover) fail the backup, without fallback.
#
# Protocol 1: action, private JSON credentials, port, username (empty=no auth),
# selector "all", authentication database. JSON is also valid YAML for the
# native --config option. Only the password key is supplied by the host.
# stdout contains names, two version lines, or a binary archive. Diagnostics are
# suppressed by the host. Exit 20 = invalid action; 21 = unsafe credentials; 23 = unsupported topology.
# Credentials never appear in argv; mongosh reads the private file itself.
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

# Fixed read-only query program. User input travels through environment fields,
# never interpolated into JavaScript. Password contents stay inside the process.
query() {
    BBUI_CRED="$cred" BBUI_PORT="$port" BBUI_USER="$dbuser" BBUI_AUTH="$authdb" BBUI_ACTION="$act" \
      mongosh --nodb --quiet --norc --eval '
        const fs = require("fs");
        const c = new Mongo("mongodb://127.0.0.1:" + process.env.BBUI_PORT + "/?directConnection=true");
        if (process.env.BBUI_USER) {
          const password = JSON.parse(fs.readFileSync(process.env.BBUI_CRED, "utf8")).password;
          const ok = c.getDB(process.env.BBUI_AUTH).auth(process.env.BBUI_USER, password);
          if (!(ok === 1 || ok === true || (ok && ok.ok === 1))) throw new Error("auth");
        }
        const admin = c.getDB("admin");
        const hello = admin.runCommand({hello:1});
        if (hello.ok !== 1 || !hello.setName || hello.msg === "isdbgrid") quit(23);
        const options = admin.runCommand({getCmdLineOpts:1});
        if (options.ok !== 1 || options.parsed?.sharding?.clusterRole) quit(23);
        if (process.env.BBUI_ACTION === "discover") {
          print("all");
        } else {
          const result = admin.runCommand({buildInfo:1});
          if (result.ok !== 1) throw new Error("version");
          print(result.version);
        }
      '
}

# Dispatch validated protocol fields; native failures propagate to the supervisor.
main() {
    [ "$#" -eq 6 ] || exit 20
    act=$1; cred=$2; port=$3; dbuser=$4; database=$5; authdb=$6
    validate_credentials
    command -v mongosh >/dev/null || exit 24
    command -v mongodump >/dev/null || exit 24
    case "$act" in
      discover) query ;;
      probe) query; mongodump --version | head -n 1 ;;
      dump)
        [ "$database" = all ] || exit 20
        query >/dev/null
        set -- --host=127.0.0.1 --port="$port" --archive --oplog
        if [ -n "$dbuser" ]; then
          set -- "$@" --username="$dbuser" --authenticationDatabase="$authdb" --config="$cred"
        fi
        exec mongodump "$@"
        ;;
      *) exit 20;;
    esac
}
main "$@"
