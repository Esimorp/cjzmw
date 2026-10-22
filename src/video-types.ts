export interface VideoMetadata {
  id: string
  /**
   * URL the browser loads, as a root-relative path under the static `public`
   * directory (e.g. `/videos/<id>.mp4`). The server always derives it from the
   * persisted file name; client-supplied paths are never trusted.
   */
  url: string
  /**
   * Path relative to the `public` root (e.g. `videos/<id>.mp4`). Optional for
   * older documents that only stored a workspace-local file name.
   */
  publicPath?: string
  filename: string
  size: number
  duration: number
  width: number
  height: number
  fps: number
  codec: string
}
