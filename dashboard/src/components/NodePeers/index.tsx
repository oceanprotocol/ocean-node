import React, { useEffect, useState } from 'react'

import styles from './style.module.css'
import Spinner from '../Spinner'
import { truncateString } from '../../shared/utils/truncateString'
import Copy from '../Copy'

export default function NodePeers() {
  const [nodePeers, setNodePeers] = useState([''])
  const [isLoadingNodePeers, setLoadingNodePeers] = useState(true)

  useEffect(() => {
    setLoadingNodePeers(true)
    try {
      const apiNodePeers = '/getOceanPeers'
      fetch(apiNodePeers, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'GET'
      })
        .then((res) => res.json())
        .then((data) => {
          setNodePeers(data)
          setLoadingNodePeers(false)
        })
    } catch (error) {
      console.log('error', error)
    }
  }, [])

  return (
    <div className={styles.nodes}>
      <div className={styles.title24}>Node Peers</div>
      {isLoadingNodePeers && (
        <div className={styles.loaderContainer}>
          <Spinner />
        </div>
      )}

      {nodePeers.length > 0 ? (
        nodePeers.map((address) => {
          return (
            <div className={styles.nodeAddress}>
              {truncateString(address, 12)} <Copy text={address} />
            </div>
          )
        })
      ) : (
        <div>There are no nodes connected</div>
      )}
    </div>
  )
}
