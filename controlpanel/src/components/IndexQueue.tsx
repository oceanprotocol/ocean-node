import { useState, useEffect } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow
} from '@mui/material'
import styles from './ControlPanel/index.module.css'
import { useAdminContext } from '@/context/AdminProvider'
import Alert from '@mui/material/Alert'

interface QueueItem {
  txId: string
  chainId: number
  chain: string
}

export default function IndexQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const { networks } = useAdminContext()
  const [avoidAskQueue, setAvoidAskQueue] = useState<boolean>(false)

  let intervalId: any = null
  useEffect(() => {
    const fetchQueue = () => {
      fetch('/api/services/indexQueue')
        .then((response) => {
          if (response.status === 400) {
            console.warn('Cannot fetch queue: Node is not running Indexer')
            setAvoidAskQueue(true)
            if (intervalId) {
              clearInterval(intervalId) // Stop doing this, there is no point, since we don't have Indexer
            }
          } else {
            response.json().then((data) => {
              const transformedQueue = data.queue.map((item: any) => {
                const network = networks.find((net) => net.chainId === item.chainId)
                return {
                  txId: item.txId,
                  chainId: item.chainId,
                  chain: network ? network.network : 'Unknown Network'
                }
              })
              setQueue(transformedQueue)
            })
          }
        })
        .catch((error) => {
          console.error('Error fetching queue:', error)
        })
    }

    fetchQueue() // Initial fetch
    let pollingInterval = 10000 // Default polling interval (10 seconds)
    if (process.env.INDEXER_INTERVAL) {
      pollingInterval = Number(process.env.INDEXER_INTERVAL)
    }
    intervalId = setInterval(fetchQueue, pollingInterval)

    return () => {
      if (intervalId) {
        clearInterval(intervalId) // Clear interval on component unmount
      }
    }
  }, [])

  return (
    <div>
      <div
        className={styles.title24}
        style={{ paddingTop: '55px', paddingBottom: '55px' }}
      >
        Indexing Queue
      </div>
      {queue.length > 0 ? (
        <TableContainer>
          <Table aria-label="simple table">
            <TableHead>
              <TableRow>
                <TableCell>
                  <b>Transaction ID</b>
                </TableCell>
                <TableCell align="right">
                  <b>Network</b>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {queue.map((item, index) => (
                <TableRow key={index}>
                  <TableCell component="th" scope="row">
                    {item.txId}
                  </TableCell>
                  <TableCell align="right">{item.chain}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <p>Indexing queue is empty.</p>
      )}
      {avoidAskQueue && (
        <Alert
          className={styles.indexerQueueAlert}
          severity="warning"
          onClose={() => {
            setAvoidAskQueue(false)
          }}
        >
          Node is not running Indexer. No need to get queue at this point!
        </Alert>
      )}
    </div>
  )
}
