#!/bin/bash
# Double-click in Finder to run desktop/try.sh in a Terminal window.
cd "$(dirname "$0")" || exit 1
./try.sh "$@"
status=$?
echo
read -n 1 -s -r -p "Press any key to close this window…"
exit $status
