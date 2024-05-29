import React, { useEffect, useState } from 'react'
import styles from './style.module.css'
import Spinner from '../Spinner'
import { truncateString } from '../../shared/utils/truncateString'
import Copy from '../Copy'

export default function NodePeers() {
  const [nodePeers, setNodePeers] = useState<string[]>([])
  const [isLoadingNodePeers, setLoadingNodePeers] = useState(true)

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

  return (
    <div className={styles.nodes}>
      <div className={styles.title24}>Connected Nodes</div>
      {isLoadingNodePeers && (
        <div className={styles.loaderContainer}>
          <Spinner />
        </div>
      )}

      {nodePeers.length > 0 ? (
        nodePeers.map((address) => (
          <div className={styles.nodeAddress} key={address}>
            {truncateString(address, 12)} <Copy text={address} />
          </div>
        ))
      ) : (
        <div>There are no nodes connected</div>
      )}
    </div>
  )
}
