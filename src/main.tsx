import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createDAppKit, DAppKitProvider } from '@mysten/dapp-kit-react'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { getWallets } from '@mysten/wallet-standard'
import './index.css'
import App from './App.tsx'

const suiWalletExtensionPresent = getWallets().get().some((wallet) => wallet.id === 'com.mystenlabs.suiwallet')
const dAppKit = createDAppKit({
  networks: ['testnet'],
  defaultNetwork: 'testnet',
  // The Slush web fallback shares its id with the Sui browser extension.
  // Register the fallback only when an extension has not already registered.
  slushWalletConfig: suiWalletExtensionPresent ? null : { appName: 'Payee Passport' },
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: 'https://fullnode.testnet.sui.io:443' }),
})

declare module '@mysten/dapp-kit-react' {
  interface Register { dAppKit: typeof dAppKit }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DAppKitProvider dAppKit={dAppKit}><App /></DAppKitProvider>
  </StrictMode>,
)
