import React, { useEffect, useState } from 'react'
import cs from 'classnames'
import styles from './index.module.css'
import { truncateString } from '../../shared/utils/truncateString'
import { useAdminContext } from '@/context/AdminProvider'
import AdminActions from '../Admin'
import Spinner from '../Spinner'
import NodePeers from '../NodePeers'
import Copy from '../Copy'
import { NodeDataType } from '@Types/dataTypes'
import SupportedStorage from './SupportedStorage'
import SupportedNetworks from './SupportedNetworks'
import Indexer from './Indexer'
import AdminAccounts from './AdminAccounts'
import NodePlatform from './NodePlatform'

export default function Dashboard() {
  const [data, setData] = useState<NodeDataType>()
  const [isLoading, setLoading] = useState(true)
  const [ipAddress, setIpAddress] = useState('')
  const { setAllAdmins, setNetworks } = useAdminContext()

  useEffect(() => {
    setLoading(true)
    try {
      const apiUrl = '/directCommand'
      fetch(apiUrl, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          command: 'status'
        })
      })
        .then((res) => res.json())
        .then((data) => {
          setData(data)
          setAllAdmins(data.allowedAdmins)
          setNetworks(data.indexer)
          setLoading(false)
        })
    } catch (error) {
      setLoading(false)
      console.error('error', error)
    }
  }, [])

  useEffect(() => {
    // Fetch the IP address
    fetch('https://api.ipify.org?format=json')
      .then((res) => res.json())
      .then((data) => {
        setIpAddress(data.ip)
      })
      .catch((error) => {
        console.error('Failed to fetch IP address:', error)
      })
  }, [])

  const nodeData = [
    {
      id: data?.id,
      ip: ipAddress,
      indexerData: data?.indexer
    }
  ]

  const arrayOfPlatformObjects: { key: string; value: string | number }[] = []

  data &&
    Object.keys(data?.platform).forEach((key) => {
      const obj = {
        key,
        // @ts-expect-error - error is shown here because the key is used as an index.
        value: JSON.stringify(data?.platform[key])
      }

      arrayOfPlatformObjects.push(obj)
    })

  const ConnectionDetails = () => {
    return (
      <div>
        <div className={styles.title29}>NETWORK</div>
        <div className={styles.details}>
          <div className={styles.details}>
            <div className={styles.columnP2P}>
              <div className={cs([styles.title24, styles.borderBottom])}>
                P2P - {data?.p2p ? 'UP' : 'DOWN'}
              </div>
              <div className={styles.nodes}>
                <div className={styles.title24}>NODE ID</div>
                {nodeData.map((node) => {
                  return (
                    <div className={styles.node} key={node.id}>
                      <div className={styles.nodeAddress}>
                        <div className={styles.node}>{truncateString(node.id, 12)}</div>
                      </div>
                      <Copy text={node?.id as string} />
                    </div>
                  )
                })}
              </div>
              <div className={styles.nodes}>
                <div className={styles.title24}>Address</div>
                <div className={styles.node}>
                  {truncateString(data?.address, 12)}
                  <Copy text={data?.address as string} />
                </div>
              </div>
              <NodePeers />
            </div>
            <div className={styles.columnHTTP}>
              <div className={cs([styles.title24, styles.borderBottom])}>
                HTTP - {data?.http ? 'UP' : 'DOWN'}
              </div>
              <div className={styles.nodes}>
                <div className={styles.nodeAddress}>
                  <h5 className={styles.title24}>IP : </h5>
                  <div className={styles.nodeAddress}>{ipAddress}</div>
                  <Copy text={ipAddress as string} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <AdminActions />

      <div className={styles.bodyContainer}>
        {isLoading ? (
          <div className={styles.loaderContainer}>
            <Spinner />
          </div>
        ) : (
          <div className={styles.body}>
            <ConnectionDetails />
            <Indexer data={data} />
            <SupportedNetworks data={data} />
            <SupportedStorage data={data} />
            <AdminAccounts />
            <NodePlatform platformData={arrayOfPlatformObjects} />
          </div>
        )}
      </div>
    </div>
  )
}
