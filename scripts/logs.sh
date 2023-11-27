#!/bin/bash

# Default parameters
API_URL=${1:-"http://localhost:8000"}
START_TIME=$(date -u -d '-24 hour' +"%Y-%m-%dT%H:%M:%SZ") # for Linux
# START_TIME=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ") # for macOS
END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ") # current time
MAX_LOGS=100
MODULE_NAME=""
LEVEL=""

# Check if specific parameters are provided and override the defaults
if [ ! -z "$2" ]; then
  START_TIME=$2
fi

if [ ! -z "$3" ]; then
  END_TIME=$3
fi

if [ ! -z "$4" ]; then
  MAX_LOGS=$4
fi

if [ ! -z "$5" ]; then
  MODULE_NAME=$5
fi

if [ ! -z "$6" ]; then
  LEVEL=$6
fi

# Prepare the data for the GET request
DATA=(
  --data-urlencode "startTime=$START_TIME"
  --data-urlencode "endTime=$END_TIME"
  --data-urlencode "maxLogs=$MAX_LOGS"
)

# Include moduleName and level in the request if they are provided
if [ ! -z "$MODULE_NAME" ]; then
  DATA+=(--data-urlencode "moduleName=$MODULE_NAME")
fi

if [ ! -z "$LEVEL" ]; then
  DATA+=(--data-urlencode "level=$LEVEL")
fi

# Make API call to retrieve logs
curl -G "$API_URL/logs" \
     -H "Content-Type: application/json" \
     "${DATA[@]}" | jq
