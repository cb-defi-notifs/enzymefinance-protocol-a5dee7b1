/*
 * @file Uses the EntranceRateDirectFee to test the basic functionality of an EntranceRateFeeBase
 * that does not rely on settlement type
 */

import { utils } from 'ethers';
import {
  EthereumTestnetProvider,
  randomAddress,
} from '@crestproject/crestproject';
import {
  EntranceRateDirectFee,
  entranceRateFeeConfigArgs,
  FeeHook,
  settlePostBuySharesArgs,
} from '@melonproject/protocol';
import { assertEvent, defaultTestDeployment } from '@melonproject/testutils';

async function snapshot(provider: EthereumTestnetProvider) {
  const { accounts, deployment, config } = await defaultTestDeployment(
    provider,
  );

  // Create standalone EntranceRateDirectFee
  const [EOAFeeManager, ...remainingAccounts] = accounts;
  const standaloneEntranceRateFee = await EntranceRateDirectFee.deploy(
    config.deployer,
    EOAFeeManager,
  );

  return {
    accounts: remainingAccounts,
    config,
    deployment,
    EOAFeeManager,
    standaloneEntranceRateFee,
  };
}

describe('constructor', () => {
  it('sets state vars', async () => {
    const {
      deployment: { feeManager, entranceRateDirectFee },
    } = await provider.snapshot(snapshot);

    const getFeeManagerCall = await entranceRateDirectFee.getFeeManager();
    expect(getFeeManagerCall).toMatchAddress(feeManager);

    // Implements expected hooks
    const implementedHooksCall = await entranceRateDirectFee.implementedHooks();
    expect(implementedHooksCall).toMatchObject([FeeHook.PostBuyShares]);
  });
});

describe('addFundSettings', () => {
  it('can only be called by the FeeManager', async () => {
    const { standaloneEntranceRateFee } = await provider.snapshot(snapshot);
    const entranceRateFeeConfig = await entranceRateFeeConfigArgs(1);

    await expect(
      standaloneEntranceRateFee.addFundSettings(
        randomAddress(),
        entranceRateFeeConfig,
      ),
    ).rejects.toBeRevertedWith('Only the FeeManger can make this call');
  });

  it('correctly handles valid call', async () => {
    const {
      EOAFeeManager,
      standaloneEntranceRateFee,
    } = await provider.snapshot(snapshot);

    // Add fee config for a random comptrollerProxyAddress
    const comptrollerProxyAddress = randomAddress();
    const rate = utils.parseEther('1');
    const entranceRateFeeConfig = await entranceRateFeeConfigArgs(rate);
    const receipt = await standaloneEntranceRateFee
      .connect(EOAFeeManager)
      .addFundSettings(comptrollerProxyAddress, entranceRateFeeConfig);

    // Assert the FundSettingsAdded event was emitted
    assertEvent(receipt, 'FundSettingsAdded', {
      comptrollerProxy: comptrollerProxyAddress,
      rate,
    });

    // Assert state has been set
    const getRateForFundCall = await standaloneEntranceRateFee.getRateForFund(
      comptrollerProxyAddress,
    );
    expect(getRateForFundCall).toEqBigNumber(rate);
  });
});

describe('payout', () => {
  it('returns false', async () => {
    const { standaloneEntranceRateFee } = await provider.snapshot(snapshot);
    const payoutCall = await standaloneEntranceRateFee.payout
      .args(randomAddress(), randomAddress())
      .call();

    expect(payoutCall).toBe(false);
  });
});

describe('settle', () => {
  it('can only be called by the FeeManager', async () => {
    const { standaloneEntranceRateFee } = await provider.snapshot(snapshot);

    const settlementData = await settlePostBuySharesArgs({
      buyer: randomAddress(),
      investmentAmount: utils.parseEther('1'),
      sharesBought: utils.parseEther('1'),
    });

    await expect(
      standaloneEntranceRateFee.settle(
        randomAddress(),
        randomAddress(),
        FeeHook.PostBuyShares,
        settlementData,
      ),
    ).rejects.toBeRevertedWith('Only the FeeManger can make this call');
  });
});