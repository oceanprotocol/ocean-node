import {
  createContext,
  useContext,
  useState,
  ReactNode,
  FunctionComponent,
  Dispatch,
  SetStateAction,
  useEffect
} from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { verifyMessage } from 'ethers'

interface network {
  chainId: number
  network: string
}

interface AdminContextType {
  admin: boolean
  setAdmin: Dispatch<SetStateAction<boolean>>
  allAdmins: string[]
  setAllAdmins: Dispatch<SetStateAction<string[]>>
  expiryTimestamp: number | undefined
  setExpiryTimestamp: Dispatch<SetStateAction<number | undefined>>
  generateSignature: () => void
  signature: string | undefined
  setSignature: Dispatch<SetStateAction<string | undefined>>
  validTimestamp: boolean
  setValidTimestamp: Dispatch<SetStateAction<boolean>>
  networks: network[]
  setNetworks: Dispatch<SetStateAction<network[]>>
}

const AdminContext = createContext<AdminContextType | undefined>(undefined)

export const AdminProvider: FunctionComponent<{ children: ReactNode }> = ({
  children
}) => {
  const { address, isConnected } = useAccount()
  const { signMessage, data: signMessageData } = useSignMessage()
  const [admin, setAdmin] = useState<boolean>(false)
  const [allAdmins, setAllAdmins] = useState<string[]>([])
  const [expiryTimestamp, setExpiryTimestamp] = useState<number | undefined>()
  const [signature, setSignature] = useState<string | undefined>()
  const [validTimestamp, setValidTimestamp] = useState<boolean>(true)
  const [networks, setNetworks] = useState<network[]>([])

  // Ensure signature and expiry are cleared when the account is changed or disconnected
  useEffect(() => {
    if (!isConnected || !address) {
      setSignature(undefined)
      setExpiryTimestamp(undefined)
    }
  }, [address, isConnected])

  // Get expiryTimestamp and signature from localStorage
  useEffect(() => {
    const storedExpiry = localStorage.getItem('expiryTimestamp')
    const storedExpiryTimestamp = storedExpiry ? parseInt(storedExpiry, 10) : null
    if (storedExpiryTimestamp && storedExpiryTimestamp > Date.now()) {
      setExpiryTimestamp(storedExpiryTimestamp)
      const storedSignature = localStorage.getItem('signature')
      if (storedSignature) {
        setSignature(storedSignature)
      }
    }
  }, [address, isConnected])

  // Store signature and expiryTimestamp in localStorage
  useEffect(() => {
    if (expiryTimestamp && expiryTimestamp > Date.now()) {
      localStorage.setItem('expiryTimestamp', expiryTimestamp.toString())
      signature && localStorage.setItem('signature', signature)
    }
  }, [expiryTimestamp, signature, address, isConnected])

  useEffect(() => {
    if (signMessageData) {
      setSignature(signMessageData)
    }
  }, [signMessageData, address, isConnected])

  useEffect(() => {
    const interval = setInterval(() => {
      if (expiryTimestamp) {
        const now = Date.now()
        setValidTimestamp(now < expiryTimestamp)
      }
    }, 300000) // Check every 5 minutes

    return () => clearInterval(interval)
  }, [expiryTimestamp, address, isConnected])

  const generateSignature = () => {
    const newExpiryTimestamp = Date.now() + 12 * 60 * 60 * 1000 // 12 hours ahead in milliseconds
    signMessage({
      message: newExpiryTimestamp.toString()
    })
    setExpiryTimestamp(newExpiryTimestamp)
  }

  // Remove signature and expiryTimestamp from state if they are not from the currently connected account
  useEffect(() => {
    if (expiryTimestamp && signature) {
      const signerAddress = verifyMessage(
        expiryTimestamp.toString(),
        signature
      )?.toLowerCase()
      if (signerAddress !== address?.toLowerCase()) {
        setExpiryTimestamp(undefined)
        setSignature(undefined)
      }
    }
  }, [address, expiryTimestamp, signature])

  const value: AdminContextType = {
    admin,
    setAdmin,
    allAdmins,
    setAllAdmins,
    expiryTimestamp,
    setExpiryTimestamp,
    generateSignature,
    signature,
    setSignature,
    validTimestamp,
    setValidTimestamp,
    networks,
    setNetworks
  }

  // Update admin status based on current address
  useEffect(() => {
    const isAdmin = allAdmins.some(
      (adminAddress) => address && adminAddress?.toLowerCase() === address?.toLowerCase()
    )
    setAdmin(isAdmin)
  }, [address, allAdmins, isConnected])

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export const useAdminContext = () => {
  const context = useContext(AdminContext)
  if (context === undefined) {
    throw new Error('AdminContext must be used within an AdminProvider')
  }
  return context
}
