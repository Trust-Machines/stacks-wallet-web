import { memo, Suspense, useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { StacksTransaction } from '@stacks/transactions';
import toast from 'react-hot-toast';
import { Formik } from 'formik';

import { useHomeTabs } from '@app/common/hooks/use-home-tabs';
import { useRouteHeader } from '@app/common/hooks/use-route-header';
import { LoadingKeys } from '@app/common/hooks/use-loading';
import { useDrawers } from '@app/common/hooks/use-drawers';
import { useAnalytics } from '@app/common/hooks/analytics/use-analytics';
import { TransactionFormValues } from '@app/common/transactions/transaction-utils';
import { useNextNonce } from '@app/query/nonce/account-nonces.hooks';
import { Header } from '@app/components/header';
import { useWalletType } from '@app/common/use-wallet-type';
import { useLedgerNavigate } from '@app/features/ledger/hooks/use-ledger-navigate';
import { EditNonceDrawer } from '@app/features/edit-nonce-drawer/edit-nonce-drawer';
import { HighFeeDrawer } from '@app/features/high-fee-drawer/high-fee-drawer';
import { useSelectedAsset } from '@app/pages/send-tokens/hooks/use-selected-asset';
import { useSendFormValidation } from '@app/pages/send-tokens/hooks/use-send-form-validation';
import { useFeeEstimations } from '@app/query/fees/fees.hooks';
import {
  useGenerateSendFormUnsignedTx,
  useSendFormEstimatedUnsignedTxByteLengthState,
  useSendFormSerializedUnsignedTxPayloadState,
  useSignTransactionSoftwareWallet,
} from '@app/store/transactions/transaction.hooks';
import { logger } from '@shared/logger';
import { FeeType } from '@shared/models/fees-types';
import { RouteUrls } from '@shared/route-urls';
import { useTransferableAssets } from '@app/store/assets/asset.hooks';

import { SendTokensSoftwareConfirmDrawer } from './components/send-tokens-confirm-drawer/send-tokens-confirm-drawer';
import { SendFormInner } from './components/send-form-inner';
import { useSubmitTransactionCallback } from '@app/common/hooks/use-submit-stx-transaction';

function SendTokensFormBase() {
  const navigate = useNavigate();
  const assets = useTransferableAssets();
  const { showEditNonce, showNetworks } = useDrawers();
  const [isShowing, setShowing] = useState(false);
  const [assetError, setAssetError] = useState<string | undefined>(undefined);
  const { setActiveTabActivity } = useHomeTabs();
  const { selectedAsset } = useSelectedAsset();
  const sendFormSchema = useSendFormValidation({ setAssetError });
  const generateTx = useGenerateSendFormUnsignedTx();
  const signSoftwareWalletTx = useSignTransactionSoftwareWallet();
  const txByteLength = useSendFormEstimatedUnsignedTxByteLengthState();
  const txPayload = useSendFormSerializedUnsignedTxPayloadState();
  const feeEstimations = useFeeEstimations(txByteLength, txPayload);
  const { nonce } = useNextNonce();
  const analytics = useAnalytics();
  const { whenWallet } = useWalletType();
  const ledgerNavigate = useLedgerNavigate();

  useRouteHeader(<Header title="Send" onClose={() => navigate(RouteUrls.Home)} />);

  useEffect(() => {
    if (showNetworks) {
      navigate(RouteUrls.Home);
    }
  }, [navigate, showNetworks]);

  const handleConfirmDrawerOnClose = useCallback(() => {
    setShowing(false);
    void setActiveTabActivity();
  }, [setActiveTabActivity]);

  const broadcastTransactionFn = useSubmitTransactionCallback({
    loadingKey: LoadingKeys.CONFIRM_DRAWER,
  });

  const broadcastTransactionAction = useCallback(
    async (signedTx: StacksTransaction) => {
      if (!signedTx) {
        logger.error('Cannot broadcast transaction, no tx in state');
        toast.error('Unable to broadcast transaction');
        return;
      }
      try {
        await broadcastTransactionFn({
          onClose() {
            handleConfirmDrawerOnClose();
          },
          onError(e) {
            handleConfirmDrawerOnClose();
            navigate(RouteUrls.TransactionBroadcastError, { state: { message: e.message } });
          },
          replaceByFee: false,
        })(signedTx);
      } catch (e) {
        handleConfirmDrawerOnClose();
        navigate(RouteUrls.TransactionBroadcastError, {
          state: { message: e instanceof Error ? e.message : 'unknown error' },
        });
      }
    },
    [broadcastTransactionFn, handleConfirmDrawerOnClose, navigate]
  );

  if (assets.length < 1) return null;

  const initialValues: TransactionFormValues = {
    amount: '',
    fee: '',
    feeType: FeeType[FeeType.Middle],
    memo: '',
    nonce,
    recipient: '',
  };

  return (
    <>
      <Formik
        initialValues={initialValues}
        validateOnChange={false}
        validateOnBlur={false}
        validateOnMount={false}
        validationSchema={sendFormSchema}
        onSubmit={async values => {
          if (selectedAsset && !assetError) {
            const tx = await generateTx(values);
            whenWallet({
              software: () => setShowing(true),
              ledger: () => {
                if (!tx) return logger.error('Attempted to sign tx, but no tx exists');
                ledgerNavigate.toConnectAndSignTransactionStep(tx);
              },
            })();
          }
        }}
      >
        {props => (
          <>
            <Suspense fallback={<></>}>
              <SendFormInner
                assetError={assetError}
                feeEstimations={feeEstimations.estimates}
                nonce={nonce}
              />
            </Suspense>
            {whenWallet({
              ledger: <></>,
              software: (
                <SendTokensSoftwareConfirmDrawer
                  isShowing={isShowing && !showEditNonce}
                  onClose={() => handleConfirmDrawerOnClose()}
                  onUserSelectBroadcastTransaction={async (
                    transaction: StacksTransaction | undefined
                  ) => {
                    if (!transaction) return;
                    const signedTx = signSoftwareWalletTx(transaction);
                    if (!signedTx) return;
                    await broadcastTransactionAction(signedTx);
                    void analytics.track('submit_fee_for_transaction', {
                      calculation: feeEstimations.calculation,
                      fee: props.values.fee,
                      type: props.values.feeType,
                    });
                  }}
                />
              ),
            })}
            <EditNonceDrawer />
            <HighFeeDrawer />
          </>
        )}
      </Formik>
      <Outlet />
    </>
  );
}

export const SendTokensForm = memo(SendTokensFormBase);
