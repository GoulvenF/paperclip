# Low-Trust Presets

Paperclip ships core trust preset names so containment decisions are enforced in
Community Edition even when EE policy editing is unavailable.

## Presets

- `standard`: the default V1 company-visible collaboration model. This preserves
  existing behavior for normal agents.
- `low_trust_review`: an opt-in containment preset for automated work that may
  consume hostile or prompt-injected input, such as untrusted pull requests,
  external tickets, dependency diffs, or generated review output.

## Boundary Model

`low_trust_review` is resolved from existing JSON policy fields:

- agent permissions: `permissions.trustPreset` and
  `permissions.authorizationPolicy.trustBoundary`
- project policy:
  `executionWorkspacePolicy.authorizationPolicy.trustBoundary`
- issue/run policy: `executionPolicy.authorizationPolicy.trustBoundary`

The resolver intersects those sources. Narrower wins. A low-trust preset must
resolve to a concrete company-local project, root issue, or issue-id scope. If a
policy source names another company, uses an unsupported preset, or lacks that
scope for risky access, Paperclip fails closed.

## Containment, Not Privacy

This is containment for hostile automated work. It is not a general project,
issue, or human privacy system.

V1 standard work remains company-visible by default: board users and in-company
actors can inspect company work objects unless a separate access-control feature
changes that behavior. Low-trust containment instead limits what the low-trust
agent can read or mutate through the Paperclip API and prevents raw untrusted
output from being automatically promoted into higher-trust agent context.

Low-trust agents cannot read or mutate agent configuration, instruction bundles,
or company skill configuration through direct grants. Configuration changes from
low-trust work must go through higher-trust review and promotion paths instead.

## Human-directed work

An authenticated board user can talk to a low-trust agent in their own Agent
Chat or assign it a task outside its default intake boundary. Creating or
assigning a task, or posting a new board comment to its current agent assignee,
records a server-owned `issue_human_work_grants` receipt in the same transaction.
External sender attribution and agent claims of human authority do not qualify.
Existing owner conversations use their immutable conversation identity.

At dispatch and API authorization, Paperclip checks the current assignment and
the actual run's task. The exception permits reading, commenting on, and updating
only that exact task. It does not extend to another task, a child, a whole project,
configuration, instructions, secrets, or runtime management. Normal responsible
user checks still apply. The exception is never stored in the inherited trust
boundary; retries and resumed runs recheck the receipt and current assignment.

Changing the assignee revokes the receipt, including a change away and back.
Retrying an old comment does not grant new authority. A new human assignment or
comment can authorize the current assignee again. Sandbox and isolated workspace
requirements still apply, as do malformed-policy and company-boundary checks.

## Child→Parent Reporting Under Containment

The direct-parent report comment (`doc/execution-semantics.md` §6, "Child→Parent
Reporting") is **off by default** for `low_trust_review`: a contained run reads
untrusted input, so a free-prose comment into the higher-trust parent thread is
a prompt-injection promotion path. Contained reviewers report by completing
their own review issue (`done` — the verdict is the deliverable; the
`issue_blockers_resolved` wake carries it upward) and by the platform's
system-attributed stop-only relay when they enter `blocked` or `cancelled`.
Never instruct a contained delegate to comment on its parent issue.

## Runtime Containment

Managed `low_trust_review` runs fail closed unless Paperclip can enforce the
runtime boundary:

- the selected execution environment must use the `sandbox` driver
- the effective execution workspace mode must be `isolated_workspace`
- the issue being run must be inside the resolved low-trust boundary or be the
  exact human-directed task described above
- secret references must use binding ids explicitly allowed by the boundary
- inline sensitive environment values such as API keys and tokens are rejected
- workspace runtime-service mutations are denied unless the boundary explicitly
  grants the `runtime.manage` tool class

The Docker workflow in `doc/UNTRUSTED-PR-REVIEW.md` remains useful for manual
local review, but Paperclip-managed low-trust execution requires a sandboxed
environment instead of a host-local adapter process.
