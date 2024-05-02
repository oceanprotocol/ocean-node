import React, { useState, useEffect } from 'react'

interface QueueItem {
  txId: string
  chainId: string
}

// Assuming RPCS is available in environment and properly formatted as JSON
const rpcs = JSON.parse(process.env.RPCS || '{}')

const IndexQueueComponent: React.FC = () => {
  const [queue, setQueue] = useState<QueueItem[]>([])

  useEffect(() => {
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
  }, [])

  return (
    <div>
      <h1>Indexing Queue</h1>
      <ul>
        {queue.map((item, index) => (
          <li key={index}>
            Transaction ID: {item.txId} - Network: {item.chainId}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default IndexQueueComponent
