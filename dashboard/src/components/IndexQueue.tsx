import React, { useState, useEffect } from 'react'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import styles from './Dashboard/index.module.css'
import {
  ENVIRONMENT_VARIABLES,
  existsEnvironmentVariable
} from '../../../src/utils/index.js'

interface QueueItem {
  txId: string
  chainId: string
}

const rpcs = JSON.parse(process.env.RPCS || '{}')

export default function IndexQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([])

  useEffect(() => {
    const fetchQueue = () => {
      fetch('/api/services/indexQueue')
        .then((response) => response.json())
        .then((data) => {
          const transformedQueue = data.queue.map((item: any) => ({
            txId: item.txId,
            chainId: rpcs[item.chainId]?.network || item.chainId
          }))
          setQueue(transformedQueue)
        })
        .catch((error) => {
          console.error('Error fetching queue:', error)
        })
    }

    fetchQueue() // Initial fetch
    let pollingInterval = 2000 // Default polling interval
    if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.INDEXER_INTERVAL)) {
      pollingInterval = Number(process.env.INDEXER_INTERVAL)
    }
    const intervalId = setInterval(fetchQueue, pollingInterval)

    return () => {
      clearInterval(intervalId) // Clear interval on component unmount
    }
  }, [])

  return (
    <div>
      <div className={styles.title24}>Indexing Queue</div>
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
                  <TableCell align="right">{item.chainId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <p>Indexing queue is empty.</p>
      )}
    </div>
  )
}
