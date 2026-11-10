import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createDAppKit, DAppKitProvider } from '@mysten/dapp-kit-react'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import './index.css'
import App from './App.tsx'

const dAppKit = createDAppKit({
  networks: ['testnet'],
  defaultNetwork: 'testnet',
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
