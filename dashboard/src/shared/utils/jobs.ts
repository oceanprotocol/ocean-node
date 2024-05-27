import { CommandStatus, JobStatus } from '../types/JobTypes'

export const checkJobPool = async function (jobId?: string): Promise<JobStatus[]> {
  const id = jobId || ''

  try {
    const jobsPool = '/api/services/jobs/' + id
    const res = await fetch(jobsPool, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      method: 'GET'
    })
    const data = await res.json()
    return data.jobs
  } catch (err) {
    console.error(err)
  }

  return []
}

export function getSeverityFromStatus(status: CommandStatus): string {
  switch (status) {
    case CommandStatus.DELIVERED:
      return 'info'
    case CommandStatus.SUCCESS:
      return 'success'
    case CommandStatus.PENDING:
      return 'warning'
    default:
      return 'error'
  }
}

export function isJobDone(jobStatus: CommandStatus): boolean {
  return [CommandStatus.SUCCESS, CommandStatus.FAILURE].includes(jobStatus)
}
