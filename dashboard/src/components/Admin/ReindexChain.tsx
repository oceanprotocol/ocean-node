import React, { useState } from 'react'
import styles from './index.module.css'
import { useAdminContext } from '@context/AdminProvider'
import Button from '@mui/material/Button'
import NetworkSelector from '../shared/NetworkSelector'
import { CommandStatus, JobStatus } from '@/shared/types/JobTypes'
import { checkJobPool, getSeverityFromStatus, isJobDone } from '@/shared/utils/jobs'
import JobStatusPanel from '../JobStatusPanel'
import { clearInterval } from 'timers'

export default function ReIndexChain() {
  const [showChainInput, setShowChainInput] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [chainId, setChainId] = useState<string>()
  const { signature, expiryTimestamp } = useAdminContext()
  const [severity, setSeverity] = useState<any>('info')
  const [job, setJob] = useState<JobStatus | null>(null)

  let intervalId: any = null

  async function reIndex() {
    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      if (expiryTimestamp && signature && chainId) {
        const response = await fetch(apiUrl, {
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          method: 'POST',
          body: JSON.stringify({
            command: 'reindexChain',
            chainId,
            expiryTimestamp,
            signature
          })
        })
        if (response.status === 200) {
          const jobData = await response.json()
          setSeverity(jobData.status === CommandStatus.DELIVERED ? 'info' : 'error')
          setJob(jobData)
          alert(`Chain with ID ${chainId} is now being reindexed.`)
          let done = false
          intervalId = setInterval(async () => {
            // its an array of jobs or empty array
            const statusJob = await checkJobPool(jobData.jobId)
            if (statusJob.length === 1) {
              const job = statusJob[0]
              setSeverity(getSeverityFromStatus(job.status))
              done = isJobDone(job.status)
              setJob(job)
            } else {
              // clear the Job status panel
              setJob(null)
            }
          }, 3000)
          if (done && intervalId) {
            clearInterval(intervalId)
          }
          setShowChainInput(false)
        } else {
          alert('Error reindexing chain. Please try again.')
        }
      }
    } catch (error) {
      console.error('error', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.column}>
      <Button type="button" onClick={() => setShowChainInput(!showChainInput)}>
        ReIndex Chain
      </Button>

      {showChainInput && (
        <div className={styles.filters}>
          <NetworkSelector chainId={chainId} setChainId={setChainId} />

          <Button type="button" onClick={reIndex} variant="outlined" disabled={isLoading}>
            ReIndex Chain
          </Button>
        </div>
      )}
      <JobStatusPanel job={job} severity={severity} />
    </div>
  )
}
