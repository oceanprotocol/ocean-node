import React, { useEffect, useState } from 'react'
import cs from 'classnames'
import styles from './index.module.css'
import { truncateString } from '../../shared/utils/truncateString'
import { useAdminContext } from '@/context/AdminProvider'
import AdminActions from '../Admin'
import Spinner from '../Spinner'
import NodePeers from '../NodePeers'
import Copy from '../Copy'
import IndexQueue from '../IndexQueue'

type IndexerType = {
  block: string
  chainId: string
  network: string
  delayed?: boolean
}

type ProviderType = {
  chainId: string
  network: string
}

type SupportedStorageType = {
  arwave: boolean
  ipfs: boolean
  url: boolean
}

type PlatformType = {
  arch: string
  cpus: number
  freemem: number
  loadavg: number[]
  machine: string
  node: string
  osType: string
  osVersion: string
  platform: string
  release: string
  totalmem: number
}

type NodeDataType = {
  address: string
  id: string
  publicKey: string
  uptime: string
  version: string
  http: boolean
  p2p: boolean
  indexer: IndexerType[]
  platform: PlatformType
  provider: ProviderType[]
  supportedStorage: SupportedStorageType
}

export default function Dashboard() {
  const [data, setData] = useState<NodeDataType>()
  const [isLoading, setLoading] = useState(true)
  const { setAllAdmins, allAdmins } = useAdminContext()

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
          setLoading(false)
        })
    } catch (error) {
      console.log('error', error)
    }
  }, [])

  const nodeData = [
    {
      id: data?.id,
      dns: 'ns-380.awsdns-47.com',
      ip: '192.0.2.44',
      indexerData: data?.indexer
    }
  ]

  const [node, setNode] = useState(nodeData[0])

  const arrayOfPlatformObjects: { key: string; value: string | number }[] = []

  data &&
    Object.keys(data?.platform).forEach((key) => {
      const obj = {
        key,
        // @ts-expect-error - error is shown here because the key is used as an index.
        value: data?.platform[key]
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
                    <div className={styles.node}>
                      <div
                        key={node.id}
                        className={styles.nodeAddress}
                        onClick={() => setNode(node)}
                      >
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
                  <h5 className={styles.title24}>DNS : </h5>
                  <div className={styles.nodeAddress}>{node.dns}</div>
                </div>
                <div className={styles.nodeAddress}>
                  <h5 className={styles.title24}>IP : </h5>
                  <div className={styles.nodeAddress}>{node.ip}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const Indexer = () => {
    return (
      <div className={cs([styles.indexer, styles.borderBottom])}>
        <div className={styles.title29}>INDEXER</div>
        <div className={styles.rowIndexer}>
          {data?.indexer.map((item) => {
            return (
              <div
                className={cs([styles.indexBlock, item.delayed && styles.delayed])}
                key={item.block}
              >
                <h5>{item.network}</h5>
                <div>ChainID: {item.chainId}</div>
                <div>BLOCK: {item.block}</div>
              </div>
            )
          })}
        </div>
        <IndexQueue />
      </div>
    )
  }

  const AdminAccounts = () => {
    return (
      <div className={styles.indexer}>
        <div className={styles.title29}>Admin Accounts</div>
        <div className={styles.provider}>
          {allAdmins.map((admin, i) => {
            return (
              <div className={styles.providerRow} key={i}>
                {admin}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const ObjectModule = ({
    title,
    data
  }: {
    title: string
    data: { key: string; value: string | number }[]
  }) => {
    return (
      <div className={styles.indexer}>
        <div className={styles.title29}>{title}</div>
        <div className={styles.provider}>
          {data.map((item) => {
            return (
              <div className={styles.providerRow} key={item.value}>
                <div className={styles.providerTitle}>
                  <b>{item.key}:</b>
                </div>
                <div>{item.value} </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const SupportedStorage = () => {
    return (
      <div className={styles.indexer}>
        <div className={styles.title29}>SUPPORTED STORAGE</div>
        <div className={styles.provider}>
          <div className={styles.providerRow}>
            <div className={styles.providerTitle}>
              <b>arwave:</b>
            </div>
            <div>{data?.supportedStorage.arwave.toString()} </div>
          </div>
          <div className={styles.providerRow}>
            <div className={styles.providerTitle}>
              <b>ipfs:</b>
            </div>
            <div>{data?.supportedStorage.ipfs.toString()} </div>
          </div>
          <div className={styles.providerRow}>
            <div className={styles.providerTitle}>
              <b>url:</b>
            </div>
            <div>{data?.supportedStorage.url.toString()} </div>
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
            <Indexer />
            <ObjectModule title="PLATFORM" data={arrayOfPlatformObjects} />
            <SupportedStorage />
            <AdminAccounts />
          </div>
        )}
      </div>
    </div>
  )
}
