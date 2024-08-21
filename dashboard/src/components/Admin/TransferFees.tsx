import React, { useState } from 'react'
import { TextField, Button, Alert, Snackbar } from '@mui/material'
import { useAdminContext } from '@context/AdminProvider'
import { CommandStatus, JobStatus } from '@/shared/types/JobTypes'
import { checkJobPool, getSeverityFromStatus, isJobDone } from '@/shared/utils/jobs'
import JobStatusPanel from '../JobStatusPanel'
import styles from './index.module.css'

export default function TransferFees() {
  const [showChainInput, setShowChainInput] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [chainId, setChainId] = useState<string>('')
  const [tokenAddress, setTokenAddress] = useState<string>('')
  const [tokenAmount, setTokenAmount] = useState<string>('')
  const [destinationAddress, setDestinationAddress] = useState<string>('')
  const { signature, expiryTimestamp } = useAdminContext()
  const [severity, setSeverity] = useState<any>('info')
  const [job, setJob] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snackbarOpen, setSnackbarOpen] = useState(false)

  let intervalId: any = null

  const validateInputs = () => {
    if (!chainId || !tokenAddress || !tokenAmount || !destinationAddress) {
      setError('All fields are required.')
      return false
    }
    if (isNaN(Number(tokenAmount))) {
      setError('Token amount must be a number.')
      return false
    }
    setError(null)
    return true
  }

  async function transferFees() {
    if (!validateInputs()) return

    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          command: 'collectFees',
          chainId,
          tokenAddress,
          tokenAmount,
          destinationAddress,
          expiryTimestamp,
          signature
        })
      })

      if (response.status === 200) {
        const jobData = await response.json()
        setSeverity(jobData.status === CommandStatus.DELIVERED ? 'info' : 'error')
        setJob(jobData)
        setSnackbarOpen(true)

        let done = false
        intervalId = setInterval(async () => {
          const statusJob = await checkJobPool(jobData.jobId)
          if (statusJob.length === 1) {
            const job = statusJob[0]
            setSeverity(getSeverityFromStatus(job.status))
            done = isJobDone(job.status)
            setJob(job)
          } else {
            setJob(null)
          }
        }, 3000)
        if (done && intervalId) {
          clearInterval(intervalId)
        }
        setShowChainInput(false)
      } else {
        setError('Error transferring fees. Please try again.')
      }
    } catch (error) {
      console.error('error', error)
      setError('Error transferring fees. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.column}>
      <Button variant="text" onClick={() => setShowChainInput(!showChainInput)}>
        Transfer Fees
      </Button>

      {showChainInput && (
        <div className={styles.filters}>
          <TextField
            label="Chain ID"
            value={chainId}
            onChange={(e) => setChainId(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
            type="number"
          />
          <TextField
            label="Token Address"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          <TextField
            label="Token Amount"
            value={tokenAmount}
            onChange={(e) => setTokenAmount(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
            type="number"
          />
          <TextField
            label="Destination Address"
            value={destinationAddress}
            onChange={(e) => setDestinationAddress(e.target.value)}
            fullWidth
            margin="normal"
            variant="outlined"
          />
          {error && <Alert severity="error">{error}</Alert>}
          <Button
            type="button"
            onClick={transferFees}
            variant="outlined"
            disabled={isLoading}
            fullWidth
          >
            Transfer Fees
          </Button>
        </div>
      )}
      <JobStatusPanel job={job} severity={severity} />
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={() => setSnackbarOpen(false)}
        message="Fees successfully transferred!"
      />
    </div>
  )
}
