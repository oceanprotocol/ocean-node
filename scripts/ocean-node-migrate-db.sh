#!/bin/bash
# Moves a node of version 5.1.0 or older to this release: copies its node state (the SQLite
# files) to PostgreSQL or Elasticsearch, then starts the node. Run it in the folder of
# docker-compose.yml. A file with Typesense gets PostgreSQL or Elasticsearch in its place; a
# file with Elasticsearch keeps it. The file before a change stays in docker-compose.yml.old.

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
MIGRATE="node dist/helpers/scripts/migrateDatabase.js"
FILE=docker-compose.yml
OLD=docker-compose.yml.old
NEW_DB=''
CHANGED=''

if [ ! -f "$FILE" ]; then
  echo "Error: $FILE not found in the current directory"
  exit 1
fi

# the compose project: its name is the start of the volume names
project() {
  local name
  name=$($DC config 2>/dev/null | sed -n 's/^name: *//p' | head -n 1)
  echo "${name:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
}

# the value of a key in docker-compose.yml, with or without quotes
value() {
  sed -n "s/^ *$1: *['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\} *$/\1/p" "$FILE" | head -n 1
}

# keeps the file before the change
keep_old() {
  cp "$FILE" "$OLD" && CHANGED=1
}

# adds $DB_LINES after the first line that matches $1, at its indent
add_lines() {
  keep_old || return 1
  export DB_LINES
  awk -v anchor="$1" '
    !done && $0 ~ anchor {
      print; match($0, /^ */); n = split(ENVIRON["DB_LINES"], line, "\n")
      for (i = 1; i <= n; i++) print substr($0, 1, RLENGTH) line[i]
      done = 1; next
    }
    { print }' "$OLD" > "$FILE"
}

# the database, as the quickstart writes it; the database has no published port
database_parts() {
  local password
  password=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')
  if [ "$NEW_DB" == "postgresql" ]; then
    DB_LINES="DB_TYPE: 'postgresql'
DB_URL: 'postgresql://postgresql:5432/ocean'
DB_USERNAME: 'ocean'
DB_PASSWORD: '$password'"
    SERVICE="  postgresql:
    image: postgres:17
    container_name: postgresql
    restart: on-failure
    networks:
      - ocean_network
    volumes:
      - postgresql-data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: 'ocean'
      POSTGRES_USER: 'ocean'
      POSTGRES_PASSWORD: '$password'"
  else
    DB_LINES="DB_TYPE: 'elasticsearch'
DB_URL: 'http://elasticsearch:9200'
DB_USERNAME: 'elastic'
DB_PASSWORD: '$password'"
    SERVICE="  elasticsearch:
    image: elasticsearch:8.5.1
    container_name: elasticsearch
    restart: on-failure
    networks:
      - ocean_network
    volumes:
      - elasticsearch-data:/usr/share/elasticsearch/data
    environment:
      ES_JAVA_OPTS: '-Xms512m -Xmx512m'
      discovery.type: 'single-node'
      ELASTIC_PASSWORD: '$password'
      xpack.security.enabled: 'true'
      xpack.security.http.ssl.enabled: 'false'"
  fi
  VOLUME="  $NEW_DB-data:
    driver: local"
}

# Typesense out, the new database in: the DB_URL line, depends_on, the service and its volume
replace_typesense() {
  keep_old || return 1
  export DB_LINES SERVICE VOLUME
  awk -v db="$NEW_DB" '
    function block(text, indent,   n, i, line) {
      n = split(text, line, "\n")
      for (i = 1; i <= n; i++) print indent line[i]
    }
    /^ *DB_URL:.*typesense/ { match($0, /^ */); block(ENVIRON["DB_LINES"], substr($0, 1, RLENGTH)); next }
    /^ *DB_TYPE:.*typesense/ { next }
    /^ *- typesense *$/ { sub(/typesense/, db); print; next }
    /^  typesense(-data)?: *$/ { skip = 1; next }
    skip && /^[^ ]|^  [^ ]/ { skip = 0 }
    skip { next }
    /^volumes: *$/ { block(ENVIRON["SERVICE"], ""); print ""; print; block(ENVIRON["VOLUME"], ""); next }
    { print }' "$OLD" > "$FILE"
}

# docker-compose.yml for this release; 1 when the file cannot be changed
update_compose() {
  local type url
  type=$(value DB_TYPE)
  url=$(value DB_URL)
  if [[ "$url" == *typesense* ]]; then
    if ! grep -q '^  typesense: *$' "$FILE" || ! grep -q '^volumes: *$' "$FILE"; then
      echo "Error: $FILE has Typesense, but not as the quickstart of 5.1.0 writes it."
      echo "Run the quickstart, select 2 or 3, and then run this script again."
      return 1
    fi
    read -r -p "Database for the node: 2) PostgreSQL 3) Elasticsearch [2/3]: " choice
    case "$choice" in
      2) NEW_DB=postgresql ;;
      3) NEW_DB=elasticsearch ;;
      *) echo "Cancelled"; return 1 ;;
    esac
    # a database keeps the password of its first start: its volume must be new
    DB_DATA="$(project)_$NEW_DB-data"
    if docker volume inspect "$DB_DATA" >/dev/null 2>&1; then
      echo "Error: the volume $DB_DATA exists. It keeps a password that this script does not know."
      echo "If it holds no data that you need, remove it (docker volume rm $DB_DATA) and run this script again."
      NEW_DB=''
      return 1
    fi
    database_parts
    replace_typesense
    return
  fi
  if [ "$type" == "sqlite" ]; then
    return 0
  fi
  if [ -z "$url" ]; then
    echo "Error: $FILE has no DB_URL. Run the quickstart, select 2 or 3, and then run this script again."
    return 1
  fi
  # an Elasticsearch of version 5.1.0 (with no DB_TYPE, 5.1.0 used Elasticsearch) stays
  if [ "$type" != "postgresql" ] && { [ -z "$(value DB_USERNAME)" ] || [ -z "$(value DB_PASSWORD)" ]; }; then
    echo "Error: this release needs DB_USERNAME and DB_PASSWORD for Elasticsearch."
    echo "Add them to the ocean-node service in $FILE, then run this script again."
    return 1
  fi
  if [ -z "$type" ]; then
    DB_LINES="DB_TYPE: 'elasticsearch'"
    add_lines '^ *DB_URL:'
  fi
}

# the file before the change, and no container or volume of a database that was added
restore() {
  [ -n "$CHANGED" ] || return
  if [ -n "$NEW_DB" ]; then
    $DC rm -s -f "$NEW_DB" >/dev/null 2>&1
    docker volume rm "$DB_DATA" >/dev/null 2>&1
  fi
  mv "$OLD" "$FILE"
  echo "$FILE is as before the script."
}

update_compose || { restore; exit 1; }
if [ -n "$CHANGED" ] && ! $DC config -q; then
  echo "Error: the changed $FILE is not valid."
  restore
  exit 1
fi

# read-only checks; the node still runs. Exit 2: nothing to copy.
$DC run --rm ocean-node $MIGRATE --check
code=$?
if [ $code -ne 0 ]; then
  restore
  exit $code
fi

$DC stop ocean-node || exit 1
trap 'echo "The node is stopped. Run this script again, or start the node without the copy: $DC up -d"; [ -f "$OLD" ] && echo "To go back to the old node: mv $OLD $FILE && $DC up -d"' EXIT

$DC run --rm ocean-node $MIGRATE || exit 1

trap - EXIT
if [ -n "$NEW_DB" ]; then
  # the Typesense container of the old file
  $DC up -d --remove-orphans
else
  $DC up -d
fi
