import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import { AdminProvider } from '@context/AdminProvider'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <AdminProvider>
      <Component {...pageProps} />
    </AdminProvider>
  )
}
