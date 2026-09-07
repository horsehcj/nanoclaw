# Provider host maintenance contract

Agent containers handle conversations. A host coding agent handles installation
recovery, debugging, customization, and operational skills such as
`update-nanoclaw`. A provider's runtime can work while this second path is missing.

## Ownership and selection

The host maintenance capability belongs to setup, alongside provider authentication
and installation. The container-facing host contract describes mounts and runtime
surfaces; it does not install or launch programs on the operator's machine.

`HOST_HARNESS_PROVIDER` in `.env` records the installation's host choice.
`NANOCLAW_HOST_PROVIDER` overrides it for one invocation. Setup asks before its
environment/container/gateway steps, with the selected runtime as the suggested
choice. Different agent groups can use different providers without changing the
host assistant. `none` disables assistance.

Run `pnpm run maintain`, `pnpm run maintain -- --debug`, or
`pnpm run maintain -- --update` from the checkout. `--configure` changes the host
choice and opens the selected harness's native configuration flow. Update runs the
existing update skill, including its clean-tree, backup, validation, cutover,
confirmation, and rollback requirements.

## Declaring support

A provider skill declares `nanoclaw-provider-host-harness-module` in its existing
SKILL.md metadata. The relative path points to an audited module in that skill,
available before applying its runtime payload. It exports `hostHarness`, satisfying
`setup/providers/host-harness-contract.ts`, with an explicit seam version and
`prepare`, `configure`, and `launch` methods.

- Importing the module is side-effect-free. Runtime imports use only Node and
  existing host dependencies; installed payloads, Docker, and OneCLI are unavailable
  during early recovery.
- `prepare` detects or offers to install the native CLI. `available` means the CLI
  starts; it does not assert authenticated model access.
- `configure` opens native authentication and model configuration. Returning from
  that UI does not prove account entitlement or a successful model request.
- `launch` receives the checkout and an optional private context-file path. It
  preserves native permissions and configuration, inherits the terminal, and
  distinguishes a normal exit from failure. Core rechecks the failed setup step;
  an exited coding agent is never proof that a repair worked.

The generic loader checks path containment and the versioned interface and uses
one module instance for each provider/checkout during a process. Install/refresh
contract inventory also loads each declared module. Shape validation is not a
sandbox: the module is executable, reviewed skill code, just like its apply steps.

Absence of a declaration identifies legacy host support; it is not a claim of
complete maintenance support. Legacy provider failure hooks and the guarded Claude
fallback remain compatible. A declared capability that is missing or broken is
reported explicitly. Declining an assistant ends the offer.

## OpenCode behavior

OpenCode's bundled module serves fresh setup, failures, stalled-build help, `?`
help, and the maintenance command. Existing native installations and their settings
are reused. When no working CLI is found, setup offers the pinned `opencode-ai`
1.18.25 package in `data/host-harness/opencode`, using the published platform
binary. Dependency lifecycle scripts are disabled; setup then explicitly runs
only the pinned OpenCode package's native installer and checks its version.
The host version is independent of the
container CLI/SDK pin; existing versions are reported and preserved.

Host credentials and model configuration use OpenCode's native `/connect` and
`/models` workflows. They are independent of NanoClaw's OneCLI credentials, allowing
host assistance while the gateway is down. A custom endpoint needs native OpenCode
provider configuration; choosing a NanoClaw runtime endpoint does not copy its key
or overwrite an existing host configuration. See the [OpenCode provider guide](https://opencode.ai/docs/providers/).

OpenCode discovers `.claude/skills` natively, so operational skills retain one
source. The maintenance command supplies the requested skill path explicitly.
See [OpenCode skills](https://opencode.ai/docs/skills/).

The shell bootstrap precedes Node and these hooks. A failure to install the basic
Node tooling still prints raw logs; the TypeScript maintenance flow becomes
available after those prerequisites work. Host assistance can also be declined or
unavailable offline. Setup must retain useful diagnostics in either case.

## Design decision

Use a separately versioned setup capability, declared in existing skill metadata,
instead of putting imperative CLI operations into the data-only container mount
contract. Loading the bundled module avoids a circular dependency on a completed
runtime installation. Independent native authentication makes gateway recovery
possible; reusing OneCLI would reduce sign-in duplication but make the repair tool
depend on a component it must repair. Preserve the operator's host configuration
instead of silently copying runtime credentials into it.

## Acceptance

Exercise bare-checkout imports; normal installation and reuse; cancellation and
failed installation; early failures before provider apply; reruns with runtime auth
skipped; independent host/group selection; missing, malformed and escaped modules;
private context cleanup; native permissions/configuration preservation; and native
skill discovery. Verify a real host CLI and model fixture without Docker or OneCLI.
Report platform and real-account limits separately from controlled test results.
