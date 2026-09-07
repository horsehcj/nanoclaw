import '../setup/providers/index.js';
import '../src/providers/index.js';
import '../src/provider-contracts/index.js';
import { listSetupProviders } from '../setup/providers/registry.js';
import { listProviderContainerConfigNames } from '../src/providers/provider-container-registry.js';
import { listProviderHostContractNames } from '../src/provider-contracts/registry.js';
import { verifyHostHarnessDeclarations } from '../setup/lib/host-maintenance.js';

// Validate pre-install host maintenance modules in the host runtime too.
const hostMaintenance = await verifyHostHarnessDeclarations();

console.log(
  JSON.stringify({
    host: listProviderHostContractNames().sort(),
    hostProviders: listProviderContainerConfigNames().sort(),
    setupProviders: listSetupProviders()
      .map((provider) => provider.value)
      .sort(),
    hostMaintenance,
  }),
);
