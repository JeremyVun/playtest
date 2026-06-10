#!/bin/sh
set -eu
curl -fsS -X POST "$BASE_URL/api/reset"
