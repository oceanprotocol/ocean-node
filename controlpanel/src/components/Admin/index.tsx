import styles from './index.module.css'
import DownloadLogs from './DownloadLogs'
import StopNode from './StopNode'
import { useAdminContext } from '@/context/AdminProvider'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Stack from '@mui/material/Stack'
import ReIndexChain from './ReindexChain'
import ReIndexTransaction from './ReindexTransaction'
import TransferFees from './TransferFees'

export default function AdminActions() {
  const { generateSignature, signature, validTimestamp, admin } = useAdminContext()
  const { isConnected } = useAccount()

  return (
    <div className={styles.root}>
      <div className={styles.title}>ADMIN ACTIONS</div>
      {!isConnected && <ConnectButton />}
      {isConnected && !admin && (
        <div className={styles.unauthorised}>Your account does not have admin access</div>
      )}

      {(!signature || !validTimestamp) && isConnected && admin && (
        <button type="button" className={styles.unlockButton} onClick={generateSignature}>
          Unlock
        </button>
      )}
      {isConnected && signature && validTimestamp && isConnected && admin && (
        <Stack spacing={2} direction="column">
          <DownloadLogs />
          <ReIndexChain />
          <ReIndexTransaction />
          <TransferFees />
          <StopNode />
        </Stack>
      )}
    </div>
  )
}
