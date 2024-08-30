# Logs

Refer to Logs section in the [environmental variables documentation](env.md#logs) for information on how to configure the logs.

## Log Retrieval using HTTP

### Get Multiple Logs

HTTP GET /logs

This endpoint retrieves multiple log entries based on various query parameters. If query parameters are not provided, it defaults to the last 24 hours of logs and a maximum of 100 log entries. Please replace the `startTime`, `endTime` values with actual data as per your requirement when making requests.

**Query Parameters:**

- `startTime` (optional): The start time for logs retrieval in ISO 8601 format.
- `endTime` (optional): The end time for logs retrieval in ISO 8601 format.
- `maxLogs` (optional): The maximum number of log entries to retrieve.
- `moduleName` (optional): The module name to filter the logs.
- `level` (optional): The log level to filter the logs (e.g., "info", "error").

**Example Request:**

```http
GET /logs?startTime=2023-01-01T00:00:00Z&endTime=2023-01-02T00:00:00Z&maxLogs=50&moduleName=auth&level=info

```

**Example Response:**

```json
[
  {
    "timestamp": 1700569124922,
    "level": "info",
    "message": "User logged in successfully.",
    "moduleName": "HTTP"
  },
  {
    "timestamp": 1700569124922,
    "level": "info",
    "message": "Session refreshed.",
    "moduleName": "HTTP"
  }
  // More log entries...
]
```

If no logs are found for the given criteria, you will receive a `404 Not Found` response.

### Get a Single Log by ID

HTTP GET /log/:id

This endpoint retrieves a single log entry by its unique identifier.

**Path Parameters:**

- `id`: The unique identifier of the log entry.

Example Request:

```http
GET /log/123456789
```

```json
{
  "id": "1",
  "level": "info",
  "message": "NEW Test log message 1700569124912",
  "timestamp": 1700569124922,
  "moduleName": "HTTP"
}
```

If the log with the given ID is not found, you will receive a `404 Not Found` response. For server errors, you will receive a `500 Internal Server Error` response.

## Log Retrieval Using Script

The logging system provides a convenient way to retrieve logs via a command-line script. The script is capable of fetching logs with various filters, such as start time, end time, maximum number of logs, module name, and log level.

**Usage**
You can call the script directly from your command line with optional parameters to filter the logs. The parameters are as follows:

- `API_URL`: The URL of the logs API endpoint. Defaults to http://localhost:8000.
- `START_TIME`: The start time for the logs you want to retrieve. Defaults to 24 hours before the current time.
- `END_TIME`: The end time for the logs you want to retrieve. Defaults to the current time.
- `MAX_LOGS`: The maximum number of logs to retrieve. Defaults to 100.
- `MODULE_NAME`: The specific module name to filter the logs. Optional.
- `LEVEL`: The specific log level to filter the logs. Optional.

**Example Without Parameters (Uses Defaults):**

```bash
npm run logs
```

**Example With Specific Parameters:**

```
npm run logs http://localhost:8000 "2023-11-01T00:00:00Z" "2023-11-30T23:59:59Z" 50 "http" "info"
```
