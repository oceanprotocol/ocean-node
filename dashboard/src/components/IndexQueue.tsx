import React, { useState, useEffect } from 'react'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Paper from '@mui/material/Paper'

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
    const intervalId = setInterval(fetchQueue, 2000) // Poll API every 2000 milliseconds (2 seconds)

    return () => {
      clearInterval(intervalId) // Clear interval on component unmount
    }
  }, [])

  return (
    <div>
      <h1>Indexing Queue</h1>
      <TableContainer component={Paper}>
        <Table aria-label="simple table">
          <TableHead>
            <TableRow>
              <TableCell>Transaction ID</TableCell>
              <TableCell align="right">Network</TableCell>
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
    </div>
  )
}
