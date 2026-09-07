# OpenCode provider execution and setup

The provider targets NanoClaw's host contract seam version 2 and pins the native
OpenCode CLI and SDK together at 1.18.25. The skill owns its runtime, host, setup,
and authentication adapters. The core supplies provider contracts, delivery
wording, the memory renderer, resolved MCP configuration, and container policy.

## Turn completion

OpenCode events describe activity and can include stale idle events or recoverable
errors during compaction. HTTP disconnects can also leave native execution alive.
Using event order as completion authority caused missed replies and unsafe replay.

Each shared runtime therefore serializes prompts and continuously reads its event
stream before starting a turn. The synchronous native prompt response determines
completion. A client-assigned user message ID and durable session history identify
the turn's assistant messages, including native compaction continuation. All
deliverable text parts are retained; internal summaries are excluded. Missing
history or uncertain execution fails visibly without submitting the prompt again.
An abort must settle the original native prompt within a bounded cleanup window;
otherwise the provider stops its owned server before permitting another turn.

This uses the existing SDK and persistence. A new retry queue, parallel native
prompts, and idle-event completion would add ambiguous execution ownership.

## Memory and native continuation

Injecting memory into the next external prompt misses OpenCode's automatic
continuation after compaction. Native event handlers are not awaited, so refreshing
memory from a compaction event would race the next model request.

A local native plugin uses the awaited system-transform and session-compacting
hooks. The provider seeds rendered memory once on a fresh session and updates
current core instructions and delivery wording before every external turn. The
plugin supplies that context on each native model request and refreshes rendered
memory before compaction continues. Private per-session snapshots preserve it
across server restarts. Children resolve only their actual ancestor's snapshot;
child compaction writes a separate snapshot. Renderer failures retain the last
snapshot; successful empty output clears it. Legacy sessions without a snapshot
receive current core instructions until their next compaction refreshes memory.

## Credentials and installation

Authentication uses this NanoClaw installation's OneCLI management URL, API key,
and optional project ID. Secret metadata is checked before prompting for a key.
Rotation updates the same secret ID to preserve grants; ambiguous names or
incompatible metadata stop the flow. Supported API-key providers declare their
actual header scheme, including Google's `x-goog-api-key`. Unknown schemes require
an explicit adapter rather than guessing a bearer header. Local keyless endpoints
need no vault access. Provider defaults are saved only after authentication succeeds.

The normal setup flow applies or refreshes the skill, verifies contracts, builds
the local image, and then authenticates through a lazily loaded setup adapter.
An exact seam-version predicate guards all skill mutations during installation
and refresh. The install flow skips build, test, and external skill effects because
its caller owns those steps. Missing or mismatched host Bun uses the container's
pinned version through pnpm. Removal lists every installed file and registration.

## Verification boundaries

Unit and socket tests cover event lifetime, failure reconciliation, cancellation,
memory inheritance, vault metadata, credential rotation, setup failure ordering,
unsupported-core refusal, and installation refresh. The optional native test in
`payload/container/agent-runner/src/providers/opencode.native.test.ts` exercises the
actual pinned executable and SDK against a local model and MCP server, including
a 65-second tool call. These fixtures prove adapter behavior without establishing
live account entitlement, OAuth refresh reliability, or external model quality.
