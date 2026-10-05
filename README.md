# Git Stacks

An open-source, local-first desktop alternative to Graphite's pull-request
management, without requiring a new stack-management CLI.

Current product scope lives in [PRODUCT.md](PRODUCT.md); design rules live in
[DESIGN.md](DESIGN.md). This guide covers how to run the app, how the
large-repository work is measured, how development and verification are performed,
and how a release is published and updated; record run-specific evidence and
outstanding acceptance checks in the associated pull request.

## License and contributions

Git Stacks project code is licensed under the [MIT License](LICENSE).
Dependencies, bundled Git, and other third-party material retain their own
licenses; the project license does not replace their attribution or
redistribution requirements.

Upstream pull requests are maintainer-only. This repository does not accept
external pull requests; bug reports and feature requests can be filed in
[GitHub issues](https://github.com/howarewoo/git-stacks/issues). The public source
may still be cloned, forked, modified, and redistributed under its license.

For security vulnerabilities, use **Report a vulnerability** on the repository's
[security advisories page](https://github.com/howarewoo/git-stacks/security/advisories)
when private vulnerability reporting is enabled. Do not put credentials,
private repository data, or exploit details in public issues.

### Repository administration

Keep **Settings → General → Pull requests → Collaborators only** selected and
the owner as the sole collaborator. Inviting another collaborator grants that
account permission to create upstream pull requests. Review installed GitHub
Apps separately: collaborator restrictions are not a substitute for limiting
an app's write permissions or who can trigger its automations.

Before changing visibility, review the hosted branches and tags, their history,
issues and pull requests, releases, and Actions logs and artifacts for sensitive
material. Ignore rules do not remove files already committed, and making the
repository private again does not retract copies or forks. Land the preparation
changes before making the repository public, then enable private vulnerability
reporting under **Settings → Advanced Security**.

All workflows use standard GitHub-hosted runners. Standard runner execution is
free for public repositories; private-repository minutes, paid larger runners,
storage, and model-provider usage have their own billing rules. After the hosted
workflows pass, retire idle self-hosted runner registrations and stop their local
services; do not interrupt jobs or delete retained runner data during the cutover.

## Commands

Use Node 24, npm, and the committed `package-lock.json`. A local source build
does not need GitHub credentials. See [GitHub sign-in](#github-sign-in) for
the required-`gh` policy and current-runtime instructions.

```sh
npm ci                 # install
npm run dev            # run the app
npm run build          # typecheck + production build
npm test               # the test suite
npm run test:live       # the disposable GitHub end-to-end suite (no credentials)
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

Watcher tests use real filesystem events. Advancing a fake clock starts a
coordinator refresh but does not complete its filesystem reads; await the
emitted snapshot before asserting it. Observe watch readiness through events,
not a fixed sleep: a newly registered macOS watch can miss its first write.
Debouncing coalesces delivered filesystem bursts, not entire Git commands;
do not pin a terminal commit to an exact watcher event count.

Destination-focus checks activate the named navigation control with Enter and
verify heading focus and the live announcement, independently of shortcut bindings.

## Agent skills

Repository-owned agent skills live in `.agents/skills/`. They are optional agent
workflows, not desktop features or a required stack-management CLI.

Use [ready-stack](.agents/skills/ready-stack/SKILL.md) for an explicit request to
prepare an existing PR stack bottom-to-top. Supply a canonical PR URL identifying
the stack or an explicit PR list; invocation syntax depends on the agent host.
For example:

```text
Prepare the stack containing <canonical PR URL> using ready-stack.
Prepare these PRs using ready-stack: <bottom PR URL>, <top PR URL>.
Prepare the stack containing <canonical PR URL> using ready-stack --preview.
```

Preparation includes scoped corrections, review-thread handling, verification,
publication, and restacking. After each layer's corrections and local verification,
it submits drafts for review one at a time, bottom-to-top, and leaves already-ready
PRs unchanged. Valid existing approval means no review resubmission or new request.
Missing human approval does not prevent preparing descendants once author work and
required checks are complete; the report distinguishes author-ready from merge-ready.
The skill never merges, enqueues, or changes auto-merge. Preview is read-only,
and loading the skill alone grants no mutation authority.
The report is also the recovery handoff: it records verified state and the first
unproved operation to resume.

Unlike [flatten-pr-graph](.agents/skills/flatten-pr-graph/SKILL.md), which orders PRs
and deliberately skips checks, ready-stack verifies each changed layer. See its
[verification scenarios](.agents/skills/ready-stack/references/verification.md)
for activation, safety, recovery, and behavioral evaluation. For Markdown-only
skill changes, use `npm run format:check` and exercise the skill with disposable
fixtures or read-only preview; application tests do not validate agent behavior.

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
  merge, or the merge queue. The queue is offered when GitHub reports a queue for
  that base ref, so it is available on the first merge rather than after this
  repository has enqueued something. A direct merge also asks for the method,
  because a queued merge runs the repository's own settings instead.
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
  queue membership, so Git Stacks asks GitHub about the pull request's own
  membership: a pull request the queue holds is reported as queued, with the
  place GitHub names, and one it no longer holds — ejected, or closed without
  merging — is reported as dropped. Merged and closed pull requests outrank the
  entry, and a read whose answer is for a different head or base confirms
  nothing about the reviewed request.
- That read is host-bound and never inferred. A schema without the queue
  fields, a refused credential, an answer this build cannot read, and a dropped
  connection all leave membership unknown: the last membership a read confirmed
  is kept and labelled as not re-read, never turned into a removal. An accepted
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

One test is deliberately platform-scoped. The release producer's own reader
shells out to `gh`, and the job that publishes runs on `ubuntu-24.04`, so that
reader is exercised on POSIX with a stand-in for `gh` on the search path rather
than with the network: every decision the producer makes about a channel's
history — the sequence, the version, an unreadable feed, a signature with no
manifest, a manifest with no signature — is tested on all three platforms by
handing the helper the bytes a release would have published, because that is the
only part of the read that talks to anything.

## GitHub sign-in

GitHub collaboration requires the GitHub CLI (`gh`) under the approved product
scope; the [current runtime](#current-runtime) still has legacy authentication.
Install `gh` from [cli.github.com](https://cli.github.com/) and authenticate for
the host you intend to use:

```sh
gh --version
gh auth login --hostname github.com --web
gh auth status --hostname github.com
```

Check status before logging in if you already authenticated. `gh` owns credential
storage, refresh, account selection, and logout. The approved model needs no
app-owned GitHub App registration, Client ID, client secret, or primary credential
vault. Local Git remains available when the CLI is missing, signed out, or offline.

### Current runtime

[#11](https://github.com/howarewoo/git-stacks/issues/11) tracks required-CLI
detection and account guidance, removal of App/device-flow authentication, and
retirement of alternate primary authentication paths. The runtime still supports
`auto`, `direct`, and `gh` transports and the legacy App account panel. Its
`not-configured` status says nothing about your CLI session.

Selecting CLI transport does not remove the legacy account service or isolate
the OS credential store. Use isolated fixtures for credential-bearing automated
checks and a designated test profile for manual native-store checks.

Use the existing CLI-backed mode now:

```sh
GIT_STACKS_GITHUB_TRANSPORT=gh npm run dev
```

Leave `GIT_STACKS_GITHUB_TOKEN`, `GIT_STACKS_GITHUB_TOKEN_<HOST>`, `GITHUB_TOKEN`,
and `GH_TOKEN` unset to use your CLI session; explicit environment tokens take
precedence. Unscoped tokens belong to github.com. Another host receives only
its `GIT_STACKS_GITHUB_TOKEN_<HOST>`, with the canonical host encoded as
upper-case hexadecimal (`github.com` is `6769746875622E636F6D`). The CLI child
receives only that host's token under `GH_TOKEN` or `GH_ENTERPRISE_TOKEN`.
Credentials are resolved privately in main and pinned to their host and request;
never redirect them to another host or copy `gh auth token` output into the app
or a shell command.

GitHub CLI can fall back to plaintext token storage when its secure store is
unavailable; [its login documentation](https://cli.github.com/manual/gh_auth_login)
describes that behavior. Use a working secure credential store, do not select
`--insecure-storage`, and never include credentials or credential paths in a
support bundle. Requiring `gh` does not establish secure storage by itself.

[GitLab through `glab`](PRODUCT.md#future-provider-direction) is future direction
and is outside this cutover.

## GitHub Notifications

The GitHub Notifications inbox is a separate, optional module, not part of the
pull request inbox. It is off by default and nothing about sign-in, pull
requests, stacks, or reviews changes when it is off, held off by policy, or
stripped of its credential.

The Notifications API requires a separately authorized token with the
`notifications` scope. The module does not borrow the CLI session, and the
cutover preserves its credential protection without widening core account
permissions. Its consent flow remains:

1. **Settings › Notifications** explains what authorizing adds — the credential
   kind, the `notifications` scope, how it is protected, and the fact
   that removing it affects nothing else — before the switch is touched.
2. **GitHub Notifications › Authorize notifications** opens a dialog that repeats
   the boundary, names the host and the account the token belongs to, and
   requires the acknowledgement before anything is stored. The host shown is the
   one the dialog acknowledged; if the selected host changes while the dialog is
   open, the submission is refused rather than sealing a token for a host the
   person is no longer pointed at.
3. The token is entered as a masked password field, so it is on screen in this
   window before it is submitted — that is unavoidable, and it is the only moment
   it is here. It crosses the preload bridge once and is never handed back to the
   window after that. At rest it is sealed with a key this computer's operating
   system protects and stored as ciphertext in this app's own notification
   credential file; ordinary application state holds only an opaque reference to
   it, and the token itself never reaches a log, status object, diagnostic report,
   support bundle, or screenshot.

The module polls conditionally. It sends GitHub's own `Last-Modified` value back
as `If-Modified-Since`, honours `X-Poll-Interval` as a floor, and never asks for
more than one page of 50. A 304 replays the whole list rather than replacing it
with the page that answered. That floor applies to a person pressing Refresh
too: an early refresh returns what is already known and sends nothing.

Marking one thread read is `PATCH /notifications/threads/{id}` and marking the
whole inbox read is the `PUT /notifications` GitHub documents for it. Both are
sent once and never replayed, because a second attempt could repeat a change
GitHub already applied, and a change that did not reach GitHub is reported on the
inbox rather than silently retried. When the host cannot be reached, the last
list GitHub confirmed stays on screen marked stale with the reason, rather than
being shown as current or discarded; an inbox nobody can confirm any more is
stale for the same reason even when it is empty.

`Done` is a separate control from Ignore and Unsubscribe because it is a
separate change on GitHub: it is `DELETE /notifications/threads/{id}`, marking
the thread itself done, not changing its subscription. The subscription controls
stay available whatever the thread is, and only Open is withheld when a subject
has no page this host is known to serve.

Marking the whole inbox read is a bulk operation GitHub answers by accepting it
rather than by confirming it. When that acceptance is not yet confirmed, the
inbox says so plainly, keeps the last confirmed state of each thread, and will
not send the bulk request again — the next read that GitHub permits is what
settles it. A write whose answer never arrives is reported as unknown, not as
failed and not as applied, and is not silently retried.

Only the API routes whose web page is actually known are turned into links: a
pull request, an issue, and a commit. A subject GitHub reports by some other
route — a check suite, say — is shown as itself with Open withheld, rather than
guessed at.

Whether a thread can be opened is a question about its address, not about what
this build calls it. A `reason` or subject `type` GitHub invents after this build
was written is kept and shown as unknown, and on its own withholds nothing: a
pull request, an issue, or a commit reached by an unfamiliar reason is still
opened, and Mark read, Done, Ignore, and Unsubscribe stay available for it
whatever its kind or reason. Open is withheld only when there is no address this
build can validate into a page on the host that sent it.

A notification's `subject.url` is an API address, not a page. It is resolved onto
the web origin of the host that sent it before Open is offered, so the link
leaves for a page on that host; a subject from any other origin, or one that is
not a repository, is offered no link at all rather than a guessed one.

Each host keeps its own credential reference and cached list, and each credential
belongs to one host and one account: a host change, an account change, or a
replacement credential ends any read, write, or authorization still in flight, so
no list is ever published or written under another host's or account's name.

This module seals its token in its own store. Removing it leaves the CLI account
intact. Retiring app-owned primary account records must preserve Notifications
credentials, CLI credentials, and unrelated operating-system keys. A replacement
Notifications credential commits before the superseded credential is retired.

Changing the selected GitHub host retires the previous host's center where the
change happens, rather than at the next notification request: the window is
handed the newly selected host's inbox, so the previous host's threads do not
remain on screen under the new host's name.

### Verifying the notification center

```sh
npx tsx --test tests/notifications.test.ts
GIT_STACKS_NOTIFICATION_EVIDENCE="$PWD/test-results/notifications" node tests/notifications.e2e.cjs
```

`tests/notifications.test.ts` drives the module over a real TLS socket with a
certificate generated for the run and pinned in the transport it is given, so
verification is on; one test proves it by presenting a second, untrusted
certificate for the same address and observing the refusal.

`tests/notifications.e2e.cjs` launches the built Electron app against that same
kind of controlled host, trusts only that run's certificate, and drives the real
window: it opens a recent repository, turns the module on in Settings,
authorizes through the consent dialog, and then reads the requests the host
actually served. It writes its screenshots to `GIT_STACKS_NOTIFICATION_EVIDENCE`
when that is set, and cleans up its own processes, profile, and repository
otherwise. It is complementary to the [packaged desktop smoke](#packaged-desktop-smoke),
not a substitute for it.

A control in that window is pressed at a real point, and the press counts only
once the window reports that exact control receiving the click. A window that
re-lays-out between measuring a control and pressing it has the press aimed
again, up to four times, when the press reached nothing; a press that reached a
different control, or that the window cannot account for at all, is reported
rather than repeated.

Both launches — the initial one and the restarted process — start through the
isolated desktop fixture, `tests/fixtures/isolated-desktop.cjs`, which runs as
the Electron main entry instead of the production main file. The fixture
replaces every `safeStorage` entry point the compiled product uses with a
synthetic AES-256-GCM sealing key confined to the run's own fixture root, forces
Chromium onto `--use-mock-keychain`/`--password-store=basic`, proves no native
method is reachable, and only then imports the production main: if that proof
fails it exits before the production module loads. The same fixture root is
reused across the restart, so the synthetic key persists and the sealed
credential file stays readable across it. This run therefore never reads or
writes the operating system's real credential store, and it is not acceptance
of that store: no run here claims the real OS keychain, and the real-OS-store
acceptance remains a separate manual gate.

Three things in that run are worth stating as mechanisms rather than as results,
because each is a place where a weaker check would pass and a wrong claim would
follow from it.

**Waiting for the app, not for the socket.** An answer arriving at the
controlled host says nothing about whether the app has finished acting on it,
so both halves are waited for separately: the request as the host recorded it,
and then the record the producer writes back for that host, which moves only
when it has republished the confirmed list and the validator it belongs to. Each
of those waits fails the run when it times out; none of them falls through to
the next step having waited for nothing.

**The poll floor is GitHub's, and the module keeps it.** After a host applies a
write whose answer is lost, the window is showing a read state it could not
learn. Reconciling that needs a read the host's own interval permits, and the
run waits past that interval for the read to happen rather than pressing
Refresh to force one: once the floor has passed the module reconciles on its own
timer, so a press would be a person asking for something the floor may refuse.
The count of what the host has been asked is taken before the write that changed
its list, which is well before the wait, because a read the app sends by itself
is exactly the one a baseline measured from too late would miss.

**The isolated smoke observes the legacy App account panel.** It strips App
registration values and asserts `not-configured`, no credential reference, and
no login. It does not prove CLI authentication; the
[account cutover](#current-runtime) must update this fixture.

The renderer surface is also exercised in the [gallery](#renderer-verification):
`notifications-awaiting-credential`, `notifications-ready`,
`notifications-stale`, `notifications-rejected`,
`notifications-policy-disabled`, and `notifications-other-host` cover the states a
person meets before, during, and after authorization, and what a selected-host
change does to an inbox the window is already showing.

**What the zoomed screenshots are, and what they are not.**
`webContents.setZoomFactor(2)` is the real zoom; more screenshot pixels would only
be the same layout at a higher density. The run proves the factor took effect by
the halved CSS viewport it produces, not by the size of the image. The zoomed
shots capture the viewport rather than the whole document, because a capture
grown past the viewport repaints a fixed dialog at the position it held in the
shorter viewport it was opened in, which shows an overlaid surface as clipped
when it is not.

At 200% zoom a 1024px window leaves a 512px CSS viewport, in which the
navigation rail and the workspace content stack and the inbox rows fall below the
fold. A capture of that viewport is 1024 physical pixels wide, and it shows the
toolbar and the rail rather than the notification rows — a cropped toolbar edge
in one of these images is what the page is scrolled to at that moment, not a
control that has been lost. Nothing here claims every control is visible at once
at this zoom. What the run does instead is reveal each control in turn by
scrolling it into view, confirm it is the thing actually under the pointer's
point with a hit test, act on it there, and capture that. A claim about a row's
position or reachability at this zoom rests on those measurements and on the
gallery at a 512px viewport — not on an image that does not contain the rows.

The one place a person has to type is the consent dialog, and it is reached
without a pointer at this zoom: from the focus the dialog itself puts on
opening, by `Tab` to the token field, `Tab` to the acknowledgement and `Space` to
give it, then `Tab` to the submit and `Space` to send, with the focus checked at
every step. Nothing in the run moves the caret into the field itself, because a
field it had to aim at would prove nothing about the one a person finds. `Space`
rather than `Enter` is the activating key throughout, since `Enter` is this app's
own command key and never reaches the focused control. This is a claim about
this window's own focus order and its own key handling; it is not a claim about
what the operating system's keyboard navigation or any assistive technology
does with this app, which the run neither drives nor measures.

**Baseline images and visual diffs.** When baseline screenshots are updated,
each image is compared with the previous baseline before it is accepted, and
only images affected by intentional layout changes are updated. A visual change
is bounded to the component that changed, leaving unchanged surfaces pixel-identical.

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

Every **open in browser** control, including the legacy device page, and every
pull request, issue, stack, and check link cross the same main-process host
boundary. A link is opened
only when it is HTTPS, carries no credentials, and names `github.com`, the
configured host, or the host owning an open repository's origin. Public GitHub
links remain available when an enterprise host is selected. The host is compared whole, so its port is
part of it: an enterprise host configured as `ghe.example.com:8443` opens links
on that port, while the same name on another port, a look-alike that merely ends
in a trusted name such as `github.com.evil.example`, and any other host are all
refused. A refused link never reaches the operating system.

### Authentication

Each host needs its own authenticated CLI account. An authenticated github.com
session does not authenticate an enterprise host:

```sh
gh auth login --hostname ghe.example.com --web
gh auth status --hostname ghe.example.com
```

Use the actual configured host instead of the example. Git Stacks must select
the repository's host explicitly for CLI authentication and API operations,
and must never retry a failed enterprise request against github.com.
GitHub Enterprise still needs its own capability probes; a successful CLI
login is not proof of native-stack or merge-queue support.

See [Current runtime](#current-runtime) for the remaining App authentication
and environment overrides.

### Capability matrix

This build reports the same five capabilities for every host, each from what
that host actually answered:

| Capability                   | What the host is asked                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| REST API                     | Whether the host serves REST requests for this repository              |
| GraphQL API                  | Whether the host serves GraphQL queries                                |
| Native stacked pull requests | Whether the host serves the resource that groups stacked pull requests |
| Repository discovery         | Whether the host can be asked which repositories are reachable         |
| GitHub App sign-in (legacy)  | Whether the current, pre-cutover build has a device-flow registration  |

[#38](https://github.com/howarewoo/git-stacks/issues/38) tracks replacing the
legacy App row with CLI availability and authentication status under the
[account cutover](#current-runtime).

Every host has its own endpoints: a GitHub Enterprise Server host serves REST
from `/api/v3` and GraphQL from `/api/graphql` on its own name, while
`github.com` answers from `api.github.com`. Neither is derived from the other,
and a request is never retried against a different path or a different host.

| State             | Meaning                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `supported`       | The host answered and offers the capability.                                                       |
| `unsupported`     | The host answered and does not offer the capability.                                               |
| `unauthenticated` | The host answered, but no credential for that host is available.                                   |
| `unreachable`     | The host did not answer.                                                                           |
| `not-configured`  | A prerequisite is missing, such as the legacy App probe's device-flow registration.                |
| `unknown`         | The capability has not been established, or the host answered something this build could not read. |

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

This build does not infer ruleset or merge-queue support from a host name or a
version number. GitHub Enterprise Server versions differ from one another and
from github.com, so the app reports what a host answered and never maps a version
to a feature. Merge-queue delivery is offered for a base ref only when GitHub
reports a queue for it, or this repository has already had an enqueue accepted
for it; whether a given instance offers a queue depends on that instance's
version and its configuration, not on anything this build knows in advance.

Per-host and per-repository capability state is visible in Settings and in
Diagnostics.

## Settings

Settings is reachable from the command palette (**Settings…**). Preferences are
stored in `settings.json` under the app's user-data directory, which main owns
and validates; the renderer never chooses or writes that path.

| Setting                              | Effect                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git to run                           | Chooses the bundled runtime or the system `git` for every Git operation.                                                                                                                                                        |
| GitHub host                          | The host for CLI authentication, discovery, and API requests: `github.com` or an enterprise host name (an optional port). Each repository's own remote decides the host in use.                                                 |
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
credentials. Changing it retires old-host reads and identity; the current App
implementation also retires its old account. A host change must not log out
the external CLI or delete its credentials.

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

Restoring the defaults is a change like any other, so it keeps a locked
setting's value too: a machine whose policy fixes `updates.channel` to `beta`
resets every other preference and stays on the beta channel, both in the stored
settings and in the updater this run follows.

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

### GitHub CLI diagnostics

**Settings → Diagnostics** reports the configured
[transport preference](#current-runtime). Under `auto`, the active adapter
depends on a usable App or environment credential, which diagnostics does not
read; the active adapter is reported as _not established_. An unset or
unrecognized preference resolves to `auto`.

Detection runs `gh --version` through the Git-probe allowlist with a byte cap,
deadline, and credential-free environment. It makes no account or host query
and reports no credential or executable path. Recognized output is reduced to
the semantic version; unrecognized output is labelled as such. A missing CLI,
timeout, or non-zero exit reports _unavailable_; direct mode reports _not asked_.
This probe does not establish authentication.

[#30](https://github.com/howarewoo/git-stacks/issues/30) tracks host-authentication
status, packaged executable discovery, and recovery guidance for the
[required-`gh` cutover](#current-runtime). Missing CLI or authentication blocks
GitHub work only.

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

Every sequence a channel issues is also written once under a name of its own —
`history-stable-000000000007.json` and `history-stable-000000000007.json.sig` on
`updates-stable` — which nothing ever rewrites. A release reads its history from
those names as well as from the two fixed names above, so an interrupted
publication cannot leave a channel looking empty.

A prerelease on GitHub publishes the `beta` channel; a full release publishes
`stable`. The moving tag only ever moves forward along this repository's history,
and a tag that has been moved elsewhere stops the release instead of being
overwritten. Before any of it is published, the manifest and its signature are
read back from disk, the signature is verified again with the key this release
injected, every installer is re-hashed, each packaged build's own key set is
compared with the one being signed with, and each artifact's provenance is
verified.

Those two names are the only place on the moving release where a publication
overwrites what was there, and an upload that is interrupted between them leaves
a manifest with no signature, a signature with no manifest, or the two
describing different releases. So publication is ordered, and
`scripts/release-update-publish.ts` is the only thing that performs it:

1. **Bank the sequence.** The manifest and its signature are uploaded once more
   under names derived from that sequence — `history-stable-000000000007.json`
   and `.sig` — which nothing ever rewrites. A pair already banked at that
   sequence with these exact bytes is this same publication re-run and is left
   alone; a different pair means the sequence was spent by a publication that
   did not complete, which no release may republish.
2. **Publish the installers**, each under the name the manifest publishes it
   as. Those names carry the version they were built from, and an installer
   published under a name the live manifest already binds to different bytes is
   refused rather than replaced, because a name is a URL an installation has
   already fetched.
3. **Move the two fixed names** onto this release: the installers are in place,
   then the manifest that names them, then the signature that proves it.
4. **Read both back** off the release and verify the signature over the bytes
   that are actually there. An upload that cannot be confirmed is an upload that
   may or may not have happened, so the only honest answer is to read the bytes
   a client will fetch.

Nothing is deleted, and nothing a client needs is only ever reachable after it
exists somewhere immutable. A release that dies at any point leaves the previous
release readable from its banked copy, and the next release reads that copy: a
channel whose two fixed names are both missing, or whose pair does not verify,
is not an empty channel, and the sequence it issues is one past the highest a
trusted key signed anywhere on the tag. A sequence is never reused and a bank is
never rewritten, so a cancelled publication costs a sequence, not the channel's
history. Re-run the release to put the live pair back; the operator floor
(`--sequence`) exists for a channel whose history is being repaired by hand, and
it can only ever move the counter up.

One channel publishes one release at a time. The publishing job takes a lock
named after the channel it is about to move, and a run already in progress is
never cancelled part-way: without that lock two releases published in the same
moment would each read the same published history, each issue the same next
sequence for different bytes, and the feed would carry two releases claiming one
sequence — which every app that had already taken the first would refuse for
good, since a sequence is spent once used. A queued run waits and then reads
the history the run before it left behind, and re-checks its own version against
the feed, so waiting costs a queue slot and skipping the check would cost
correctness. `stable` and `beta` hold separate locks and do not wait on each
other.

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
   anybody else is refused even when its digest matches the manifest exactly.
   The programs that answer those questions are named by absolute path —
   `/usr/bin/codesign`, `/usr/sbin/spctl`, `/usr/bin/plutil`, `/usr/bin/hdiutil`,
   `/usr/bin/ditto`, and on Windows the interpreter under the system directory
   Windows itself reports — because a program named on its own is found through
   `PATH`, and on Windows through the current directory too, which is the
   repository the app was started in. Nothing on the install path needs Xcode or
   any other developer tool: the architecture is read out of the Mach-O header
   rather than asked of `lipo`, and the notarisation ticket is left to
   Gatekeeper's own assessment rather than to `xcrun stapler`, which is a
   developer tool. On
   macOS the disk image is opened read-only and nothing is mounted until the
   image itself has proved that it is this app's — a valid signature carrying
   this app's team, and a passing Gatekeeper assessment of the image — and then
   the application inside it has to prove the same thing again with more:
   same bundle identifier, same version, a stapled notarisation ticket, and its
   own Gatekeeper assessment. The copied bundle is checked a third time before it
   replaces the running one. Nothing here is optional: an image this app cannot
   attribute to its own team is not opened at all. An installer that cannot be started is a refusal, not an
   install: this app stays open rather than closing with nothing to finish the
   work. On macOS the installed bundle is moved aside rather than overwritten in
   place, so a failure part-way through leaves a working app to go back to;
   where the platform installer has to replace files this process is running
   from, the app closes and the installer finishes on its own.

The Windows installer retains its prepared copy after dispatch. An elevated
install may continue in a different process, so the originally spawned PID
exiting does not prove the executable is free.

Before dispatch, the app writes a random 32-character ASCII token beside the
copy, with no prefix or newline. `build/installer.nsh`, included by
electron-builder at its default `nsis.include` path, echoes it after the install
work with the actual installer's PID as `token=...` and `pid=...` CRLF lines.
On a later launch, cleanup requires that exact token, a complete response inside
the owned handoff directory, and `ESRCH` when probing the reported installer PID.
Missing, malformed, foreign, still-running, or unprobeable evidence retains the
copy. The app's version is not completion evidence. A refused launch or a stop
before dispatch still removes the directory that attempt created.

Once the platform installer owns the files, the update cannot be stopped: a
cancel or a channel change at that point is reported as too late rather than
pretending to have taken effect.

One thing happens at a time. A check, a download, an install, and a channel
change are each a single operation, and the second of them waits for the first
to finish and clean up rather than running beside it. A stop is asked for
through the operation's own signal and does not take the boundary away from it:
the operation releases it, in its own cleanup, before the next one starts. That
is why a result from a cancelled or superseded attempt can never land beside a
newer one, and why a stopped download removes only the file it staged rather
than whatever is in the staging directory at the time.

A release becomes offerable only after the history that records having seen it
is written and flushed to the disk: a temporary file of its own, flushed
through its own handle, and then moved into place, with the directory entry
flushed as well on macOS and Linux. Windows has no way to flush a directory
entry from Node's standard library — `FlushFileBuffers` requires a handle
opened for `GENERIC_WRITE`, and a writable directory handle needs
`FILE_FLAG_BACKUP_SEMANTICS` — so there the file's own flush and the atomic
replacement are what this code performs, and the durability of the name across a
power loss is left to the platform rather than claimed here. A write or a
replacement that fails is a failure: the check offers nothing. A check that cannot record what it saw
offers nothing, revokes a build already downloaded for the same release, and
stops every later download and install, because the replay guard is the thing
that keeps an older release from being offered as a new one. A cancelled
attempt leaves the release it authenticated standing, but the next download is
a fresh decision made by a fresh check, so nothing is ever downloaded on the
strength of a run that did not finish.

A channel change is committed with the setting that records it. The updater
takes the channel, the settings file is written while the change is still
undecided, and only then is the new channel published; a write that fails puts
the previous channel back, and an install in flight refuses the change
outright. A stored channel and the channel this process is following cannot
disagree.

The updater writes only to the app's own user-data directory, and on macOS to a
staged and a moved-aside copy of the bundle beside the installed one, both
carrying this app's own prefix. It never reads or writes a repository.

**What a fixture cannot prove.** The test suite stages an installer and runs the
real code over it, which proves the digests, the manifest, the channel, the
sequencing and the refusals. It cannot prove a native install: `codesign`,
`spctl`, `hdiutil`, `Get-AuthenticodeSignature` and the NSIS installer are not
run in a test process on any platform, so a path that asks the operating system
about a signature is only ever exercised as far as the operating system answers. Installing a real signed release is the
acceptance step, and it is written out under Platform support below. The
handoff's directory and file modes describe POSIX protection; the equivalent
Windows isolation is a documented limit, not something the tests establish.
The lifecycle fixture uses two real processes: the process started by the app
is not the process reporting completion. It checks retention before completion
and while that process is running, removal after a matching answer and process
exit, preservation of foreign siblings, and refusal of malformed evidence. The
stand-in reads the raw request without prefix stripping and writes the same
CRLF response fields as `build/installer.nsh`.

Compile the installer hook through electron-builder's NSIS include chain to
check its `customHeader` and `customInstall` integration. Compilation and the
two-process fixture do not execute the Windows installer; installation of a
real signed release on Windows remains the platform acceptance step below.

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
| macOS    | `dmg`                                                | Developer ID Application for the app and for the image, notarised and stapled                        | Yes. The download is checked against the installed app's own signing identity, team, bundle identifier, version, and architecture, staged beside the running bundle and proved again there, then moved into the bundle's place and the app restarts into it. |
| Windows  | NSIS installer                                       | Authenticode, verified before it runs                                                                | Yes. The installer's Authenticode identity is compared with the installed app's own; the installer is then started, this app closes, and the update finishes on its own.                                                                                     |
| Linux    | AppImage, also covered by the packaged desktop smoke | No platform signature exists to check; the release's own manifest signature is what authenticates it | No. An AppImage is a single file the person runs from wherever they put it, with no installed copy to replace and no signature to check before running it, so in-place updates are unsupported there and a download is offered to run instead.               |

The release states the Linux policy in its own log on every Linux build — "linux:
best-effort artifact — built, published and signed, never updated in place by the
app" — and the step that prints it runs the shipped code to make it true: it
asks the installer what it supports on Linux, hands it a staged update anyway,
and requires a refusal that writes nothing, starts nothing and restarts
nothing. A Linux installer that appeared would make the app answer differently
and fail that step, which is the moment the policy line has to be rewritten with
it.

Signing needs a code-signing certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`), and
macOS notarisation needs an Apple developer account (`APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Maintainers have to configure
those as repository secrets; the release job fails closed when any of them is
missing, stopping before packaging rather than publishing an unsigned artifact
under a release name. Installing a real signed release is the acceptance step,
run on a machine that holds the real credentials, before a signed release counts
as delivered:

1. Publish a release and let the workflow run to completion. Every job must be
   green; a failed attestation, signature, or provenance step is not a release.
2. On macOS, confirm the shipped image and the application inside it are signed
   by the expected team, that `xcrun stapler validate` accepts the ticket, and
   that `spctl --assess --type open` accepts the image, on a machine that has
   never seen the download.
3. On Windows, confirm `Get-AuthenticodeSignature` reports `Valid` and the
   signer's subject matches the installed app's own.
4. Install the published release on a clean machine, then publish the next
   pre-release and let an installed build take it: the digest re-check, the
   native signature checks, the handoff, the replacement, and the relaunch all
   run only there.
5. Confirm the channel lock behaved: two releases published at once must leave
   one sequence per channel, and the second must have read the first's history.

Signing the disk image as well as the application inside it needs the private key
a second time, after the packager has already deleted the keychain it imported
the certificate into. The release job does that in a keychain that exists only
for the step: created with a password generated at that moment, unlocked only
there, given the partition list `codesign` needs, made the only keychain in the
search path so the identity cannot come from anywhere else, and deleted by a trap
however the step ends, with the earlier search path restored. The certificate is
written to a file the step owns, masked in the log, and removed. The signing
identity is the single distribution certificate in that keychain for the team the
release claims — matched by name and team rather than by a bare team selector,
because a selector is a search term — and none or several is a refusal rather
than a guess.

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
not a switch someone can throw on an installed app, and it takes three releases
in this order:

1. **The new public key is committed** to `resources/update-history-keys.json`
   and injected into this release through `UPDATE_SIGNING_ADDITIONAL_KEY_ID`,
   `UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY`, `UPDATE_SIGNING_ADDITIONAL_VALID_FROM`
   and `UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL` — all four or none, or the
   release is refused. This release's manifest is still signed with the old key,
   so every installed build can verify it and installs the build that learned
   the new key.
2. **The next release signs with the new key.** The overlap carries the old key
   with an end date far enough out that no artifact it signed can still be
   offered — a manifest stops being offered 30 days after it was issued — so
   every build that installed step 1 can verify this one.
3. **The release after that retires the old key** by not declaring it. Builds
   from step 2 stop consulting it when its `validUntil` passes, and a key outside
   its validity window is never consulted at all, so the old key stops verifying
   then rather than whenever someone notices.

`resources/update-history-keys.json` is what makes step 3 possible. A build only
carries the keys that are current, so once the old key is retired nothing in the
app can authenticate the manifests it signed — and the release that retired it
could not read the history it was replacing, which would stop the channel
outright. That file is the durable record of every public key that may sign a
channel manifest, so a release can still prove what it published last month. A
release refuses to publish a build carrying a key the file does not declare, and
the key is committed there _before_ it signs anything, in the same change that
introduces it. It holds public keys only, which every packaged build already
carries in its own bundle; a private key is never compiled into a build, never
committed to this repository, and never written to a CI log. The release job
signs with a secret held by the repository owner.

The other half of the same discipline is the publication order above: a sequence
is banked under a name of its own before the two fixed names move, so
interrupting a publication costs a sequence rather than the channel's history,
and a bank is never rewritten.

## Untrusted text

Text that arrives from outside this app is text, and it is shown as text. The
values a person reads but did not write are a pull request title and branch
name, a repository description, and a commit subject and author. They are
rendered as React children — `data-views.tsx`, `repository-hover-cards.tsx`,
`repository-views.tsx`, `onboarding.tsx` — so an author's angle brackets are
characters on the screen and never markup. There is no Markdown renderer in
this app and no sanitiser standing in for one: nothing parses a value into
elements, and nothing writes one with `innerHTML`.

`scripts/update-flow-smoke.mjs` proves that in the real window rather than
asserting it about the source. It commits a subject that is
`<img src=x onerror="…"> <script>…</script> <b>bold</b>`, opens the repository
in the running app — where the branch card shows that subject as its commit
preview — and then reads the rendered document: the characters are present, the
deepest element containing them has no element children at all, nothing in the
window carries an inline `on*` handler, no `img`, `object`, `embed`, or `iframe`
appeared, and nothing the payload says ran. The commit list in **History** uses
the same React child for the same value; that view is not exercised by this
run, and the proof is of the surface in the screenshot. Release notes and refusal messages
arriving over a release signature are held to the same rule, in
`tests/release-boundary.test.ts`.

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
CI installs `xvfb` and `xauth` on GitHub's standard `ubuntu-24.04-arm` hosted
runner, builds the app, and runs Electron under Xvfb. Local runs need a display
server. Compare trend results on the same runner class and Git/Node versions,
since filesystem and process startup costs vary by machine. Hosted-runner
measurements start a new comparison series; the old self-hosted timings are not
a directly comparable baseline. The existing performance budgets still apply.

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
- **Pull request enumeration is collected before display.** The renderer reveals
  pull requests incrementally; the main process collects the origin's open pull
  requests through paginated GraphQL reads on the host's typed transport, then
  reads any locally tracked pull requests missing from that listing individually.
  Use the [current-runtime instructions](#current-runtime) for CLI transport.

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

The typed control surface is `window.fixture`: `actions` and `externalUrls` record dispatch; `calls` records reads and writes; `hold(method)` and `release(method, occurrence?)` control in-flight requests, oldest first (or targeted by `'oldest'` or `'newest'`); `failNext(method, message)` rejects one request; `answerNext(method, value)` answers one request with a value the producer itself would return, so a spec can put a read that ended on the wire; and `setScenario(name)` installs another scenario's answers into the double that is already installed, without remounting the App — the window keeps its destination, its state, and its reads in flight, and subsequent reads answer from the newly selected scenario's own repository (or refuse when it has none), while the repository already displayed is preserved until the user or application opens another repository or refreshes. That is what makes an in-place transition provable: a remount is indistinguishable from a first load, and every in-place transition — a read that ends, a read that is replaced, a read that names no account — would only ever be provable by reloading the page.

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

| Area      | Gallery scenarios / exercised controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell     | `shell-no-repository`, `shell-loading`, `shell-connected`, `shell-long-content`, `shell-offline`; the real Hide details pane control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Ancestry  | `ancestry-linear`, `ancestry-branching`, `ancestry-deep`, `ancestry-remote-consolidated`, `ancestry-missing-parent`, `ancestry-cycle`, `ancestry-requires-restack`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Changes   | `files-clean`, `files-staged`, `files-unstaged`, `files-renamed`, `files-untracked`, `files-conflicts`, `files-truncated`, `files-long-content`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| History   | `history-loading` (`release('history')` to finish), `history-error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PRs       | `pull-requests-lifecycle`, `pull-requests-checks`, `pull-requests-checks-detail` (required failure, optional failure, running workflow, required context not yet reported), `pull-requests-checks-stale` (visibly stale report with rerun unavailable), `pull-requests-empty`, `pull-requests-unavailable`, `pull-requests-issue-links` (a closing-keyword link and a local contextual link on one PR)                                                                                                                                                                                                                                                                                                                            |
| Review    | `review-stacked`, plus `answerNext('reviewFiles', …)` for a deleted text file and a 1,200-line generated file: the deleted file is read, addressed, and commented on entirely through its base lines, and the generated file's window stays two pages wide while each reveal, including the one that slides it, keeps every mounted row on the line its gutter names; the file tree's rows are reached and opened with arrow keys and Enter without dispatching anything                                                                                                                                                                                                                                                          |
| Stashes   | `stash-stable-oid`, `stash-empty`, `stash-index-shift`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Inbox     | `pr-inbox-queue` (two registered repositories, one row per group), `pr-inbox-empty`, `pr-inbox-partial` (a repository read without review or check metadata), `pr-inbox-membership-unknown` (the host named no account, so no viewer-relative group is decided and the reason is named), `pr-inbox-unavailable` (GitHub unreachable behind the confirmed rows), `pr-inbox-retired` (a read ended before it confirmed anything, so it holds no rows and blames neither the account or the network); the six group counts, keyboard search, saving and removing a filter, `failNext('pullRequestInbox')` for the refusal, `answerNext('pullRequestInbox', …)` for a read that ended, and `setScenario` for the in-place transitions |
| Workflows | `workflow-preview-ready`, `workflow-preview-loading` (`release('stackPreview')`), `workflow-preview-blocked`, `workflow-preview-stale`, `workflow-action-error`, `workflow-partial-restack`, `workflow-conflict-recovery`, `workflow-operation-recovery`, `workflow-external-operation`; form validation, typed confirmation, and `hold('runAction')` for busy state                                                                                                                                                                                                                                                                                                                                                              |

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

Run `npx playwright test` locally for one combined visual/behavioral HTML report (separate invocations replace the previous report). Axe attachments retain violations and incomplete checks; rendered contrast measurements are report annotations. The `Accessibility checks` workflow runs the behavioural renderer suite (axe, contrast, keyboard, focus, 200% zoom, reduced motion) plus the shared keyboard/state-label unit tests on every push and pull request. Pixel baselines are macOS-only and stay a local gate. The committed images come from more than one macOS point release, so the exact platform, architecture, and pinned Playwright Chromium an image was recorded under are stated per run rather than asserted here for all of them; patch-level system-font drift is a reviewed failure, not masked.

Baselines are committed images, and the pull request records the exact platform, architecture, and verification run evidence each image came from rather than maintaining transient author-only capture notes here.

The visual suite covers the ten destinations and three dialog compositions at minimum/default/wide sizes, shared-control variants, and a small set of long/error/recovery layouts. Other fixture states remain available in the gallery without separate screenshots or label-only assertions. Behavioral tests focus on keyboard access, asynchronous transitions, contrast, zoom/reduced motion, and mutation guards.

### Packaged desktop smoke

```sh
npm run package
npm run test:desktop
```

The smoke launches `release/mac-arm64/Git Stacks.app` by default on macOS and `release/linux-unpacked/git-stacks` on Linux; Windows is unsupported until its process-tree cleanup can be verified. `node scripts/packaged-desktop-smoke.mjs --help` lists the explicit app-path option. It creates a disposable repository and local bare remote, isolates the Chromium user data, the temporary directory, the Git configuration and the gh configuration inside the workspace, strips inherited Git/GitHub and credential-shaped environment variables, and cleans the temporary workspace. On macOS the app inherits the host home directory, because the system only spawns the app's sandboxed helper processes against the home the password database reports: with a synthetic `HOME` the browser process never brings those helpers up and stops answering on its own DevTools endpoint, so the smoke can never reach the renderer. Nothing the app, git or gh reads comes from that home — user data is the redirected `--user-data-dir`, and `GIT_CONFIG_NOSYSTEM=1` with an empty `GIT_CONFIG_GLOBAL` and a disposable `GH_CONFIG_DIR` keep the machine's own Git identity, credential helpers and GitHub login out of the fixture. A `browserType.connectOverCDP` timeout on the first `/json/version` request is that dead endpoint, not a slow start. Reports and failure screenshots remain under `out/packaged-smoke/<timestamp>/`.

The packaged executable, preload bridge, CSP, window lifecycle, real 200% page zoom, external-link policy, and local Git workflows are exercised rather than inferred from a dev server. No GitHub mutation or personal repository is used. Native window-state API checks are not physical title-bar-button or VoiceOver verification; record those manual boundaries separately. The shared isolated desktop fixture is installed before the production main loads (an early Node-inspector pause, `--use-mock-keychain` and `--password-store=basic` on the launch), so this proof covers the actual shipped bundle and CSP under synthetic credential sealing: it is not a proof of the native OS secret store, and it is not proof of a signed release.

### IPC sender validation

The same packaged smoke proves the `validateSender` boundary in `src/main/index.ts` through the real Electron IPC path, never a renderer double or an exported guard. The authorized main frame calls read-only bridge methods first and is expected to be answered, then:

- a second hidden window the smoke itself creates, in the same shipped main process, with the shipped preload and the shipped `webPreferences`, loading the same `app://` document, sends the same calls and must be refused as an untrusted request while the authorized frame keeps answering and `repositories.json`/`settings.json` stay byte-identical;
- a `data:` document loaded with `webContents.loadURL` into the shipped window's own main frame — a capability no renderer holds, since the smoke's navigation check proves the renderer's own attempts to leave the origin are refused — must be refused as an untrusted origin from the very sender and frame the app trusts.

Both refusals are checked against the handler's own precondition (`repository:refresh` needs an open repository), so a guard that stopped answering would be caught rather than mistaken for a refusal. The frame clause of the guard has no live case to reject: `frame-src 'none'`, the `will-frame-navigate` and `will-attach-webview` guards, and `nodeIntegrationInSubFrames: false` mean no child frame of the shipped window ever holds an `ipcRenderer`. The smoke attempts three named subframes and then reads each child frame from the main process — a renderer can only read a frame it is same-origin with — asking the frame itself what it holds. To pass, each attempted frame must have exactly one matching main-process observation reporting `typeof window.desktop === 'undefined'`; missing frames or failed inspections fail the check rather than count as bridge absence. A frame whose navigation the CSP refused may hold a `chrome-error://` document rather than the requested app document; the report records the document actually observed. This measures that the frame clause is unreachable; it is not a live rejection proof for it.

### PR Inbox desktop smoke

```sh
npm run build
node tests/inbox.e2e.cjs [shots-dir]
```

The smoke launches the real Electron main process and preload bridge — never a renderer fixture double — against a synthetic GitHub host this script owns, over verified TLS (`NODE_EXTRA_CA_CERTS`, no verification is disabled). The fixture certificate, repositories, tokens, `settings.json`/`repositories.json`, Chromium profile, and Git/gh configuration all live in the owned temporary root, so no ambient credential, personal repository, or OS secret store can reach the run. Credential sealing is provided by the shared external fixture at `tests/fixtures/isolated-desktop.cjs`, which replaces every native `safeStorage` entry point before the production main module loads and keeps Chromium on `--use-mock-keychain`/`--password-store=basic`; if that guard cannot be proven, the fixture refuses to load the production main. It observes, in the live window: the six Inbox groups with the counts the host answered, the `/` chord reaching the queue's search field, a matchless search reaching the filtered-empty state rather than an empty queue, clearing restoring the rows, a row opening its own repository's Review with no Git action, a row for another registered repository adopting that repository, and a saved filter surviving a real process restart. The synthetic host is the only authority: nothing here writes to GitHub.

This is a dev-main smoke; the packaged executable, preload packaging, and CSP remain the packaged desktop smoke's proof, and a real OS key-store acceptance is a separate manual gate.

### Update flow smoke

```sh
npm run build
npm run test:update-flow
```

`scripts/update-flow-smoke.mjs` launches the built app — real main process, real preload, real renderer — through the shared [isolated desktop fixture](#isolated-desktop-fixture), which is the Electron main entry rather than `out/main/index.js`: it installs a synthetic AES-256-GCM sealing backend, proves no native `safeStorage` method is still reachable, and only then imports the production main with `--use-mock-keychain` and `--password-store=basic`, so if that proof fails the production module is never loaded at all. One disposable temporary root holds the repository the app opens, the Chromium profile, the Git and gh configuration, the fixture's sealing key and this run's generated TLS material; it is removed on every way out of the run — success, failure or signal — and `--keep` retains it for inspection. Inherited git and gh state, GitHub credentials, secret-shaped variables, `SSH_AUTH_SOCK`, the `NODE_OPTIONS`, `NODE_TLS_*`, `NODE_EXTRA_*` and `ELECTRON_*` overrides are dropped before the app is launched; that repository is also initialised and committed under the same held environment, so no host git identity, template, `GIT_DIR` or signing key decides what the app is shown first.

macOS has the app inherit the host home, as the other desktop runs do, because its sandboxed helper processes only come up against the home the password database reports — so `HOME` is the one path this run does not own, and the paths git and gh read are held to the run's own files instead. The app reports what its Git environment can already do by running `git config` from that home, which a home that is itself a Git repository would answer from its own local configuration. **That arrangement is unsupported and refused**: before the app starts, the run asks git whether it discovers a repository at that directory — including worktrees, bare repositories, and Git directories — without querying any configuration value, and stops with a prerequisite error if it does. Only Git's expected non-repository result permits launch; other probe failures stop the run. The run never queries that repository's configuration and never acts on it; on such a machine it does not run.

The run then reads the launched process's own environment back out of the app's main process and asserts that none of those shapes arrived from outside, that the fixture marker and its 0600 sealing key are on disk before the app is driven, and that the commit carries this run's own identity. The window is driven over the DevTools protocol — real mouse events, real typing, screenshots — against a release server this script owns with a certificate generated for the run: the manifest is signed, offered, downloaded and proved against the recorded digest, and an installer changed on disk after the download is refused without anything being run. That is dev-main evidence; it is not acceptance of the real OS key store, a signed release, or the packaged app, and a real OS key-store acceptance remains a separate manual gate.

### Isolated desktop fixture

`tests/fixtures/isolated-desktop.cjs` launches the real production main, preload, and renderer (`out/main/index.js`), with the Electron main entry replaced by the fixture itself:

```sh
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  tests/fixtures/isolated-desktop.cjs \
  --use-mock-keychain --password-store=basic \
  --user-data-dir=<owned-temp-root>/user-data \
  --fixture-root <owned-temp-root> \
  --main out/main/index.js
```

Keep the fixture file first and Chromium startup switches before any `--` separator. The fixture patches the shared native `safeStorage` object in place, preserving Electron's non-configurable export getter and existing import aliases; it never calls the original methods. Keep sandboxing enabled.

Before the production main module is imported, the fixture replaces every `safeStorage` entry point the compiled product uses with a local AES-256-GCM implementation keyed by `<fixture-root>/synthetic-key.bin` (mode 0600), so sealed credentials never touch the operating system's store and a wrong key fails to open them. The key persists only inside the caller-owned fixture root across fixture restarts; it is never printed, and neither is any plaintext. Chromium's own key store is forced to `--use-mock-keychain` and `--password-store=basic` before the app is imported. If any of that cannot be proven, the fixture exits before the production main is loaded. A launch is under the fixture when `<fixture-root>/fixture.json` is present. Passive: it exists only because the fixture created it. The fixture changes no production source, adds no production env switch, and is never referenced by packaged code; accepting the real OS key store remains a separate, external gate, and packaged-desktop acceptance stays with `npm run test:desktop`.

`scripts/packaged-desktop-smoke.mjs` exercises the same synthetic backend in the shipped (unsigned development) package: it pauses the main entry at `--inspect-brk`, installs the helper's fixture before the first production statement, then resumes. That run is synthetic-store evidence only; it never claims the real OS keychain or a signed install.

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

**Two platforms, two records.** The target readers are VoiceOver on macOS and Narrator or NVDA on Windows; the `Accessibility checks` workflow runs headless Chromium on Linux and is evidence for no reader. One record per platform, each naming the reviewer, the date, the OS version and build, the app revision under test (`git rev-parse HEAD`), the reader with its version and settings, display scaling, the keyboard input modes in force (Sticky, Filter, and Slow Keys on Windows; keyboard menu navigation on macOS), and whether the chords are the shipped defaults or the ones set in Settings → Keyboard shortcuts. A macOS record does not answer the Windows one, an unrun platform is recorded as not run, and the evidence belongs in the pull request.

**What to launch.** `npm ci`, then `npm run package`, then the unpacked application from `release/`: macOS `release/mac-arm64/Git Stacks.app/Contents/MacOS/Git Stacks` (or `release/mac/Git Stacks.app/Contents/MacOS/Git Stacks`), Linux `release/linux-unpacked/git-stacks`, Windows `release/win-unpacked/Git Stacks.exe`. `npm run test:desktop` is the automated packaged smoke: it supports macOS and Linux and refuses Windows ("Packaged desktop smoke supports macOS and Linux only; Windows process-tree cleanup is not implemented"), so the Windows pass is manual, and on the platforms it supports `--keep` retains its disposable workspace and prints the path.

**An owned, credential-free run.** Everything the pass touches lives in one directory this pass creates, and the app is launched from a shell that carries none of the machine's Git, GitHub, or credential state. A fresh `--user-data-dir` is part of that, not all of it: it holds `settings.json`, `repositories.json`, the stored GitHub account, and the notification state, but the app also reads `GIT_STACKS_GITHUB_TOKEN`, `GITHUB_TOKEN`, and `GH_TOKEN` from the environment and can fall back to the machine's `gh` login, so `--user-data-dir` alone does not make the run credential-free. On macOS leave `HOME` as it is: the app brings its sandboxed helpers up only against the home the password database reports.

```sh
# macOS: an empty environment plus this run's own variables
root=$(mktemp -d -t git-stacks-a11y)
cd "$root"
: > gitconfig
mkdir gh
env -i \
  PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
  root="$root" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$root/gitconfig" \
  GH_CONFIG_DIR="$root/gh" GIT_TERMINAL_PROMPT=0 \
  sh
```

```powershell
# Windows PowerShell: a GUID root, then strip the ambient variables in place
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("git-stacks-a11y-" + [guid]::NewGuid())
New-Item -ItemType Directory $root | Out-Null
New-Item -ItemType File (Join-Path $root 'gitconfig') | Out-Null
New-Item -ItemType Directory (Join-Path $root 'gh') | Out-Null
Set-Location $root
Get-ChildItem Env: | Where-Object { $_.Name -match '^(GIT_|GH_|GITHUB_|GIT_STACKS_|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_TLS|NODE_EXTRA|ELECTRON_)|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
Get-ChildItem Env: | Where-Object { $_.Name -match '^(GIT_|GH_|GITHUB_|GIT_STACKS_|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_TLS|NODE_EXTRA|ELECTRON_)|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY' } | Select-Object -ExpandProperty Name
$env:GIT_CONFIG_NOSYSTEM = '1'; $env:GIT_CONFIG_GLOBAL = Join-Path $root 'gitconfig'
$env:GH_CONFIG_DIR = Join-Path $root 'gh'; $env:GIT_TERMINAL_PROMPT = '0'
```

The shell that block opens is where the rest of the run happens: the fixture block below, and the packaged app itself with `--user-data-dir="$root/user-data"`. `exit` leaves it. `env -i` is what makes the run credential-free — nothing from the outer shell survives, so no `GITHUB_TOKEN`, `GH_TOKEN`, or host-scoped token, no `GIT_DIR`, `GIT_WORK_TREE`, or counted `GIT_CONFIG_*` pair, no `SSH_AUTH_SOCK`, `NODE_OPTIONS`, or Electron override reaches it — and `root` is passed into it explicitly, because an empty environment has nothing else to expand. The PowerShell block is one session rather than a subshell: it sets `$root`, moves into it with `Set-Location`, strips the ambient variables, and then runs the same fixture block and the same app launch, where the argument is `--user-data-dir=$root\user-data`; its query must print nothing, and anything it lists is unset before continuing. `GIT_CONFIG_NOSYSTEM` with an empty `GIT_CONFIG_GLOBAL` means Git reads no system or global configuration at all — no credential helper, `include`, signing, or hook path — and the empty `gh` directory means no `gh` login. Every Git the app starts inherits the launching environment, so the app is launched from that same session.

**The fixture.** Both setups have moved into the run root, so this block's relative paths land inside it. Every line is a `git` call or a directory step that both shells spell the same way, and the tree starts empty, so nothing depends on how a shell would encode a file it wrote:

```sh
mkdir a11y-fixture
cd a11y-fixture
git init --quiet --initial-branch=main .
git config user.name "Accessibility Review"
git config user.email "a11y@example.invalid"
git config commit.gpgsign false
git commit --quiet --allow-empty -m "Seed commit"
git init --quiet --bare --initial-branch=main ../a11y-fixture-origin.git
git remote add origin ../a11y-fixture-origin.git
git push --quiet --set-upstream origin main
git checkout --quiet -b feature/one
git commit --quiet --allow-empty -m "Feature one"
git config --local branch.feature/one.parent main
git checkout --quiet -b feature/two
git commit --quiet --allow-empty -m "Feature two"
git config --local branch.feature/two.parent feature/one
```

Add a file of your own when a step needs a working change; what the app reads is Git, not how the file was written.

A member is recorded as `branch.<name>.parent`; the app walks those links to the default branch and groups branches by the first ancestor below it, so each further branch needs a new name and the previous branch as its parent, and only such a chain reaches one stack — build it past 200 members (`LIST_PAGE_SIZE`) when you intend to exercise the paged-list parts of steps 3 and 4. Open the fixture with **Add local repository** on the no-repository pane or by dropping the folder on the window — adoption never writes to the repository — then delete the run root and nothing else.

**Readers.** `Mod` is `Cmd` on macOS and `Ctrl` on Windows ([`src/shared/shortcuts.ts`](src/shared/shortcuts.ts)); press each `Mod` chord to confirm it reaches the app, because a reader can keep a chord for itself. The branch tree, the stack rail, History, and every dialog handle the keyboard in the app, and a reader's reading mode — NVDA browse mode, Narrator scan mode — spends arrows, Home, End, and Enter on its own cursor, so run those checks in the reader's interaction or focus mode and use the reading mode to read what the app announces. Record which mode each observation was made in; an announcement that differs between the two modes is recorded, not treated as a defect.

1. Confirm the record above names this platform, this build, and this reader, and that the reader is in the configuration you recorded. Then Tab to **Add local repository**, confirm the reader announces its name and role, and record what the operating system's folder picker announces, where focus lands once the workbench opens, and whether the repository's name and path are spoken.
2. **Destination navigation.** With no pointer, arrow through the Workspace destinations rail and activate each of the ten destinations. After each switch, confirm focus lands on the destination's heading and the change is spoken through the polite live region. Also verify the direct routes: `/` focuses the in-view filter, `Mod+K` opens the command palette with its own search focused, and the view shortcuts reach every destination: `Mod+1`–`Mod+8` for Branches through Diagnostics, `Mod+9` for PR Inbox, and `Mod+0` for GitHub Notifications.
3. **Branch tree.** Tab once into the repository branch tree and confirm it is a single tab stop. With Up/Down move between rows and confirm level, sibling position, and set size are announced; Home/End jump to the first and last row of the whole filtered list, revealing the page that mounts it when the list is paged, and the tree keeps its single tab stop. Press Enter and confirm the details pane follows the selection and focus stays in the tree. Confirm every row states current, remote, parent cycle, parent missing, requires-restack, pull-request number, checks, and ahead/behind in words, and that a visible focus ring marks the row. Filter the list so a branch's parent is no longer shown, and confirm the remaining rows announce no parent above them and share one root set. Finally, slide the mounted window past the first page and repeat Up/Down: focus must move to the neighbouring mounted row, the rows already mounted must be the rows still mounted, and the window must not jump back to the top.
4. **Stack rail and history.** On Stacks, Tab into the member list and repeat the same arrow/Home/End/Enter contract, including Up/Down and Home/End on a stack longer than one page. On History, do the same for the commit list and confirm the inspected commit is announced as current.
5. **Text entry.** In the reader's focus or interaction mode, type `7/k` into the in-view filter and confirm every character is inserted, no destination changes, and the palette does not open. Repeat inside the command palette search. Open a dialog and confirm Tab is trapped, Escape does not discard entered work, explicit Cancel returns focus to the control that opened the dialog, and a rejected operation keeps focus inside the modal with its error associated. Record reader-owned letter navigation in browse or scan mode separately from app shortcut failures; Narrator automatically turns scan mode off in edit fields so text can be entered.
6. **Zoom and motion.** Check both sizes separately. Zoom to 200% — the app installs a real application menu, so View's Zoom In and Reset Zoom are reachable from the keyboard — walk all ten destinations, then Reset Zoom, then resize the window to the app's own minimum, 1000×700, and walk them again: at each, no horizontal scrolling, no action pushed off-screen, and the tree, rail, and history still keyboard-reachable. Enable Reduce Motion on macOS, turn Animation effects off on Windows, and confirm transitions are suppressed while status text, focus rings, and busy locks remain.
7. **State without colour.** Repeat the branch, pull-request, and Diagnostics surfaces under a high-contrast or monochrome display setting (Increase contrast or Grayscale on macOS, a built-in high-contrast theme on Windows) and confirm lifecycle, checks, review, capability support, and unavailable/unknown data are all still readable as words.
8. **Errors and recovery.** Trigger unavailable GitHub metadata, a history error, a stale preview reload, busy state, partial completion, and conflict Continue/Abort. Confirm focus moves to a newly raised error and that announcements are timely without duplicating or hiding important state. With an error still on screen, open and cancel a dialog and confirm focus returns to the control that opened it rather than back to that error.
9. **Native window controls.** With the reader and no pointer, reach the window's own controls and confirm each is announced by the name of its action — minimize, zoom, and close on macOS; minimize, maximize or restore, and close on Windows — that activating each does what its name says, and that returning from full screen leaves the same names in the same order. A control announced by its icon, its position, or an untranslated name is a finding.
10. Record findings and platform limits in the pull request. Sign off only after blocking keyboard, contrast, state-truthfulness, and safety-dispatch findings are resolved.

Real GitHub mutations require a separately designated test repository and explicit authorization; none is included in routine fixtures or CI.

## Disposable GitHub end-to-end suite

`tests/live` is the suite that runs against a real GitHub instead of a double in
process: real Git, a real HTTPS transport, and a repository that exists for the
length of one run. It exists for the behaviour mocks cannot prove — a native
stack created twice, a merge requested twice, a review written against a
comparison that moved, a check the host reports differently than we expect.

```sh
npm run test:live                  # the controlled target: no credentials, no network
npx tsx tests/live/cli.ts --list   # every scenario, its title, and what it needs
```

### The controlled target

`--controlled` stands the API double and Git's smart HTTP protocol up on one
real TLS socket with a certificate generated for the run, and points the
production transport at it. The clone's `origin` is a real HTTPS URL the
application resolves a host and a repository from, so its fetches, pushes, and
API reads all cross the same boundary they cross against github.com. The
certificate is verified rather than trusted blindly, and nothing in the run
names `github.com`, so the run cannot reach the real service even by accident.

The run's own host answers on a `127.0.0.1` authority, so the URLs a scenario
asks for are that host's and not the apparent `github.com` spelling — and the
transport rule is told which they are rather than left to guess from the shape
of an address. Each repository this run creates is registered as it is created,
and a remote is answered only on an exact match against one of those URLs. A
sibling path on the same host, any other authority, and a URL registered by
nobody are all refused, because a rule that let through anything matching
`https` — or anything under the directory this host serves — would be a rule
that answers a request for github.com itself.

The Git boundary refuses the same way. Git applies successive `-C` options in
order and a separate `--git-dir` names a repository outright, so a command
carrying more than one directory selector is refused rather than resolved: the
last selector is where the command actually runs, and measuring the claim
against the first is how a command reaches a checkout this run never created.
That holds for a command the fixture answers and for one it forwards to the
real `git`, because both are checked before either runs.

This is the target that needs no authorization, and it is the one CI runs. It is
not a mock: the scenarios exercise the production services, the production
transport, and real `git`, and the only thing stood in for GitHub is GitHub.

### What the run takes away from the environment

A live run is the one place in this repository where a real credential is in the
environment, so it replaces that environment rather than inheriting it. Every
Git the run starts — the ones it starts itself, the ones an external clone
starts, and the ones the application's own services start — reads an empty home
and template directory, no system or global configuration, hooks pointed at a
directory the run created and left empty, signing off, helpers cleared, and
tracing off; the run's own credential rides in a header scoped to the disposable
repository rather than in the remote URL. It also removes what a machine can
carry that would widen where that credential goes: `GIT_DIR` and its relatives,
the counted `GIT_CONFIG_*` pairs, an ambient token, and an ambient API base.

`NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_EXTRA_CA_CERTS` are retired with them,
and the two are not the same kind of thing. The application's API calls are
`fetch` in this process, and Node reads the first of them when it opens the
connection: with it set to `0`, a request carrying this run's bearer completes
its handshake against a certificate nothing vouches for. Retiring
`GIT_SSL_NO_VERIFY` secures the Git children and changes nothing about that
request, so the retirement happens in the same install, before the first
authenticated request rather than with the Git commands later. The recovery
command retires it too, and for the same reason: it deletes repositories, and a
certificate bypass still in place when its first connection opens would be a
credential sent to whatever answered.

The second is read once, when the process starts. Deleting it stops this run's
Git children from inheriting an extra authority; it does not unload authorities
this process already loaded. Which authorities a Node process trusts from its
first instruction is settled by how it was launched, and a run that starts
already trusting a certificate is not made safe by any environment it installs
afterwards — so the suite claims no certificate pinning it does not perform, and
the boundary it does enforce is the one it can: no credential leaves on a
connection whose certificate this process has not accepted.

When the run finishes — succeeded, failed, or refused — the process environment
is restored exactly as it was found, on the refusal path and the failure path as
well as the successful one. A process left holding a bypass it did not start with
is not a thing this suite produces.

### The authorized target

`--github` runs the same scenarios against a repository it creates on a real
host and deletes afterwards. There is no default: a run with no owner, no
token, and no run id is refused, and the refusal names the variables to set. A
credential is never inherited from an ambient `gh` session and never read from a
variable the application itself uses — the suite spends a credential somebody
gave it for a disposable repository, or it does not run.

Authorized API calls serialize across both actors, with at least one second
between mutations. The pagination scenario's 100 filler reviews therefore take
at least 99 seconds; controlled runs do not wait. A real primary or secondary
rate-limit refusal parks subsequent scenarios and cleanup for the host's
`Retry-After` or exhausted-budget reset, with a one-minute fallback when no
deadline is supplied. The refused request is reported, never automatically
replayed, including when its mutation outcome is uncertain.

| Variable                                   | Meaning                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GIT_STACKS_LIVE_GITHUB_OWNER`             | The account the disposable repository is created under. Required.                                                           |
| `GIT_STACKS_LIVE_GITHUB_TOKEN`             | That account's token. Required; never defaulted.                                                                            |
| `GIT_STACKS_LIVE_GITHUB_REVIEWER_TOKEN`    | A second account that can approve and reply. Optional; without it the scenarios that need a reviewer fail rather than skip. |
| `GIT_STACKS_LIVE_GITHUB_REPOSITORY_PREFIX` | Prefix of the disposable repository. Defaults to `git-stacks-live-e2e`.                                                     |
| `GIT_STACKS_LIVE_GITHUB_RUN_ID`            | Id stamped on everything the run creates. Defaults to a per-run digest.                                                     |
| `GIT_STACKS_LIVE_GITHUB_RECEIPT`           | Where the cleanup receipt is written.                                                                                       |

The account needs permission to create and delete a repository, to administer
its rule sets, and to merge. Anything the host cannot do is discovered by
probing, not assumed: the native stack surface is asked through the product's
own detector, review threads are asked about a real pull request, a merge queue
is configured and read back off the rule set that declares it, and a credential
is answered by sending a write and seeing whether the host takes it. What could
not be observed becomes a note in the report, and a scenario whose capability is
missing is a **failure**, not a skip — a suite that quietly stops covering merge
queues would report green while the thing it exists to catch goes uncaught.

### The rule sets it configures

A rule set is created through `POST /repos/{owner}/{repo}/rulesets`, and the body is
the one the endpoint documents: the seven required `merge_queue` parameters
(`merge_method`, `min_entries_to_merge`, `min_entries_to_merge_wait_minutes`,
`max_entries_to_merge`, `max_entries_to_build`, `check_response_timeout_minutes`,
`grouping_strategy`) and nothing else, a required check named by `context` with
`integration_id` omitted rather than set to `null`, the refs it protects stated in
full, and the review-thread-resolution policy stated as `false`. Both omissions are
the point: the endpoint refuses a parameter its contract does not have, and refuses
an `integration_id` that is not an integration's integer id, so a body carrying
`queue_type`, `merge_commit_message`, `merge_commit_title` or `integration_id: null`
is a 422 on a real repository — a capability probe that sends one learns nothing
about the account it asked, and the scenario that needed the queue or the check
fails rather than reporting what it could not have configured. The controlled host
holds the same line: it refuses those bodies with the same 422 rather than storing
them, so a harness that regresses fails there before anyone spends a credential on a
request github.com would refuse.

### Which branch a run works on

The trunk is whatever the host says it is. The repository's default branch is
read out of the answer to the create request — that endpoint takes no such
parameter, so nothing is passed and nothing is assumed — and every layer base,
pull request base, native-chain expectation, queue ref and schema-probe parent
in the suite reads that value rather than the word `main`. A host that creates a
repository without naming one is refused before anything is seeded: a guess at
that point means committing to a branch the repository has no evidence of
having, and then asking the host questions about it.

The controlled target takes the name it is stood up with, so an account whose
repositories default to `trunk` is something this suite can cover rather than
something it quietly assumes away. No environment variable was added for it: the
live run reads the branch from the host, and a host that will not name one is
refused.

### Who may push

A host that served every push would prove nothing about authorization, because a
public repository answers everybody. The controlled host answers the question
GitHub answers: it identifies the credential behind the request, looks up the
role that account holds on the repository that was named, and refuses a push
whose principal it does not recognise or whose role does not permit writing. The
same boundary covers the foreign repository a reviewer is given, whose access is
granted and read back before it is used, and a credential authorized for the
disposable repository authorizes nothing else on the same host: it rides in a
header scoped to that one repository's URL.

On the authorized target the run claims the real `git` over the directory it
created, and releases that claim when it finishes. It never claims `gh`, never
invokes it, and never reads a credential from it, so a suite that is supposed to
spend a credential somebody handed it cannot spend an ambient session instead.

### What it covers

`--list` is the authoritative catalogue. In outline: native stack create, extend,
unstack, invalid chains, fork heads, and cross-repository numbers; single-line,
multi-line, and reply review threads, resolve and unresolve, a review against a
moved comparison, and a second account approving what the author cannot; check
and status rollup, rerun refusal, and a spent rate limit; required-check and
required-approval rule sets; direct and queued asynchronous merges; external
mutation between preview and submit (force-push, retarget, merge, branch deletion,
stack membership); network, rate-limit, and credential faults at the adapter
boundary; and a schema-drift check against the committed fixture.

Faults are injected at the transport boundary rather than in a server, which is
what makes them usable against a real host. A lost response is the one fault a
fixture cannot stage honestly and a live host must not be asked to produce: the
request really is sent, GitHub really does apply it, and only the answer is
discarded — the exact state a person is in when a merge may or may not have been
requested, and the only way to prove a retry does not create a second merge,
stack, or pull request. A refused write is the opposite: the host never sees it.
The fault decorator reads `destinationHost` and `credentialAuthority()` from the
wrapped transport on demand, preserving host provenance and credential rotation.

### Cleanup and receipts

Every resource the run creates carries the marker `git-stacks-live-e2e:<run id>`
in its own description. Cleanup reads the marker back off the repository before
it deletes anything, and refuses every resource — reporting what is still
standing — when the marker cannot be proven. A name collision, a hand-made
repository, or a previous run's leftover is never removed on a guess. Cleanup
runs in a `finally` that covers workspace setup, the capability probe, the
scenarios, and schema generation, so a startup failure and a scenario failure
both clean up; a run that left anything behind exits non-zero.

The account that spends the credential and the account the repository belongs to
are two different answers, and the receipt keeps them apart. A run pointed at an
organization creates the repository as a user acting for it, so every entry names
the login that actually authenticated, and recovery asks for the accounts the
receipt names rather than for the owner alone — demanding the organization
itself would refuse the exact run that most needs recovering. A reviewer
credential that turns out to be the same account as the primary is refused before
anything is deleted rather than after.

The receipt is also written _before_ the request that creates the resource, and
flushed to disk before that request is sent, which is what makes a lost answer
recoverable: the exact owner, name and marker are on the disk before the host has
been asked. When the host names the object it created, that same entry is
completed with the host's own id rather than a second entry being appended —
two entries for one repository would leave one of them unsettleable and
outstanding for ever.

Recovery removes a repository only after the host confirms the id the receipt
records _and_ the marker it stamped, in that order, and settles nothing else: a
resource inside a repository that was removed is reported as gone with it, a
refusal stays outstanding with its reason, and a read that could not be answered
at all is reported as unknown rather than as removed or absent, because
reporting a dropped connection as a deleted repository is the one answer a person
cannot act on. Recovery installs no global transport, so a credential it was
given for one deletion is never reachable by the rest of the process, and the
same is true of the certificate bypass it retires first.

The receipt is updated after every change, so a run that dies between creating
something and deleting it still leaves the list of what to clean up by hand. It
holds handles, timestamps, and refusal reasons — never a request body, a diff,
or a credential. Progress lines, failure messages, stack traces, and request
summaries are all rendered through the redactor first: configured credential
literals (longest first, so a secret containing another is removed whole), the
credential shapes the application already knows, any `user:password@` in a URL,
and local paths.

Exit codes are `0` passed, `1` a scenario or cleanup failed, `2` the run was
refused before it started.

`npx tsx tests/live/cli.ts --recover <receipt>` is what a run that was killed
before its own cleanup needs. It reads that run's receipt, asks the host to
confirm the id and the marker for everything the receipt names, and removes only
those; a receipt naming something the host does not confirm is reported and left
alone.

### The committed schema fixture

`tests/fixtures/live-github-observed-schema.json` is the contract the mock
fixtures are held to. It records the shape the host was observed to answer —
paths and JSON types only, no values, no repository name, no identifier — and
`schema/observed-responses-match-the-committed-fixture` fails when a field the
parsers depend on is missing or has changed type. Regenerate it deliberately
with `--write-schema`, which prepares a real subject (a diff, a submitted review
with a comment, a two-layer stack, a check run, and a commit status) before
observing, because a probe over an empty pull request observes no fields at all.

**Controlled provenance is not github.com acceptance.** The fixture's `source`
field identifies its generating target. A controlled fixture describes the API
double, not the real host. Compare it against an authorized live run and record
the resulting evidence outside this README before making real-host claims.

### The workflow

`.github/workflows/live-github-e2e.yml` runs both targets, and it can only be
started by hand (`workflow_dispatch`) with no inputs. There is no
`pull_request`, `pull_request_target`, `push`, or `schedule` trigger, because
every automatic trigger is a way for a branch somebody else controls to spend
the disposable account's credential. Both jobs check out
`github.event.repository.default_branch` explicitly — not the ref the dispatch
happened from — with `persist-credentials: false`, pinned action SHAs,
`contents: read` and no write scope, and one run at a time on the account so two
runs cannot clean up each other's repositories.

The `live` job reads its owner from an environment variable and its two tokens
from secrets on the `live-github-e2e` environment, and refuses to install or run
anything when any of them is unset — a repository that has not been configured
says so and exits non-zero rather than starting with a guess. **Naming the
environment in the workflow does not configure its protection.** A repository
owner has to create the environment and, separately, require reviewers, set a
wait timer, restrict it to the default branch, and add the two tokens as
environment secrets; until they do, no protection exists and only the
fail-closed gate stands between a dispatch and a run. The only file taken off
the runner is the receipt; the credential is passed to one command and never
written, echoed, or uploaded.

An ordinary failure or a failing scenario cleans up in process. A job killed at
its `timeout-minutes` cannot, and no in-process handler can: there is nothing to
run one once the process is gone. So recovery is a third job in the same
workflow, which runs when the live job did not succeed. It takes the receipt that
job published as an artifact — the artifact, because each job runs on its own
fresh machine, so a path on one runner says nothing about the next one — and
removes only what that receipt names, after the host confirms both the id the
run created and the marker it stamped. With no receipt published it says so
and fails rather than searching for repositories whose names merely resemble
what the run would have used. The run id in the log identifies any repository a
recovery could not remove, since every resource carries the marker.

### Acceptance boundary

The controlled target uses disposable repositories, a generated TLS authority, and
the production services. Run it with the commands above and record measured results
outside this README. It does not establish real github.com behavior, authentication,
or desktop acceptance; those require separately authorized verification.

Automated live GitHub E2E is deferred as a development gate; howarewoo owns
manual live acceptance recorded against a tested revision
([#34](https://github.com/howarewoo/git-stacks/issues/34),
[#39](https://github.com/howarewoo/git-stacks/issues/39)). Automated live runs
still require explicit dedicated credentials, never an ambient personal CLI
session. Signing and human accessibility acceptance are unchanged.

Recovery is a narrower claim than that, and it is stated as the mechanism rather
than as a result. The command opens its own connection: a private agent, no
keep-alive, a fresh verified handshake for every request, destroyed when the
command ends. It does not reuse this process's pooled `fetch`, so no socket opened
earlier — under a bypass, or against a different authority — can carry a deletion
credential on a trust decision this run did not make. A caller that stands a host
up can supply the authority that host's certificate chains to, which widens what
the connection will believe and does not narrow it, and the process's own
certificate switches are retired before the first request and restored afterwards.

Which handles it is willing to delete is decided by the id and the marker the
receipt records, so a look-alike repository is left alone, and a resource whose
repository is still standing is reported rather than counted as removed.

`runRecoveryAgainstControlledHost` in `tests/live/cli.ts` creates a controlled TLS
host, a marked repository, and a receipt naming its id, then invokes the actual
`--recover` command. Its regression checks the command outcome and reads the
repository back from the host. Run the recovery regression alongside the controlled
suite; neither substitutes for authorized recovery verification against github.com.

Two things this suite depends on are configuration outside the repository
rather than code in it: the protected environment and its required reviewers,
and the environment secrets. Until a repository owner sets them, the
fail-closed gate is the only thing standing between a dispatch and a run, and
the section above says so rather than implying the protection exists. The
desktop application is a separate matter from all of
this: a packaged, signed install is verified on its own terms and none of the
evidence here says anything about it.

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
- **A merged layer stays where GitHub merged it.** It is not moved, and no surgery may
  reparent it: GitHub will not retarget a pull request that already merged, so inserting
  a layer below one, or reordering the layers around one so its parent changes, is
  refused in the preview before a single ref moves. Inserting above a merged layer is
  allowed, because nothing GitHub merged is retargeted; the merged pull requests keep
  their branches, their bases, and their place in the native stack GitHub does not
  unstack them from.
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

## PR Inbox

`Mod+9` opens the PR Inbox: a GitHub-derived triage queue over every registered repository. In the gallery, a row for a second registered repository opens that repository's own workspace: `openRepository` answers with the snapshot registered for the requested path and adopts it, so every repository-scoped read after it answers for the repository now on screen. The `pr-inbox-*` scenarios carry their own primary snapshot holding the pull requests their rows name, so the `connected` fixture that other destinations review is not rewritten to suit the queue. `pr-inbox-no-repository` is the same queue with nothing open, which is the case the search shortcut is checked in as well. It answers "what pull request work is waiting on me?" — it is **not** GitHub's notification inbox. Nothing in it reads a notification, subscription, release, or discussion, and no classic notification scope is required: every fact comes from the pull request, review, and check data the app already reads through a host-aware transport. Opening a row lands in the Review workspace for that row's own repository without checking anything out or changing branches. A row belongs to the host, account, and credential its read was made with: changing any of them retires the read in flight and drops its rows, so a later refresh that fails keeps nothing from the credential it replaced. The credential is whatever the transport that will make the requests would authenticate with — including the profile the `gh` CLI reports when that CLI speaks for a host — reduced to an opaque per-host fingerprint that never holds the credential itself. The host alone is enough to retire the queue, so switching it does not wait for an account status. Each host is admitted against its own newest reported allowance, never against another host's, and a count from a window that has already reset admits the next refresh; a host that named a wait is left alone until then, kept across refreshes that confirm no rows.

### Group semantics

Group membership is a pure function of GitHub-reported facts. The signed-in viewer is the login the host reported for the read; logins are compared case-insensitive. A read that names no viewer places a pull request in no viewer-relative group — authorship and a request to the viewer are undecided rather than false — and the repository is reported as read without knowing whose queue this is, so the rows that stop being listed stop for a stated reason. A host that refuses the review, comment, and check fields answers a degraded read: the row is marked as read without that metadata, its check badge reads "unknown" rather than reporting a result the host never gave, and it is placed only in the groups those facts support. Drafts and recently merged do not depend on the account, so those rows keep their groups either way.

| Group                 | Rule                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Review requested**  | Open, not a draft, directly review-requested from you, and not authored by you. A pull request you opened yourself is your work, not a review you owe, so asking yourself for review never lands here. |
| **Needs my response** | Open, not a draft, authored by you, and either changes were requested or the last review or comment is somebody else's. A pull request nobody has spoken on is not waiting on you.                     |
| **My PRs — waiting**  | Open, authored by you, not a draft, not waiting on your reply, and not approved.                                                                                                                       |
| **My PRs — approved** | Open, authored by you, not a draft, and GitHub's review decision is approved.                                                                                                                          |
| **Drafts**            | Open and a draft, whoever opened it. Drafts are never in a review group.                                                                                                                               |
| **Recently merged**   | Merged within the recent window (30 days by default), measured from the read's own clock.                                                                                                              |

Only one overlap is intentional: **My PRs — approved** and **Needs my response**. The two answer different questions — what the reviewers decided, and who owes the next turn — so a pull request that was approved and then commented on is genuinely both. Every other pair is disjoint; `inboxGroupOverlapsAllowed` names the one allowed pair and `tests/pr-inbox.test.ts` holds the rest closed across the full cross-product of state, draft, author, request, decision, last turn, and merge instant.

### Rows, search, and saved filters

Rows are compact and keyboard-navigable: the list is one composite widget with a single Tab stop, arrow keys, `Home`, and `End`, and `Enter` opens the row into Review. Each row shows and announces its reported author, so what the search matches is what the row says; a host that reports no author says that rather than naming one. Search matches what a row already shows — title, `#number`, repository, head branch, base branch, and author — and every whitespace-separated term must match. The advertised search chord focuses the destination that is on screen, so `/` in the queue lands in the queue's own filter rather than in a search that does not exist for it. The repository selector is exact. A named filter is a group, a search, and optionally one repository; filters are stored in `pull-request-inbox.json` beside the settings file, written atomically at owner-only permissions, one write at a time so two overlapping saves cannot interleave, and re-loaded on launch. One malformed draft refuses the whole write rather than silently losing a filter. Listing and saving both join the same initialization, so the stored file has been completely read before any save can overwrite it or any read can list a partial state. The renderer holds a synchronous lock for the whole save, so the interface cannot start an overlapping one, counts generations so a late initialization read cannot report the filters of an earlier save, and keeps the filter controls locked until readiness completes, so an in-flight read and a pending write cannot drop or clobber filter state.

### Refresh states

Empty, filtered-empty, stale/offline, auth-required, and partial-permission are five different answers, and the queue never reports an unanswered read as an empty one. A read that was **ended** is a sixth, separate from all of them:

- **empty** — GitHub confirmed the read and the group genuinely holds nothing.
- **filtered-empty** — GitHub confirmed the read; this group, search, and repository select none of the rows.
- **unconfirmed** — the read did not answer. The last confirmed rows stay on screen behind the reason, and if there are none the queue says it is unconfirmed rather than showing an empty list.
- **partial** — some repositories answered and some could not. The rows below are the ones GitHub confirmed, and the unread repositories are named individually (`not visible to this credential`, `sign-in rejected`, `GitHub unreachable`, `origin is not on a GitHub host`, …).
- **degraded** — the host answered without the review, comment, and check fields its schema does not carry. The rows are real and stay on screen, their check state is explicitly unknown rather than reported as no checks, and the read is never counted as complete.
- **membership unknown** — the host read the rows and named no account for them, so whose queue they are could not be established. Every viewer-relative group is left undecided rather than decided against a person the read could not name, the rows that do not depend on an account keep their groups, the repository is named as _read without knowing whose queue this is_, and the read is never counted as complete. It is stated ahead of a narrowed read, because the reason those rows are not being shown as work is the missing account, not the missing metadata.
- **failed** — the request was made and the host answered with something this build cannot read as a verdict, such as a server error. It is never reported as a repository that was not attempted: the repository keeps the reason the host gave, and a queue that read nothing because every repository failed names that reason per repository rather than reducing them all to one line.
- **skipped** — a repository outside the refresh's request budget, or on a host whose credential was already rejected in this refresh, is reported as _not attempted_, never as an empty repository.
- **retired** — the read was ended before it confirmed anything, because the identity it was reading for is no longer the one asking. It carries no rows, no repositories, and no login, and it says so without claiming a sign-out, a lost connection, or a queue that was never read. Keeping the last confirmed rows is for a read that could not answer under the identity that confirmed them, so this state deliberately empties the queue instead of inheriting it.

The refresh is budgeted twice, and both halves count what actually happened. It refuses to start while GitHub's remaining budget is below the 250-request reserve the repository sync already keeps, and it stops mid-refresh once the 24-request per-refresh cap is spent, naming the repositories it did not attempt. Every round trip is charged before it is made — a refused field and the narrower query that follows it, each page of the pull-request listings, the native-stack capability probe, and each page of the stack collection — so a repository that fails part-way cannot spend the allowance while contributing nothing to it. Admission reads the allowance the host itself reported, in the window that report belongs to: a count from a window that has already closed is set aside however recently it arrived and however much more it allows, and where another report for that host and credential still describes an open window, that one is what admission reads. GitHub counts each window separately, so a spent window never refuses a later one. A refusal is believed on GitHub's terms rather than the read's: whatever wait it names — a `Retry-After`, or the moment the primary window resets when it names no counter at all — runs from the answer that carried it. That wait is shared by ordinary repository reads and Inbox reads, rather than belonging only to the read that met it, with credential-scoped primary limits and host-wide secondary waits distinguished below.

Primary allowance observations also belong to the credential that made the request, not just the host. Ordinary repository reads and Inbox reads share that credential's allowance; replacing the credential on the same host does not carry the previous account's spent primary window into the replacement account's queue. A primary-limit refusal that names only its reset stays with that credential; a secondary-limit refusal or an explicit `Retry-After` still establishes a host-wide wait. A late answer from the previous credential cannot lower the replacement's primary allowance. Replacing one host's credential leaves other hosts' observations intact, and installing or clearing a stored account does not discard a primary reserve for an unchanged environment credential that overrides it.

When a primary refusal supplies both a reset and `Retry-After`, the explicit retry duration sets the host-wide wait; the later primary reset still applies only to the credential that exhausted that window. A replacement credential can therefore read after the explicit wait ends without waiting for the previous account's primary reset. A primary refusal that names neither a reset nor a retry duration stops that principal's remaining repositories in the current refresh, but does not invent a deadline for the next refresh or stop another principal.

Rows belong to one identity. The account, its credential, and the selected host decide whose queue is on screen: signing out, switching accounts, or changing host ends the read still running for the previous identity, refuses its late answer, and drops its rows rather than showing them until a refresh can answer for the new one. Which host that is comes from one decision, in one order, because a host read from the wrong place names the wrong credential. The host serving a configured non-public API base decides first, and decides even when a host was named as well, because the CLI is sent to that URL and authenticates as whoever serves it; then the host that was named; then `GH_HOST` from the merged environment, canonicalised; and only then the public host. A base equal to the public default is the public host by fallback rather than by anyone's decision, so it resolves nothing a host name does not and cannot outvote a host that was named. The same host names the requests, the credential asked of the CLI, the environment the CLI's process runs with, and the allowance the answers are credited to, so all four can never disagree. Registered clones and worktrees of one remote are one GitHub repository, so they are read once, counted once, and opened through one deterministic local path.

Leaving the destination cancels the read it started. The queue reads on open and on a 60-second cadence only while its destination is visible, and each read claims the `inbox-refresh` request id, so a superseded read and the one abandoned by navigating away both stop in the main process rather than spending the budget of a window nobody is looking at.

Run the Inbox tests with:

```sh
npx tsx --test tests/pr-inbox.test.ts tests/pr-inbox-service.test.ts
```
