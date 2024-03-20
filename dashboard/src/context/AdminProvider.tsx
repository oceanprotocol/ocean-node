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

export interface SignMessageObject {
  expiryTimestamp: number
  signature: string
}
interface AdminContextType {
  admin: boolean
  setAdmin: Dispatch<SetStateAction<boolean>>
  allAdmins: string[]
  setAllAdmins: Dispatch<SetStateAction<string[]>>
  expiryTimestamp: number | undefined
  setExpiryTimestamp: Dispatch<SetStateAction<number | undefined>>
  generateSignature: () => void
  signMessageObject: SignMessageObject | undefined
}

// Create a context with a default value that matches the type
const AdminContext = createContext<AdminContextType | undefined>(undefined)

export const AdminProvider: FunctionComponent<{ children: ReactNode }> = ({
  children
}) => {
  const { address, isConnected } = useAccount()
  const { signMessage, data: signature } = useSignMessage()
  const [admin, setAdmin] = useState<boolean>(false)
  const [allAdmins, setAllAdmins] = useState<string[]>([])
  const [expiryTimestamp, setExpiryTimestamp] = useState<number>()
  const [signMessageObject, setSignMessageObject] = useState<
    SignMessageObject | undefined
  >()

  const generateSignature = async () => {
    if (
      isConnected &&
      (!signMessageObject ||
        new Date().getTime() / 1000 >= signMessageObject?.expiryTimestamp)
    ) {
      const expiryTimestamp = Math.floor(new Date().getTime() / 1000) + 12 * 60 * 60
      await signMessage({
        message: sha256(toUtf8Bytes(expiryTimestamp.toString()))
      })
      if (signature) {
        setSignMessageObject({
          expiryTimestamp,
          signature
        })
      }
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
    signMessageObject
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
