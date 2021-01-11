import { EthereumTestnetProvider, randomAddress } from '@crestproject/crestproject';
import {
  AdapterWhitelist,
  adapterWhitelistArgs,
  callOnIntegrationArgs,
  IntegrationManagerActionId,
  kyberTakeOrderArgs,
  PolicyHook,
  policyManagerConfigArgs,
  takeOrderSelector,
  uniswapV2TakeOrderArgs,
  validateRulePreCoIArgs,
} from '@enzymefinance/protocol';
import {
  assertEvent,
  createFundDeployer,
  createMigratedFundConfig,
  createNewFund,
  defaultTestDeployment,
} from '@enzymefinance/testutils';
import { utils } from 'ethers';

async function snapshot(provider: EthereumTestnetProvider) {
  const { accounts, deployment, config } = await defaultTestDeployment(provider);

  return {
    accounts,
    deployment,
    config,
  };
}

async function snapshotWithStandalonePolicy(provider: EthereumTestnetProvider) {
  const {
    accounts: [EOAPolicyManager, ...remainingAccounts],
    config,
  } = await provider.snapshot(snapshot);

  const adapterWhitelist = await AdapterWhitelist.deploy(config.deployer, EOAPolicyManager);

  return {
    accounts: remainingAccounts,
    adapterWhitelist,
    whitelistedAdapters: [randomAddress(), randomAddress()],
    comptrollerProxy: randomAddress(),
    EOAPolicyManager,
  };
}

async function snapshotWithConfiguredStandalonePolicy(provider: EthereumTestnetProvider) {
  const {
    accounts,
    adapterWhitelist,
    whitelistedAdapters,
    comptrollerProxy,
    EOAPolicyManager,
  } = await provider.snapshot(snapshotWithStandalonePolicy);

  const permissionedAdapterWhitelist = adapterWhitelist.connect(EOAPolicyManager);

  const adapterWhitelistConfig = adapterWhitelistArgs(whitelistedAdapters);
  await permissionedAdapterWhitelist.addFundSettings(comptrollerProxy, adapterWhitelistConfig);

  return {
    accounts,
    adapterWhitelist: permissionedAdapterWhitelist,
    comptrollerProxy,
    whitelistedAdapters,
    EOAPolicyManager,
  };
}

describe('constructor', () => {
  it('sets state vars', async () => {
    const {
      deployment: { policyManager, adapterWhitelist },
    } = await provider.snapshot(snapshot);

    const policyManagerResult = await adapterWhitelist.getPolicyManager();
    expect(policyManagerResult).toMatchAddress(policyManager);

    const implementedHooksResult = await adapterWhitelist.implementedHooks();
    expect(implementedHooksResult).toMatchObject([PolicyHook.PreCallOnIntegration]);
  });
});

describe('addFundSettings', () => {
  it('can only be called by the PolicyManager', async () => {
    const { adapterWhitelist, whitelistedAdapters, comptrollerProxy } = await provider.snapshot(
      snapshotWithStandalonePolicy,
    );

    const adapterWhitelistConfig = adapterWhitelistArgs(whitelistedAdapters);

    await expect(adapterWhitelist.addFundSettings(comptrollerProxy, adapterWhitelistConfig)).rejects.toBeRevertedWith(
      'Only the PolicyManager can make this call',
    );
  });

  it('sets initial config values for fund and fires events', async () => {
    const { adapterWhitelist, whitelistedAdapters, comptrollerProxy, EOAPolicyManager } = await provider.snapshot(
      snapshotWithStandalonePolicy,
    );

    const adapterWhitelistConfig = adapterWhitelistArgs(whitelistedAdapters);
    const receipt = await adapterWhitelist
      .connect(EOAPolicyManager)
      .addFundSettings(comptrollerProxy, adapterWhitelistConfig);

    // Assert the AddressesAdded event was emitted
    assertEvent(receipt, 'AddressesAdded', {
      comptrollerProxy,
      items: whitelistedAdapters,
    });

    // List should be the whitelisted adapters
    const listResult = await adapterWhitelist.getList(comptrollerProxy);
    expect(listResult).toMatchObject(whitelistedAdapters);
  });
});

describe('updateFundSettings', () => {
  it('cannot be called', async () => {
    const { adapterWhitelist } = await provider.snapshot(snapshotWithStandalonePolicy);

    await expect(adapterWhitelist.updateFundSettings(randomAddress(), randomAddress(), '0x')).rejects.toBeRevertedWith(
      'Updates not allowed for this policy',
    );
  });
});

describe('validateRule', () => {
  it('returns true if an adapter is in the whitelist', async () => {
    const { adapterWhitelist, whitelistedAdapters, comptrollerProxy } = await provider.snapshot(
      snapshotWithConfiguredStandalonePolicy,
    );

    // Only the adapter arg matters for this policy
    const preCoIArgs = validateRulePreCoIArgs({
      adapter: whitelistedAdapters[0], // good adapter
      selector: utils.randomBytes(4),
    });

    const validateRuleResult = await adapterWhitelist.validateRule
      .args(comptrollerProxy, randomAddress(), PolicyHook.PreCallOnIntegration, preCoIArgs)
      .call();

    expect(validateRuleResult).toBeTruthy();
  });

  it('returns false if an adapter is not in the whitelist', async () => {
    const { adapterWhitelist, comptrollerProxy } = await provider.snapshot(snapshotWithConfiguredStandalonePolicy);

    // Only the adapter arg matters for this policy
    const preCoIArgs = validateRulePreCoIArgs({
      adapter: randomAddress(), // bad adapter
      selector: utils.randomBytes(4),
    });

    const validateRuleResult = await adapterWhitelist.validateRule
      .args(comptrollerProxy, randomAddress(), PolicyHook.PreCallOnIntegration, preCoIArgs)
      .call();

    expect(validateRuleResult).toBeFalsy();
  });
});

describe('integration tests', () => {
  it('can create a new fund with this policy, and it works correctly during callOnIntegration', async () => {
    const {
      accounts: [fundOwner],
      deployment: {
        fundDeployer,
        adapterWhitelist,
        tokens: { weth: denominationAsset },
      },
    } = await provider.snapshot(snapshot);

    // declare variables for policy config
    const adapterWhitelistAddresses = [randomAddress(), randomAddress(), randomAddress()];
    const nonWhitelistedAdapter = randomAddress();
    const adapterWhitelistSettings = adapterWhitelistArgs(adapterWhitelistAddresses);
    const policyManagerConfig = policyManagerConfigArgs({
      policies: [adapterWhitelist.address],
      settings: [adapterWhitelistSettings],
    });

    // create new fund with policyManagerConfig argument
    const { comptrollerProxy } = await createNewFund({
      signer: fundOwner,
      fundDeployer,
      denominationAsset,
      fundOwner,
      fundName: 'Test Fund!',
      policyManagerConfig,
    });

    // confirm a non-whitelisted adapter is not allowed
    const failingPreCoIArgs = validateRulePreCoIArgs({
      adapter: nonWhitelistedAdapter,
      selector: utils.randomBytes(4),
    });

    const failingValidateRuleResult = await adapterWhitelist.validateRule
      .args(comptrollerProxy, randomAddress(), PolicyHook.PreCallOnIntegration, failingPreCoIArgs)
      .call();

    expect(failingValidateRuleResult).toBeFalsy();

    // confirm a whitelisted adapter is allowed
    const passingPreCoIArgs = validateRulePreCoIArgs({
      adapter: adapterWhitelistAddresses[0],
      selector: utils.randomBytes(4),
    });

    const passingValidateRuleResult = await adapterWhitelist.validateRule
      .args(comptrollerProxy, randomAddress(), PolicyHook.PreCallOnIntegration, passingPreCoIArgs)
      .call();

    expect(passingValidateRuleResult).toBeTruthy();
  });

  it('can create a migrated fund with this policy', async () => {
    const {
      accounts: [fundOwner],
      config: {
        deployer,
        integratees: {
          synthetix: { addressResolver: synthetixAddressResolverAddress },
        },
      },
      deployment: {
        kyberAdapter,
        uniswapV2Adapter,
        chainlinkPriceFeed,
        dispatcher,
        feeManager,
        fundDeployer,
        integrationManager,
        policyManager,
        synthetixPriceFeed,
        valueInterpreter,
        vaultLib,
        adapterWhitelist,
        tokens: { weth: denominationAsset, mln: incomingAsset },
      },
    } = await provider.snapshot(snapshot);

    const adapterWhitelistAddresses = [kyberAdapter.address];
    const adapterWhitelistSettings = adapterWhitelistArgs(adapterWhitelistAddresses);
    const policyManagerConfig = policyManagerConfigArgs({
      policies: [adapterWhitelist.address],
      settings: [adapterWhitelistSettings],
    });

    // create new fund with policy as above
    const { vaultProxy } = await createNewFund({
      signer: fundOwner,
      fundDeployer,
      denominationAsset,
      fundOwner,
      fundName: 'Test Fund!',
      policyManagerConfig,
    });

    // migrate fund
    const nextFundDeployer = await createFundDeployer({
      deployer,
      chainlinkPriceFeed,
      dispatcher,
      feeManager,
      integrationManager,
      policyManager,
      synthetixPriceFeed,
      synthetixAddressResolverAddress,
      valueInterpreter,
      vaultLib,
    });

    const { comptrollerProxy: nextComptrollerProxy } = await createMigratedFundConfig({
      signer: fundOwner,
      fundDeployer: nextFundDeployer,
      denominationAsset,
      policyManagerConfigData: policyManagerConfig,
    });

    const signedNextFundDeployer = nextFundDeployer.connect(fundOwner);
    await signedNextFundDeployer.signalMigration(vaultProxy, nextComptrollerProxy);

    // Warp to migratable time
    const migrationTimelock = await dispatcher.getMigrationTimelock();
    await provider.send('evm_increaseTime', [migrationTimelock.toNumber()]);

    // Migration execution settles the accrued fee
    await signedNextFundDeployer.executeMigration(vaultProxy);

    // send money to vault to trade
    await denominationAsset.transfer(vaultProxy.address, utils.parseEther('10'));

    // trade with an allowed adapter, expect success
    const kyberArgs = kyberTakeOrderArgs({
      incomingAsset,
      minIncomingAssetAmount: utils.parseEther('1'),
      outgoingAsset: denominationAsset,
      outgoingAssetAmount: utils.parseEther('1'),
    });

    const kyberCallArgs = callOnIntegrationArgs({
      adapter: kyberAdapter,
      selector: takeOrderSelector,
      encodedCallArgs: kyberArgs,
    });

    await nextComptrollerProxy
      .connect(fundOwner)
      .callOnExtension(integrationManager, IntegrationManagerActionId.CallOnIntegration, kyberCallArgs);

    // trade with an adapter that's not explicitly allowed, expect failure
    const uniswapArgs = uniswapV2TakeOrderArgs({
      path: [incomingAsset.address],
      minIncomingAssetAmount: utils.parseEther('1'),
      outgoingAssetAmount: utils.parseEther('1'),
    });

    const uniswapCallArgs = callOnIntegrationArgs({
      adapter: uniswapV2Adapter,
      selector: takeOrderSelector,
      encodedCallArgs: uniswapArgs,
    });

    const uniswapTx = nextComptrollerProxy
      .connect(fundOwner)
      .callOnExtension(integrationManager, IntegrationManagerActionId.CallOnIntegration, uniswapCallArgs);
    await expect(uniswapTx).rejects.toBeRevertedWith(
      'VM Exception while processing transaction: revert Rule evaluated to false: ADAPTER_WHITELIST',
    );
  });
});
