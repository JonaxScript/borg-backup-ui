#!/bin/bash
# Bash startup adapter scoped to one Borg Backup UI notify invocation.
# The Unraid sidebar needs HTML description; agents receive the original text.
# No global configuration or installed notification-agent script is changed.
if [[ ${BBUI_UNRAID_AGENT_DESCRIPTION+x} ]]; then
    export DESCRIPTION="$BBUI_UNRAID_AGENT_DESCRIPTION"
    unset BBUI_UNRAID_AGENT_DESCRIPTION
fi

# Restore the caller's startup environment for nested shells. If it named a
# readable startup file, run that file here as Bash normally would have done.
_bbui_previous_bash_env=${BBUI_UNRAID_PREVIOUS_BASH_ENV-}
unset BBUI_UNRAID_PREVIOUS_BASH_ENV
if [[ -n $_bbui_previous_bash_env ]]; then
    export BASH_ENV="$_bbui_previous_bash_env"
    if [[ $_bbui_previous_bash_env != "${BASH_SOURCE[0]}" && -r $_bbui_previous_bash_env ]]; then
        source "$_bbui_previous_bash_env"
    fi
else
    unset BASH_ENV
fi
unset _bbui_previous_bash_env
