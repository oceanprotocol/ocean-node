import { useState, useEffect } from 'react'

interface QueueItem {
  txId: string
  chainId: string
}

const rpcs = JSON.parse(process.env.RPCS || '{}')

export default function IndexQueueComponent() {
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
