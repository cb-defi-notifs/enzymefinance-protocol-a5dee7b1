// SPDX-License-Identifier: GPL-3.0

/*
    This file is part of the Enzyme Protocol.

    (c) Enzyme Council <council@enzyme.finance>

    For the full license information, please view the LICENSE
    file that was distributed with this source code.
*/

pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

/// @title ITestCompoundV3CometRewards Interface
/// @author Enzyme Council <security@enzyme.finance>
interface ITestCompoundV3CometRewards {
    struct RewardConfig {
        address token;
        uint64 rescaleFactor;
        bool shouldUpscale;
    }

    function rewardConfig(address _cToken)
        external
        view
        returns (RewardConfig memory rewardConfig_);
}
