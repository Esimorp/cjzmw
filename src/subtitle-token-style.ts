import { createContext, useContext } from 'react'

/**
 * A registered token style: CSS class names only, never inline values.
 *
 * The classes are the single source of truth for font size, colour and
 * margins — they are defined in `App.css`. A token references a style by its
 * `styleName`; tokens without one fall back to {@link DEFAULT_SUBTITLE_TOKEN_STYLE_NAME}.
 */
export interface SubtitleTokenStyle {
  className: string
  focusedClassName: string
}

/** Name of the built-in style that cannot be unregistered. */
export const DEFAULT_SUBTITLE_TOKEN_STYLE_NAME = 'default'

/** CSS classes defined in App.css: base chip look plus the focused variant. */
export const DEFAULT_SUBTITLE_TOKEN_STYLE: SubtitleTokenStyle = Object.freeze({
  className: 'token-chip--default',
  focusedClassName: 'token-chip--default-focused',
})

/** Style registry plus stable register/unregister callbacks. */
export interface SubtitleTokenStyleContextValue {
  /** Registered styles by name; always contains the default. */
  styles: Readonly<Record<string, SubtitleTokenStyle>>
  /** Registers (or replaces) a style under `styleName`. */
  registerStyle: (styleName: string, style: SubtitleTokenStyle) => void
  /** Removes a style; the default style cannot be removed. */
  unregisterStyle: (styleName: string) => void
  /** Resolves a name, falling back to the default style. */
  getStyle: (styleName?: string | null) => SubtitleTokenStyle
}

const CLASS_NAME_PATTERN = /^-?[A-Za-z_][A-Za-z0-9_-]*(\s+-?[A-Za-z_][A-Za-z0-9_-]*)*$/

/**
 * Accepts one or more CSS class names (`token-chip--large` or
 * `token-chip--a token-chip--b`). Anything that is not plain class syntax —
 * braces, semicolons, `<`, quotes — is rejected so a caller cannot smuggle
 * arbitrary CSS or markup through a style name.
 */
export function sanitizeClassName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 200) return null
  return CLASS_NAME_PATTERN.test(trimmed) ? trimmed : null
}

/** Validates a style definition; returns `null` when either class is invalid. */
export function sanitizeSubtitleTokenStyle(value: unknown): SubtitleTokenStyle | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { className?: unknown; focusedClassName?: unknown }
  const className = sanitizeClassName(candidate.className)
  const focusedClassName = sanitizeClassName(candidate.focusedClassName)
  if (!className || !focusedClassName) return null
  return { className, focusedClassName }
}

/** Style name must be a simple identifier-like key. */
export function sanitizeStyleName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64) return null
  return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null
}

const fallbackGetStyle = (): SubtitleTokenStyle => DEFAULT_SUBTITLE_TOKEN_STYLE

export const SubtitleTokenStyleContext = createContext<SubtitleTokenStyleContextValue>({
  styles: Object.freeze({ [DEFAULT_SUBTITLE_TOKEN_STYLE_NAME]: DEFAULT_SUBTITLE_TOKEN_STYLE }),
  // Outside a provider these are intentional no-ops rather than crashes.
  registerStyle: () => undefined,
  unregisterStyle: () => undefined,
  getStyle: fallbackGetStyle,
})

/** Read the style registry, or resolve by name via `getStyle`. */
export function useSubtitleTokenStyle(): SubtitleTokenStyleContextValue {
  return useContext(SubtitleTokenStyleContext)
}

/** Resolve one token's classes, falling back to the default style. */
export function useSubtitleTokenClasses(styleName?: string | null): SubtitleTokenStyle {
  const { getStyle } = useSubtitleTokenStyle()
  return getStyle(styleName)
}
