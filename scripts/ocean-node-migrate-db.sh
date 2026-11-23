#!/bin/bash
# Moves a node of version 5.1.0 or older to this release: copies its node state (the SQLite
# files) to PostgreSQL or Elasticsearch, then starts the node. Run it in the folder of
# docker-compose.yml (or .yaml). A file with Typesense gets PostgreSQL or Elasticsearch in its
# place; a file with Elasticsearch keeps it. The file before a change stays in <file>.old.
# The answers come from the terminal, so `curl -fsSL <url> | bash` works too.

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
MIGRATE="node dist/helpers/scripts/migrateDatabase.js"
# the file that docker compose reads: .yml first, as docker compose does
FILE=docker-compose.yml
[ -f "$FILE" ] || FILE=docker-compose.yaml
OLD=$FILE.old
NEW_DB=''
CHANGED=''

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

keep_old() {
  cp "$FILE" "$OLD" && CHANGED=1
}

# the database, as ocean-node-quickstart.sh writes it: keep the two in step. It has no
# published port: only the node can reach it.
database_parts() {
  local password image user url data env
  password=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')
  if [ "$NEW_DB" == "postgresql" ]; then
    image=postgres:17 user=ocean url=postgresql://postgresql:5432/ocean
    data=/var/lib/postgresql/data
    env="POSTGRES_DB: 'ocean'
POSTGRES_USER: 'ocean'
POSTGRES_PASSWORD: '$password'"
  else
    image=elasticsearch:8.5.1 user=elastic url=http://elasticsearch:9200
    data=/usr/share/elasticsearch/data
    env="ES_JAVA_OPTS: '-Xms512m -Xmx512m'
discovery.type: 'single-node'
ELASTIC_PASSWORD: '$password'
xpack.security.enabled: 'true'
xpack.security.http.ssl.enabled: 'false'"
  fi
  DB_LINES="DB_TYPE: '$NEW_DB'
DB_URL: '$url'
DB_USERNAME: '$user'
DB_PASSWORD: '$password'"
  SERVICE="  $NEW_DB:
    image: $image
    container_name: $NEW_DB
    restart: on-failure
    networks:
      - ocean_network
    volumes:
      - $NEW_DB-data:$data
    environment:
$(echo "$env" | sed 's/^/      /')"
}

# Typesense out, the new database in: the DB_URL line, depends_on, the service and its volume
replace_typesense() {
  keep_old || return 1
  export DB_LINES SERVICE
  awk -v db="$NEW_DB" '
    function block(text, indent,   n, i, line) {
      n = split(text, line, "\n")
      for (i = 1; i <= n; i++) print indent line[i]
    }
    /^ *DB_URL:.*typesense/ { match($0, /^ */); block(ENVIRON["DB_LINES"], substr($0, 1, RLENGTH)); next }
    /^ *DB_TYPE:.*typesense/ { next }
    /^ *- typesense *$/ { sub(/typesense/, db); print; next }
    # the next key ends the Typesense service; the new service takes its place
    skip && /^[^ ]|^  [^ ]/ { skip = 0; print "" }
    skip { next }
    /^  typesense: *$/ { block(ENVIRON["SERVICE"], ""); skip = 1; next }
    /^  typesense-data: *$/ { sub(/typesense/, db); print; next }
    { print }' "$OLD" > "$FILE"
}

# docker-compose.yml for this release; 1 when the file cannot be changed
update_compose() {
  local type url
  type=$(value DB_TYPE)
  url=$(value DB_URL)
  if [[ "$url" == *typesense* ]]; then
    if ! grep -q '^  typesense: *$' "$FILE" || ! grep -q '^  typesense-data: *$' "$FILE"; then
      echo "Error: $FILE has Typesense, but not as the quickstart of 5.1.0 writes it."
      echo "Run the quickstart, select 2 or 3, and then run this script again."
      return 1
    fi
    read -r -p "Database for the node: 2) PostgreSQL 3) Elasticsearch [2/3]: " choice </dev/tty
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
      return 1
    fi
    database_parts
    replace_typesense
    return
  fi
  # The database is in DB_URL, or in the dbConfig of the node config file (config.json): the
  # DB_* values of the compose file override those of the file. The check of the node, before
  # the node stops, finds a missing database.
  # Without DB_TYPE, version 5.1.0 used Elasticsearch: the node keeps it. Every node has a
  # PRIVATE_KEY in the compose file.
  if [ -z "$type" ]; then
    local key=DB_URL
    [ -n "$url" ] || key=PRIVATE_KEY
    keep_old && awk -v key="$key" '!done && $0 ~ "^ *" key ":" {
      print; match($0, /^ */); print substr($0, 1, RLENGTH) "DB_TYPE: '\''elasticsearch'\''"
      done = 1; next
    } { print }' "$OLD" > "$FILE"
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

# all of the work: with `curl | bash`, nothing runs before the whole script is read
main() {
  if [ ! -f "$FILE" ]; then
    echo "Error: docker-compose.yml or docker-compose.yaml not found in the current directory"
    exit 1
  fi
  if ! { : </dev/tty; } 2>/dev/null; then
    echo "Error: the script asks questions: run it in a terminal"
    exit 1
  fi

  update_compose || { restore; exit 1; }
  if [ -n "$CHANGED" ] && ! $DC config -q; then
    echo "Error: the changed $FILE is not valid."
    restore
    exit 1
  fi

  # read-only checks; the node still runs. Exit 2: nothing to copy.
  $DC run --rm ocean-node $MIGRATE --check </dev/tty
  local code=$?
  if [ $code -ne 0 ]; then
    restore
    exit $code
  fi

  $DC stop ocean-node || exit 1
  trap 'echo "The node is stopped. Run this script again, or start the node without the copy: $DC up -d"; [ -f "$OLD" ] && echo "To go back to the old node: mv $OLD $FILE && $DC up -d"' EXIT

  $DC run --rm ocean-node $MIGRATE </dev/tty || exit 1

  trap - EXIT
  # --remove-orphans: the Typesense container of the old file
  $DC up -d ${NEW_DB:+--remove-orphans}
}

main "$@"
