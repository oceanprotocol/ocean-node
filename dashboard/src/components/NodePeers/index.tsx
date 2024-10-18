import React, { useEffect, useState } from 'react'
import styles from './style.module.css'
import Spinner from '../Spinner'
import Copy from '../Copy'
import { Button, Typography } from '@mui/material'

export default function NodePeers() {
  const [nodePeers, setNodePeers] = useState<string[]>([])
  const [isLoadingNodePeers, setLoadingNodePeers] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const fetchNodePeers = async () => {
    setLoadingNodePeers(true)
    try {
      const apiNodePeers = '/getOceanPeers'
      const res = await fetch(apiNodePeers, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'GET'
      })
      const data = await res.json()
      setNodePeers(data)
    } catch (error) {
      console.error('error', error)
    } finally {
      setLoadingNodePeers(false)
    }
  }

  useEffect(() => {
    fetchNodePeers()

    const intervalId = setInterval(() => {
      fetchNodePeers()
    }, 120000) // 2 minutes

    return () => clearInterval(intervalId)
  }, [])

  // Determine the nodes to display
  const displayedNodePeers = showAll ? nodePeers : nodePeers.slice(0, 10)

  return (
    <div className={styles.nodes}>
      <div className={styles.title24}>Connected Nodes (Total {nodePeers.length})</div>

      {isLoadingNodePeers ? (
        <div className={styles.loaderContainer}>
          <Spinner />
        </div>
      ) : (
        <>
          {nodePeers.length > 0 ? (
            displayedNodePeers.map((address) => (
              <div className={styles.nodeAddress} key={address}>
                {address} <Copy text={address} />
              </div>
            ))
          ) : (
            <Typography variant="body1">There are no nodes connected</Typography>
          )}

          {!showAll && nodePeers.length > 10 && (
            <Button onClick={() => setShowAll(true)} variant="text" color="primary">
              Show All
            </Button>
          )}
          {showAll && nodePeers.length > 10 && (
            <Button onClick={() => setShowAll(false)} variant="text" color="primary">
              Show Less
            </Button>
          )}
        </>
      )}
    </div>
  )
}
