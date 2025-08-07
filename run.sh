#!/bin/sh
set -e

DATA_DIR="/data"

# Ensure options.json exists
if [ ! -f "$DATA_DIR/options.json" ]; then
  echo "ERROR: options.json not found in $DATA_DIR" >&2
  exit 1
fi

# Copy HA add-on options (service config) to Orca config.json
# cp "$DATA_DIR/options.json" /app/config.json
echo "$(jq -r .config $DATA_DIR/options.json)" > /app/config.json

# Start the Orca server
exec npm start
