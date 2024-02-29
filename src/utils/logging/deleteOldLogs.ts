export async function deleteOldLogs() {
  const currentTime = new Date().getTime()
  const xTime = parseInt(process.env.LOG_RETENTION_TIME || '2592000000') // Default to 30 days
  const deleteBeforeTime = currentTime - xTime

  try {
    // Assuming your log entries have a `timestamp` field in milliseconds
    const deleteResult = await this.provider
      .collections(this.schema.name)
      .documents()
      .delete({
        filter_by: `timestamp:<${deleteBeforeTime}`
      })
    console.log(`Deleted logs: ${deleteResult}`)
  } catch (error) {
    console.error(`Error when deleting old log entries: ${error.message}`)
  }
}
