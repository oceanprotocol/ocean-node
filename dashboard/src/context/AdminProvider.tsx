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
import { useAccount } from 'wagmi'

interface AdminContextType {
  admin: boolean
  setAdmin: Dispatch<SetStateAction<boolean>>
  allAdmins: string[]
  setAllAdmins: Dispatch<SetStateAction<string[]>>
}

// Create a context with a default value that matches the type
const AdminContext = createContext<AdminContextType | undefined>(undefined)

export const AdminProvider: FunctionComponent<{ children: ReactNode }> = ({
  children
}) => {
  const { address } = useAccount()
  const [admin, setAdmin] = useState<boolean>(false)
  const [allAdmins, setAllAdmins] = useState<string[]>([])

  const value: AdminContextType = {
    admin,
    setAdmin,
    allAdmins,
    setAllAdmins
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
