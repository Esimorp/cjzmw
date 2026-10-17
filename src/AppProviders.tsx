import { StrictMode, type ReactNode } from 'react'
import { SubtitleProvider } from './SubtitleProvider'
import { SubtitleTokenStyleProvider } from './SubtitleTokenStyleProvider'

/**
 * Shared root wrapper for both client hydration and SSR rendering, so the two
 * entry points can never drift apart.
 *
 * The style registry wraps the subtitle store so consumers can resolve token
 * classes from the same tree.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <SubtitleTokenStyleProvider>
        <SubtitleProvider>{children}</SubtitleProvider>
      </SubtitleTokenStyleProvider>
    </StrictMode>
  )
}
