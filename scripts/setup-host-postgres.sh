#!/usr/bin/env bash
# Native PostgreSQL setup (host install). Prefer Docker Compose for the challenge stack.
set -euo pipefail

DB_NAME="${DATABASE_NAME:-wagering}"
DB_USER="${DATABASE_USER:-wagering}"
DB_PASSWORD="${DATABASE_PASSWORD:-wagering}"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

echo "PostgreSQL role '${DB_USER}' and database '${DB_NAME}' are ready."
