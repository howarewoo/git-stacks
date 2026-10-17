import * as React from 'react'
import type { DesktopAPI } from '@git-stacks/shared/types'

/** A drifted approval stays retired until an explicit new preview, never a draft reseed. */
export function useOperationSafety(
  api: Pick<DesktopAPI, 'operationSafety'>,
  token: string | undefined,
  preview: { kind: 'stack' | 'native' | 'lifecycle'; token: string } | undefined,
  busy: boolean,
  revision = '',
): { current: boolean; reason: string | null } {
  const key = JSON.stringify([token, preview])
  const [state, setState] = React.useState({
    key: '',
    current: false,
    reason: null as string | null,
  })
  const invalidatedKeys = React.useRef(new Map<string, string>())
  React.useEffect(() => {
    if (!token || busy) return
    const invalid = invalidatedKeys.current.get(key)
    if (invalid) {
      setState({ key, current: false, reason: invalid })
      return
    }
    let retired = false
    let invalidated = false
    let reading = false
    setState({
      key,
      current: false,
      reason: 'Checking the original approval against live safety facts…',
    })
    const inspect = async () => {
      if (retired || reading || invalidated) return
      reading = true
      try {
        if (!api.operationSafety)
          throw new Error('Original approval safety inspection is unavailable.')
        const result = await api.operationSafety(token, preview)
        if (retired) return
        invalidated = !result.current
        if (!result.current)
          invalidatedKeys.current.set(key, result.reason ?? 'Original approval changed.')
        setState({ key, ...result })
      } catch (error) {
        if (retired) return
        invalidated = true
        setState({ key, current: false, reason: String(error) })
        invalidatedKeys.current.set(key, String(error))
      } finally {
        reading = false
      }
    }
    void inspect()
    const interval = window.setInterval(() => void inspect(), 5000)
    const focus = () => void inspect()
    window.addEventListener('focus', focus)
    return () => {
      retired = true
      window.clearInterval(interval)
      window.removeEventListener('focus', focus)
    }
  }, [api, key, busy, revision])
  return state.key === key
    ? state
    : { current: false, reason: 'Original approval safety inspection is pending.' }
}
