import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import { AdminProvider } from '@context/AdminProvider'
import '@rainbow-me/rainbowkit/styles.css'
import { getDefaultConfig, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import { chains } from '@utils/chains'

export default function App({ Component, pageProps }: AppProps) {
  const config = getDefaultConfig({
    appName: 'Ocean Node Control Panel',
    projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_ID
      ? process.env.NEXT_PUBLIC_WALLET_CONNECT_ID
      : 'da267f7e1897e2cf92a7710f92e8f660',
    chains,
    ssr: true
  })

  const queryClient = new QueryClient()

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <AdminProvider>
            <Component {...pageProps} />
          </AdminProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
