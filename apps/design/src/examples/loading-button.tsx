import { useState } from 'react'
import { Button } from '@git-stacks/ui'

export function LoadingButtonExample() {
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState('Only the example ref is copied; no Git operation runs.')

  async function copyRef() {
    setWorking(true)
    try {
      await navigator.clipboard.writeText('feature/quiet-graph')
      setResult('Example ref copied.')
    } catch {
      setResult('Clipboard access was refused. Select and copy the ref below instead.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="grid gap-3">
      <code>feature/quiet-graph</code>
      <Button loading={working} onClick={() => void copyRef()}>
        Copy example ref
      </Button>
      <output aria-live="polite">{result}</output>
    </div>
  )
}
