import { hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppProviders } from './AppProviders.tsx'

hydrateRoot(
  document.getElementById('root')!,
  <AppProviders>
    <App />
  </AppProviders>,
)
