#!/usr/bin/env bash
# Isolated, disposable test services; existing containers/databases are never reused.
set -euo pipefail
cd "$(dirname "$0")/.."
run_id="tgm-server-test-$$"
mssql_name="${run_id}-mssql"
oracle_name="${run_id}-oracle"
created=()
cleanup() {
  for name in "${created[@]}"; do
    podman stop --time 10 "$name" >/dev/null 2>&1 || true
    podman rm -v "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
mssql_image="${MSSQL_TEST_IMAGE:-mcr.microsoft.com/mssql/server:2022-latest}"
oracle_image="${ORACLE_TEST_IMAGE:-ghcr.io/gvenzl/oracle-free:23-slim}"
test_password="Tgm_Test_${RANDOM}_Ab9!"
podman run -d --name "$mssql_name" -e ACCEPT_EULA=Y -e MSSQL_PID=Developer \
  -e "MSSQL_SA_PASSWORD=$test_password" -e MSSQL_MEMORY_LIMIT_MB=2048 \
  -p 127.0.0.1::1433 "$mssql_image" >/dev/null
created+=("$mssql_name")
podman run -d --name "$oracle_name" -e "ORACLE_PASSWORD=$test_password" \
  -p 127.0.0.1::1521 "$oracle_image" >/dev/null
created+=("$oracle_name")
printf 'Waiting for isolated SQL Server and Oracle test services...\n'
ready=false
for ((attempt=0; attempt<180; attempt++)); do
  if podman exec "$mssql_name" /opt/mssql-tools18/bin/sqlcmd -C -U sa -P "$test_password" -Q 'select 1' >/dev/null 2>&1 \
    && podman exec "$oracle_name" healthcheck.sh >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  podman logs --tail 30 "$mssql_name"
  podman logs --tail 30 "$oracle_name"
  exit 1
fi
# Only this disposable container's SYSTEM account may grant DBMS_LOCK to test users.
podman exec -i "$oracle_name" sqlplus -s / as sysdba <<'SQL'
whenever sqlerror exit failure
alter session set container=FREEPDB1;
grant execute on sys.dbms_lock to system with grant option;
exit;
SQL
export MSSQL_HOST=127.0.0.1 MSSQL_USER=sa MSSQL_DATABASE=master
export MSSQL_PORT="$(podman port "$mssql_name" 1433/tcp | sed 's/.*://')"
export MSSQL_PASSWORD="$test_password"
export ORACLE_HOST=127.0.0.1 ORACLE_DATABASE=FREEPDB1
export ORACLE_PORT="$(podman port "$oracle_name" 1521/tcp | sed 's/.*://')"
export ORACLE_PASSWORD="$test_password"
corepack yarn vitest run tests/server-integration.test.ts tests/server-unit.test.ts
