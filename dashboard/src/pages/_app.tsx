import '@/styles/globals.css'
import type { AppProps } from 'next/app'
import { AdminProvider } from '@context/AdminProvider'
import '@rainbow-me/rainbowkit/styles.css'
import { getDefaultConfig, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { mainnet, polygon, hardhat } from 'wagmi/chains'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'

// Define Ganache as a custom network
const barge = {
  ...hardhat,
  id: 8996,
  name: 'Ganache',
  network: 'ganache',
  rpcUrls: {
    default: {
      http: ['http://127.0.0.1:8545']
    }
  }
}

export default function App({ Component, pageProps }: AppProps) {
  const config = getDefaultConfig({
    appName: 'Ocean Node Dashboard',
    projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_ID
      ? process.env.NEXT_PUBLIC_WALLET_CONNECT_ID
      : 'da267f7e1897e2cf92a7710f92e8f660',
    chains: [mainnet, polygon, barge],
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
