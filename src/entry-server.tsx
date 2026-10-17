import { renderToString } from 'react-dom/server'
import App from './App.tsx'
import { AppProviders } from './AppProviders.tsx'

export function render(_url: string): { html: string; head: string } {
  const html = renderToString(
    <AppProviders>
      <App />
    </AppProviders>,
  )

  return { html, head: '' }
}
