import { createContext, useContext } from 'react'

/**
 * A registered token style: CSS class names only, never inline values.
 *
 * The classes are the single source of truth for font size, colour and
 * margins — they are defined in `subtitles.css`. A token references a style by
 * its `styleName`; tokens without one fall back to
 * {@link DEFAULT_SUBTITLE_TOKEN_STYLE_NAME}.
 */
export interface SubtitleTokenStyle {
  className: string
  focusedClassName: string
}

/** Name of the built-in style that cannot be unregistered. */
export const DEFAULT_SUBTITLE_TOKEN_STYLE_NAME = 'default'

/** CSS classes defined in subtitles.css: base chip look plus the focused variant. */
export const DEFAULT_SUBTITLE_TOKEN_STYLE: SubtitleTokenStyle = Object.freeze({
  className: 'token-chip--default',
  focusedClassName: 'token-chip--default-focused',
})

/** Name of the built-in emphasis style (`重点`). */
export const EMPHASIS_SUBTITLE_TOKEN_STYLE_NAME = 'emphasis'

/** Emphasis classes: bigger and heavier, with a louder focused variant. */
export const EMPHASIS_SUBTITLE_TOKEN_STYLE: SubtitleTokenStyle = Object.freeze({
  className: 'token-chip--emphasis',
  focusedClassName: 'token-chip--emphasis-focused',
})

/**
 * Built-in styles every registry starts with.
 *
 * They are registered by the provider itself (and re-seeded into the Remotion
 * bridge through its `initialStyles` snapshot), so no consumer has to register
 * them and an exported video always resolves the same names.
 */
export const BUILT_IN_SUBTITLE_TOKEN_STYLES: Readonly<
  Record<string, SubtitleTokenStyle>
> = Object.freeze({
  [DEFAULT_SUBTITLE_TOKEN_STYLE_NAME]: DEFAULT_SUBTITLE_TOKEN_STYLE,
  [EMPHASIS_SUBTITLE_TOKEN_STYLE_NAME]: EMPHASIS_SUBTITLE_TOKEN_STYLE,
})

/** Display labels for the built-in styles; custom names are shown verbatim. */
const BUILT_IN_STYLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [DEFAULT_SUBTITLE_TOKEN_STYLE_NAME]: '默认样式',
  [EMPHASIS_SUBTITLE_TOKEN_STYLE_NAME]: '重点',
})

/** Human-readable label for a registered style name (used by the picker). */
export function subtitleTokenStyleLabel(styleName: string): string {
  return BUILT_IN_STYLE_LABELS[styleName] ?? styleName
}

/** True for styles the registry owns and must never drop. */
export function isBuiltInSubtitleTokenStyle(styleName: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_SUBTITLE_TOKEN_STYLES, styleName)
}

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
  styles: BUILT_IN_SUBTITLE_TOKEN_STYLES,
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
