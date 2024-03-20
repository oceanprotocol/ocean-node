import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import { AdminProvider } from '@context/AdminProvider'
import '@rainbow-me/rainbowkit/styles.css'
import { getDefaultConfig, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { mainnet, polygon } from 'wagmi/chains'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'

export default function App({ Component, pageProps }: AppProps) {
  const config = getDefaultConfig({
    appName: 'Ocean Node Dashboard',
    projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_ID
      ? process.env.NEXT_PUBLIC_WALLET_CONNECT_ID
      : '',
    chains: [mainnet, polygon],
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
