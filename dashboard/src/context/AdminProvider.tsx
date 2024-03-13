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

interface AdminContextType {
  userAddress: string
  setUserAddress: Dispatch<SetStateAction<string>>
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
  const [admin, setAdmin] = useState<boolean>(false)
  const [userAddress, setUserAddress] = useState<string>('')
  const [allAdmins, setAllAdmins] = useState<string[]>([])

  const value: AdminContextType = {
    admin,
    setAdmin,
    userAddress,
    setUserAddress,
    allAdmins,
    setAllAdmins
  }

  useEffect(() => {
    for (const adminAddress of allAdmins) {
      if (adminAddress.toLowerCase() === userAddress.toLowerCase()) {
        setAdmin(true)
        console.log('admin has logged in')
      }
    }
  }, [userAddress, allAdmins])

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export const useAdminContext = () => {
  const context = useContext(AdminContext)
  if (context === undefined) {
    throw new Error('AdminContext must be used within an AdminProvider')
  }
  return context
}
