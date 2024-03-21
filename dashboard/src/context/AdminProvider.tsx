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
import { sha256, toUtf8Bytes } from 'ethers'

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

  // Effect for handling localStorage retrieval and initialization
  useEffect(() => {
    const storedExpiry = localStorage.getItem('expiryTimestamp')
    if (storedExpiry) {
      setExpiryTimestamp(parseInt(storedExpiry, 10))
    }

    const storedSignature = localStorage.getItem('signature')
    if (storedSignature) {
      setSignature(storedSignature)
    }
  }, [])

  useEffect(() => {
    if (expiryTimestamp) {
      localStorage.setItem('expiryTimestamp', expiryTimestamp.toString())
    }
  }, [expiryTimestamp])

  useEffect(() => {
    if (signature) {
      localStorage.setItem('signature', signature)
    }
  }, [signature])

  useEffect(() => {
    if (signMessageData) {
      setSignature(signMessageData)
    }
  }, [signMessageData])

  useEffect(() => {
    const interval = setInterval(() => {
      if (expiryTimestamp) {
        const now = Math.floor(Date.now() / 1000)
        setValidTimestamp(now < expiryTimestamp)
      }
    }, 300000) // Check every 5 minutes (300000 milliseconds)

    return () => clearInterval(interval)
  }, [expiryTimestamp])

  const generateSignature = () => {
    if (
      isConnected &&
      (!expiryTimestamp || new Date().getTime() / 1000 >= expiryTimestamp)
    ) {
      const newExpiryTimestamp = Math.floor(new Date().getTime() / 1000) + 12 * 60 * 60
      signMessage({
        message: sha256(toUtf8Bytes(newExpiryTimestamp.toString()))
      })
      setExpiryTimestamp(newExpiryTimestamp)
    }
  }

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
    setValidTimestamp
  }

  useEffect(() => {
    for (const adminAddress of allAdmins) {
      if (address && adminAddress.toLowerCase() === address.toLowerCase()) {
        setAdmin(true)
      }
    }
  }, [address, allAdmins])

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export const useAdminContext = () => {
  const context = useContext(AdminContext)
  if (context === undefined) {
    throw new Error('AdminContext must be used within an AdminProvider')
  }
  return context
}
