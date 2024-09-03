import { getStatusColors } from '@/shared/utils/jobs'
import Alert from '@mui/material/Alert'

export default function JobStatusPanel(props: any) {
  const color: string = props.job ? getStatusColors(props.job.status) : 'black'
  return (
    <div>
      {props.job !== null && (
        <Alert
          sx={{ bgcolor: color }}
          variant="filled"
          severity={props.severity}
          onClose={() => {}}
        >
          Job with id <strong>{props.job.jobId}</strong> has status{' '}
          <strong>{props.job.status}</strong>
        </Alert>
      )}
    </div>
  )
}
