import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'sui-vendor', test: /node_modules\/@mysten\//, priority: 20 },
            { name: 'react-vendor', test: /node_modules\/(?:react|react-dom|scheduler)\//, priority: 15 },
            { name: 'icons', test: /node_modules\/lucide-react\//, priority: 10 },
          ],
        },
      },
    },
  },
})
