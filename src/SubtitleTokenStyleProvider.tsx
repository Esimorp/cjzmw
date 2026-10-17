import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_SUBTITLE_TOKEN_STYLE,
  DEFAULT_SUBTITLE_TOKEN_STYLE_NAME,
  SubtitleTokenStyleContext,
  sanitizeStyleName,
  sanitizeSubtitleTokenStyle,
  type SubtitleTokenStyle,
  type SubtitleTokenStyleContextValue,
} from './subtitle-token-style'

type StyleRegistry = Record<string, SubtitleTokenStyle>

const INITIAL_REGISTRY: StyleRegistry = {
  [DEFAULT_SUBTITLE_TOKEN_STYLE_NAME]: DEFAULT_SUBTITLE_TOKEN_STYLE,
}

/**
 * Idempotently makes sure the built-in default style is present. Used once at
 * provider initialisation so re-registration cannot create duplicates.
 */
function registerDefaultStyle(registry: StyleRegistry): StyleRegistry {
  const existing = registry[DEFAULT_SUBTITLE_TOKEN_STYLE_NAME]
  if (existing && sameStyle(existing, DEFAULT_SUBTITLE_TOKEN_STYLE)) return registry
  return { ...registry, [DEFAULT_SUBTITLE_TOKEN_STYLE_NAME]: DEFAULT_SUBTITLE_TOKEN_STYLE }
}

function sameStyle(a: SubtitleTokenStyle, b: SubtitleTokenStyle): boolean {
  return a.className === b.className && a.focusedClassName === b.focusedClassName
}

/** Keeps only entries that pass the same validation as `registerStyle`. */
function sanitizeInitialStyles(
  initialStyles?: Record<string, SubtitleTokenStyle>,
): StyleRegistry {
  if (!initialStyles) return INITIAL_REGISTRY
  const next: StyleRegistry = { ...INITIAL_REGISTRY }
  for (const [name, style] of Object.entries(initialStyles)) {
    const safeName = sanitizeStyleName(name)
    const safeStyle = sanitizeSubtitleTokenStyle(style)
    if (!safeName || !safeStyle) continue
    next[safeName] = safeStyle
  }
  return next
}

/**
 * Provides the named token-style registry.
 *
 * The context value is memoised on the registry only, and all three callbacks
 * are stable, so token renders cannot loop through a fresh object identity.
 * Invalid names/styles are ignored, the default style cannot be removed, and
 * re-registering an unchanged value keeps the previous registry object.
 *
 * `initialStyles` carries a read-only snapshot of another registry (used by the
 * Remotion bridge, which renders in a separate React tree). Custom entries are
 * preserved; the built-in default is always present.
 */
export function SubtitleTokenStyleProvider({
  children,
  initialStyles,
}: {
  children: ReactNode
  /** Optional snapshot of already-registered styles to seed the registry. */
  initialStyles?: Record<string, SubtitleTokenStyle>
}) {
  // The default style is registered up front, exactly once, and can never be
  // unregistered, so `getStyle` always has a fallback.
  const [styles, setStyles] = useState<StyleRegistry>(() =>
    registerDefaultStyle(sanitizeInitialStyles(initialStyles)),
  )

  const registerStyle = useCallback((styleName: string, style: SubtitleTokenStyle) => {
    const safeName = sanitizeStyleName(styleName)
    const safeStyle = sanitizeSubtitleTokenStyle(style)
    if (!safeName || !safeStyle) return
    setStyles((current) => {
      const existing = current[safeName]
      // No-op when the same value is registered again.
      if (existing && sameStyle(existing, safeStyle)) return current
      return { ...current, [safeName]: safeStyle }
    })
  }, [])

  const unregisterStyle = useCallback((styleName: string) => {
    const safeName = sanitizeStyleName(styleName)
    // The default style is built in and can never be removed.
    if (!safeName || safeName === DEFAULT_SUBTITLE_TOKEN_STYLE_NAME) return
    setStyles((current) => {
      if (!(safeName in current)) return current
      const next = { ...current }
      delete next[safeName]
      return next
    })
  }, [])

  const getStyle = useCallback(
    (styleName?: string | null): SubtitleTokenStyle => {
      if (!styleName) return DEFAULT_SUBTITLE_TOKEN_STYLE
      return styles[styleName] ?? DEFAULT_SUBTITLE_TOKEN_STYLE
    },
    [styles],
  )

  const value = useMemo<SubtitleTokenStyleContextValue>(
    () => ({ styles, registerStyle, unregisterStyle, getStyle }),
    [styles, registerStyle, unregisterStyle, getStyle],
  )

  return (
    <SubtitleTokenStyleContext.Provider value={value}>{children}</SubtitleTokenStyleContext.Provider>
  )
}
