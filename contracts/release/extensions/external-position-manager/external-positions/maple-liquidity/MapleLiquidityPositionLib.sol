// SPDX-License-Identifier: GPL-3.0

/*
    This file is part of the Enzyme Protocol.
    (c) Enzyme Council <council@enzyme.finance>
    For the full license information, please view the LICENSE
    file that was distributed with this source code.
*/

pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "../../../../../persistent/external-positions/maple-liquidity/MapleLiquidityPositionLibBase1.sol";
import "../../../../interfaces/IMaplePool.sol";
import "../../../../interfaces/IMapleMplRewards.sol";
import "../../../../utils/AddressArrayLib.sol";
import "../../../../utils/AssetHelpers.sol";
import "./IMapleLiquidityPosition.sol";
import "./MapleLiquidityPositionDataDecoder.sol";

/// @title MapleLiquidityPositionLib Contract
/// @author Enzyme Council <security@enzyme.finance>
/// @notice An External Position library contract for Maple liquidity positions
contract MapleLiquidityPositionLib is
    IMapleLiquidityPosition,
    MapleLiquidityPositionDataDecoder,
    MapleLiquidityPositionLibBase1,
    AssetHelpers
{
    using AddressArrayLib for address[];
    using SafeERC20 for ERC20;
    using SafeMath for uint256;

    uint256 private constant MPT_DECIMALS_FACTOR = 10**18;

    /// @notice Initializes the external position
    /// @dev Nothing to initialize for this contract
    function init(bytes memory) external override {}

    /// @notice Receives and executes a call from the Vault
    /// @param _actionData Encoded data to execute the action
    function receiveCallFromVault(bytes memory _actionData) external override {
        (uint256 actionId, bytes memory actionArgs) = abi.decode(_actionData, (uint256, bytes));

        if (actionId == uint256(Actions.Lend)) {
            __lend(actionArgs);
        } else if (actionId == uint256(Actions.IntendToRedeem)) {
            __intendToRedeem(actionArgs);
        } else if (actionId == uint256(Actions.Redeem)) {
            __redeem(actionArgs);
        } else if (actionId == uint256(Actions.Stake)) {
            __stake(actionArgs);
        } else if (actionId == uint256(Actions.Unstake)) {
            __unstake(actionArgs);
        } else if (actionId == uint256(Actions.ClaimInterest)) {
            __claimInterest(actionArgs);
        } else if (actionId == uint256(Actions.ClaimRewards)) {
            __claimRewards(actionArgs);
        } else {
            revert("receiveCallFromVault: Invalid actionId");
        }
    }

    /// @dev Claims all interest accrued and send it to the Vault
    function __claimInterest(bytes memory _actionArgs) private {
        IMaplePool pool = IMaplePool(__decodeClaimInterestActionArgs(_actionArgs));

        pool.withdrawFunds();

        ERC20 liquidityAssetContract = ERC20(pool.liquidityAsset());

        // Send liquidity asset interest to the vault
        liquidityAssetContract.safeTransfer(
            msg.sender,
            liquidityAssetContract.balanceOf(address(this))
        );
    }

    /// @dev Claims all rewards accrued and send it to the Vault
    function __claimRewards(bytes memory _actionArgs) private {
        address rewardsContract = __decodeClaimRewardsActionArgs(_actionArgs);

        IMapleMplRewards mapleRewards = IMapleMplRewards(rewardsContract);
        ERC20 rewardToken = ERC20(mapleRewards.rewardsToken());
        mapleRewards.getReward();

        rewardToken.safeTransfer(msg.sender, rewardToken.balanceOf(address(this)));
    }

    /// @dev Activates the cooldown period to redeem an asset from a Maple pool
    function __intendToRedeem(bytes memory _actionArgs) private {
        address pool = __decodeIntendToRedeemActionArgs(_actionArgs);

        IMaplePool(pool).intendToWithdraw();
    }

    /// @dev Lends assets to a Maple pool
    function __lend(bytes memory _actionArgs) private {
        (
            address liquidityAsset,
            address pool,
            uint256 liquidityAssetAmount
        ) = __decodeLendActionArgs(_actionArgs);
        __approveAssetMaxAsNeeded(liquidityAsset, pool, liquidityAssetAmount);

        IMaplePool(pool).deposit(liquidityAssetAmount);

        if (!isUsedLendingPool(pool)) {
            usedLendingPools.push(pool);

            emit UsedLendingPoolAdded(pool);
        }
    }

    /// @dev Redeems assets from a Maple pool and claims all accrued interest
    function __redeem(bytes memory actionArgs) private {
        (
            address liquidityAsset,
            address pool,
            uint256 liquidityAssetAmount
        ) = __decodeRedeemActionArgs(actionArgs);

        // Also claims all accrued interest
        IMaplePool(pool).withdraw(liquidityAssetAmount);

        // Send liquidity asset back to the vault
        // Balance will be greater than liquidityAssetAmount if accrued interest is > 0
        ERC20(liquidityAsset).safeTransfer(
            msg.sender,
            ERC20(liquidityAsset).balanceOf(address(this))
        );

        // If the full amount of pool tokens has been redeemed, it can be removed from usedLendingPools
        if (ERC20(pool).balanceOf(address(this)) == 0) {
            usedLendingPools.removeStorageItem(pool);

            emit UsedLendingPoolRemoved(pool);
        }
    }

    /// @dev Stakes assets to a rewardsContract
    function __stake(bytes memory _actionArgs) private {
        (address rewardsContract, address pool, uint256 poolTokenAmount) = __decodeStakeActionArgs(
            _actionArgs
        );

        IMaplePool(pool).increaseCustodyAllowance(rewardsContract, poolTokenAmount);
        IMapleMplRewards(rewardsContract).stake(poolTokenAmount);
    }

    /// @dev Unstakes assets from a rewardsContract
    function __unstake(bytes memory _actionArgs) private {
        (address rewardsContract, uint256 poolTokenAmount) = __decodeUnstakeActionArgs(
            _actionArgs
        );
        IMapleMplRewards(rewardsContract).withdraw(poolTokenAmount);
    }

    ////////////////////
    // POSITION VALUE //
    ////////////////////

    /// @notice Retrieves the debt assets (negative value) of the external position
    /// @return assets_ Debt assets
    /// @return amounts_ Debt asset amounts
    function getDebtAssets()
        external
        override
        returns (address[] memory assets_, uint256[] memory amounts_)
    {
        return (assets_, amounts_);
    }

    /// @notice Retrieves the managed assets (positive value) of the external position
    /// @return assets_ Managed assets
    /// @return amounts_ Managed asset amounts
    function getManagedAssets()
        external
        override
        returns (address[] memory assets_, uint256[] memory amounts_)
    {
        uint256 usedLendingPoolsLength = usedLendingPools.length;

        assets_ = new address[](usedLendingPoolsLength);
        amounts_ = new uint256[](usedLendingPoolsLength);

        for (uint256 i; i < usedLendingPoolsLength; i++) {
            IMaplePool pool = IMaplePool(usedLendingPools[i]);

            assets_[i] = pool.liquidityAsset();

            // The liquidity asset balance is derived from the pool token balance (which is stored as a wad),
            // while interest and losses are already returned in terms of the liquidity asset (not pool token)
            uint256 liquidityAssetBalance = ERC20(usedLendingPools[i])
                .balanceOf(address(this))
                .mul(10**(uint256(ERC20(assets_[i]).decimals())))
                .div(MPT_DECIMALS_FACTOR);

            uint256 accumulatedInterest = pool.withdrawableFundsOf(address(this));
            uint256 accumulatedLosses = pool.recognizableLossesOf(address(this));

            amounts_[0] = liquidityAssetBalance.add(accumulatedInterest).sub(accumulatedLosses);
        }

        return (assets_, amounts_);
    }

    ///////////////////
    // STATE GETTERS //
    ///////////////////

    // EXTERNAL FUNCTIONS

    /// @notice Checks whether a poolToken has been used to lend
    /// @return isUsedLendingPool True if the asset is part of the used lending pools
    function isUsedLendingPool(address _asset) public view returns (bool) {
        return usedLendingPools.contains(_asset);
    }
}
