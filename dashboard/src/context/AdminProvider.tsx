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

// Create a context with a default value that matches the type
const AdminContext = createContext<AdminContextType | undefined>(undefined)

export const AdminProvider: FunctionComponent<{ children: ReactNode }> = ({
  children
}) => {
  const { address, isConnected } = useAccount()
  const { signMessage, data: signMessageData } = useSignMessage()
  const [admin, setAdmin] = useState<boolean>(false)
  const [allAdmins, setAllAdmins] = useState<string[]>([])
  const [expiryTimestamp, setExpiryTimestamp] = useState<number>()
  const [signature, setSignature] = useState<string>()
  const [validTimestamp, setValidTimestamp] = useState<boolean>(false)

  useEffect(() => {
    if (signMessageData) {
      console.log('3. signMessageData:  ', signMessageData)
      setSignature(signMessageData)
      console.log('4. signMessageData:  ', signMessageData)
    }
  }, [signMessageData])

  useEffect(() => {
    // This effect checks the expiryTimestamp against the current time
    const interval = setInterval(() => {
      if (expiryTimestamp) {
        const now = Math.floor(Date.now() / 1000)
        setValidTimestamp(now < expiryTimestamp)
      }
    }, 300000) // Check every 5 minutes (300000 milliseconds)

    return () => clearInterval(interval) // Cleanup the interval on unmount
  }, [expiryTimestamp])

  const generateSignature = () => {
    if (
      isConnected &&
      (!expiryTimestamp || new Date().getTime() / 1000 >= expiryTimestamp)
    ) {
      const expiryTimestamp = Math.floor(new Date().getTime() / 1000) + 12 * 60 * 60
      signMessage({
        message: sha256(toUtf8Bytes(expiryTimestamp.toString()))
      })
      setExpiryTimestamp(expiryTimestamp)
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
        console.log('admin has logged in')
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
