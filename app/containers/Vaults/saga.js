import BigNumber from 'bignumber.js';
import { selectAccount } from 'containers/ConnectionProvider/selectors';
import { selectMigrationData } from 'containers/Vaults/selectors';
import blacklist from 'containers/Vaults/blacklist.json';
import { approveTxSpend } from 'utils/contracts';
import request from 'utils/request';
import { APP_INITIALIZED } from 'containers/App/constants';
import { ACCOUNT_UPDATED } from 'containers/ConnectionProvider/constants';
import { call, put, takeLatest, select, all, take } from 'redux-saga/effects';
import {
  selectSelectedAccount,
  selectVaults,
  selectTokenAllowance,
  selectContractData,
} from 'containers/App/selectors';
import { MAX_UINT256 } from 'containers/Cover/constants';
import { vaultsLoaded, userVaultStatisticsLoaded } from './actions';
import {
  VAULTS_LOADED,
  WITHDRAW_FROM_VAULT,
  WITHDRAW_ALL_FROM_VAULT,
  DEPOSIT_TO_VAULT,
  CLAIM_BACKSCRATCHER_REWARDS,
  RESTAKE_BACKSCRATCHER_REWARDS,
  MIGRATE_VAULT,
  TRUSTED_MIGRATOR_ADDRESS,
  V2_WETH_VAULT_ADDRESS,
  V2_ETH_ZAP_ADDRESS,
  ZAP_PICKLE,
  DEPOSIT_PICKLE_SLP_IN_FARM,
  EXIT_OLD_PICKLE,
} from './constants';
// TODO: Do better... never hard-code vault addresses
const v1WethVaultAddress = '0xe1237aA7f535b0CC33Fd973D66cBf830354D16c7';
const ethAddress = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const crvAaveAddress = '0x03403154afc09Ce8e44C3B185C82C6aD5f86b9ab';
const crvSAaveV2Address = '0xb4D1Be44BfF40ad6e506edf43156577a3f8672eC';
const crvSAaveV1Address = '0xBacB69571323575C6a5A3b4F9EEde1DC7D31FBc1';

const injectEthVaults = (vaults) => {
  const ethereumString = 'ETH';
  const v1WethVault = _.find(vaults, { address: v1WethVaultAddress });
  const v1EthVault = _.cloneDeep(v1WethVault);
  v1EthVault.displayName = ethereumString;
  v1EthVault.pureEthereum = true;
  v1EthVault.token.address = ethAddress;
  v1EthVault.token.symbol = 'ETH';
  v1EthVault.token.icon = `https://rawcdn.githack.com/iearn-finance/yearn-assets/master/icons/tokens/${ethAddress}/logo-128.png`;

  const v2WethVault = _.find(vaults, { address: V2_WETH_VAULT_ADDRESS });
  const v2EthVault = _.cloneDeep(v2WethVault);

  v2EthVault.displayName = ethereumString;
  v2EthVault.pureEthereum = true;
  v2EthVault.token.address = ethAddress;
  v2EthVault.token.symbol = 'ETH';
  v2EthVault.token.icon = `https://rawcdn.githack.com/iearn-finance/yearn-assets/master/icons/tokens/${ethAddress}/logo-128.png`;
  v2EthVault.zapAddress = V2_ETH_ZAP_ADDRESS;

  vaults.push(v1EthVault, v2EthVault);
  return vaults;
};

function* fetchVaults() {
  const endpoint =
    process.env.API_ENV === 'development' ||
    process.env.NODE_ENV === 'development'
      ? `https://dev.vaults.finance/all`
      : `https://vaults.finance/all`;
  try {
    const vaults = yield call(request, endpoint);
    const vaultsWithEth = injectEthVaults(vaults);

    // TODO: Remove UI hacks...
    const masterChefAddress = '0xbD17B1ce622d73bD438b9E658acA5996dc394b0d';
    const correctedVaults = _.map(vaultsWithEth, (vault) => {
      const newVault = vault;
      if (vault.address === masterChefAddress) {
        newVault.type = 'masterChef';
      }
      return newVault;
    });

    const filteredVaults = _.filter(
      correctedVaults,
      (vault) => _.includes(blacklist, vault.address) === false,
    );

    yield put(vaultsLoaded(filteredVaults));
  } catch (err) {
    console.log('Error reading vaults', err);
  }
}

function* fetchUserVaultStatistics() {
  try {
    const selectedAccount = yield select(selectSelectedAccount());
    const vaults = yield select(selectVaults());

    const userVaultStatisticsUrl = `https://api.yearn.tools/user/${selectedAccount}/vaults?statistics=true&apy=true`;
    const userVaultStatistics = yield call(request, userVaultStatisticsUrl);
    const vaultsWithUserStatistics = vaults.reduce((current, next) => {
      const userDepositedInNextVault = userVaultStatistics.find(
        (userVaultStatistic) =>
          next.vaultAlias === userVaultStatistic.vaultAlias,
      );
      if (userDepositedInNextVault) {
        return current.concat({ ...next, ...userDepositedInNextVault });
      }
      return current.concat(next);
    }, []);
    // console.log(vaultsWithUserStatistics);
    yield put(userVaultStatisticsLoaded(vaultsWithUserStatistics));
  } catch (err) {
    console.log('Error reading vaults', err);
  }
}

function* withdrawFromVault(action) {
  const {
    vaultContract,
    withdrawalAmount,
    decimals,
    pureEthereum,
    unstakePickle,
  } = action.payload;

  const account = yield select(selectAccount());

  const vaultContractData = yield select(
    selectContractData(vaultContract.address),
  );

  const v2Vault = _.get(vaultContractData, 'pricePerShare');

  const vaultAddress = _.get(vaultContractData, 'address');
  const vaultIsAave =
    vaultAddress === crvAaveAddress ||
    vaultAddress === crvSAaveV2Address ||
    vaultAddress === crvSAaveV1Address;

  let sharesForWithdrawal;
  if (v2Vault) {
    const sharePrice = _.get(vaultContractData, 'pricePerShare');
    sharesForWithdrawal = new BigNumber(withdrawalAmount)
      .dividedBy(sharePrice / 10 ** decimals)
      .decimalPlaces(0)
      .toFixed(0);
  } else {
    const sharePrice = _.get(vaultContractData, 'getPricePerFullShare');
    sharesForWithdrawal = new BigNumber(withdrawalAmount)
      .dividedBy(sharePrice / 10 ** 18)
      .decimalPlaces(0)
      .toFixed(0);
  }

  try {
    // Vault is not eth
    if (!pureEthereum) {
      if (unstakePickle) {
        // Pickle transaction
        yield call(
          vaultContract.methods.withdraw.cacheSend,
          26,
          withdrawalAmount,
          {
            from: account,
          },
        );
      } else {
        if (vaultIsAave) {
          // Vault is AAVE
          yield call(
            vaultContract.methods.withdraw.cacheSend,
            sharesForWithdrawal,
            {
              from: account,
              gas: 2000000,
            },
          );
          return;
        }
        // Vault is not AAVE
        yield call(
          vaultContract.methods.withdraw.cacheSend,
          sharesForWithdrawal,
          {
            from: account,
          },
        );
      }
    } else {
      // Vault is ETH
      const { zapContract } = vaultContract;
      if (zapContract) {
        let method;
        if (zapContract.methods.withdrawETH) {
          method = zapContract.methods.withdrawETH;
        } else {
          method = vaultContract.methods.withdraw;
        }
        yield call(method.cacheSend, sharesForWithdrawal, {
          from: account,
        });
      } else {
        yield call(
          vaultContract.methods.withdrawETH.cacheSend,
          sharesForWithdrawal,
          {
            from: account,
          },
        );
      }
    }
  } catch (error) {
    console.error(error);
  }
}

function* withdrawAllFromVault(action) {
  const { vaultContract, balanceOf } = action.payload;

  const vaultContractData = yield select(
    selectContractData(vaultContract.address),
  );

  const vaultAddress = _.get(vaultContractData, 'address');
  const vaultIsAave =
    vaultAddress === crvAaveAddress ||
    vaultAddress === crvSAaveV2Address ||
    vaultAddress === crvSAaveV1Address;

  const account = yield select(selectAccount());

  try {
    if (vaultIsAave) {
      yield call(vaultContract.methods.withdraw.cacheSend, balanceOf, {
        from: account,
        gas: 2000000,
      });
      return;
    }

    // if (!pureEthereum) {
    yield call(vaultContract.methods.withdraw.cacheSend, balanceOf, {
      from: account,
    });
    // } else {
    //   yield call(vaultContract.methods.withdrawAllETH.cacheSend, {
    //     from: account,
    //   });
    // }
  } catch (error) {
    console.error(error);
  }
}

function* depositToVault(action) {
  const {
    vaultContract,
    tokenContract,
    depositAmount,
    pureEthereum,
    hasAllowance,
  } = action.payload;

  const account = yield select(selectAccount());
  const tokenAllowance = yield select(
    selectTokenAllowance(tokenContract.address, vaultContract.address),
  );

  const vaultAllowedToSpendToken = tokenAllowance > 0 || hasAllowance;

  try {
    if (!pureEthereum) {
      if (!vaultAllowedToSpendToken) {
        yield call(
          approveTxSpend,
          tokenContract,
          account,
          vaultContract.address,
        );
      }
      yield call(vaultContract.methods.deposit.cacheSend, depositAmount, {
        from: account,
      });
    } else {
      const { zapContract } = vaultContract;
      if (zapContract) {
        yield call(zapContract.methods.depositETH.cacheSend, {
          from: account,
          value: depositAmount,
        });
      } else {
        yield call(vaultContract.methods.depositETH.cacheSend, {
          from: account,
          value: depositAmount,
        });
      }
    }
  } catch (error) {
    console.error(error);
  }
}

function* zapPickle(action) {
  const {
    zapPickleContract,
    tokenContract,
    depositAmount,
    pureEthereum,
  } = action.payload;

  const account = yield select(selectAccount());
  const tokenAllowance = yield select(
    selectTokenAllowance(tokenContract.address, zapPickleContract.address),
  );

  const vaultAllowedToSpendToken = tokenAllowance > 0;

  try {
    if (!pureEthereum) {
      if (!vaultAllowedToSpendToken) {
        yield call(
          approveTxSpend,
          tokenContract,
          account,
          zapPickleContract.address,
        );
      }
      yield call(zapPickleContract.methods.zapInCRV.cacheSend, depositAmount, {
        from: account,
      });
    } else {
      yield call(zapPickleContract.methods.zapInETH.cacheSend, {
        from: account,
        value: depositAmount,
      });
    }
  } catch (error) {
    console.error(error);
  }
}

function* exitOldPickleGauge(action) {
  const { oldPickleGaugeContract } = action.payload;

  const account = yield select(selectAccount());
  try {
    yield call(oldPickleGaugeContract.methods.exit().send, { from: account });
  } catch (error) {
    console.error('failed exit', error);
  }
}

function* depositPickleSLPInFarm(action) {
  const {
    vaultContract,
    tokenContract,
    depositAmount,
    allowance,
  } = action.payload;

  const account = yield select(selectAccount());

  const vaultAllowedToSpendToken = allowance > 0;

  try {
    if (!vaultAllowedToSpendToken) {
      yield call(
        // eslint-disable-next-line no-underscore-dangle
        tokenContract.methods.approve(vaultContract._address, MAX_UINT256).send,
        { from: account },
      );
    }
    yield call(vaultContract.methods.deposit(depositAmount).send, {
      from: account,
    });
  } catch (error) {
    console.error(error);
  }
}

function* restakeBackscratcherRewards(action) {
  const { vyperContract, threeCrvContract } = action.payload;

  const account = yield select(selectAccount());
  const allowance = yield select(
    selectTokenAllowance(threeCrvContract.address, vyperContract.address),
  );

  const spendTokenApproved = new BigNumber(allowance).gt(0);

  try {
    if (!spendTokenApproved) {
      yield call(
        approveTxSpend,
        threeCrvContract,
        account,
        vyperContract.address,
      );
    }
    yield call(vyperContract.methods.zap.cacheSend, {
      from: account,
    });
  } catch (error) {
    console.error(error);
  }
}

function* claimBackscratcherRewards(action) {
  const { vaultContract } = action.payload;

  const account = yield select(selectAccount());

  try {
    yield call(vaultContract.methods.claim.cacheSend, {
      from: account,
    });
  } catch (error) {
    console.error(error);
  }
}

function* migrateVault(action) {
  const { vaultContract, trustedMigratorContract } = action.payload;

  const account = yield select(selectAccount());
  const allowance = yield select(
    selectTokenAllowance(vaultContract.address, TRUSTED_MIGRATOR_ADDRESS),
  );
  const migrationData = yield select(selectMigrationData);
  console.log(account);

  const vaultMigrationData = migrationData[vaultContract.address];
  const isMigratable = !!vaultMigrationData;
  if (!isMigratable) {
    console.error(`Cant migrate vault ${vaultContract.address}`);
    return;
  }

  const vaultAddress = vaultContract.address;
  const vaultIsAave =
    vaultAddress === crvAaveAddress ||
    vaultAddress === crvSAaveV2Address ||
    vaultAddress === crvSAaveV1Address;

  const spendTokenApproved = new BigNumber(allowance).gt(0);

  try {
    if (!spendTokenApproved) {
      yield call(
        approveTxSpend,
        vaultContract,
        account,
        trustedMigratorContract.address,
      );
    }

    if (vaultIsAave) {
      yield call(
        trustedMigratorContract.methods.migrateAll.cacheSend,
        vaultMigrationData.vaultFrom,
        vaultMigrationData.vaultTo,
        {
          from: account,
          gas: 2000000,
        },
      );
      return;
    }

    yield call(
      trustedMigratorContract.methods.migrateAll.cacheSend,
      vaultMigrationData.vaultFrom,
      vaultMigrationData.vaultTo,
      {
        from: account,
      },
    );
  } catch (error) {
    console.error(error);
  }
}

export default function* initialize() {
  yield takeLatest([APP_INITIALIZED], fetchVaults);
  // Wait for these two to have already executed
  yield all([take(ACCOUNT_UPDATED), take(VAULTS_LOADED)]);
  yield fetchUserVaultStatistics();
  yield takeLatest(WITHDRAW_FROM_VAULT, withdrawFromVault);
  yield takeLatest(WITHDRAW_ALL_FROM_VAULT, withdrawAllFromVault);
  yield takeLatest(DEPOSIT_TO_VAULT, depositToVault);
  yield takeLatest(ZAP_PICKLE, zapPickle);
  yield takeLatest(DEPOSIT_PICKLE_SLP_IN_FARM, depositPickleSLPInFarm);
  yield takeLatest(RESTAKE_BACKSCRATCHER_REWARDS, restakeBackscratcherRewards);
  yield takeLatest(CLAIM_BACKSCRATCHER_REWARDS, claimBackscratcherRewards);
  yield takeLatest(MIGRATE_VAULT, migrateVault);
  yield takeLatest(EXIT_OLD_PICKLE, exitOldPickleGauge);
}
