import React, { useState } from 'react'
import {
  TextField,
  Button,
  Alert,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions
} from '@mui/material'
import { useAdminContext } from '@context/AdminProvider'
import styles from './index.module.css'

export default function TransferFees() {
  const [showChainInput, setShowTransferInput] = useState(false)
  const [isLoading, setLoading] = useState(false)
  const [chainId, setChainId] = useState<string>('')
  const [tokenAddress, setTokenAddress] = useState<string>('')
  const [tokenAmount, setTokenAmount] = useState<string>('')
  const [destinationAddress, setDestinationAddress] = useState<string>('')
  const { signature, expiryTimestamp } = useAdminContext()
  const [error, setError] = useState<string | null>(null)
  const [snackbarOpen, setSnackbarOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [responseMessage, setResponseMessage] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

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
        if (jobData?.tx && jobData?.message) {
          setTxHash(jobData.tx)
          setResponseMessage(jobData.message)
          setDialogOpen(true)
          setSnackbarOpen(true)
          setShowTransferInput(false)
        }
      } else {
        setError(
          response.statusText
            ? response.statusText
            : 'Error transferring fees. Please try again.'
        )
      }
    } catch (error) {
      console.error('error', error)
      setError('Error transferring fees. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleDialogClose = () => {
    setDialogOpen(false)
  }

  return (
    <div className={styles.column}>
      <Button variant="text" onClick={() => setShowTransferInput(!showChainInput)}>
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
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={() => setSnackbarOpen(false)}
        message="Fees successfully transferred!"
      />
      <Dialog
        open={dialogOpen}
        onClose={handleDialogClose}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">{'Transfer Successful'}</DialogTitle>
        <DialogContent>
          <DialogContentText id="alert-dialog-description">
            {responseMessage && (
              <span>
                {responseMessage} <br />
                <strong style={{ marginTop: '10px', display: 'block' }}>
                  Transaction Hash:
                </strong>{' '}
                {txHash}
              </span>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDialogClose} autoFocus>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  )
}
