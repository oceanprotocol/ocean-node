import { JobStatus } from '@/shared/types/JobTypes'
import Alert from '@mui/material/Alert'

export interface JobStatusProps {
  severity: any
  job: JobStatus
}

export default function JobStatusPanel(props: any) {
  return (
    <div>
      {props.job !== null && (
        <Alert variant="filled" severity={props.severity}>
          Job with id <strong>{props.job.jobId}</strong> has status{' '}
          <strong>{props.job.status}</strong>
        </Alert>
      )}
    </div>
  )
}
