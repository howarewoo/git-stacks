# Git Stacks

A local-first desktop workbench for Git branches and stacked pull requests.

Design rules live in [DESIGN.md](DESIGN.md). This guide covers how to run the app,
how the large-repository work is measured, how development and verification are
performed, and how a release is published and updated; record run-specific
evidence and outstanding acceptance checks in the associated pull request.

## Commands

```sh
npm ci                 # install
npm run dev            # run the app
npm run build          # typecheck + production build
npm test               # the test suite
npm run format:check   # formatting gate
npm run bench:performance  # large-repository benchmarks
npm run build:promotion-helper  # build the atomic no-replace rename helper
```

`npm run dev`, `npm run build`, `npm test`, `npm run package`, and `npm run
dist` all build the clone promotion helper first, so a C compiler must be
available on the build machine (`cc`, `gcc`, `clang`, or `cl`; set `CC` to
choose). The helper is compiled from source at build time and copied into the
packaged app as `resources/promote`; nothing is compiled at runtime, and a build
that cannot compile it fails instead of shipping a build that would fall back to
an unsafe rename. `npm run package` and `npm run dist` finish by running the
helper from inside the packaged app, so a build that left it out fails there.
The signed release workflow compiles on a runner for each target platform and
puts the Visual Studio toolchain on `PATH` for its Windows runner, which does
not have `cl` by default.

When changing `GitAction`, update the renderer fixture's action messages in
`tests/renderer/fixtures/control.ts` and affected test payloads. `npm run build`
typechecks these test consumers as well as the application.

Stale-preview publishing tests assert rejection and unchanged local and remote
refs. Diagnostic wording is not part of that behavioral contract.

Destination-focus checks activate the named navigation control with Enter and
verify heading focus and the live announcement, independently of shortcut bindings.
## Live local and remote freshness

The open repository updates itself. Local Git work done in a terminal — a
commit, a branch switch, a fetch that moves refs — is picked up by a debounced
filesystem watch, as is a deleted or moved repository, its return, and a
directory replaced at the same path: the watch follows the directory's identity,
so it re-arms on the replacement rather than on the tree that moved away. Reads
for one repository run concurrently while mutations serialize behind them.

No watch is subscribed on the Git directories until the watches are armed, so a
repository replaced during that window delivers no event at all. The directory's
identity is therefore rechecked after the Git directories are resolved, and a
resolution whose identity no longer holds is discarded and looked up again
rather than watched: the worktree, the parent, and the Git directories are all
armed from the same tree the identity names, so they cannot disagree about which
tree they describe. The retries are bounded, and a root still being rewritten
when they run out keeps no Git directory watch at all instead of one belonging
to a tree that is gone; the worktree and parent watches follow the path either
way, and the periodic sweep settles the target on a later turn.

On a platform that cannot watch a directory tree recursively, the periodic
sweep fingerprints the worktree and ref content instead, so a nested file or a
loose ref below `refs/heads/feature/` still schedules a refresh. A mutation
starts only after the reads its arrival cancelled have settled.

GitHub is read on a focus-aware cadence: a short interval while the window is
focused and visible, a slow inbox and repository refresh otherwise. A manual
refresh overlaps the automatic read already running, and only the newest of the
two publishes: the older one never overwrites fresher data, backoff, or the
credentials state with its own. Responses are read conditionally where GitHub
supports it, and failures back off exponentially. A secondary rate limit parks
the nonessential tier, a low remaining budget parks it too, and rejected
credentials stop polling until the person refreshes.

The same order also decides what a local-only refresh reuses. Reads claim their
place when they start, so an older read that answers after a newer one cannot
become the repository's confirmed payload: the next filesystem refresh shows the
newer pull requests and issues, not the answer that merely arrived last.

The inbox is read separately from the pull requests, so a successful issue
refresh never reports the pull requests on screen as freshly checked. When the
issue read fails, the last confirmed issues stay listed and the reason they are
unconfirmed is shown, instead of an empty inbox that looks current.

The title bar states remote freshness in words, with the age of the last
confirmed data, and says when local Git still works. Cached responses are
display only: the native stacks capability the snapshot asks GitHub about on
every interval is read with its validator, and review submission, publish,
and force-push always re-read GitHub live. A high-impact mutation that lost
its answer is never replayed on reconnect — it is listed with its reason until
dismissed.

Renderer checks distinguish the `/` in-view filter from the `Mod+K` command
palette. The safety suite advances pending hover timers after opening a
destructive dialog to verify that contextual cards cannot cover its warning.

### Merging a pull request

Merging uses GitHub's asynchronous merge API for a pull request that belongs
to a stack, and the operation is worth knowing about from the outside:

- The dialog previews the contiguous unmerged run below the selected pull
  request, and asks how GitHub should land it: the repository default, a direct
  merge, or the merge queue. A direct merge also asks for the method, because a
  queued merge runs the repository's own settings instead.
- The submitted stack is re-checked at the moment of the request. If a pull
  request joined or left the stack, or a head moved, since the preview, nothing
  is sent and the dialog says what changed.
- A merge GitHub is still running does not finish: the dialog shows it as
  running and keeps the request. While that run is in flight the dialog follows
  it; the moment it returns, what GitHub reports is what the dialog shows, because
  a read is newer than the progress the run pushed. **Refresh what GitHub reports**
  asks again at any time, including after the run has finished, and a read that
  fails keeps the last result GitHub published instead of blanking it.
- Every accepted request is written down before it is read, together with the
  pull request state a read confirmed, so a crash, a restart, an expired result,
  or a refresh that cannot reach GitHub still reports what was confirmed — merged,
  enqueued, or failed with GitHub's reason.
- The asynchronous merge API's terminal `enqueued` result does not track later
  queue membership. Git Stacks reads the pull request's lifecycle: merged,
  dropped when closed without merging, or unconfirmed while still open.
  An ejected pull request can remain open, so open is not proof of membership.
  Check the pull request timeline on GitHub for queue updates. An accepted
  enqueue is retained as evidence that its base ref has a queue. A failed
  refresh preserves the last confirmed outcome without claiming fresh data.
- A terminal result is written down even when GitHub returns no request UUID,
  which is what the immediate `200` for a pull request that is already merged or
  already in a queue carries. Nothing is polled for an identity GitHub never
  issued, and the accepted enqueue still proves the queue for that base ref.
- A merge GitHub refused stays a failure on every later read, with GitHub's own
  reason, instead of being summarised as an operation that changed nothing.
- GitHub owns what happens to a merged pull request. Git Stacks never deletes
  or retargets a local branch for you, and any base GitHub moved is reported
  for you to restack and publish.

## GitHub sign-in

Git Stacks signs in to GitHub with a GitHub App device flow, so no `gh`
executable is required. The registration is created out of band; the only value
the build needs is its public client id, given as `GIT_STACKS_GITHUB_APP_CLIENT_ID`.
Without it the account panel reports "not configured" and nothing else changes.

```sh
GIT_STACKS_GITHUB_APP_CLIENT_ID=Iv1... npm run dev
```

Device sign-in must be enabled under the app's `Optional Features`, and
user-to-server token expiration must stay enabled so a refresh token is issued.
`GIT_STACKS_GITHUB_TOKEN`, `GITHUB_TOKEN`, and `GH_TOKEN` remain an explicit
override: when one is set it is used instead of the app's own credential, is
never written to application state, and is not removed by sign-out.

Cancelling sign-in or starting a replacement retires the previous request; a
late device-code response cannot reopen it. If saving the account record fails
after its new credential was stored, that staged credential is removed and the
previous account remains selected.

## GitHub hosts

Git Stacks addresses one GitHub host at a time. `github.com` is the default, and
until a different host is chosen nothing changes: a github.com repository is
still answered by github.com. A GitHub Enterprise Server host is not a separate
mode. It is a host like any other, reached over HTTPS by its own host name.

### Choosing a host

Settings carries the GitHub host name. The field takes a bare host name such as
`ghe.example.com`. A pasted `https://` URL is normalized down to that host name;
anything else aimed elsewhere — a path, a query, another scheme, or embedded
credentials — is refused and the previous value stands.

A repository is answered by the host that owns it. A repository whose origin
remote is on one host is never answered by another host, and there is no
fallback to `github.com` or to any other service. A host that does not answer
is reported as unanswered, not quietly served by the default host.

### What is host-aware

Sign-in, repository discovery, clone URLs in both HTTPS and SSH form,
pull-request reads and writes, native stacks, and diagnostics all address the
host that owns the repository or the host that is configured. github.com is not
a separate code path; it is the same path with a different name.

### Links opened outside the app

Every **open in browser** control, the device sign-in page, and every pull
request, issue, stack, and check link cross the same boundary in the main
process, and the boundary is the host rather than the link. A link is opened
only when it is HTTPS, carries no credentials, and names `github.com`, the
configured host, or the host owning an open repository's origin. Public GitHub
links remain available when an enterprise host is selected. The host is compared whole, so its port is
part of it: an enterprise host configured as `ghe.example.com:8443` opens links
on that port, while the same name on another port, a look-alike that merely ends
in a trusted name such as `github.com.evil.example`, and any other host are all
refused. A refused link never reaches the operating system.

### Authentication

Each host needs its own credential. Sign-in uses the GitHub App device flow, and
the public client id is read per host:

| Host         | Client id environment variable                                  |
| ------------ | --------------------------------------------------------------- |
| `github.com` | `GIT_STACKS_GITHUB_APP_CLIENT_ID`                               |
| Any other    | `GIT_STACKS_GITHUB_APP_CLIENT_ID_<HOST>`, host as upper-case hexadecimal |

`ghe.example.com` therefore reads
`GIT_STACKS_GITHUB_APP_CLIENT_ID_6768652E6578616D706C652E636F6D`, named the
way a per-host token is: the host is not spelled out, so two hosts can never
produce one name, and a host with a custom port (`ghe.example.com:8443`) is
named as well as one without. There is no other name to fall back to — spelling
the host with underscores would let `ghe.a-b.example` sign in with
`ghe.a.b.example`'s registration, and spelling it with its port would produce a
name no shell accepts. A host with no client id configured reports "not
configured" and nothing else changes. Whether a host can complete a device-flow
sign-in depends on that host's configuration: a GitHub Enterprise Server
instance must have the device flow enabled under the app's optional features,
or no sign-in is possible.

`GIT_STACKS_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, and an authenticated
`gh` session are used when they are present. `gh` is optional and is never
required. A credential belongs to the host it was issued for and is never sent
to another host, so signing in to one host leaves the others unauthenticated.

### Capability matrix

This build reports the same five capabilities for every host, each from what
that host actually answered:

| Capability                   | What the host is asked                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| REST API                     | Whether the host serves REST requests for this repository              |
| GraphQL API                  | Whether the host serves GraphQL queries                                |
| Native stacked pull requests | Whether the host serves the resource that groups stacked pull requests |
| Repository discovery         | Whether the host can be asked which repositories are reachable         |
| GitHub App sign-in           | Whether this build has a device-flow registration for that host        |

Every host has its own endpoints: a GitHub Enterprise Server host serves REST
from `/api/v3` and GraphQL from `/api/graphql` on its own name, while
`github.com` answers from `api.github.com`. Neither is derived from the other,
and a request is never retried against a different path or a different host.

Credentials are per host. A sign-in belongs to the host that issued it and is
never sent to another, and an ambient `GIT_STACKS_GITHUB_TOKEN`, `GITHUB_TOKEN`,
or `GH_TOKEN` is a `github.com` credential: another host only receives a token
set in its own `GIT_STACKS_GITHUB_TOKEN_<HOST>`, where `<HOST>` is the host name
written as upper-case hexadecimal: `github.com` is
`GIT_STACKS_GITHUB_TOKEN_6769746875622E636F6D`. Two different hosts can never
produce the same variable that way, and the name uses only characters a shell
accepts. A `gh` child process is given that host's own token under the variable
the CLI reads for that host — `GH_TOKEN` for github.com,
`GH_ENTERPRISE_TOKEN` for any other — and none of the unscoped ones. A
credential exchange never follows a redirect, so a host cannot forward a
refresh token somewhere else.

| State             | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `supported`       | The host answered and offers the capability.                                                                         |
| `unsupported`     | The host answered and does not offer the capability.                                                                 |
| `unauthenticated` | The host answered, but no credential for that host is available.                                                     |
| `unreachable`     | The host did not answer.                                                                                             |
| `not-configured`  | A prerequisite is missing, such as no GitHub App client id for that host, or no configured way to ask a host at all. |
| `unknown`         | The capability has not been established, or the host answered something this build could not read.                   |

Repository discovery is reported from an actual discovery run, not from the
API answering at all: a host that serves its API root and refuses a repository
collection reports discovery as it is. A capability this build never asks about
is never reported as either.

`unsupported` is only ever reported when the host answered. A host that does
not answer is `unreachable`, never `unsupported`; a timeout is not evidence
that a capability is missing.

### Native stacks

On a host whose stacks resource answered, stacks behave as they do on
`github.com`. On a host that does not serve that resource, the local stack view
and ordinary chained pull requests — each pull request based on the branch
below it — keep working, and the app never labels such a stack a GitHub stack.
Nothing in that state claims GitHub grouped those pull requests: the grouping
is the local one, and the app says which of the two it is showing.

### Rulesets, merge queue, and version-dependent behaviour

This build does not detect or claim ruleset or merge-queue support on any host,
including `github.com`. GitHub Enterprise Server versions differ from one
another and from github.com, so the app reports what a host answered and never
maps a version number to a feature. Whether a given instance offers a feature
depends on that instance's version and its configuration, not on anything this
build knows in advance.

Per-host and per-repository capability state is visible in Settings and in
Diagnostics.

## Settings

Settings is reachable from the command palette (**Settings…**). Preferences are
stored in `settings.json` under the app's user-data directory, which main owns
and validates; the renderer never chooses or writes that path.

| Setting                              | Effect                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git to run                           | Chooses the bundled runtime or the system `git` for every Git operation.                                                                                                                                                        |
| GitHub host                          | The GitHub host every sign-in, discovery run, and API request addresses: `github.com` or an enterprise host name (an optional port). Each repository's own remote decides the host in use.                                      |
| Editor                               | Program used by **Open in editor** in the file inspector. Empty means the platform default.                                                                                                                                     |
| Merge tool                           | Program Git runs to resolve a conflict. Takes precedence over `GIT_MERGE_TOOL` and `merge.tool`. Empty means Git's own configuration.                                                                                           |
| Default pull strategy / merge method | Seeds the workflow dialog; still changeable per operation.                                                                                                                                                                      |
| Background refresh                   | Seconds between automatic refreshes of an open repository. `Off` refreshes only on request.                                                                                                                                     |
| Theme                                | `Match system`, `Light`, or `Dark`.                                                                                                                                                                                             |
| Reduce motion                        | Removes non-essential transitions regardless of the system setting.                                                                                                                                                             |
| Include local paths                  | Lets a support bundle name the Git executable path. Nothing else widens.                                                                                                                                                        |
| Shortcuts                            | Chord editing with conflict detection.                                                                                                                                                                                          |
| Update channel                       | The channel **Settings → Updates** follows: `stable` for signed releases for everyone, `beta` for the pre-release channel, which moves faster and changes more often. It defaults to `stable` and persists until it is changed. |

The GitHub host accepts a bare host name (a pasted `https://` URL is normalized
down to its host) and refuses a path, a query, a non-HTTPS scheme, or embedded
credentials. Changing it retires the sign-in for the previous host and forgets
what this build had learned about that host.

A value is validated before use. Editors and merge tools are restricted to a supported program allowlist (`code`, `cursor`, `vim`, `nvim`, `kdiff3`, etc.); arbitrary shell interpreters or commands with arguments are refused. Editor launching enforces repository containment following symlinks. An unreadable field falls back to its default and is reported on the Settings surface; the rest of the file still applies. A file that is not valid JSON is replaced by defaults on the next save. All settings reads and modifications are serialized through an atomic transactional queue.

**Merge tool names are mapped to the tool Git runs.** A program name is not
always a `git mergetool --tool=` id: `bcompare` is launched by Git's `bc3`
backend. Each supported program therefore resolves to the backend Git ships, and
the conflict view names the program you chose while the action runs that id. A
program Git ships no backend for — an editor such as `code` — becomes usable
only once your own Git configuration defines a command for it:

```sh
git config mergetool.code.trustExitCode true
git config mergetool.code.cmd 'code --wait "$MERGED"'
```

`mergetool.<name>.cmd` is the whole requirement. `mergetool.<name>.path` alone
does not define a custom tool — it only replaces the executable of a tool Git
already knows how to invoke, and `git mergetool` stops at
`mergetool.<name>.cmd not set`. Until the command exists the conflict view
reports the tool as unavailable and names that reason, rather than offering a
tool that fails on the first conflict. A tool named by `merge.tool` or
`GIT_MERGE_TOOL` is already a Git tool id and is passed through unchanged.

**The one-time shortcut import.** The build before this one kept shortcuts in
web storage. Those bindings are offered for import once, at startup, as an
intent rather than an assignment: main commits the import only if the settings
file still holds the untouched state the offer was decided from — the migration
marker unset and the stored chords still the defaults. A reset or a shortcut
edit that reaches the file first therefore wins, and the pending import is
declined rather than restoring old bindings over a newer choice. Either outcome
drops the stored copy: a committed import cannot run twice, and a declined one
is a decision, not a retry. The session's write count is what tells a reset
apart from an untouched file, because a reset restores exactly the defaults the
import is qualified against.

**Handled failures are recorded, redacted.** Every main-process request is
registered through one place, so a failure it handles leaves a bounded in-memory
record of the scope that failed and the message the window was about to show —
first line only, capped, and passed through the bundle's secret redaction before
it is ever written. Nothing else is kept: no repository, ref, file, command, or
token. A request from outside the app is refused rather than failed, and a
cancelled operation is the answer the user asked for, so neither is recorded.
This build collects nothing and sends nothing: there is no telemetry endpoint
and no crash upload, and no setting enables one. The only artifact is the
support bundle you create yourself.

### Settings policy

`GIT_STACKS_SETTINGS_POLICY` names a JSON file whose `locks` object fixes
settings for a managed computer:

```json
{ "locks": { "git.useSystemGit": "Managed machines use the system Git" } }
```

A locked setting is disabled in the surface and cannot be written, including
through a direct file edit. Re-saving the value the lock already fixes is
allowed, so an unrelated edit is never blocked. A policy file that cannot be
read or that names a setting this build does not know holds **every** managed
setting at its current value and reports the reason, rather than reading as
"nothing is locked".

```sh
GIT_STACKS_SETTINGS_POLICY=/etc/git-stacks-policy.json npm run dev
```

### Support bundle

**Create support bundle** previews first: every section is listed with whether it
is included and why. The bundle is assembled from named fields and never
contains access tokens, source contents, diffs, branch or pull-request text, or
raw GitHub API bodies — not even when local paths are included. Diagnostic probes
use fixed, non-destructive read commands with sanitized outputs and error codes.
The export binds to the preview snapshot and verifies live settings immediately
before writing: if path consent is revoked while the save dialog is open, local paths
remain withheld in the saved bundle.

The saved file is owner-only (`0600`) whether it is created or replaced. A
mode given to a write applies only when the write creates the file, so
exporting over an existing world-readable `git-stacks-support.txt` would
otherwise leave it readable by everyone while its contents were replaced. The
file is truncated first and its mode set before any content is written, so new
content is never readable under the permissions the file arrived with.

Recent failures is included only when something was recorded. It carries the
main-process failure summaries described under **Handled failures** above, and
they pass through the same secret and path redaction as every other field.

## Signed updates

A release is a signed manifest plus the artifacts that manifest names. The app
authenticates the manifest with a release public key compiled into the build
before it fetches anything the manifest names, and then checks the downloaded
artifact against that same manifest before it installs anything. No repository is
read or written on any path through this.

Checking for an update sends nothing about the person or their machine. It reads
a published file from this project's release location, and there is no telemetry
or crash upload behind it.

### What a release reads before it publishes

The next manifest in a channel is minted from the manifest that channel already
publishes, and that one is read as a signed fact or not at all: the producer
downloads the manifest _and_ its detached signature and verifies the signature
over the exact bytes against the release keys it trusts. An unsigned asset, a
signature from another key, or a manifest that does not match its signature
stops the release. It is not treated as an empty channel, because a sequence
minted from a rewritten feed can sit below the high-water mark installations
have already seen, and those installations could then never update again.

A published manifest that has since expired is still read for its sequence and
version. Expiry says a feed should be refreshed; it does not say the sequence it
used never happened. Only the absence of the whole pair — a channel with no
manifest and no signature — means the channel is new.

A release that cannot read its channel does not publish. A network failure, an
expired token, or a rate limit is not evidence that a channel is empty, and
restarting a sequence at one would be a replay the app is right to refuse.

### How a release is published

Publishing a GitHub release runs
[`.github/workflows/release-desktop.yml`](.github/workflows/release-desktop.yml)
in three jobs. The packaging job refuses to start unless the release tag is `v`
followed by the version in `package.json` and every signing prerequisite is
present, injects the release update key into the build, runs the test suite, and
packages macOS, Windows, and Linux. It uploads only what it verified: the macOS
build must pass `codesign --verify` with a `Developer ID Application` authority, a
`stapler`-validated notarisation ticket, and the expected team identifier, and
the Windows installer is refused unless `Get-AuthenticodeSignature` reports
`Valid`. Provenance is attested for the uploaded files, and a separate job
refuses a known-vulnerable dependency and keeps a dependency inventory with the
run.

The publishing job then mints, signs, and re-verifies the channel's manifest and
publishes it with its detached signature and the installers it names, on that
channel's moving release tag, so a channel's feed address never has to be
rebuilt:

| Channel  | Moving release tag | Manifest             | Detached signature       |
| -------- | ------------------ | -------------------- | ------------------------ |
| `stable` | `updates-stable`   | `update-stable.json` | `update-stable.json.sig` |
| `beta`   | `updates-beta`     | `update-beta.json`   | `update-beta.json.sig`   |

A prerelease on GitHub publishes the `beta` channel; a full release publishes
`stable`. The moving tag only ever moves forward along this repository's history,
and a tag that has been moved elsewhere stops the release instead of being
overwritten. The installers are uploaded before the manifest that names them and
the signature, so the feed is complete or it is not moved. Before any of it is
published, the manifest and its signature are read back from disk, the signature
is verified again with the key this release injected, every installer is
re-hashed, each packaged build's own key set is compared with the one being
signed with, and each artifact's provenance is verified.

A manifest is issued, never edited in place. Its signing key is the
`UPDATE_SIGNING_KEY` repository secret, and the packaging job injects that key's
public half into the app it builds, so a released build is the only build that
carries one. Nothing in the workflow generates a key, and every step that needs
one fails closed without it: a key this repository made up would verify against
nothing an installed build trusts, and a manifest signed by a key no build
carries could be installed by no one. The repository itself holds no key
material — `resources/update-trusted-keys.json` is committed empty, because a
public key committed here would be trusted by every packaged build built from
it. Each channel's sequence is read back from the manifest that channel already
publishes, so it only ever rises, and each installer is published under a plain
asset name with no spaces, because the URL the manifest names has to end in
exactly the file name it describes.

Every field is required: `schema`, `channel`, `version`, `sequence`, `issuedAt`,
`expiresAt`, `notes`, `rollbackOf`, and `artifacts`, where each artifact carries
its `platform`, `arch`, `kind`, `fileName`, `url`, `sha256`, and `size`. A
manifest carrying a field this build does not know is refused rather than
parsed, because a field the code does not check is a field a forger could use.

### What the app does with a release

The order is the point, and it belongs to the app rather than to the feed:

1. Nothing is fetched until the build has a key to verify with. A packaged build
   takes its keys only from the key set compiled into its own bundle, and a
   packaged build with no such key — every one not put together by the release
   job — reports updates as not configured and never opens a socket.
2. The manifest and its detached signature are read, and the signature is
   verified against the manifest bytes exactly as they arrived. Only bytes a
   trusted key actually signed are ever parsed, so a URL, a file name, or a
   version taken from an unsigned manifest is not read.
3. The rules the signature does not cover are applied: the manifest publishes the
   channel this build follows, it is inside its 30-day lifetime, it is not older
   than the newest release sequence already offered here, it names a build for
   this platform and architecture, its version is newer than the running build or
   is an authorised rollback, and every URL it names is HTTPS on this project's
   release location and under the channel's release path, ending in the file name
   the manifest describes.
4. The offered artifact is downloaded, and the download is discarded unless its
   byte count and SHA-256 match what the signed manifest recorded. The file is
   written under a temporary name and only moved into place once both match, so
   nothing downstream can read a partial or substituted file. A redirect is
   followed only to this project's own release location or to the one release
   asset host GitHub serves the file from, so a signed manifest cannot send the
   download somewhere the manifest itself could not have been fetched from.
5. The download is proved once more, and the build handed to the platform
   installer is copied into owner-private handoff storage: a directory in this
   app's own state entered by its owner alone on a POSIX system, and a file
   created exclusively, so an existing destination is refused rather than
   written through. That reduces interference with the download between the
   digest check and the install, and it catches a file that changed on disk in
   that window. It is not a lock, it does not bind the check to an immutable
   object, and it says nothing about a process running as this same user — a
   backup or sync agent commonly is one.
6. Before anything is run, the download must carry the platform's own signature
   and the identity of the app that is already installed. An installer signed by
   anybody else is refused even when its digest matches the manifest exactly. A
   macOS disk image is checked for its own signature and team, and assessed by
   Gatekeeper, before it is mounted; the application inside it is checked again
   separately, and the copied bundle is checked a third time before it replaces
   the running one. An installer that cannot be started is a refusal, not an
   install: this app stays open rather than closing with nothing to finish the
   work. On macOS the installed bundle is moved aside rather than overwritten in
   place, so a failure part-way through leaves a working app to go back to;
   where the platform installer has to replace files this process is running
   from, the app closes and the installer finishes on its own.

Once the platform installer owns the files, the update cannot be stopped: a
cancel or a channel change at that point is reported as too late rather than
pretending to have taken effect.

The updater writes only to the app's own user-data directory, and on macOS to a
staged and a moved-aside copy of the bundle beside the installed one, both
carrying this app's own prefix. It never reads or writes a repository.

**What has not been observed here.** No signed macOS or Windows installer has
been installed by this work: that needs an Apple Developer ID and a Windows
signing certificate, neither of which this repository holds. The digest re-check
in step 5, the native signature checks in step 6, the handoff, and the
Gatekeeper assessment of a disk image are all code paths that only run on a
platform with a real signature, so their behaviour against a real signed
installer is unproven and is not claimed. The handoff's directory and file modes
describe POSIX protection; the equivalent Windows isolation has not been
independently verified here either.

### Channels

`stable` follows signed releases for everyone. `beta` follows the pre-release
channel, which moves faster and changes more often. The channel is chosen in
**Settings → Updates** and stored as `updates.channel` in `settings.json`. It
defaults to `stable` and only the person changes it, so a build keeps following
the channel it was set to rather than drifting to whatever was published last;
moving to `beta` is an explicit choice, not something a prerelease makes on your
behalf. The newest release sequence offered on each channel is remembered
separately, so returning to a channel cannot walk back to a manifest older than
one this computer has already been offered there. Changing the channel starts a
different feed with its own sequence history, and the previous offer is dropped
rather than kept.

### Rollback

A rollback is a new signed release, not a reissued old one. It needs all three of:
a release sequence higher than the newest this computer has been offered on that
channel, a version lower than the release it replaces, and `rollbackOf` naming
that newer release. The app then presents it as an authorised rollback of that
version rather than as an ordinary upgrade. It is never a silent downgrade: a
manifest whose version is not newer than the running build is refused as
`not-newer` unless it carries exactly that authorisation, and a manifest older
than the newest release sequence already offered on that channel is refused as
`replayed` even when every other field matches. A manifest at the same sequence
is offered again, so an offer that was never taken survives a restart and still
cannot be replayed backwards. A rollback replaces the installed application and
nothing else: it does not touch a user's repositories, working trees, branches,
or uncommitted work.

On the publishing side, a rollback is a release of an older version that names
the version it replaces through the `UPDATE_ROLLBACK_OF` repository variable. A
release of an older version without that variable is refused by the release job
rather than published as a quiet downgrade, and the sequence still rises, so the
rollback reaches the installations that have already seen what it withdraws.

The release job enforces the same rule from its side: a version lower than the
one that channel already publishes is refused unless `UPDATE_ROLLBACK_OF` names
exactly that version, and a `rollbackOf` on a release that is not a downgrade is
refused too. A downgrade can therefore never be published by accident, only
chosen.

### Platform support

| Platform | Package                                              | Signing                                                                                              | Updated in place                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | `dmg`                                                | Developer ID Application, notarised and stapled                                                      | Yes. The download is checked against the installed app's own signing identity, team, bundle identifier, version, and architecture, staged beside the running bundle and proved again there, then moved into the bundle's place and the app restarts into it. |
| Windows  | NSIS installer                                       | Authenticode, verified before it runs                                                                | Yes. The installer's Authenticode identity is compared with the installed app's own; the installer is then started, this app closes, and the update finishes on its own.                                                                                     |
| Linux    | AppImage, also covered by the packaged desktop smoke | No platform signature exists to check; the release's own manifest signature is what authenticates it | No. An AppImage is a single file the person runs from wherever they put it, with no installed copy to replace and no signature to check before running it, so in-place updates are unsupported there and a download is offered to run instead.               |

The release states the Linux policy in its own log on every Linux build — "linux:
best-effort artifact — built, published and signed, never updated in place by the
app" — and that step fails the release if `src/main/update/install.ts` ever grows
a Linux entry, so the line cannot quietly stop being true.

No signed macOS or Windows artifact has been produced, and none can be produced
from this repository as it stands. Signing needs a code-signing certificate
(`CSC_LINK`, `CSC_KEY_PASSWORD`), and macOS notarisation needs an Apple
developer account (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
The release job fails closed when any of them is missing: it stops before
packaging rather than publishing an unsigned artifact under a release name. No
release has been published and no manifest has been signed, and this repository
carries no release key, so no build of it can currently be offered a verified
update at all.

### An unsigned build is not a release

`npm run dist` run locally packages the app without a certificate, so the output
is a development package, not a release: it is not signed, not notarised, not
attested, and not offered to anyone else. It also refuses to install updates. A
packaged build takes its trusted keys from its own bundle and nowhere else, and a
local package carries none because only the release job injects one, so it
reports updates as not configured, and the app will not fetch a manifest or
install anything. An unpackaged `npm run dev` build may instead take one key
from `GIT_STACKS_UPDATE_KEY_ID` and `GIT_STACKS_UPDATE_PUBLIC_KEY` for fixtures,
and **Settings → Updates** says so when it is running on such a key; that path
does not exist in a packaged build, because whoever starts a process decides its
environment.

### Keeping the release key trusted

A released build's trusted public key is compiled into the main bundle during
packaging, so nothing on a user's machine can add, drop, or change it after
installation. Rotating it is therefore a shipped change with an overlap window,
not a switch someone can throw on an installed app. The new key is injected into
the next release alongside the old one, and the old key stays trusted for as long
as an artifact it signed can still be offered — a manifest stops being offered 30
days after it was issued, so the window has to outlast the manifests in flight.
Only then does the retiring key's `validUntil` pass, and a key outside its
validity window is never consulted at all, so the old key stops verifying the
moment it is retired rather than whenever someone notices. A private key is never
compiled into a build, never committed to this repository, and never written to a
CI log: the release job signs with a secret held by the repository owner, and a
build only ever carries the public half of it.
## Onboarding

With no repository open, the window offers three ways in, and all of them end
with an ordinary Git working tree:

- **Search GitHub** lists the repositories the signed-in credential can reach,
  paged through the REST API. Selecting one opens a clone form with a
  destination folder, HTTPS or SSH, and an optional shallow clone. Before
  anything is written, the dialog shows the exact `git clone` and
  `gh repo clone` commands and copies either one to the clipboard.
- **Add local repository** opens the folder picker and adopts whatever is
  there. It is read, never written: adding a repository never rewrites its
  config, refs, or files.
- **Drop a folder** on the window. Drops are ignored while a repository is
  already open so a stray drag cannot switch workspaces.

The clone is built in an isolated staging folder (`.git-stacks-clone-${token}`)
beside the destination, in the same filesystem, and is promoted into place only
after it reads as a finished clone. Promotion is the single commit point, and it
is one atomic rename that refuses to replace anything already there:

- Darwin: `renamex_np(RENAME_EXCL)`
- Linux: `renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE)`
- Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`

Node exposes none of these, so they are reached through a small helper,
[`native/promote-repository.c`](native/promote-repository.c), compiled for the
host by `npm run build:promotion-helper` and shipped beside the Git runtime as
`resources/promote` in the packaged app. It does one syscall and then exits; it
never looks at the destination before renaming, so there is no window between
the check and the move. A destination that is already there — an empty
directory, a populated one, a file, a symlink — makes the rename fail and is
left exactly as it was, and the clone is refused as a collision rather than
clobbered, merged into, or emptied.

There is no fallback path. A kernel or filesystem without a no-replace rename,
a build whose helper is missing, and a destination on another volume are each
reported as refusals that name what happened, because the alternative —
checking whether the destination is free and then renaming over it — would
destroy a directory another program owns in the window between the two steps.
Nothing is written in any of those cases, and the staging folder this clone
minted is the only thing removed.

Cancellation is honoured up to the commit point and no further. A cancel that
arrives while the Git transfer runs, after the Git process exits, or during the
post-clone checks discards only the staging folder this clone created — its
name carries a random token minted for that clone — and registers nothing. Past
the commit point the clone is a finished repository in the folder the person
chose, so the switch that opens it and writes it to recents runs to the end: a
cancel that lands there completes the switch and reports the clone as finished.
Nothing removes a promoted folder afterwards, which is why recents and the
active repository can never name a folder that was deleted under them. An
activation that fails after the commit point is reported with the path left in
place rather than removing a repository the person asked for.

The onboarding pane also reports what this machine can already do with Git: the
commit identity, the default branch, whether a credential helper is configured
for HTTPS, and whether an `ssh` client is on `PATH`. Those are read-only facts.
Git Stacks never sets a Git credential helper, `user.name`, `user.email`, or
`init.defaultBranch`; a private HTTPS clone needs a credential helper the user
already has, and the dialog says so rather than configuring one.

Repository discovery lists accessible repositories with pagination, bounded by
GitHub's hard limit of 1,000 search results (10 pages of 100 items). Searches
returning `incomplete_results` (due to GitHub query timeouts) or exceeding the
1,000-result cap surface clear inline warnings prompting the user to refine
their search. Small non-empty repositories whose size rounds down to 0 KB are
accurately distinguished from unborn or unpushed empty repositories.
Neither endpoint reports a repository the credential cannot read, and a
response that omits the optional `permissions` object is a hit, not a refusal:
it is listed, with its push access treated as unproven and the row marked read
only. Only a malformed entry — one that names no clonable `owner/name` — is
dropped.
Discovery sends one `Authorization` header to the selected host's API base (`api.github.com` for github.com) and nothing
else. Access tokens never reach a command line, a log, the renderer, or a
remote URL: the app-signed transport is used directly from the main process.

## Performance budgets

Git Stacks is used on repositories far larger than the ones it was built
against. The budgets below are exported from
[`src/shared/performance.ts`](src/shared/performance.ts) and are the single
value used by the main process, the renderer, the tests, and the benchmark
harness. There is no second copy of a budget anywhere.

| Budget                   | Value         | Enforced by                                |
| ------------------------ | ------------- | ------------------------------------------ |
| `STARTUP_BUDGET_MS`      | 10000 ms      | `bench:performance` → `startup`            |
| `SNAPSHOT_BUDGET_MS`     | 4000 ms       | `bench:performance` → `snapshot`, `status` |
| `HISTORY_BUDGET_MS`      | 2000 ms       | `bench:performance` → `history`            |
| `COMMIT_DIFF_BUDGET_MS`  | 3000 ms       | `bench:performance` → `commit-diff`        |
| `INTERACTION_BUDGET_MS`  | 250 ms        | `bench:performance` → `interaction`        |
| `LIST_PAGE_SIZE`         | 200 rows      | every repository-sized list                |
| `DIFF_PAGE_SIZE`         | 1000 lines    | `DiffView`                                 |
| `MAX_STATUS_BYTES`       | 8 MiB         | `listStatus`, cut on NUL record boundaries |
| `MAX_HISTORY_BYTES`      | 1 MiB         | `getHistory`, cut on NUL record boundaries |
| `MAX_DIFF_BYTES`         | 4 MiB         | `getCommitDiff`, `changedDiff`             |
| `MAX_FILE_BYTES`         | 2 MiB         | working-tree file preview                  |
| `GIT_CONCURRENCY`        | 8             | `mapWithConcurrency`                       |
| `SNAPSHOT_BRANCH_BUDGET` | 1500 branches | per-branch analysis in `getSnapshot`       |

### Benchmarks

```sh
npm run build
npm run bench:performance
```

The harness builds its own fixtures with the local `git` binary — a working tree
of 100,000 files, 3,000 branches with distinct non-default tips (including
450 recorded stack members), a 5,000-commit history, and a commit touching
5,000 files. The snapshot benchmark exercises actual parent comparisons rather
than sharing the default tip across the fixture's branches. No clone, token, or
private repository is involved. Compare runs on the same runner class and
benchmark version; older measurements with different definitions are not
carried into the current trend.

The `startup` measurement runs the built Electron app against the 3,000-ref
fixture. It starts before process launch and ends after the automation clicks
the pre-seeded recent repository and its first 200 branch rows complete two
animation frames. The `interaction` measurement starts at an actual input event
in the “Filter current view branches, files, and pull requests” field, not the
command palette, and ends after the filtered branch result completes two
animation frames. The separate `diff-render-ssr` measurement is server-side
rendering cost for a 1,000-line diff preview; it is not an input-to-paint budget.
CI installs `xvfb` and `xauth` on the self-hosted Linux ARM64 runner, builds the
app, and runs Electron under Xvfb. The runner needs passwordless `sudo` and
Debian-compatible `apt-get`. Local runs need a display server.
Compare trend results on the same runner class and Git/Node versions, since
filesystem and process startup costs vary by machine.

It writes `benchmarks/latest.json` and appends one line per run to
`benchmarks/trend.jsonl` (capped at the last 200 runs). The `Performance budgets`
workflow runs the harness on every push and pull request, uploads `benchmarks/`
as an artifact, and fails the job when any measurement exceeds its budget.

### What the hot paths no longer do

**One config read instead of two per branch.** `getSnapshot` issued
`git config --get branch.<name>.parent` and `branch.<name>.parentTip` for every
local branch. It now reads them all in a single
`git config --null --get-regexp` pass, using the same idiom the GitHub
integration already used for tracked pull request numbers.

**A concurrency ceiling instead of one process per branch.** Parent inference
probes distinct tips in batches; direct descendants of the default branch need
no individual merge-base process, while deeper histories use the existing
merge-base fallback. The same batched parent list answers the behind-count:
a branch whose recorded parent commit is one of its tip's parents already
contains that commit's whole history, so it reports zero commits behind with no
`rev-list` process at all. Every other branch still measures its behind-count
through `mapWithConcurrency` at `GIT_CONCURRENCY`, rather than forking one
process per branch at once.

**Behind counts answered from the parent edges already read.** The same batched
`log --no-walk` pass that infers a parent records each tip's direct parents, so
a base a branch already contains — a stack one commit down, or a whole recorded
stack — is behind by exactly zero and needs no `rev-list` of its own. A base
those edges do not prove is still counted by Git, one process per branch under
`mapWithConcurrency`, so the number a branch reports is always the number
`git rev-list --count <branch>..<base>` returns.

**A branch-analysis budget.** `SNAPSHOT_BRANCH_BUDGET` caps per-branch
merge-base and behind probes. A branch consumes one budget slot across both
phases: admission for parent inference also reserves its behind comparison.
Beyond the budget, recorded parents remain available, but inferred parents or
behind counts can be unknown.
`snapshot.limits.branchesSkipped` counts branches with incomplete analysis;
the Branches view states this limit rather than claiming an exact comparison.

**One index and HEAD-tree read instead of one process per batch of paths.** To
mark submodules and sparse-excluded paths, `getSnapshot` asked `getIndexEntries`
and `getHeadGitlinks` about every changed path. Each of those split the path
list into batches of at most 1024 pathspecs and forked one process per batch,
sequentially, so a working tree with 100,000 changed files forked ~200
processes that mostly returned nothing: the paths were untracked, and the
benchmark fixture has no commit, so `HEAD` had no tree to read at all. Both now
read the whole repository once in a single process and filter in memory:
`git ls-files -v --stage -z` for the index, and `git ls-tree -r -d -z HEAD`,
which recurses only into directories and so reports gitlinks without listing
every blob. The two reads are independent, so `getSnapshot` runs them together
and settles both before a rejection escapes. The batched pathspec read is still
used when it answers in a single process, so a caller that asks about one file —
a diff preview, a staging guard — does not read a large repository's whole
index. Both whole-repository reads stay capped at `MAX_STATUS_BYTES`. A cap that
truncates one falls back to the batched pathspec read, asking again about every
requested path rather than only the ones still unresolved. An unmerged path
occupies one `ls-files` record per stage, so a cap landing on a NUL boundary can
leave the straddling path half-read — and a half-read path is one the "still
unresolved" filter would have kept, reporting a gitlink as an ordinary file. The
fallback is rare (it needs a listing past the cap) and reuses the batched reads
this path used before. An unborn `HEAD` is a complete answer rather than a
truncated one, and is not retried.

**Streaming reads instead of buffer-then-copy.** `executeCapped` retains at most
its byte cap while the child process runs. Cancellation sends TERM, escalates
when necessary, and waits for the process to close before releasing the read
queue. Record-shaped output (status, history) is cut on NUL boundaries; history
accepts only rows with all five terminated fields.

**Incremental lists.** Branch, changed-file, pull request, stash, and
stack-member lists mount 200 rows initially, expand to 400 on the first reveal,
then slide a bounded two-page window on deeper navigation. Previous controls
return to earlier rows rather than accumulating the entire traversed prefix.
History holds one fetched page of at most 50 commits and navigates older/newer
pages. Diff regions expand from 1,000 to at most 2,000 mounted lines, then slide.
Branch-tree connectors and cycle/missing-parent warnings use each branch's
position in the complete list even after the two-page window slides.

Arrow keys address the mounted rows in mounted-window coordinates, so a move made
after the window has slid lands on the neighbouring mounted row rather than
re-basing onto the whole list. Only Home and End name the whole list, and they
slide the window to mount the row they land on.

### Stale results and cancellation

`RequestGate` (renderer) and `RequestRegistry` (main) together guarantee that a
result computed for a repository, ref, or commit the window has already left is
never applied to the one it now shows:

- `openRepository` resets the gate before awaiting, retiring every in-flight
  refresh, and the main process aborts old reads before waiting for the
  repository-switch operation to enter its queue.
- `readRepository` re-checks the active repository after the read completes, not
  only before it starts.
- A newer history page or commit diff claims the same request id, which aborts
  the previous one. Cancelled reads reject with `CommandCancelled`; the renderer
  drops them instead of showing an error.
- A read cancelled while still queued in `RepositoryOperations` never starts.
- Cancelling a file view also stops its fingerprint scan and waits for both
  diff commands and the fingerprint task to settle before the next repository
  operation starts; mutation preflight reads remain non-cancelable.
- A mutation is refused only while another mutation or a repository switch is
  pending, or once the repository it was asked for is no longer the one the
  window shows — a switch can complete while the action is still waiting for
  the background reads it ends. It is never refused because a read is still
  being answered. Reads and writes share one queue, so a mutation submitted
  during a read runs after it, and no other write or switch can interleave with
  it; what the action then checks is that action's own business, unchanged by
  the wait. A repository switch refuses mutations for as long as it is pending,
  so an action asked for against the repository being left cannot land on the
  one the window opens next.

### Documented limits

These are the extreme cases the app states rather than hanging or crashing on.

- **A changed-file listing past 8 MiB.** The listing is cut on a record boundary
  and `limits.filesTruncated` is set. The Working changes view says how many
  files it is showing and disables bulk stage, bulk unstage, and stash, because
  acting on a partial listing would silently skip files. Inspect individual
  files, or use an editor or the command line for the rest.
- **More branches than `SNAPSHOT_BRANCH_BUDGET`.** Reported through
  `limits.branchesSkipped`, as described above.
- **A diff past `MAX_DIFF_BYTES` or a file past `MAX_FILE_BYTES`.** The
  backend retains only the bounded preview. The desktop diff view separately
  limits rendering to the first 512 KiB of text and mounts at most 2,000 lines
  after reveal. Truncated previews are labelled; inspect the complete change
  in an editor.
- **History is paged, not accumulated.** A repository with a million commits is
  navigable one page at a time without retaining previous pages.
- **An individual history entry over 1 MiB.** The reader reports a preview
  limit error instead of presenting a partial entry as the end of history.
- **Pull request enumeration follows `gh`.** The renderer reveals pull requests
  incrementally; the main process still asks the `gh` CLI for the origin's open
  and tracked pull requests in one paginated call.

## Renderer verification

These fixtures exercise Git Stacks, not the Journey prototype. Production React components, tokens, and the real `App` are imported by a separate Vite entry point under `tests/renderer`; the packaged renderer does not expose a fixture route or install a fake desktop API.

### Fresh checkout

Use Node 24 and the committed `package-lock.json`:

```sh
npm ci
npx playwright install chromium
npm run gallery
```

Open the loopback URL printed by Vite. No GitHub credentials, Electron preload, personal repository, external font, or chat artifact is required. The deterministic `DesktopAPI` double records requests in memory; it never executes Git, authenticates, or opens external URLs. Treat its action history as evidence of renderer dispatch only, not proof that a Git operation succeeds. The packaged smoke covers real local Git separately.

Append `#/index` for the scenario directory. App scenarios use `/?scenario=shell-connected#/app`; the gallery activates the real App's Open local repository control to load the deterministic snapshot. `shell-no-repository` and `shell-loading` intentionally stay on the no-repository/loading surface. Component routes retain `#/design-system-controls`, `#/design-system-shell-specimen`, `#/design-system-data-specimen`, and `#/design-system-dialog-specimen` in this separate gallery only.

The typed control surface is `window.fixture`: `actions` and `externalUrls` record dispatch; `calls` records reads and writes; `hold(method)` and `release(method)` control in-flight requests; `failNext(method, message)` rejects one request; `setScenario(name)` remounts the App against another deterministic snapshot. This API exists only in the gallery. `manifest.ts` lists all scenario names; `scenarios.ts` owns their typed data.

`pull-requests-checks-detail` and `pull-requests-checks-stale` are the checks
drill-down: the panel behind the row badge lists every check GitHub reported for
the pull request head with its source (check run, commit status, workflow run,
or expected), its own state, and whether the repository requires it, in separate
Required / Informational / Unproven groups. It also states its own currency, so a
report last read before a refused or rate-limited refresh reads as stale with the
reason rather than as the current state. `Refresh checks` forces a re-read,
`Watch checks` re-reads on an interval while the panel is open, and `Rerun`
appears only where the read proves the account may run workflows. The fixture
records `pullRequestChecks` and `rerunPullRequestCheck` in `window.fixture.calls`.

Ordinary scenarios keep the row's check state when its drill-down is opened or
refreshed. A `none` state produces an empty report, not a synthetic passing run.

Workflow reruns require an explicit association with the selected pull request,
not merely a matching commit. Push-only CI remains visible without a rerun action.
Actions check runs join workflows by their check-suite IDs, never details URLs.
Effective required-workflow rules leave requirements unknown when their policy
cannot be represented by status-check contexts.

The conflict fixture implements `conflictView` with index stages and a captured fingerprint. The safety scenario verifies that choosing incoming content edits only the draft, then `resolveConflict` sends that content and fingerprint when the user explicitly stages it.
History recovery coverage holds a commit diff while a repository refresh changes
HEAD and fails the replacement history read; the branch picker and reload control
must remain usable, and retrying must restore the commit list.

| Area      | Gallery scenarios / exercised controls                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell     | `shell-no-repository`, `shell-loading`, `shell-connected`, `shell-long-content`, `shell-offline`; the real Hide details pane control                                                                                                                                                                                                                                                                   |
| Ancestry  | `ancestry-linear`, `ancestry-branching`, `ancestry-deep`, `ancestry-remote-consolidated`, `ancestry-missing-parent`, `ancestry-cycle`, `ancestry-requires-restack`                                                                                                                                                                                                                                     |
| Changes   | `files-clean`, `files-staged`, `files-unstaged`, `files-renamed`, `files-untracked`, `files-conflicts`, `files-truncated`, `files-long-content`                                                                                                                                                                                                                                                        |
| History   | `history-loading` (`release('history')` to finish), `history-error`                                                                                                                                                                                                                                                                                                                                    |
| PRs       | `pull-requests-lifecycle`, `pull-requests-checks`, `pull-requests-checks-detail` (required failure, optional failure, running workflow, required context not yet reported), `pull-requests-checks-stale` (visibly stale report with rerun unavailable), `pull-requests-empty`, `pull-requests-unavailable`, `pull-requests-issue-links` (a closing-keyword link and a local contextual link on one PR) |
| Stashes   | `stash-stable-oid`, `stash-empty`, `stash-index-shift`                                                                                                                                                                                                                                                                                                                                                 |
| Workflows | `workflow-preview-ready`, `workflow-preview-loading` (`release('stackPreview')`), `workflow-preview-blocked`, `workflow-preview-stale`, `workflow-action-error`, `workflow-partial-restack`, `workflow-conflict-recovery`, `workflow-operation-recovery`, `workflow-external-operation`; form validation, typed confirmation, and `hold('runAction')` for busy state                                   |

```sh
npm test
npm run build
npm run tokens:check
npm run test:ui
npm run test:visual
npm run test:controls
npm run format:check
```

The gallery can also be built with `npm run build:gallery`. Its output is `out/renderer-fixtures`, outside the production renderer entry point. `test:controls` loads that output in an isolated Electron window.

Run `npx playwright test` locally for one combined visual/behavioral HTML report (separate invocations replace the previous report). Axe attachments retain violations and incomplete checks; rendered contrast measurements are report annotations. The `Accessibility checks` workflow runs the behavioural renderer suite (axe, contrast, keyboard, focus, 200% zoom, reduced motion) plus the shared keyboard/state-label unit tests on every push and pull request. Pixel baselines are macOS-only and stay a local gate. Baselines use macOS 26.5.2 (25F84), arm64, with pinned Playwright Chromium; patch-level system-font drift is a reviewed failure, not masked.

The visual suite covers the seven destinations and three dialog compositions at minimum/default/wide sizes, shared-control variants, and a small set of long/error/recovery layouts. Other fixture states remain available in the gallery without separate screenshots or label-only assertions. Behavioral tests focus on keyboard access, asynchronous transitions, contrast, zoom/reduced motion, and mutation guards.

### Packaged desktop smoke

```sh
npm run package
npm run test:desktop
```

The smoke launches `release/mac-arm64/Git Stacks.app` by default on macOS and `release/linux-unpacked/git-stacks` on Linux; Windows is unsupported until its process-tree cleanup can be verified. `node scripts/packaged-desktop-smoke.mjs --help` lists the explicit app-path option. It creates a disposable repository and local bare remote, isolates user-data/configuration, strips inherited Git/GitHub and credential-shaped environment variables, and cleans the temporary workspace. Reports and failure screenshots remain under `out/packaged-smoke/<timestamp>/`.

The packaged executable, preload bridge, CSP, window lifecycle, real 200% page zoom, external-link policy, and local Git workflows are exercised rather than inferred from a dev server. No GitHub mutation or personal repository is used. Native window-state API checks are not physical title-bar-button or VoiceOver verification; record those manual boundaries separately.

### Updating visual baselines

Use the pinned Playwright Chromium, OS/architecture, viewport, locale, timezone, device scale, and system fonts recorded in the verification report. Baselines are platform-specific: a passing macOS image is not Linux or Windows evidence. Do not update images solely to silence failures.

1. Run `npm run test:visual` and inspect the expected/actual/difference images in `test-results` or `playwright-report`.
2. Diagnose whether the change is intentional. Inspect the actual production surface, keyboard behavior, and accessible state before accepting it.
3. Run `npm run test:visual:update` in the documented environment.
4. Review every changed image, then run `npm run test:visual` without update mode. Commit reviewed images with the component change.

Screenshot tests wait for fonts and stable fixture state, use fixed data/timestamps, and control motion. Do not mask meaningful status text, selection, operation feedback, or destructive confirmation. Narrow-window coverage represents desktop pane adaptation; it does not define a mobile product.

### Changing tokens and components

After editing `src/renderer/src/design-system/tokens.json`, run `npm run tokens:generate` and `npm run tokens:check`. Follow [DESIGN.md](DESIGN.md) for token roles and component rules.

When adding a variant or migrating a view:

- Update the production component and its existing typed fixture, not a copied HTML specimen.
- Add a deterministic scenario for the consumer-visible boundary: loading, empty, unavailable, blocked, submitting, rejected/stale, partial completion, or conflict recovery.
- Exercise keyboard entry, visible focus, dismissal/focus return, disabled explanations, zoom, and separate row-selection/action targets.
- For mutations, assert the action produced by a real UI interaction: cancellation, duplicate prevention, confirmation gating, filtered scope, and captured preview tokens/OIDs/fingerprints. Do not replace these with tests of the double itself.
- Add screenshots only for a distinct visual state; update the fixture matrix and evidence with the migration PR.

### Manual assistive-technology sign-off

Automated axe and contrast checks supplement, not replace, human keyboard and assistive-technology review. Final migration sign-off requires an explicitly recorded manual pass; missing evidence is a blocker, not an implied pass. The `Accessibility checks` workflow automates what a machine can judge; the script below is the part it cannot.

Use the packaged build and only disposable fixture repositories. `npm run test:desktop -- --keep` retains its disposable workspace and prints the path for a reviewer. Open only that fixture repository in the packaged app; remove the retained workspace after review.

1. Record reviewer, date, exact macOS/build, Electron/app revision, VoiceOver version/settings, display scaling, and keyboard navigation settings.
2. **Destination navigation.** With no pointer, arrow through the Workspace destinations rail and activate each of the seven destinations. After each switch, confirm focus lands on the destination's heading and the change is spoken through the polite live region. Also verify the direct routes: `/` focuses the in-view filter, `Mod+K` opens the command palette with its own search focused, and the view shortcuts (`Mod+1`–`Mod+7`) reach every destination.
3. **Branch tree.** Tab once into the repository branch tree and confirm it is a single tab stop. With Up/Down move between rows and confirm level, sibling position, and set size are announced; Home/End jump to the first and last row of the whole filtered list, revealing the page that mounts it when the list is paged, and the tree keeps its single tab stop. Press Enter and confirm the details pane follows the selection and focus stays in the tree. Confirm every row states current, remote, parent cycle, parent missing, requires-restack, pull-request number, checks, and ahead/behind in words, and that a visible focus ring marks the row. Filter the list so a branch's parent is no longer shown, and confirm the remaining rows announce no parent above them and share one root set. Finally, slide the mounted window past the first page and repeat Up/Down: focus must move to the neighbouring mounted row, the rows already mounted must be the rows still mounted, and the window must not jump back to the top.
4. **Stack rail and history.** On Stacks, Tab into the member list and repeat the same arrow/Home/End/Enter contract, including Up/Down and Home/End on a stack longer than one page. On History, do the same for the commit list and confirm the inspected commit is announced as current.
5. **Text entry.** Type `7/k` into the in-view filter and confirm every character is inserted, no destination changes, and the palette does not open. Repeat inside the command palette search. Open a dialog and confirm Tab is trapped, Escape does not discard entered work, explicit Cancel returns focus to the control that opened the dialog, and a rejected operation keeps focus inside the modal with its error associated.
6. **Zoom and motion.** Set the window to 200% zoom (or 720×470) and walk all seven destinations: no horizontal scrolling, no action pushed off-screen, and the tree, rail, and history still keyboard-reachable. Enable Reduce Motion and confirm transitions are suppressed while status text, focus rings, and busy locks remain.
7. **State without colour.** Repeat the branch, pull-request, and Diagnostics surfaces under a high-contrast or monochrome display setting and confirm lifecycle, checks, review, capability support, and unavailable/unknown data are all still readable as words.
8. **Errors and recovery.** Trigger unavailable GitHub metadata, a history error, a stale preview reload, busy state, partial completion, and conflict Continue/Abort. Confirm focus moves to a newly raised error and that announcements are timely without duplicating or hiding important state. With an error still on screen, open and cancel a dialog and confirm focus returns to the control that opened it rather than back to that error.
9. Verify the native close/minimize/full-screen controls, including returning from full screen.
10. Record findings and platform limits in the pull request. Sign off only after blocking keyboard, contrast, state-truthfulness, and safety-dispatch findings are resolved.

Real GitHub mutations require a separately designated test repository and explicit authorization; none is included in routine fixtures or CI.

## Changes workspace

Select a file row to inspect its staged and working-tree diffs. The separate file checkbox stages or unstages the whole file; its mixed state means the file has changes on both sides of the index. File-row selection alone never stages anything. If Git rejects a file action, the index is unchanged and the mixed checkbox still reflects the partially staged file after refresh.

For a text file, use the per-hunk **Stage hunk** or **Unstage hunk** button to move just that hunk between the working tree and index. Toggle changed lines within a hunk to include or exclude them, then apply the hunk; toggling a line alone does not write to Git. With focus on a hunk, Up/Down/Home/End move among hunks, and Enter or S applies the focused hunk. Keyboard activation of an individual line button only changes its selection.

Only staged changes enter the next commit. Each hunk action checks the selected file's index and working-tree identity again, then takes Git's index lock before copying the complete current index. Another file staged while the diff was loading is preserved; a Git writer that encounters the owned lock must retry. If the selected file changed, refresh the inspector and review the diff. Renames and copies, new or deleted files, binary/untracked/conflicted files, unsupported text diffs, and oversized diffs require whole-file handling or conflict resolution rather than partial patching. Selected text patches retain adjacent replacement order, exact repeated-line positions, zero-context insertion anchors, CRLF, no-newline markers, and quoted Unicode paths where Git can safely apply them.

When a tracked text file also changes executable mode, staging a text hunk does not stage the mode change; the mode remains separately available through whole-file staging. A mode-only change has no text hunk to select.

## Stack synchronization and recovery

Sync Stack (`Mod+Shift+S`, or the `Sync stack…` command in the command palette) fetches and prunes remotes, discovers the native stack trunk, compares local vs. remote trunk tips, and plans a safe bottom-up restack of the entire stack.

### Trunk and layer classification

Before executing any mutation, the preview compares local and remote branch tips and classifies each layer:

- **Trunk drift**: Evaluates whether the trunk is up to date, behind, ahead, or diverged. If the remote trunk was force-pushed or rewritten upstream (`diverged`), syncing is blocked until the local trunk is reconciled to avoid replaying onto an inconsistent upstream history.
- **Merged layers**: Detects whether a lower layer's PR was merged (via merge commit, squash, or rebase). Merged layers are dropped from the replay cascade. Descendant layers are automatically retargeted onto the updated trunk or the highest surviving predecessor.
- **Rebase boundaries**: For squash- or rebase-merged predecessors, the replay boundary is derived from the immutable head recorded at merge time (`isProvenMergeHead`). If a safe boundary cannot be proven from Git history or the merge journal, syncing is refused to prevent replaying duplicate commits or dropping unmerged work.
- **Layer states**: Each branch is classified as `up-to-date`, `needs-rebase`, `retargeted`, `needs-push`, `needs-force`, `merged`, or `blocked`.

### Force-with-lease safety

Sync Stack never rewrites published remote history without explicit confirmation:

- When any layer requires a force push (because local history was rebased and replaced the published commit), the preview identifies the exact remote OID captured during fetch.
- Pushes use `--force-with-lease` specifying the captured remote tip. If another writer moved the remote branch while the local rebase was running, Git rejects the lease and halts execution immediately.
- The user must explicitly check the lease-approval box and type the target branch name before the sync action can be submitted.

### Conflict recovery

If Git encounters conflicts during the rebase cascade:

1. The operation pauses and writes a recovery journal entry (`kind: 'sync'`) under `.git/git-stacks/journal/`, saving the active rebase state and backup refs for all replayed branches (`refs/git-stacks/backups/<id>/<branch>`).
2. Conflicted files appear in the Changes view and conflict resolver.
3. Once conflicts are resolved, use **Continue** to adopt the rebased commit and resume the cascade for the remaining branches.
4. Alternatively, use **Abort** to restore all branches and their metadata to their exact pre-sync backup refs and return to the original clean checkout.

## Stack surgery

Stack surgery inserts a layer, moves a layer up or down, and removes a layer from a
linear stack. Each operation is planned, previewed, and applied bottom-up with the same
replay and recovery machinery as Sync Stack, so a conflict stops at the layer that caused
it and the original tips stay recoverable.

### What a surgery changes

- **Insert a layer** creates a branch at the tip of the layer you anchor on, reparents
  the layer that sat above it, and replays the layers above that. The new branch is
  created with no commits of its own; the preview names the exact tip it starts at.
- **Move a layer down** places it on the layer below, so the layer that used to sit
  there follows it and everything above that is replayed. **Move a layer up** swaps it
  with the layer above it: the passed layer drops onto the moved layer's parent, keeps
  its own subtree, and both layers are replayed in that order. Moving a layer under a
  layer it already contains is refused, because the result would be a cycle rather than
  an ordered chain.
- **Remove a layer** deletes the local branch and clears its recorded parent. A layer
  that has work above it is not deleted with its work: the layer above is replayed onto
  the removed layer's parent first. A merged pull request is never removed, because its
  pull request cannot leave the stack; Sync Stack drops merged layers instead.
- **Native stack membership** is GitHub's to own. Reordering submitted layers unstack
  the native stack and registers the pull requests again in the new order; layers that
  are not part of a native stack, and a repository that cannot use native stacks, plan a
  local-only surgery and say so in the preview. An inserted layer has no pull request of
  its own, so a stack whose members no longer form one chain from the trunk is unstacked
  rather than left registered in an order GitHub cannot hold.
- **An inserted layer that a pull request hangs from** is published to the remote before
  the retarget, because GitHub refuses a pull request whose base branch does not exist.
  The preview names that creation next to the retarget, and the push refuses to replace
  a branch somebody else created. Without a GitHub origin to push to, an insert below a
  submitted layer is blocked instead of planned.

### Preview and safety

- The preview lists every affected layer with its recorded parent, its new parent, the
  exact commit it is replayed from, the pull request base that changes, and the force
  push the run will need. A layer that only changes its recorded parent is shown as
  reparented rather than replayed, because no commit moves.
- A surgery is refused when a layer's replay boundary cannot be proven from Git: the
  recorded parent tip must exist and still be an ancestor of the layer tip. Git Stacks
  never guesses a fork point.
- Any change between the preview and the run — a moved branch tip, a rewritten parent, a
  changed upstream, or a different origin — invalidates the plan before a single ref
  moves. Preview tokens are single use.
- Force pushes need explicit consent and carry the remote tip captured during the
  preview, so another writer's push is rejected rather than overwritten.
- A run that stops part-way leaves the journal the recovery banner reads, including the
  branch it created and the branch it removed. Continue resumes from the journal without
  repeating completed layers; Abort restores every tip, the created branch, and the
  removed branch.
  A removed branch stays in place until every replay and remote step has
  finished, so an Abort that arrives earlier finds it already restored at the tip the
  preview captured.
- The remote half of a run - the pull request retargets and closes, and the native stack
  unstack and re-registration - is part of the same journal, and Continue runs it again
  after a resolved conflict as well as after a lost response. Every step reads what
  GitHub actually holds, in full, before it writes: a step whose result is already there
  is recognised and completed instead of repeated, including a push whose ref already
  moved, a retarget that landed, an unstack that dissolved the stack, and a stack
  creation that was registered before the response was lost. A step whose pull request
  head, base, or state, or whose native stack membership, differs from both the reviewed
  pre-state and the reviewed result stops the run instead of overwriting it.

## Linked issues

A pull request inspector and the pull request workflow dialog both list the issues
linked to that pull request, with each issue's current state and whether the
relationship is **closes on merge** or **related**.

**Search.** The dialog searches the origin repository's issues by number or
title. The typed text is a literal search: qualifier tokens such as `repo:` are
stripped, and results from any other repository are rejected, so a number that
exists in several repositories can only ever link the one this remote owns. A
closed issue can be selected — GitHub will not close it again, and the link stays
readable. When the transport fails or the machine is offline, the section reports
that issues are unavailable and the rest of the pull request workflow still works.

**Two kinds of link, deliberately separate.**

- _Related_ is app-owned local metadata (`gitstacks.pr.<number>.relatedissue` in local
  `git config`). It never changes anything on GitHub and is never claimed to be a
  relationship GitHub can interpret.
- _Closes on merge_ writes a real closing keyword (`Closes #12`) into the pull
  request description, which is the only form GitHub acts on. Detection and
  insertion follow GitHub's documented grammar: the keyword may be followed by a
  colon, and every issue needs its own full keyword, so `Closes #10, #12` closes
  only #10 and Git Stacks will still insert a complete clause for #12. Insertion
  is idempotent: an existing recognised clause is never duplicated.

**Preview, confirmation, and removal.** Both directions that touch the pull
request description are previewed first: the dialog asks the main process for the
resulting description and shows it, with the exact keyword that will be inserted
or removed, and only then dispatches. Removal deletes the exact clause that was
detected — a foreign `other/repo#12`, an unrelated `#123`, and every other word of
the author's description survive untouched. Removing a _related_ link needs no
confirmation because it only edits local metadata.

**External edits.** Every description mutation carries the body that was previewed.
The main process re-reads the pull request immediately before writing and refuses
the write if the body changed in the meantime, leaving the newer text intact.
GitHub's pull request update endpoint offers no conditional (ETag/`If-Match`)
request, so a change landing between that read and the write can still be lost;
this is a property of the API, not something the app can close. A refresh that
follows a link change never overwrites description text the user typed while the
refresh was in flight.

## Review workspace

Open **Review** from the workspace navigation, the command palette, or the
**Review changes** button on a branch's pull request. The workspace reads one pull
request from GitHub without checking out its branch: the headline, its changed
files, its commits, and its stack position are four separate reads, each with its
own cancellation id. The headline answers first; a stage that has not arrived yet
shows a loading state rather than an empty list.

The workspace fills its pane like the other destinations, and each of its three
regions is bounded and scrolls inside itself, so a large pull request cannot
stretch the page. The diff renders a two-hundred row window and labels itself
with how many rows of how many are mounted; **Show 200 more diff rows** grows
that window. At 200% zoom the three regions stack, each capped, and the pane
scrolls as it does for every other workspace.

The file tree groups changed files by directory, shows each file's status, size,
and generated/binary/too-large state, and searches both the new path and the path
a rename came from. Arrow keys move between rows and Enter or Space opens one; the
rows are plain buttons, so nothing here depends on a custom widget role.

Remote patch headers preserve spaces, quoted characters, and non-ASCII paths,
including a renamed file's old path. A missing patch with zero added and removed
lines is **no text diff**, not evidence of binary content: pure renames, mode-only
changes, empty files, and binaries can all have that shape.

GitHub's pull-request commits endpoint returns at most 250 entries. The commit
list carries the reported total and marks incomplete results explicitly. At the
cap with no reported total, it says the list may be incomplete; a confirmed total
of exactly 250 is complete. Open the pull request on GitHub for its full history.

The diff has unified and split layouts and a **Hide whitespace** toggle. The
toggle is a filter over the text GitHub already sent — the pull request files API
has no whitespace option — and it hides only a removed/added pair that is
identical once spaces and tabs are removed, reporting the hidden count against
Git's own hunk header. Line endings are left alone so a CRLF conversion stays
visible. Both layouts render through the same paged window, so a large diff stays
bounded and the rows keep the same identity across pages.

**Next/previous file** and **next/previous layer** are remappable in Shortcut
settings and dispatched by the app shell through a ref the view publishes, so the
view never registers a competing key listener. Layer navigation reads the native
stack only: choosing an adjacent layer changes what is being read and never
dispatches a checkout.

Opening a file records it as viewed locally, bound to the whole comparison it was
read at: the head commit, the base commit, and the base branch name. A force-push
or a push to the base branch changes the diff, and a retarget changes what the
files are relative to even when both commits are untouched, so the marks are
dropped rather than carried onto a diff nobody looked at. Nothing is written to
GitHub.

### Line identity contract

`ReviewLine` in `src/shared/review.ts` is the contract other review work anchors
to. A line carries its `side` (`base`, `head`, or `null` for a marker), its number
on that side, an `anchor` (the file path plus the line's text with its diff marker
removed), and a `context` (the anchor plus up to two neighbouring lines of the
same hunk each side). A hunk reuses the local staging surface's `hunkId` scheme.

A line number is an address, not an identity. `resolveReviewAnchor` in
`src/main/review.ts` re-resolves a stored `ReviewLineRef` against a freshly read
file set: **exact** when a unique same-side anchor and its neighbourhood are intact,
**moved** when the line's own text survives once but its neighbourhood changed (the
reason says where it went), and **unresolved** with a reason a reviewer can act on
for edited text, a duplicated line, a file the pull request no longer touches, or
a diff that is not available as text.
A duplicate remains unresolved even if only one copy retained the old context.

Resolution never crosses a side. A comment on a removed line is not re-anchored
onto an added line that happens to carry the same text — that would read as a
comment on the replacement. When the text survives only on the other side, the
result is unresolved and the reason names the side the line moved to.

### Reading a pull request at one revision

The file and commit reads are pinned to a single comparison. The comparison's
identity is read before the pages and again after them, and both objects count:
GitHub diffs the head against the merge base of the base and head, so a push to
the base branch changes the diff with the head object unchanged. If either moved,
or the head could not be read, the read fails with a message asking for a reload
rather than returning a set labelled with an oid the pages never came from. This
matters because viewed-file marks and any later review comment are recorded
against that oid.

The headline is read first, so a force-push between the two reads can leave its
oid out of date. The workspace says the head is _as of the headline_ in that case
instead of presenting it as the revision on screen.

### Leaving a review

The conversation column carries the whole review loop: what has been said on
GitHub, what is still unsent, and the one decision that submits it.

A line number in the diff is the control that starts a comment, so a draft is
created by choosing the lines rather than by typing a path and a number. Holding
shift extends the range to a multi-line comment, which becomes GitHub's
`start_line`/`side` pair.

Drafts are local. They are journalled to the repository's own storage under the
app's data directory — GitHub has no "pending comments" resource to hold them —
and are re-read when the workspace opens, so navigating away to another pull
request and back does not lose them. That file is shared by every window and
every worktree of the repository, so each update of it is taken under a lock
another process can see: two windows saving different pull requests at once
cannot read the same journal and publish over each other. The lock is a file
beside the journal created with an atomic link, so exactly one process takes the
name and the winner owns it until it removes it.

A lock is only ever released by the window that took it, never taken from it.
That is not caution, it is the only correct choice: unlinking or renaming the
name frees it, a second process takes it and is inside the journal in the
meantime, and nothing done afterwards can un-enter it. An open file descriptor
pins the inode a lock was made from, which is how two locks are told apart; it
does not hold the name and it is not ownership. So there is no automatic
reclamation of a lock whose holder has gone.

It fails closed instead. A lock held by a process that is still running is
waited for, because that is a window mid-write and it will let go. A lock whose
holder is gone, or one this build cannot read as its own, refuses the write at
once and names the file and the condition under which removing it is safe:
close every Git Stacks window for the repository, confirm none is open, then
remove that one file, and the next write takes the lock itself. That step
belongs to a person because whether somebody still has a window open is not a
fact on disk.

Only one thing is worth trying again, and it is the one case that is not a
refusal: a lock that is no longer there when the contender reads it was simply
released, so the next attempt takes the name. Every other failure to read it —
a lock this account may not open, or a path that is not a file — says nothing
about the holder at all, and no waiting helps, so the write refuses immediately
with the reason it could not be read and the same instruction about that one
file. Retrying it would spin on a lock that never goes away while a window sits
on a save that will not finish. Records are never dropped to keep the file small
— unsent words and unresolved-write guards both leave it only when they have been
sent, cleared, or settled.

A draft record carries the whole comparison
it was written at, plus the repository and the signed-in account it belongs to:
the journal is shared by every worktree of a repository, so the record rather
than the file is the boundary, and drafts written for another repository or by
another account are never offered for submission. A draft from a superseded
revision is shown as stale instead of being re-anchored onto a diff nobody was
looking at. A draft is drawn with a dashed rule and a "pending" label, and never
looks like something already sent.

Submitting writes every pending draft as **one** review: GitHub's
`POST /pulls/{number}/reviews` takes a single `comments` array, so several
separate inline comments become one Comment, Approve, or Request changes event
rather than N events. Approving your own pull request is refused locally, because
GitHub refuses it and a failed submit after several comments were already written
is a worse experience than never offering it. The viewer permission gate comes
from GitHub and GitHub stays authoritative: a permission the app believes is
missing is still a mutation the server can refuse, and its refusal is reported
as it came back.

Anchors are revalidated in the main process immediately before the write, not
from what the renderer happened to be holding. A force-push since the draft was
written produces **zero** mutation rather than a best guess: the drafts that can
no longer be placed are reported individually with the reason, and nothing is
posted to a line or a revision the reviewer did not name. One stale draft holds
the whole review rather than being left out of it, so a submit never succeeds
with a comment quietly dropped.

The comparison the diff was rendered from travels with the submission and is
checked against a fresh read before the anchors are resolved. A comment whose
text still matches after a force-push has usually just moved, and adopting that
would approve a revision nobody opened, so a changed head, base, or base branch
refuses the review outright and names the commit to look at instead.

There is no blind replay. A submission whose response was lost is not retried
automatically, because a duplicate review is a comment the reviewer never wrote —
and an error message is not enough to prevent one, since it vanishes on reload
and hands the same words back to a live button. The attempt is journalled
**before** the request leaves, so a crash between the POST and its response is
covered rather than being the one case with no record. It records the whole
payload: every comment's body and anchor, the decision, and the newest review
the pull request already held when the attempt began.

An unresolved attempt is never dropped to keep the journal short, however many
accumulate. It is the only proof that a request went out: if it did land and the
record is gone, reopening that draft and submitting again posts a second review
instead of reconciling the first. A record leaves only once GitHub's own state
settles it, or once a later submission's payload no longer carries its comments.
A submission that cannot record its attempt is refused rather than sent without
one.

The journal is not a dead end. Pressing Submit asks GitHub what it actually
holds, and every part of the attempt is checked — the review is newer than the
recorded boundary, is this account's, is on this revision, records the decision
GitHub stored for it, and carries the same comments. A matching summary on its own
proves nothing and is not what is matched on. Those two reads come from REST:
`PullRequestReviewComment` has no `side` or `startSide` in GitHub's schema, so
GraphQL cannot answer them and a query naming them is refused outright. REST
reports them as `LEFT`/`RIGHT`, converted once to the diff's `base`/`head` for both
ends of a range — without which a comment on a deleted line is recorded as a head
comment and can never be recognised as its own attempt.

If the review is there, the attempt did land. Those comments are left out of what
is sent, so a recovery posts only what never arrived, and every comment the
operation confirms is named back — the adopted ones and the newly posted ones
alike — so the view drops exactly those and the drafts that were never sent stay
pending.

Checking a review on this revision is not enough on its own. A reviewer can send
a comment on a line, then write the same words on the same line of the same head
while approving instead of commenting, and every field the check compares — the
line, the words, the account, the revision — reads identically for the two. So a
pending comment is named by an identity minted where it is composed, not by the
line it is on, and a recovery only looks at records that name this payload's
comments.

That identity is generated, not counted. A count is only unique if one process
owns it, and the journal is read by every window of the repository: two windows
that opened the same record and counted from the same number would mint one name
for the same line, and a settled record naming it would then answer for the other
window's comment — clearing words it never sent and reporting a decision GitHub
never received. Nothing has to be allocated, persisted, or reclaimed for a
generated name to stay unique, so the record keeps the words and nothing else,
and a record whose drafts are all sent is dropped rather than kept as a counter.
Identities minted before this — the range alone, or the range and a small whole
number — are opaque strings too, so every stored draft still reads and submits,
and none of them can be minted again.

That name is recorded per comment, so a review is only ever evidence about the
comments it was made of. Two comments sent together that land and go
unacknowledged, followed by a payload carrying one of them unchanged and a fresh
one written on the same line with the same words, deliver the first and send the
second — the review posted a different comment that happened to read the same,
and the decision made afterwards is still a decision to send. A comment reworded
after it was composed sends the new words rather than being taken for the old.

A settled write is kept rather than tidied away. The evidence that GitHub holds a
comment is the only thing between a retry and a duplicate, and the submission that
found it can still fail, or be killed before the view drops the draft. What retires
the record is a later payload that no longer carries those comments: the view keeps
a draft in its payload exactly while it has not been told it was delivered. That
makes a resumed submission idempotent without waiting on a callback the view may
never send, and GitHub losing the ability to re-derive the answer — because the
review was edited on the web — cannot hold the write for good.

The search is not limited to recent history. An attempt outlives any window, so
the reviews are walked newest first until the recorded boundary is reached, and
running out of pages before then is a hold rather than a "not there" — the search
gave up, which is not the same as concluding. Both collections are paged in full:
a review may carry 200 inline comments and a page holds 100, and a review whose
tail was never read cannot be compared whole. If GitHub does not hold the review
once the search is exhaustive, the guard stands: the record says only that the app
never heard back, which is also true of a request that never arrived, so absence is
never taken as licence to post again automatically.

The guard covers an unresolved _comment_, not an attempt. Changing the decision
or adding one more pending draft changes the attempt but not the comments, so
every attempt touching any line this payload writes is reconciled first — and what
is journalled is what is sent, so a recovery cannot re-post a comment it just
adopted.

Replies reconcile against the thread's own comments by the same rules, with the
comment ids the thread held when the attempt began as their boundary and this
account as their author — an older identical reply, this account's own or a
collaborator's, is not this attempt. Each record is scoped by repository and by
pull request, and by account, so one account's or one repository's unresolved
write never blocks another's review.

The search is not limited to recent history. An attempt outlives any window, so
the reviews are walked newest first until the recorded boundary is reached, and
running out of pages before then is a hold rather than a "not there" — the search
gave up, which is not the same as concluding. Both collections are paged in full:
a review may carry 200 inline comments and a page holds 100, and a review whose
tail was never read cannot be compared whole. GitHub lists reviews in
chronological order, so the boundary is read off the last page and not the first —
on a busy pull request the greatest id on page one is nowhere near the newest, and
a review that already existed would sit above that line and be taken for a write
that never arrived. A boundary walk that cannot reach the end records none rather
than a low one, because a wrong boundary is worse than an absent one: it errs
toward adopting somebody else's review. If GitHub does not hold the review once
the search is exhaustive, the guard stands: the record says only that the app
never heard back, which is also true of a request that never arrived, so absence is
never taken as licence to post again automatically.

The guard is bound to the revision it was written against. A record about a
different commit is not this submission's recovery: it is neither delivered nor a
hold, and it is retired. A settled record proves GitHub took that write, and it
proves it about that commit — reviewing H1 says nothing about H2, and the same
line carrying the same words on the new head is a new comment about a new commit.
Without that, approving the same line again after a push would clear the draft,
send nothing, and report an approval GitHub never received.

Exhausting a thread's comment pages is reported rather than presented as the whole
conversation. Resolved and outdated are independent facts and both appear. Files
and threads are read separately, so their revisions are compared before a thread is
allowed to jump to a line or compose a comment; a mismatch is shown with a reload
rather than resolved by guessing.

### Review update snapshots and historical comparison

GitHub pull requests do not retain complete version history for arbitrary force-pushes. The review workspace approximates PR versions from observed head SHAs without claiming a complete history the app never saw:

- **Observed head snapshots**: Persists observed head SHAs, timestamps, observation counts, and confirmed review associations in a journal beside the repository Git directory (`git-stacks-review-snapshots.json`). Identical heads deduplicate rather than append; a force-push or rebase creates a new snapshot entry.
- **Changes since reviewed shortcut**: One-click comparison between the newest head the current user confirmed/settled a review for and the current pull request head.
- **Arbitrary snapshot comparison**: Compares any observed historical snapshot to the current head using GitHub's two-endpoint compare API.
- **Hide unchanged files**: In comparison mode, files whose contents did not change between the two compared endpoints can be hidden to focus exclusively on updates since the last review.
- **Explicit history gaps**: When opening a pull request for the first time that already has multiple commits on GitHub, the workspace displays an informational gap banner explaining that earlier heads were not observed by the app and comparisons from them are unavailable.
- **Missing commits and merge-base loss**: If a historical commit was garbage-collected after a force-push or its remote branch was deleted, or if an external rebase caused merge-base loss (unrelated histories), the workspace renders an explicit unavailable alert naming the exact cause, never a fabricated fallback diff.
- **Bounded pruning**: Snapshot records are capped (maximum 40 entries) while strictly retaining user-visible reviewed anchors.
- **Zero GitHub mutation**: Snapshot metadata contains no source text, diffs, or comment bodies, and clearing local history wipes only the local journal.
- **Review after clearing**: A subsequently confirmed or adopted review records its reviewed head again, even if that head was absent from local history. Previously cleared observations remain cleared.
- **Selection isolation**: History reads, clears, and comparisons cannot replace another selection's history. A pending comparison clears the previous file list and counts.

Run snapshot unit and integration tests with:

```sh
npx tsx --test tests/review-snapshots.test.ts
npx playwright test tests/renderer/review-snapshots.spec.ts
```
