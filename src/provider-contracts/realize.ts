import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { log } from '../log.js';
import { writeAtomic } from '../migrate-claude-memory-settings.js';
import { BASE_INSTRUCTIONS_PATH, type ProjectDocSpec } from '../project-doc-compose.js';
import type { ProviderContainerContribution, VolumeMount } from '../providers/provider-container-registry.js';

import {
  describeRegisteredProviderFileTransformers,
  getProviderFileTransformer,
  type ProviderFileDiagnostic,
  type ProviderFileTransformer,
} from './file-transformers.js';
import {
  type ProviderFileTransformerId,
  type ProviderHostContract,
  type ProviderSkillBackingLocation,
  type ProviderStateVolume,
} from './registry.js';

/**
 * The host file a contract's project document is rendered from. Every
 * contract renders from core's canonical instruction template; a contract
 * declares facts for it, never a document of its own.
 */
export function providerDocumentSourcePath(projectRoot: string, contract: ProviderHostContract): string | undefined {
  if (contract.projectDocument === undefined) return undefined;
  return path.resolve(projectRoot, BASE_INSTRUCTIONS_PATH);
}

// Core-owned: the canonical instruction template is protected unconditionally;
// no provider contract switches this on or off.
export function protectedProviderDocumentSourcePaths(projectRoot: string): string[] {
  return [path.resolve(projectRoot, BASE_INSTRUCTIONS_PATH)];
}

export function providerProjectDocSpec(contract: ProviderHostContract): ProjectDocSpec | undefined {
  if (contract.projectDocument === undefined) return undefined;
  const { fileName, instructions, maxBytes } = contract.projectDocument;
  return {
    fileName,
    ...(instructions ? { instructions } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

export function providerStateVolumePath(
  volume: ProviderStateVolume,
  agentGroupId: string,
  sessionDirectory?: string,
): string {
  return resolveWithinRoot(providerStateVolumeRoot(volume, agentGroupId, sessionDirectory), volume.directory);
}

function providerStateVolumeRoot(volume: ProviderStateVolume, agentGroupId: string, sessionDirectory?: string): string {
  if (volume.scope === 'session') {
    if (!sessionDirectory) throw new Error(`Session directory required for provider state volume '${volume.id}'`);
    return path.resolve(sessionDirectory);
  }
  return path.resolve(DATA_DIR, 'v2-sessions', agentGroupId);
}

/** Realize the group-lifetime portion of a declared provider contract. */
export function initializeProviderGroupSurfaces(
  provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
): string[] {
  const initialized: string[] = [];
  const volumes = new Map(contract.stateVolumes.map((volume) => [volume.id, volume]));

  for (const volume of contract.stateVolumes) {
    if (volume.scope !== 'group') continue;
    const hostPath = providerStateVolumePath(volume, agentGroupId);
    const existed = fs.existsSync(hostPath);
    ensureDirectoryWithinRoot(providerStateVolumeRoot(volume, agentGroupId), hostPath);
    if (!existed) initialized.push(volume.directory);
  }

  for (const file of contract.files) {
    if (file.prepare.when === 'group-init') initializeFile(provider, file, volumes, agentGroupId, initialized);
  }

  for (const backing of contract.skillBackings) {
    if (backing.location.kind === 'state-volume') {
      const volume = volumes.get(backing.location.volumeId);
      if (!volume) throw new Error(`Provider skill backing references unknown volume '${backing.location.volumeId}'`);
      if (volume.scope !== 'group') continue;
    }
    const skillsPath = providerSkillDirectory(backing, volumes, agentGroupId, groupDir);
    const existed = fs.existsSync(skillsPath);
    ensureDirectoryWithinRoot(
      skillBackingContainmentRoot(backing.location, volumes, agentGroupId, groupDir),
      skillsPath,
    );
    if (!existed) initialized.push(`${path.basename(skillsPath)}/`);
  }

  return initialized;
}

export interface ProviderSpawnRealization {
  skillBackingPaths: Map<string, string>;
  contribution: import('../providers/provider-container-registry.js').ProviderContainerContribution;
}

/** Realize every-spawn provider surfaces in the order derived from their resources. */
export async function realizeProviderSpawnSurfaces(
  _provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory: string,
  selectedSkills: readonly string[],
  actions: {
    legacyOverlay: () => Promise<import('../providers/provider-container-registry.js').ProviderContainerContribution>;
    composeProjectDocument: (spec: ProjectDocSpec) => Promise<void>;
  },
): Promise<ProviderSpawnRealization> {
  const volumes = new Map(contract.stateVolumes.map((volume) => [volume.id, volume]));
  const paths = new Map<string, string>();
  // The adapter still contributes environment. Ordinary legacy mounts are
  // ignored: core owns the declared surfaces. Only explicitly declared
  // read-only file binds may survive, after validation below.
  const overlay = await actions.legacyOverlay();
  const contribution: ProviderContainerContribution = overlay.env ? { env: overlay.env } : {};

  for (const volume of contract.stateVolumes) {
    const hostPath = providerStateVolumePath(volume, agentGroupId, sessionDirectory);
    ensureDirectoryWithinRoot(providerStateVolumeRoot(volume, agentGroupId, sessionDirectory), hostPath);
  }

  for (const file of contract.files) {
    if (file.prepare.when === 'every-spawn') prepareSpawnFile(file, volumes, agentGroupId, sessionDirectory);
  }

  const fileMounts = realizeReadOnlyFileMounts(contract, overlay.mounts ?? [], agentGroupId, sessionDirectory);
  if (fileMounts.length) contribution.mounts = fileMounts;

  for (const backing of contract.skillBackings) {
    const backingRoot = skillBackingPath(backing.location, volumes, agentGroupId, groupDir, sessionDirectory);
    const skillsPath = resolveWithinRoot(backingRoot, backing.skillsSubdirectory);
    paths.set(backing.id, backingRoot);
    ensureDirectoryWithinRoot(
      skillBackingContainmentRoot(backing.location, volumes, agentGroupId, groupDir, sessionDirectory),
      skillsPath,
    );
    syncSharedSkillLinks(skillsPath, selectedSkills, backing.conflictDiagnostics === 'warn');
    if (backing.templateCopies === 'copy') {
      materializeTemplateSkills(agentGroupId, skillsPath);
    }
  }

  const spec = providerProjectDocSpec(contract);
  if (spec) await actions.composeProjectDocument(spec);

  return { skillBackingPaths: paths, contribution };
}

/** Validate the selected optional binds before returning any mount to the driver. */
function realizeReadOnlyFileMounts(
  contract: ProviderHostContract,
  contributed: readonly VolumeMount[],
  agentGroupId: string,
  sessionDirectory: string,
): VolumeMount[] {
  const selected: Array<{ mount: VolumeMount; root: string; relativePath: string }> = [];
  for (const file of contract.readOnlyFileMounts ?? []) {
    const volume = contract.stateVolumes.find((entry) => entry.id === file.volumeId);
    if (!volume || volume.mode !== 'rw') throw new Error(`Invalid read-only file volume '${file.volumeId}'`);
    const root = providerStateVolumePath(volume, agentGroupId, sessionDirectory);
    // Guard containment again at realization, even for callers bypassing registration.
    resolveWithinRoot(root, file.relativePath);
    const containerPath = path.posix.join(volume.containerPath, file.relativePath);
    const matches = contributed.filter((mount) => mount.containerPath === containerPath);
    if (matches.length === 0) continue;
    if (matches.length !== 1) throw new Error(`Duplicate provider file mount '${containerPath}'`);
    const mount = matches[0];
    if (mount.readonly !== true || !path.isAbsolute(mount.hostPath) || !fs.lstatSync(mount.hostPath).isFile()) {
      throw new Error(`Provider file mount '${containerPath}' must use a read-only regular host file`);
    }
    selected.push({
      mount: { hostPath: fs.realpathSync(mount.hostPath), containerPath, readonly: true },
      root,
      relativePath: file.relativePath,
    });
  }
  for (const { root, relativePath } of selected) prepareReadOnlyFileMountpoint(root, relativePath);
  return selected.map(({ mount }) => mount);
}

/** The state is agent-writable; never follow a planted symlink while preparing a bind. */
function prepareReadOnlyFileMountpoint(root: string, relativePath: string): void {
  // The session workspace also exposes the volume directory itself. An
  // agent can replace that entry just as it can replace a child of it.
  if (!fs.lstatSync(root).isDirectory()) {
    throw new Error('Provider file mountpoint root must be a directory, not a symlink');
  }
  const parts = relativePath.split('/');
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!fs.lstatSync(directory).isDirectory()) {
      throw new Error('Provider file mountpoint parent must be a directory, not a symlink');
    }
  }
  const target = path.join(directory, parts.at(-1)!);
  try {
    fs.closeSync(fs.openSync(target, 'wx'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!fs.lstatSync(target).isFile()) {
      throw new Error('Provider file mountpoint must be a regular file, not a symlink');
    }
  }
}

function initializeFile(
  provider: string,
  file: ProviderHostContract['files'][number],
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  initialized: string[],
): void {
  const volume = volumes.get(file.volumeId);
  if (!volume) throw new Error(`Provider prepared file references unknown volume '${file.volumeId}'`);
  const volumePath = providerStateVolumePath(volume, agentGroupId);
  const filePath = resolveWithinRoot(volumePath, file.relativePath);
  if (!fs.existsSync(filePath)) {
    if (file.prepare.operation !== 'create-if-missing') return;
    fs.writeFileSync(filePath, file.prepare.content, { flag: 'wx' });
    initialized.push(file.relativePath);
    return;
  }
  // Reconciliation runs at the moment the file is prepared, so the prepare
  // variant is the only schedule there is.
  if (file.reconcile === undefined || file.prepare.when !== 'group-init') return;
  const transformerProvider = file.reconcile.transformerProvider ?? provider;
  const transformer = providerFileTransformer(file.reconcile.transformer);
  try {
    const result = transformer.transform(fs.readFileSync(filePath, 'utf-8'), filePath);
    emitDiagnostics(result.diagnostics);
    if (result.kind === 'replace') {
      writeAtomic(filePath, result.content);
      initialized.push(`${file.relativePath} (reconciled ${providerName(transformerProvider)} settings)`);
    }
  } catch (err) {
    emitDiagnostic(transformer.mapIoFailure(err, filePath));
  }
}

function providerFileTransformer(name: ProviderFileTransformerId): ProviderFileTransformer {
  const transformer = getProviderFileTransformer(name);
  if (transformer === undefined) {
    throw new Error(
      `Unknown provider file transformer '${name}'; registered transformers: ${describeRegisteredProviderFileTransformers()}`,
    );
  }
  return transformer;
}

function prepareSpawnFile(
  file: ProviderHostContract['files'][number],
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  sessionDirectory: string,
): void {
  const volume = volumes.get(file.volumeId);
  if (!volume) throw new Error(`Provider prepared file references unknown volume '${file.volumeId}'`);
  const volumePath = providerStateVolumePath(volume, agentGroupId, sessionDirectory);
  const filePath = resolveWithinRoot(volumePath, file.relativePath);
  if (file.prepare.operation === 'append-open-close') {
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
    fs.closeSync(fs.openSync(filePath, flags));
  }
}

function providerSkillDirectory(
  backing: ProviderHostContract['skillBackings'][number],
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
): string {
  return resolveWithinRoot(
    skillBackingPath(backing.location, volumes, agentGroupId, groupDir),
    backing.skillsSubdirectory,
  );
}

function skillBackingPath(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  if (location.kind === 'group-directory') {
    return resolveWithinRoot(groupDir, location.directory, location.subdirectory);
  }
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return resolveWithinRoot(providerStateVolumePath(volume, agentGroupId, sessionDirectory), location.subdirectory);
}

function skillBackingContainmentRoot(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  if (location.kind === 'group-directory') return path.resolve(groupDir);
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return providerStateVolumePath(volume, agentGroupId, sessionDirectory);
}

/**
 * Reconcile the shared-skill symlinks in one skills directory: drop links no
 * longer selected, add missing ones pointing at the container's /app/skills.
 * Also the body of the legacy Claude path (`syncSkillSymlinks` in
 * container-runner.ts), which wraps it with mkdir + skill-selection lookup.
 */
export function syncSharedSkillLinks(
  skillsDir: string,
  desiredSkills: readonly string[],
  warnOnConflict: boolean,
): void {
  const desired = new Set(desiredSkills);
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) fs.unlinkSync(entryPath);
  }

  for (const skill of desiredSkills) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink() && warnOnConflict) {
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        { skill, path: linkPath },
      );
    }
  }
}

function resolveWithinRoot(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Provider contract path escapes its resolved root: '${segments.join('/')}'`);
  }
  return resolved;
}

function ensureDirectoryWithinRoot(root: string, directory: string): void {
  // Lexical containment only: like the legacy path, symlinks placed by the
  // operator (relocated state, shared skills) are followed, not rejected.
  resolveWithinRoot(root, path.relative(path.resolve(root), path.resolve(directory)));
  fs.mkdirSync(directory, { recursive: true });
}

function emitDiagnostics(diagnostics: readonly ProviderFileDiagnostic[] | undefined): void {
  for (const diagnostic of diagnostics ?? []) emitDiagnostic(diagnostic);
}

function emitDiagnostic(diagnostic: ProviderFileDiagnostic): void {
  log[diagnostic.level](diagnostic.message, diagnostic.fields);
}

function providerName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
