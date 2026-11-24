#!/bin/bash
# Copies the node state of SQLite files (a node of version 5.1.0 or older, or of this release
# with DB_TYPE=sqlite) to PostgreSQL or Elasticsearch, then starts the node. Run it in the
# folder of docker-compose.yml (or .yaml). It asks for the database: PostgreSQL or Elasticsearch
# take the place of the old one (Typesense or Elasticsearch; added on a SQLite node) in the
# compose file, and in the dbConfig of config.json. The files before a change stay in <file>.old.
# The answers come from the terminal, so `curl -fsSL <url> | bash` works too.

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
MIGRATE="node dist/helpers/scripts/migrateDatabase.js"
# the file that docker compose reads: .yml first, as docker compose does
FILE=docker-compose.yml
[ -f "$FILE" ] || FILE=docker-compose.yaml
# all docker compose commands read only this file
DC="$DC -f $FILE"
OLD=$FILE.old
NEW_DB=''
OLD_DB=''
DB_DATA=''
CHANGED=''
CONFIG_CHANGED=''
PROTECT_ES=''
# the database that step 3 starts: the copy runs with --no-deps
START_DB=''

# the compose project: its name is the start of the volume names
project() {
  local name
  name=$($DC config 2>/dev/null | sed -n 's/^name: *//p' | head -n 1)
  echo "${name:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
}

# the value of a key in docker-compose.yml, with or without quotes: `KEY: value` or `- KEY=value`
value() {
  sed -n -e "s/^ *$1: *['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\} *$/\1/p" \
    -e "s/^ *- *['\"]\{0,1\}$1=\([^'\"]*\)['\"]\{0,1\} *$/\1/p" "$FILE" | head -n 1
}

keep_old() {
  cp "$FILE" "$OLD" && CHANGED=1
}

# the database type of the node: DB_TYPE in the compose file, else the dbType of the
# config.json that it mounts
db_type() {
  local type
  type=$(value DB_TYPE)
  if [ -z "$type" ] && [ -f config.json ] && grep -q 'config.json' "$FILE"; then
    # the value can be on the next line: read the file as one line
    type=$(tr '\n' ' ' <config.json | sed -n 's/.*"dbType" *: *"\([a-z]*\)".*/\1/p')
  fi
  echo "$type"
}

# a change, with the credentials in URLs and all of a line after a password or the private
# key hidden: a terminal log can keep them
show_diff() {
  diff -u "$1" "$2" | sed -n '3,$p' |
    sed -E -e "s#(://[^:/@ ]+:)[^@ ]+@#\1<hidden>@#g" \
      -e "s/((PASSWORD|password|PRIVATE_KEY|privateKey)[\"']? *[:=]).*/\1 <hidden>/" | sed 's/^/    /'
}

# the database, as ocean-node-quickstart.sh writes it: keep the two in step. It has no
# published port: only the node can reach it. Its networks are those of the old database, or
# of the node when there is no old one.
database_parts() {
  local image data env
  NEW_PASSWORD=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')
  if [ "$NEW_DB" == "postgresql" ]; then
    image=postgres:17 NEW_USER=ocean NEW_URL=postgresql://postgresql:5432/ocean
    data=/var/lib/postgresql/data
    env="POSTGRES_DB: 'ocean'
POSTGRES_USER: 'ocean'
POSTGRES_PASSWORD: '$NEW_PASSWORD'"
  else
    image=elasticsearch:8.5.1 NEW_USER=elastic NEW_URL=http://elasticsearch:9200
    data=/usr/share/elasticsearch/data
    env="ES_JAVA_OPTS: '-Xms512m -Xmx512m'
discovery.type: 'single-node'
ELASTIC_PASSWORD: '$NEW_PASSWORD'
xpack.security.enabled: 'true'
xpack.security.http.ssl.enabled: 'false'"
  fi
  DB_LINES="DB_TYPE: '$NEW_DB'
DB_URL: '$NEW_URL'
DB_USERNAME: '$NEW_USER'
DB_PASSWORD: '$NEW_PASSWORD'"
  SERVICE="  $NEW_DB:
    image: $image
    container_name: $NEW_DB
    restart: on-failure
    volumes:
      - $NEW_DB-data:$data
    environment:
$(echo "$env" | sed 's/^/      /')"
}

# the old database service out (none on a SQLite node), the new one in (none for SQLite):
# depends_on, the service with the networks of the old one (of the node, when there is no old
# one), and its volume
replace_db() {
  keep_old || return 1
  export SERVICE
  awk -v old="$OLD_DB" -v db="$NEW_DB" '
    function block(text, indent,   n, i, line) {
      if (text == "") return
      n = split(text, line, "\n")
      for (i = 1; i <= n; i++) print indent line[i]
    }
    function new_service() {
      if (ENVIRON["SERVICE"] != "") { block(ENVIRON["SERVICE"], ""); printf "%s", nets; print "" }
      skip = 0
    }
    BEGIN { add = db != "sqlite" }
    # a key at column 0 or 2 ends a block; a comment or a line of a multi-line value does not
    # first read: the networks of the node
    NR == FNR {
      if (/^  ocean-node: *$/) in_node = 1
      else if (/^[A-Za-z_]|^  [A-Za-z0-9_.-]+:/) in_node = 0
      if (in_node && /^    networks:/) { node_nets = $0 "\n"; in_nets = 1 }
      else if (in_node && in_nets && /^      /) node_nets = node_nets $0 "\n"
      else in_nets = 0
      next
    }
    old == "" && /^services: *$/ { print; nets = node_nets; new_service(); next }
    # the next key ends the old service
    skip && /^[A-Za-z_]|^  [A-Za-z0-9_.-]+:/ { new_service() }
    skip && /^    networks:/ { in_nets = 1; nets = $0 "\n"; next }
    skip && in_nets && /^      / { nets = nets $0 "\n"; next }
    skip { in_nets = 0; next }
    old != "" && $0 ~ "^  " old ": *$" { skip = 1; next }
    # depends_on, as a list or as a map: the old database becomes the new one, or goes; the
    # key is written only when an entry stays
    /^    depends_on: *$/ { dep = $0; in_dep = 1; next }
    in_dep && /^      / {
      if (old != "" && ($0 ~ "^      - *" old " *$" || $0 ~ "^      " old ": *$")) {
        if (!add) { drop_sub = $0 !~ /^ *-/; next }
        sub(old, db)
      } else if (drop_sub && /^        /) next
      else drop_sub = 0
      if (dep != "") { print dep; dep = "" }
      print; next
    }
    in_dep { in_dep = 0; drop_sub = 0; dep = "" }
    add && /^volumes: *$/ { print; print "  " db "-data:"; volumes = 1; next }
    { print }
    END {
      if (skip) new_service()
      if (add && !volumes) { print "volumes:"; print "  " db "-data:" }
    }' "$OLD" "$OLD" > "$FILE" && set_node_db
}

# the DB_* values of the node: the old ones out, DB_LINES after PRIVATE_KEY. Only in the
# ocean-node service: another service can have values with the same names.
set_node_db() {
  DB_LINES=$DB_LINES awk '
    /^[A-Za-z_]|^  [A-Za-z0-9_.-]+:/ { in_node = $0 ~ /^  ocean-node: *$/ }
    in_node && /^ *DB_(TYPE|URL|USERNAME|PASSWORD):/ { next }
    in_node && /^ *PRIVATE_KEY:/ {
      print; match($0, /^ */)
      n = split(ENVIRON["DB_LINES"], line, "\n")
      for (i = 1; i <= n; i++) print substr($0, 1, RLENGTH) line[i]
      next
    }
    { print }' "$FILE" > "$FILE.new" && mv "$FILE.new" "$FILE"
}

# the dbConfig of config.json, when the compose file mounts it: the same values as the compose
# file, which override it. $1: the database type; the url changes only when NEW_URL is set.
update_config_json() {
  [ -f config.json ] && grep -q 'config.json' "$FILE" && grep -q '"dbConfig"' config.json || return 0
  if ! command -v python3 >/dev/null; then
    echo "    config.json has a dbConfig: set it as in $FILE by hand. The compose file overrides it."
    return 0
  fi
  # without the old file, a revert cannot put it back: no change
  cp config.json config.json.old || return 1
  CONFIG_CHANGED=1
  DB=$1 NEW_URL=$NEW_URL NEW_USER=$NEW_USER NEW_PASSWORD=$NEW_PASSWORD python3 -c '
import json, os, re
text = open("config.json").read()
found = re.search(r"\n([ \t]+)\"", text)
data = json.loads(text)
if os.environ["DB"] == "sqlite":
    data["dbConfig"] = {"dbType": "sqlite"}
else:
    db = {"dbType": os.environ["DB"], "username": os.environ["NEW_USER"],
          "password": os.environ["NEW_PASSWORD"]}
    if os.environ["NEW_URL"]:
        db["url"] = os.environ["NEW_URL"]
    data["dbConfig"] = {**data["dbConfig"], **db}
# write in place: a container that mounts the file sees the change
with open("config.json", "w") as file:
    file.write(json.dumps(data, indent=found.group(1) if found else 2, ensure_ascii=False) + "\n")
' || return 1
  echo "    Changes in config.json (the old file is config.json.old):"
  show_diff config.json.old config.json
}

# a database keeps the password of its first start: its volume must be new
new_volume() {
  local answer containers
  DB_DATA="$(project)_$NEW_DB-data"
  docker volume inspect "$DB_DATA" >/dev/null 2>&1 || return 0
  echo "The volume $DB_DATA exists, from an earlier $NEW_DB. It keeps a password that this script does not know."
  read -r -p "Remove this volume and all its data? [y/N]: " answer </dev/tty
  [ "$answer" == "y" ] || { echo "Cancelled"; return 1; }
  containers=$(docker ps -aq --filter volume="$DB_DATA")
  if [ -n "$containers" ]; then
    echo "    \$ docker rm -f $(echo $containers)"
    docker rm -f $containers >/dev/null || return 1
  fi
  echo "    \$ docker volume rm $DB_DATA"
  docker volume rm "$DB_DATA" >/dev/null
}

# Elasticsearch stays, protected: an open one gets security and a new password for the user
# elastic, a protected one keeps its password. The node gets the same user and password, in
# its DB_* values and in config.json. Elasticsearch restarts with security when the node stops.
keep_elasticsearch() {
  if ! grep -q '^  elasticsearch: *$' "$FILE" || ! grep -q '^ *PRIVATE_KEY:' "$FILE"; then
    echo "Error: $FILE needs the service elasticsearch and a 'PRIVATE_KEY: <key>' line in the node environment."
    return 1
  fi
  NEW_USER=elastic NEW_URL=''
  NEW_PASSWORD=$(value ELASTIC_PASSWORD)
  # a protected Elasticsearch keeps the password of its first start: the script must know it.
  # Elasticsearch 8 has security when the compose file does not set it to false.
  if [ "$(value xpack.security.enabled)" != "false" ] && [ -z "$NEW_PASSWORD" ]; then
    echo "Error: Elasticsearch can have security, but $FILE has no ELASTIC_PASSWORD. Add 'ELASTIC_PASSWORD: <password of the elastic user>' to the elasticsearch service, or 'xpack.security.enabled: false' when it has no security, then run the script again."
    return 1
  fi
  if [ "$(value xpack.security.enabled)" == "false" ]; then
    NEW_PASSWORD=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')
    PROTECT_ES=1
  fi
  local url
  url=$(value DB_URL)
  DB_LINES="DB_TYPE: 'elasticsearch'
${url:+DB_URL: '$url'
}DB_USERNAME: 'elastic'
DB_PASSWORD: '$NEW_PASSWORD'"
  keep_old || return 1
  NEW_PASSWORD=$NEW_PASSWORD awk -v protect="$PROTECT_ES" '
    BEGIN {
      q = "\047"
      security = "^ *-? *[\"\047]?(ELASTIC_PASSWORD|xpack[.]security[.](http[.]ssl[.])?enabled)[:=]"
    }
    # the security of Elasticsearch, as `KEY: value` lines or as `- KEY=value` lines
    function security_lines(indent, list,   key, val, i) {
      split("ELASTIC_PASSWORD xpack.security.enabled xpack.security.http.ssl.enabled", key, " ")
      val[1] = ENVIRON["NEW_PASSWORD"]; val[2] = "true"; val[3] = "false"
      for (i = 1; i <= 3; i++) print indent (list ? "- " key[i] "=" val[i] : key[i] ": " q val[i] q)
      added = 1
    }
    # the next key ends the Elasticsearch service
    in_es && /^[A-Za-z_]|^  [A-Za-z0-9_.-]+:/ { if (!added) { print "    environment:"; security_lines("      ", 0) } in_es = 0 }
    protect && /^  elasticsearch: *$/ { in_es = 1; print; next }
    in_es && pending { match($0, /^ */); security_lines(substr($0, 1, RLENGTH), $0 ~ /^ *- /); pending = 0 }
    in_es && /^    environment: *$/ { print; pending = 1; next }
    in_es && $0 ~ security { next }
    { print }
    END { if (in_es && !added) { print "    environment:"; security_lines("      ", 0) } }' "$OLD" > "$FILE" &&
    set_node_db && update_config_json elasticsearch
}

# docker-compose.yml for this release; 1 when the file cannot be changed
update_compose() {
  local choice type
  type=$(db_type)
  if [ "$type" == "postgresql" ]; then
    # set by a quickstart run, while the state is still in the SQLite files: copy only
    echo "    $FILE sets PostgreSQL already: the script copies the node state to it."
    START_DB=postgresql
    return 0
  fi
  if [ "$type" == "sqlite" ]; then
    OLD_DB=''
    read -r -p "The node uses SQLite. Database for the node: p) PostgreSQL e) Elasticsearch s) SQLite (keep it) [p/e/s]: " choice </dev/tty
  elif [ "$type" == "typesense" ] || [[ "$(value DB_URL)" == *typesense* ]]; then
    OLD_DB=typesense
    read -r -p "The node uses Typesense. Database for the node: p) PostgreSQL e) Elasticsearch s) SQLite [p/e/s]: " choice </dev/tty
  else
    OLD_DB=elasticsearch
    read -r -p "The node uses Elasticsearch. Database for the node: p) PostgreSQL e) Elasticsearch (keep it) s) SQLite [p/e/s]: " choice </dev/tty
  fi
  case "$choice" in
    p) NEW_DB=postgresql ;;
    e) [ "$OLD_DB" == "elasticsearch" ] && { keep_elasticsearch; return; }
       NEW_DB=elasticsearch ;;
    s) if [ -z "$OLD_DB" ]; then echo "    No change: the node keeps SQLite."; exit 0; fi
       NEW_DB=sqlite ;;
    *) echo "Cancelled"; return 1 ;;
  esac
  if { [ -n "$OLD_DB" ] && ! grep -q "^  $OLD_DB: *\$" "$FILE"; } || ! grep -q '^ *PRIVATE_KEY:' "$FILE"; then
    echo "Error: $FILE needs ${OLD_DB:+the service $OLD_DB and }a 'PRIVATE_KEY: <key>' line in the node environment."
    return 1
  fi
  if [ "$NEW_DB" == "sqlite" ]; then
    # the node reads the SQLite files of databases/ itself: no service, no connection
    DB_LINES="DB_TYPE: 'sqlite'" SERVICE=''
    replace_db && update_config_json sqlite
    return
  fi
  new_volume && database_parts && replace_db && update_config_json "$NEW_DB" &&
    START_DB=$NEW_DB
}

# a step: its number and what it does
step() {
  echo
  echo "==> [$1/6] $2"
}

# a command: shown before it runs
cmd() {
  echo "    \$ $*"
  "$@"
}

# the file before the change, and no container or volume of a database that was added
restore() {
  [ -n "$CHANGED" ] || return
  echo "==> Putting back $FILE and removing what the script added"
  if [ -n "$DB_DATA" ]; then
    echo "    \$ $DC rm -s -f $NEW_DB"
    $DC rm -s -f "$NEW_DB" >/dev/null 2>&1
    echo "    \$ docker volume rm $DB_DATA"
    docker volume rm "$DB_DATA" >/dev/null 2>&1
  fi
  cmd mv "$OLD" "$FILE"
  echo "    $FILE is as before the script."
  if [ -n "$CONFIG_CHANGED" ]; then
    # in place: a container that mounts the file sees it
    cmd cp config.json.old config.json && rm config.json.old
    echo "    config.json is as before the script."
  fi
}

# after a failure with the node stopped: the compose file and the node as before the script.
# The copy does not change the SQLite files.
revert() {
  echo
  echo "==> Failed: going back to the node as before the script"
  restore
  # the settings of Elasticsearch are as before again: it opens without a password
  if [ -n "$PROTECT_ES" ]; then
    cmd $DC up -d elasticsearch
  fi
  # --no-recreate: the stopped node container starts with its old image and settings; a new
  # container would run the new image with the old settings
  cmd $DC up -d --no-recreate
  echo "    The node runs as before the script, on the same state files."
  if [ -z "$NEW_DB" ]; then
    echo "    Rows that were copied stay in the database: the next run writes them again."
  fi
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
  # docker compose must read only the file that the script changes
  if [ -n "$COMPOSE_FILE$COMPOSE_ENV_FILES" ] || grep -qsE '^ *(export +)?COMPOSE_(FILE|ENV_FILES) *=' .env; then
    echo "Error: COMPOSE_FILE or COMPOSE_ENV_FILES is set (in the environment or in .env). The script changes only $FILE: remove it, then run the script again."
    exit 1
  fi
  for f in compose.yaml compose.yml compose.override.yaml compose.override.yml \
    docker-compose.override.yml docker-compose.override.yaml; do
    if [ -f "$f" ]; then
      echo "Error: docker compose reads $f, but the script changes only $FILE. Move the settings of $f into $FILE and remove $f, then run the script again."
      exit 1
    fi
  done

  step 1 "Updating $FILE for this release (the node still runs)"
  update_compose || { restore; exit 1; }
  if [ -n "$CHANGED" ]; then
    echo "    Changes (the old file is $OLD; the passwords are in the file):"
    show_diff "$OLD" "$FILE"
  else
    echo "    No change"
  fi

  step 2 "Checking the changed $FILE"
  if [ -z "$CHANGED" ]; then
    echo "    No change to check"
  elif cmd $DC config -q; then
    echo "    Done: the file is valid"
  else
    echo "Error: the changed $FILE is not valid."
    restore
    exit 1
  fi

  # read-only checks; the node still runs. --no-deps: a run must not recreate a database whose
  # settings changed (an Elasticsearch that gets security) while the node uses it
  step 3 "Checking the old state and the new database, read-only (the node still runs)"
  if [ -n "$START_DB" ]; then
    cmd $DC up -d "$START_DB" || { restore; exit 1; }
  fi
  cmd $DC run --rm --no-deps ocean-node $MIGRATE --check </dev/tty
  local code=$?
  if [ $code -ne 0 ]; then
    restore
    exit $code
  fi
  echo "    Done"

  step 4 "Stopping the node"
  cmd $DC stop ocean-node || { restore; exit 1; }
  echo "    Done: the node is stopped"
  # a failure from here (also Ctrl-C) brings back the node as before the script
  trap revert EXIT
  if [ -n "$PROTECT_ES" ]; then
    echo "    Elasticsearch starts again, with security and the new password:"
    cmd $DC up -d elasticsearch || exit 1
  fi

  step 5 "Backing up the state files and copying the state to the new database"
  cmd $DC run --rm --no-deps ocean-node $MIGRATE </dev/tty || exit 1
  echo "    Done"

  # the old files left databases/: a revert can no longer bring back the old node
  trap - EXIT
  # --remove-orphans: the container of the old database
  step 6 "Starting the node"
  if ! cmd $DC up -d ${NEW_DB:+--remove-orphans}; then
    echo "Error: the copy is done, but the node did not start. Find the cause in the output above, then run: $DC up -d"
    echo "    The old files are in databases/backup-<time> of the volume of the node."
    exit 1
  fi
  echo "    Done: see the node log with: $DC logs -f ocean-node"
  if [ -n "$NEW_DB" ] && [ -n "$OLD_DB" ]; then
    echo "    The volume of $OLD_DB stays. When you do not need it: docker volume ls, docker volume rm <name>"
  fi
}

main "$@"
