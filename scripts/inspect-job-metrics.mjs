// Prints whether runtimeMetrics is actually stored on the C2D job rows.
//
// Answers one question: is the snapshot missing from a status response because it was never
// persisted (DB row has no runtimeMetrics), or because it was stripped on the way out (row has
// it, response does not)?
//
//   node scripts/inspect-job-metrics.mjs                 # 5 most recent jobs
//   node scripts/inspect-job-metrics.mjs <jobId>          # one job (full or trailing part)
//   DB=path/to/c2dDatabase.sqlite node scripts/inspect-job-metrics.mjs
//
// Read-only. Run it from the node's working directory (the DB defaults to
// ./databases/c2dDatabase.sqlite, the path the node itself uses).
import { DatabaseSync } from 'node:sqlite'

const dbPath = process.env.DB ?? 'databases/c2dDatabase.sqlite'
const jobFilter = process.argv[2]

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare(
    jobFilter
      ? `SELECT jobId, status, statusText, body FROM c2djobs WHERE jobId LIKE ?
         ORDER BY dateCreated DESC`
      : `SELECT jobId, status, statusText, body FROM c2djobs
         ORDER BY dateCreated DESC LIMIT 5`
  )
  .all(...(jobFilter ? [`%${jobFilter}%`] : []))

if (rows.length === 0) {
  console.log(`no matching jobs in ${dbPath}`)
  process.exit(0)
}

for (const row of rows) {
  const body = JSON.parse(Buffer.from(row.body).toString())
  const metrics = body.runtimeMetrics
  console.log(`\njob ${row.jobId}  [status ${row.status}: ${row.statusText?.trim()}]`)
  if (!metrics) {
    console.log('  runtimeMetrics: ABSENT — never persisted for this job.')
    console.log(
      '  → the running node is not writing it into the c2djobs body blob (older build?),'
    )
    console.log(
      '    so cpu usagePercent stays 0 and the owner status response cannot include it.'
    )
    continue
  }
  console.log(`  runtimeMetrics: present, collected at ${metrics.collectedAt}`)
  console.log(
    `    cpu ${metrics.cpu?.usagePercent}% of host, ${metrics.cpu?.cumulativeSeconds}s used, ` +
      `throttled ${metrics.cpu?.throttledPeriods} periods`
  )
  console.log(
    `    mem ${metrics.memory?.usageBytes} / ${metrics.memory?.limitBytes} bytes ` +
      `(peak ${metrics.memory?.peakUsageBytes})`
  )
  console.log(`    disk ${metrics.disk?.usedBytes} / ${metrics.disk?.quotaBytes ?? '-'} bytes`)
  console.log(`    gpu entries: ${metrics.gpu?.length ?? 0}`)
  console.log(
    `    delta accumulator (needed for cpu %): ${
      metrics.prev ? `present (cpuTotal ${metrics.prev.cpuTotal})` : 'MISSING'
    }`
  )
  console.log(
    '  → the row HAS metrics. If the status response omits them, the caller is not being ' +
      'recognised as the owner (checksum/casing, token address) — not a persistence problem.'
  )
}
db.close()
