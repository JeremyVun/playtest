#!/bin/sh
# Convenience wrapper — same as: node _hash-app.mjs
exec node "$(dirname "$0")/_hash-app.mjs"
