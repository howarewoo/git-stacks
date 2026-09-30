import * as React from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { SegmentedControl } from './ui/segmented-control'
import { InlineAlert } from './ui/surface'
import { OperationFacts, WorkflowSection, type ContextFact } from './workflow-composition'
import { ShortcutEditor } from './shortcut-settings'
import {
  GITHUB_DEFAULT_HOST,
  MERGE_METHODS,
  PULL_STRATEGIES,
  THEMES,
  type AppSettings,
  type DiagnosticReport,
  type MergeMethod,
  type PullStrategy,
  type SettingsPatch,
  type SettingsSnapshot,
  type SupportBundlePreview,
  type ThemePreference,
} from '../../../shared/settings'
import type { ShortcutId } from '../../../shared/shortcuts'
import type { GitHubAccountStatus } from '../../../shared/types'
import { CAPABILITY_STATE_LABELS, type GitHubHostStatus } from '../../../shared/host'

const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase',
}

const PULL_STRATEGY_LABELS: Record<PullStrategy, string> = {
  'ff-only': 'Fast-forward only',
  merge: 'Merge commit',
  rebase: 'Rebase',
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
}

/** Seconds offered in the refresh control, or 0 for "only on request". */
const INTERVAL_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '60', label: '1 min' },
  { value: '120', label: '2 min' },
  { value: '300', label: '5 min' },
  { value: '900', label: '15 min' },
] as const

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  desktop: {
    settings?: () => Promise<SettingsSnapshot>
    updateSettings?: (patch: SettingsPatch) => Promise<SettingsSnapshot>
    resetSettings?: () => Promise<SettingsSnapshot>
    diagnostics?: () => Promise<DiagnosticReport>
    supportBundlePreview?: () => Promise<SupportBundlePreview>
    exportSupportBundle?: (previewId: string) => Promise<{ path: string; bytes: number }>
    signOutOfGitHub?: () => Promise<GitHubAccountStatus>
    githubAccountStatus?: () => Promise<GitHubAccountStatus>
    githubHostStatus?: () => Promise<GitHubHostStatus>
  } | null
  account: GitHubAccountStatus | null
  onAccountChange: (status: GitHubAccountStatus) => void
  /** Every change is written through the main process, which owns the file. */
  onSettingsChange: (settings: SettingsSnapshot['settings']) => void
  shortcutBindings: Record<ShortcutId, string>
  onShortcutBindingsChange: (bindings: Record<ShortcutId, string>) => void
  onError: (message: string) => void
}

type Section =
  | 'account'
  | 'github'
  | 'git'
  | 'appearance'
  | 'privacy'
  | 'shortcuts'
  | 'diagnostics'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'github', label: 'GitHub' },
  { id: 'git', label: 'Git' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

export function SettingsDialog({
  open,
  onOpenChange,
  desktop,
  account,
  onAccountChange,
  onSettingsChange,
  shortcutBindings,
  onShortcutBindingsChange,
  onError,
}: SettingsDialogProps) {
  const [section, setSection] = React.useState<Section>('account')
  const [snapshot, setSnapshot] = React.useState<SettingsSnapshot | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [report, setReport] = React.useState<DiagnosticReport | null>(null)
  const [bundle, setBundle] = React.useState<SupportBundlePreview | null>(null)
  const [hostStatus, setHostStatus] = React.useState<GitHubHostStatus | null>(null)
  const [hostDraft, setHostDraft] = React.useState('')
  const [editorDraft, setEditorDraft] = React.useState('')
  const [mergeToolDraft, setMergeToolDraft] = React.useState('')
  const [message, setMessage] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (!desktop?.settings) return
    try {
      const next = await desktop.settings()
      setSnapshot(next)
      setHostDraft(next.settings.github.host)
      setEditorDraft(next.settings.git.editor ?? '')
      setMergeToolDraft(next.settings.git.mergeTool ?? '')
      onSettingsChange(next.settings)
      onShortcutBindingsChange(next.settings.shortcuts)
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    }
  }, [desktop, onError, onSettingsChange, onShortcutBindingsChange])

  React.useEffect(() => {
    if (!open) return
    setMessage(null)
    void refresh()
  }, [open, refresh])

  /**
   * Writes a patch and leaves every field showing what was stored, which is not
   * always what was asked for: a value this build refuses leaves the previous
   * one in effect, and a host pasted as a URL is normalized down to its host
   * name. The stored settings are returned so a caller reports the host that is
   * in effect rather than the text it typed.
   */
  const save = React.useCallback(
    async (patch: SettingsPatch, note: string): Promise<AppSettings | null> => {
      if (!desktop?.updateSettings) return null
      setBusy(true)
      try {
        const next = await desktop.updateSettings(patch)
        setSnapshot(next)
        setHostDraft(next.settings.github.host)
        onSettingsChange(next.settings)
        onShortcutBindingsChange(next.settings.shortcuts)
        setMessage(note)
        setEditorDraft(next.settings.git.editor ?? '')
        setMergeToolDraft(next.settings.git.mergeTool ?? '')
        return next.settings
      } catch (value) {
        onError(value instanceof Error ? value.message : String(value))
        return null
      } finally {
        setBusy(false)
      }
    },
    [desktop, onError, onSettingsChange, onShortcutBindingsChange],
  )

  const lockFor = React.useCallback(
    (key: string) => snapshot?.locks.find((lock) => lock.key === key) ?? null,
    [snapshot],
  )
  const issueFor = React.useCallback(
    (key: string) => snapshot?.issues.find((issue) => issue.key === key) ?? null,
    [snapshot],
  )
  /**
   * The message a field shows. A lock is reported like a refusal rather than
   * left to a disabled control to imply, so the user learns what the policy
   * fixed instead of only noticing that the control will not move.
   */
  const problemFor = React.useCallback(
    (key: string, toolErrorMessage?: string | null) =>
      issueFor(key)?.message ?? toolErrorMessage ?? lockFor(key)?.reason ?? undefined,
    [issueFor, lockFor],
  )

  /**
   * What the host this installation points at actually supports. It is asked
   * for, not assumed: a host that has not answered is shown as unknown.
   */
  const refreshHostStatus = React.useCallback(async () => {
    if (!desktop?.githubHostStatus) return
    try {
      setHostStatus(await desktop.githubHostStatus())
    } catch {
      setHostStatus(null)
    }
  }, [desktop])

  React.useEffect(() => {
    if (!open || section !== 'github') return
    void refreshHostStatus()
  }, [open, section, refreshHostStatus])

  const openDiagnostics = React.useCallback(async () => {
    if (!desktop?.diagnostics) return
    setBusy(true)
    try {
      setReport(await desktop.diagnostics())
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    } finally {
      setBusy(false)
    }
  }, [desktop, onError])

  const previewBundle = React.useCallback(async () => {
    if (!desktop?.supportBundlePreview) return
    setBusy(true)
    try {
      setBundle(await desktop.supportBundlePreview())
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    } finally {
      setBusy(false)
    }
  }, [desktop, onError])

  const exportBundle = React.useCallback(async () => {
    if (!desktop?.exportSupportBundle || !bundle?.id) return
    setBusy(true)
    try {
      const result = await desktop.exportSupportBundle(bundle.id)
      setMessage(
        result.path
          ? `Support bundle written (${result.bytes} bytes).`
          : 'Support bundle export was cancelled.',
      )
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    } finally {
      setBusy(false)
    }
  }, [desktop, bundle?.id, onError])

  const signOut = React.useCallback(async () => {
    if (!desktop?.signOutOfGitHub) return
    setBusy(true)
    try {
      onAccountChange(await desktop.signOutOfGitHub())
      setMessage('Signed out. Your local repositories are untouched.')
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value))
    } finally {
      setBusy(false)
    }
  }, [desktop, onAccountChange, onError])

  const settings = snapshot?.settings
  const locked = (key: string) => lockFor(key) !== null

  const accountFacts: ContextFact[] = account
    ? [
        { label: 'Account', value: account.login ?? 'Signed in' },
        { label: 'Host', value: account.host, code: true },
        {
          label: 'Permissions',
          // A permission is a name and a level, so it is labelled as one rather
          // than joined as a bare string.
          value:
            account.permissions.length > 0
              ? account.permissions
                  .map((entry) => `${entry.permission} (${entry.access})`)
                  .join(', ')
              : 'None reported',
        },
        {
          label: 'Credential store',
          value: account.store.available
            ? (account.store.name ?? 'Available')
            : (account.store.reason ?? 'Unavailable'),
        },
      ]
    : [{ label: 'Account', value: 'Not signed in' }]

  const reportFacts: ContextFact[] = (report?.entries ?? []).map((entry) => ({
    label: `${entry.source} · ${entry.label}`,
    value: entry.detail ? `${entry.value} — ${entry.detail}` : entry.value,
    code: true,
  }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            These preferences are stored on this computer and validated before they are used.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4">
          <nav aria-label="Settings sections" className="grid w-44 shrink-0 content-start gap-1">
            {SECTIONS.map((entry) => (
              <Button
                key={entry.id}
                variant={section === entry.id ? 'secondary' : 'ghost'}
                size="sm"
                aria-current={section === entry.id ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </nav>

          <div className="grid min-w-0 flex-1 content-start gap-4">
            {!snapshot ? <InlineAlert tone="info">Reading settings…</InlineAlert> : null}
            {message ? (
              <InlineAlert tone="success">
                <Check aria-hidden="true" className="size-4" /> {message}
              </InlineAlert>
            ) : null}
            {snapshot?.recovered ? (
              <InlineAlert tone="warning">
                The stored settings file could not be read, so defaults are in use. Saving replaces
                it.
              </InlineAlert>
            ) : null}

            {section === 'account' && settings ? (
              <WorkflowSection label="Account">
                <OperationFacts facts={accountFacts} />
                <p className="text-[length:var(--gs-semantic-type-body-size)] text-[var(--gs-semantic-text-secondary)]">
                  Signing out removes the credential this app stores. It does not touch any local
                  repository, and signing back in restores access.
                </p>
                <Button variant="secondary" disabled={busy || !account} onClick={signOut}>
                  Sign out
                </Button>
              </WorkflowSection>
            ) : null}

            {section === 'github' && settings ? (
              <WorkflowSection label="GitHub host">
                <Field
                  id="settings-github-host"
                  label="Host"
                  description="The GitHub host this app works against. Leave it as github.com, or name your GitHub Enterprise Server host. Every request, clone URL, and sign-in follows it."
                  error={problemFor('github.host')}
                >
                  <input
                    id="settings-github-host"
                    className="w-full rounded-[length:var(--gs-semantic-radius-control)] border border-[var(--gs-semantic-border-default)] bg-[var(--gs-semantic-surface-raised)] px-3 py-2"
                    value={hostDraft}
                    placeholder={GITHUB_DEFAULT_HOST}
                    disabled={busy || locked('github.host')}
                    onChange={(event) => setHostDraft(event.target.value)}
                  />
                </Field>
                <Button
                  variant="secondary"
                  disabled={busy || locked('github.host')}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      // The field holds the host in effect, so this submits that
                      // host again instead of an empty draft, and the note names
                      // the host that was stored — which is not the text that was
                      // typed when a pasted URL was normalized down to its host.
                      const wanted = hostDraft.trim() || GITHUB_DEFAULT_HOST
                      const stored = await save(
                        { github: { host: wanted } },
                        `GitHub host set to ${wanted}.`,
                      )
                      await refreshHostStatus()
                      if (stored && stored.github.host !== wanted) {
                        setMessage(`GitHub host set to ${stored.github.host}.`)
                      }
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Use this host
                </Button>
                {hostStatus ? (
                  <OperationFacts
                    facts={[
                      { label: 'Host', value: `${hostStatus.host} (${hostStatus.kind})` },
                      { label: 'REST base', value: hostStatus.apiBase },
                      {
                        label: 'Server version',
                        value: hostStatus.serverVersion ?? 'not reported by the host',
                      },
                      ...hostStatus.capabilities.map((capability) => ({
                        label: capability.label,
                        value: CAPABILITY_STATE_LABELS[capability.state],
                        detail: capability.detail,
                      })),
                    ]}
                  />
                ) : (
                  <p className="text-[length:var(--gs-semantic-type-body-size)] text-[var(--gs-semantic-text-secondary)]">
                    This host has not answered yet, so nothing is claimed about what it supports.
                  </p>
                )}
              </WorkflowSection>
            ) : null}

            {section === 'git' && settings ? (
              <>
                <WorkflowSection label="Git runtime">
                  <Field
                    id="settings-use-system-git"
                    label="Git to run"
                    description="The bundled Git is the version this app was tested against. Choose system Git to use the copy installed on this computer."
                    error={problemFor('git.useSystemGit')}
                  >
                    <SegmentedControl
                      label="Git to run"
                      value={settings.git.useSystemGit ? 'system' : 'bundled'}
                      disabled={busy || locked('git.useSystemGit')}
                      options={[
                        { value: 'bundled', label: 'Bundled' },
                        { value: 'system', label: 'System' },
                      ]}
                      onValueChange={(value) =>
                        void save(
                          { git: { useSystemGit: value === 'system' } },
                          `Git set to the ${value} installation.`,
                        )
                      }
                    />
                  </Field>
                  {lockFor('git.useSystemGit') ? (
                    <InlineAlert tone="info">{lockFor('git.useSystemGit')!.reason}</InlineAlert>
                  ) : null}
                </WorkflowSection>

                <WorkflowSection label="Tools">
                  <Field
                    id="settings-editor"
                    label="Editor"
                    description="One program name, no arguments. Leave empty to use this platform's default application."
                    error={problemFor('git.editor', toolError(snapshot, 'editor'))}
                  >
                    <Input
                      id="settings-editor"
                      value={editorDraft}
                      disabled={busy || locked('git.editor')}
                      placeholder="platform default"
                      onChange={(event) => setEditorDraft(event.target.value)}
                      onBlur={() =>
                        void save(
                          { git: { editor: editorDraft.trim() || null } },
                          editorDraft.trim()
                            ? `Editor set to ${editorDraft.trim()}.`
                            : 'Editor reset.',
                        )
                      }
                    />
                  </Field>
                  <Field
                    id="settings-merge-tool"
                    label="Merge tool"
                    description="One program name Git runs to resolve a conflict. Leave empty to use whatever Git is configured with."
                    error={problemFor('git.mergeTool', toolError(snapshot, 'mergeTool'))}
                  >
                    <Input
                      id="settings-merge-tool"
                      value={mergeToolDraft}
                      disabled={busy || locked('git.mergeTool')}
                      placeholder="Git's own configuration"
                      onChange={(event) => setMergeToolDraft(event.target.value)}
                      onBlur={() =>
                        void save(
                          { git: { mergeTool: mergeToolDraft.trim() || null } },
                          mergeToolDraft.trim()
                            ? `Merge tool set to ${mergeToolDraft.trim()}.`
                            : 'Merge tool reset.',
                        )
                      }
                    />
                  </Field>
                </WorkflowSection>

                <WorkflowSection label="Defaults">
                  <Field
                    id="settings-pull-strategy"
                    label="Default pull strategy"
                    description="Used when a pull starts a stack update."
                    error={problemFor('git.defaultPullStrategy')}
                  >
                    <SegmentedControl
                      label="Default pull strategy"
                      value={settings.git.defaultPullStrategy}
                      disabled={busy || locked('git.defaultPullStrategy')}
                      options={PULL_STRATEGIES.map((value) => ({
                        value,
                        label: PULL_STRATEGY_LABELS[value],
                      }))}
                      onValueChange={(value) =>
                        void save(
                          { git: { defaultPullStrategy: value } },
                          `Default pull strategy set to ${PULL_STRATEGY_LABELS[value]}.`,
                        )
                      }
                    />
                  </Field>
                  <Field
                    id="settings-merge-method"
                    label="Default merge method"
                    description="Used when a completed pull request is folded into its parent."
                    error={problemFor('git.defaultMergeMethod')}
                  >
                    <SegmentedControl
                      label="Default merge method"
                      value={settings.git.defaultMergeMethod}
                      disabled={busy || locked('git.defaultMergeMethod')}
                      options={MERGE_METHODS.map((value) => ({
                        value,
                        label: MERGE_METHOD_LABELS[value],
                      }))}
                      onValueChange={(value) =>
                        void save(
                          { git: { defaultMergeMethod: value } },
                          `Default merge method set to ${MERGE_METHOD_LABELS[value]}.`,
                        )
                      }
                    />
                  </Field>
                  <Field
                    id="settings-fetch-interval"
                    label="Background refresh"
                    description="How often this app refreshes an open repository on its own. Off refreshes only when you ask."
                    error={problemFor('git.fetchIntervalSeconds')}
                  >
                    <SegmentedControl
                      label="Background refresh"
                      value={String(settings.git.fetchIntervalSeconds)}
                      disabled={busy || locked('git.fetchIntervalSeconds')}
                      options={INTERVAL_OPTIONS.map((entry) => ({
                        value: entry.value,
                        label: entry.label,
                      }))}
                      onValueChange={(value) =>
                        void save(
                          { git: { fetchIntervalSeconds: Number(value) } },
                          value === '0'
                            ? 'Background refresh turned off.'
                            : `Background refresh set to every ${value} seconds.`,
                        )
                      }
                    />
                  </Field>
                </WorkflowSection>
              </>
            ) : null}

            {section === 'appearance' && settings ? (
              <WorkflowSection label="Appearance">
                <Field
                  id="settings-theme"
                  label="Theme"
                  description="Match system follows this computer's appearance and keeps following it."
                  error={problemFor('appearance.theme')}
                >
                  <SegmentedControl
                    label="Theme"
                    value={settings.appearance.theme}
                    disabled={busy || locked('appearance.theme')}
                    options={THEMES.map((value) => ({ value, label: THEME_LABELS[value] }))}
                    onValueChange={(value) =>
                      void save(
                        { appearance: { theme: value } },
                        `Theme set to ${THEME_LABELS[value]}.`,
                      )
                    }
                  />
                </Field>
                <Field
                  id="settings-reduce-motion"
                  label={<span className="sr-only">Reduce motion</span>}
                  description="Removes non-essential transitions, whether or not this computer's system asks for it."
                  error={problemFor('appearance.reduceMotion')}
                >
                  <Checkbox
                    id="settings-reduce-motion"
                    label="Reduce motion"
                    checked={settings.appearance.reduceMotion}
                    disabled={busy || locked('appearance.reduceMotion')}
                    onChange={(event) =>
                      void save(
                        { appearance: { reduceMotion: event.target.checked } },
                        event.target.checked ? 'Motion reduced.' : 'Motion restored.',
                      )
                    }
                  />
                </Field>
              </WorkflowSection>
            ) : null}

            {section === 'shortcuts' ? (
              <WorkflowSection label="Keyboard shortcuts">
                <ShortcutEditor
                  bindings={shortcutBindings}
                  // The active bindings follow the settings the main process
                  // confirmed, never the edit being offered: adopting first
                  // would leave a locked or refused change in force.
                  onBindingsChange={(bindings) => {
                    void save({ shortcuts: bindings }, 'Shortcuts saved.')
                  }}
                  disabledReason={lockFor('shortcuts')?.reason}
                />
              </WorkflowSection>
            ) : null}

            {section === 'privacy' && settings ? (
              <>
                <WorkflowSection label="What this app collects">
                  <InlineAlert tone="info">
                    This build sends nothing anywhere. There is no telemetry endpoint and no crash
                    upload, and no setting here turns one on. The only thing produced on this
                    computer is the support bundle below, which you write yourself.
                  </InlineAlert>
                </WorkflowSection>
                <WorkflowSection label="Support bundle">
                  <Field
                    id="settings-include-paths"
                    label={<span className="sr-only">Include local paths</span>}
                    description="Off by default. A local path names a username and a directory layout, which a bug report rarely needs. Turning this on adds the Git executable path to the bundle and nothing else — source, diffs, branch names, and pull request text are never included either way."
                    error={problemFor('privacy.includeLocalPaths')}
                  >
                    <Checkbox
                      id="settings-include-paths"
                      label="Include local paths"
                      checked={settings.privacy.includeLocalPaths}
                      disabled={busy || locked('privacy.includeLocalPaths')}
                      onChange={(event) => {
                        setBundle(null)
                        void save(
                          { privacy: { includeLocalPaths: event.target.checked } },
                          event.target.checked
                            ? 'Local paths will be included in a support bundle.'
                            : 'Local paths will be withheld from a support bundle.',
                        )
                      }}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={busy} onClick={previewBundle}>
                      Preview bundle
                    </Button>
                    <Button disabled={busy || !bundle?.id} onClick={exportBundle}>
                      Create support bundle
                    </Button>
                  </div>
                  {bundle ? (
                    <OperationFacts
                      facts={bundle.sections.map((entry) => ({
                        label: entry.title,
                        value: entry.included ? entry.reason : `Not included: ${entry.reason}`,
                      }))}
                    />
                  ) : null}
                  {bundle
                    ? bundle.sections
                        .filter((entry) => entry.included)
                        .map((entry) => (
                          <details key={entry.id} className="grid gap-1">
                            <summary className="cursor-pointer text-[length:var(--gs-semantic-type-label-size)]">
                              {entry.title}
                            </summary>
                            <pre className="max-h-48 overflow-auto rounded-[var(--gs-semantic-radius-item)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] p-2 text-[length:var(--gs-semantic-type-metadata-size)]">
                              {entry.content}
                            </pre>
                          </details>
                        ))
                    : null}
                </WorkflowSection>
              </>
            ) : null}

            {section === 'diagnostics' ? (
              <WorkflowSection label="Capability report">
                <p className="text-[length:var(--gs-semantic-type-body-size)] text-[var(--gs-semantic-text-secondary)]">
                  Every line below was measured on this computer by a fixed set of commands run in
                  the app process. A line marked unavailable is something this build could not
                  establish, not an assumption.
                </p>
                <Button variant="secondary" disabled={busy} onClick={openDiagnostics}>
                  Run report
                </Button>
                {report ? <OperationFacts facts={reportFacts} /> : null}
              </WorkflowSection>
            ) : null}

            {settings ? (
              <div className="flex items-center justify-between gap-3 border-t border-[var(--gs-semantic-border)] pt-3">
                <span className="text-[length:var(--gs-semantic-type-metadata-size)] text-[var(--gs-semantic-text-secondary)]">
                  Stored in {snapshot?.file ?? 'application data'}
                </span>
                <Button
                  variant="secondary"
                  disabled={busy || !desktop?.resetSettings}
                  onClick={() => {
                    if (!desktop?.resetSettings) return
                    setBusy(true)
                    desktop
                      .resetSettings()
                      .then((next) => {
                        setSnapshot(next)
                        onSettingsChange(next.settings)
                        onShortcutBindingsChange(next.settings.shortcuts)
                        setEditorDraft('')
                        setMergeToolDraft('')
                        setMessage('Settings restored to their defaults.')
                      })
                      .catch((value) =>
                        onError(value instanceof Error ? value.message : String(value)),
                      )
                      .finally(() => setBusy(false))
                  }}
                >
                  <AlertCircle aria-hidden="true" className="size-4" /> Reset all
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Says a configured tool is missing here, where the name is typed. */
function toolError(
  snapshot: SettingsSnapshot | null,
  key: 'editor' | 'mergeTool',
): string | undefined {
  const tool = snapshot?.tools?.[key]
  if (!tool || tool.available) return undefined
  return tool.label === 'none configured'
    ? undefined
    : `${tool.label} is not installed on this computer.`
}
