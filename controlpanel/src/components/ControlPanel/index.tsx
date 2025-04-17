import { useEffect, useState } from 'react'
import styles from './index.module.css'
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
import { Box, Typography, Divider } from '@mui/material'

export default function ControlPanel() {
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
      <Box p={2}>
        <Typography variant="h5" gutterBottom>
          NETWORK
        </Typography>
        <Divider />

        <Box mt={2} mb={2}>
          <Typography variant="h6">HTTP Status</Typography>
          <Typography variant="body1">HTTP - {data?.http ? 'UP' : 'DOWN'}</Typography>
        </Box>
        <Divider />

        <Box mt={2} mb={2}>
          <Typography variant="h6">P2P Status</Typography>
          <Typography variant="body1">P2P - {data?.p2p ? 'UP' : 'DOWN'}</Typography>
        </Box>
        <Divider />

        <Box mt={2} mb={2}>
          <Typography variant="h6">NODE ID</Typography>
          {nodeData.map((node) => (
            <Box key={node.id} display="flex" alignItems="center" mb={1}>
              <Typography variant="body1" className={styles.node}>
                {node.id}
              </Typography>
              <Copy text={node?.id as string} />
            </Box>
          ))}
        </Box>
        <Divider />

        <Box mt={2} mb={2}>
          <Typography variant="h6">Address</Typography>
          <Box display="flex" alignItems="center">
            <Typography variant="body1" className={styles.node}>
              {data?.address}
            </Typography>
            <Copy text={data?.address as string} />
          </Box>
        </Box>
        <Divider />

        <Box mt={2}>
          <NodePeers />
        </Box>
      </Box>
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
