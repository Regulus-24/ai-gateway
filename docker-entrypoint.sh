#!/bin/sh
DB_FILE="${DB_PATH:-/app/data/gateway.db}"
if [ ! -f "$DB_FILE" ]; then
    echo "First run: seeding database..."
    node src/db/seed.js
    node src/db/seed-config.js
fi
exec "$@"
