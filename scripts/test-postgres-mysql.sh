#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
runtime="${CONTAINER_RUNTIME:-podman}"
command -v "$runtime" >/dev/null
run_id="tgm-pg-mysql-$$"
created=()
cleanup() {
  for name in "${created[@]}"; do
    "$runtime" stop --time 10 "$name" >/dev/null 2>&1 || true
    "$runtime" rm -v "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
password="Tgm_Test_${RANDOM}_Ab9"
pg_name="${run_id}-pg"
mysql_name="${run_id}-mysql"
"$runtime" run -d --name "$pg_name" -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=tgmtest -p 127.0.0.1::5432 "${PG_TEST_IMAGE:-docker.io/library/postgres:17-alpine}" >/dev/null
created+=("$pg_name")
"$runtime" run -d --name "$mysql_name" -e "MYSQL_ROOT_PASSWORD=$password" -p 127.0.0.1::3306 "${MYSQL_TEST_IMAGE:-docker.io/library/mysql:8.4}" >/dev/null
created+=("$mysql_name")
ready=false
for ((attempt=0; attempt<120; attempt++)); do
  if "$runtime" exec "$pg_name" pg_isready -U postgres >/dev/null 2>&1 &&
     "$runtime" exec "$mysql_name" mysql -uroot -p"$password" -e 'select 1' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  "$runtime" logs --tail 30 "$pg_name"
  "$runtime" logs --tail 30 "$mysql_name"
  exit 1
fi
unset MSSQL_HOST ORACLE_HOST
export PG_HOST=127.0.0.1 PG_USER=postgres PG_DATABASE=tgmtest PG_PASSWORD="$password"
export PG_PORT="$("$runtime" port "$pg_name" 5432/tcp | sed 's/.*://')"
export MYSQL_HOST=127.0.0.1 MYSQL_PASSWORD="$password"
export MYSQL_PORT="$("$runtime" port "$mysql_name" 3306/tcp | sed 's/.*://')"
if [[ -n "${TS_GRM_TEST_VERSION:-}" ]]; then
  COMPAT_DATABASES=1 node scripts/test-compatibility.mjs "$TS_GRM_TEST_VERSION"
else
  corepack yarn vitest run tests/cli-postgres.test.ts tests/ddl-postgres.test.ts tests/introspector-postgres.test.ts tests/migrator-postgres.test.ts tests/mysql.test.ts
fi
