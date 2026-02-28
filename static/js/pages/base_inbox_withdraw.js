// Inbox Withdraw functionality
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm";
import {
  LITE_API,
  LITE_ADDR,
  USDC_ADDR,
  INBOX_ADDR,
  ERC20_ABI,
  LITE_ABI,
  INBOX_ABI,
  getAuthToken,
  setAuthToken,
  authenticatedFetch,
  updateNavBtn,
  resolveSessionContext,
  watchWalletAccountChanges,
  switchNetwork,
  setPollCancelFlag,
  waitForBackendStateChange,
} from "../common/base_common.js";
import {
  initWalletUx,
  ensureMetaMaskInstalled,
  handleWalletReject,
} from "../common/wallet_ux.js";

let provider, signer, account;
let usdcContract, inboxContract, liteContract;
let decimals = 6;
let detachAccountsChanged = () => {};
const WITHDRAW_TX_STATE = Object.freeze({
  SUBMITTED: "SUBMITTED",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
});

const connectBtn = document.getElementById("connectBtn");
const bridgeUI = document.getElementById("bridgeUI");
const actionBtn = document.getElementById("actionBtn");
const amountInput = document.getElementById("amount");
const statusEl = document.getElementById("status");
const balanceEl = document.getElementById("usdcBalance");
const inboxBalanceEl = document.getElementById("claimableBalance");

function enterLoggedOutState(message = "") {
  account = null;
  signer = null;
  updateNavBtn(false);
  connectBtn.style.display = "block";
  bridgeUI.style.display = "none";
  if (message) {
    showStatus(message, "info");
  }
}

async function connect() {
  if (
    !ensureMetaMaskInstalled({
      statusEl,
      connectBtn,
      bridgeUI,
      flowLabel: "the inbox withdraw flow",
    })
  ) {
    return;
  }

  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 8453n) {
      showStatus("Switching to Base Mainnet...", "info");
      const switched = await switchNetwork();
      if (!switched) {
        showStatus(
          "Please switch to Base Mainnet (Chain ID 8453) manually",
          "error",
        );
        return;
      }
      provider = new ethers.BrowserProvider(window.ethereum);
    }

    const accounts = await provider.send("eth_requestAccounts", []);
    account = accounts[0];
    signer = await provider.getSigner();

    // Auth Login Flow
    const timestamp = Math.floor(Date.now() / 1000);
    const msg = `Login to PUSDC Gateway at ${timestamp}`;

    try {
      showStatus("Please sign the login message...", "info");
      const signature = await signer.signMessage(msg);

      const loginRes = await fetch(`${LITE_API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: account,
          signature,
          timestamp: timestamp.toString(),
        }),
      });

      const loginData = await loginRes.json();
      if (loginRes.ok && loginData.token) {
        setAuthToken(loginData.token);
      } else {
        throw new Error(loginData.error || "Login failed");
      }
    } catch (loginErr) {
      console.error(loginErr);
      if (handleWalletReject(loginErr, () => connect())) {
        return;
      }
      showStatus("Login failed: " + loginErr.message, "error");
      return;
    }

    usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
    inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);
    liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);

    try {
      decimals = await usdcContract.decimals();
    } catch (e) {
      console.warn("Using default decimals 6");
      decimals = 6;
    }

    connectBtn.style.display = "none";
    bridgeUI.style.display = "block";
    showStatus("Connected & Logged In", "success");
    updateNavBtn(true, account);
    updateBalance();
  } catch (err) {
    console.error(err);
    if (handleWalletReject(err, () => connect())) {
      return;
    }
    showStatus("Connection failed: " + err.message, "error");
  }
}

async function updateBalance() {
  try {
    // USDC Wallet Balance
    const bal = await usdcContract.balanceOf(account);
    balanceEl.innerText = `${ethers.formatUnits(bal, decimals)} USDC`;

    // Claimable USDC
    const inboxBalanceValue = await inboxContract.inboxBalances(account);
    inboxBalanceEl.innerText = `${ethers.formatUnits(inboxBalanceValue.toString(), decimals)} USDC`;

    // Hidden Balance
    const privacyBalCipher = await liteContract.privacyBalances(account);
    const privacyBalanceEl = document.getElementById("privacyBalance");
    if (privacyBalanceEl) {
      if (!privacyBalCipher || privacyBalCipher === "0x") {
        privacyBalanceEl.innerText = "0.00 PUSDC";
      } else {
        const resp = await authenticatedFetch(
          `${LITE_API}/api/base/usdc/decrypt_balance?balance=${privacyBalCipher}`,
        );
        const data = await resp.json();
        if (data.status === "ok") {
          privacyBalanceEl.innerText = `${ethers.formatUnits(data.balance.toString(), decimals)} PUSDC`;
        }
      }
    }
  } catch (err) {
    console.error("Error updating balances:", err);
  }
}

function setUIState(step) {
  if (step === 1) {
    actionBtn.innerText = "Withdraw";
    actionBtn.disabled = false;
  } else if (step === 2) {
    actionBtn.innerText = "Withdrawal Successful";
    actionBtn.disabled = true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSubmissionUncertainError(error) {
  const codes = [
    error?.code,
    error?.info?.error?.code,
    error?.error?.code,
    error?.data?.code,
  ]
    .filter(Boolean)
    .map((v) => String(v).toUpperCase());

  if (codes.includes("BAD_DATA")) {
    return true;
  }

  const message = [
    error?.shortMessage,
    error?.reason,
    error?.message,
    error?.info?.error?.message,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    message.includes("nonce") ||
    message.includes("bad_data") ||
    message.includes("invalid response") ||
    message.includes("could not decode result data")
  );
}

function extractTxHash(error) {
  const directHash =
    error?.transactionHash ||
    error?.hash ||
    error?.info?.txHash ||
    error?.info?.hash ||
    error?.error?.transactionHash ||
    error?.receipt?.transactionHash;
  if (directHash && /^0x[0-9a-fA-F]{64}$/.test(directHash)) {
    return directHash;
  }

  const message = [
    error?.shortMessage,
    error?.reason,
    error?.message,
    error?.info?.error?.message,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(" ");
  const match = message.match(/0x[a-fA-F0-9]{64}/);
  return match ? match[0] : null;
}

async function waitForReceiptByHash(txHash, timeoutMs = 300000) {
  if (!txHash) return null;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        return receipt;
      }
    } catch (err) {
      // Keep polling when RPC cannot parse receipt yet.
    }
    await sleep(2500);
  }
  return null;
}

async function waitForReceiptOutcome(tx, txHash, timeoutMs = 300000) {
  let candidateHash = txHash || tx?.hash || null;

  if (tx && typeof tx.wait === "function") {
    try {
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        return { state: WITHDRAW_TX_STATE.CONFIRMED, source: "receipt_wait" };
      }
      if (receipt?.status === 0) {
        return { state: WITHDRAW_TX_STATE.FAILED, source: "receipt_wait" };
      }
      candidateHash =
        candidateHash || receipt?.hash || receipt?.transactionHash || null;
    } catch (waitErr) {
      candidateHash = candidateHash || extractTxHash(waitErr);
      if (!isSubmissionUncertainError(waitErr) && !candidateHash) {
        return {
          state: WITHDRAW_TX_STATE.SUBMITTED,
          source: "receipt_wait_error",
          error: waitErr,
        };
      }
    }
  }

  const receipt = await waitForReceiptByHash(candidateHash, timeoutMs);
  if (!receipt) {
    return { state: WITHDRAW_TX_STATE.SUBMITTED, source: "receipt_timeout" };
  }
  if (receipt.status === 1) {
    return { state: WITHDRAW_TX_STATE.CONFIRMED, source: "receipt_hash" };
  }
  return { state: WITHDRAW_TX_STATE.FAILED, source: "receipt_hash" };
}

async function waitForBalanceOutcome(previousBalance, timeoutMs = 300000) {
  try {
    await waitForBackendStateChange(
      updateBalance,
      previousBalance,
      showStatus,
      timeoutMs,
      "claimableBalance",
    );
    return { state: WITHDRAW_TX_STATE.CONFIRMED, source: "balance_diff" };
  } catch (err) {
    return {
      state: WITHDRAW_TX_STATE.SUBMITTED,
      source: "balance_timeout",
      error: err,
    };
  }
}

async function handleAction() {
  const amount = amountInput.value;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    showStatus("Please enter a valid amount", "error");
    return;
  }

  const parsedAmount = ethers.parseUnits(amount, decimals);

  try {
    showStatus("Confirming transaction in wallet...", "info");
    setBtnLoading(true);
    const previousBalance = inboxBalanceEl.innerText;
    const timeoutMs = 300000;
    let tx = null;
    let txHash = null;

    try {
      tx = await inboxContract.withdraw(parsedAmount);
      txHash = tx?.hash || null;
    } catch (withdrawErr) {
      console.error("Withdraw error:", withdrawErr);
      if (handleWalletReject(withdrawErr, () => handleAction())) {
        setBtnLoading(false);
        return;
      }

      txHash = extractTxHash(withdrawErr);
      if (!isSubmissionUncertainError(withdrawErr) && !txHash) {
        throw withdrawErr;
      }

      showStatus("Transaction submitted. Waiting for confirmation...", "info");
    }

    showStatus("Waiting for confirmation...", "info");

    const receiptOutcomePromise = waitForReceiptOutcome(tx, txHash, timeoutMs);
    const balanceOutcomePromise = waitForBalanceOutcome(previousBalance, timeoutMs);

    const decisiveReceiptPromise = receiptOutcomePromise.then((result) => {
      if (
        result.state === WITHDRAW_TX_STATE.CONFIRMED ||
        result.state === WITHDRAW_TX_STATE.FAILED
      ) {
        return result;
      }
      return new Promise(() => {});
    });

    const decisiveBalancePromise = balanceOutcomePromise.then((result) => {
      if (result.state === WITHDRAW_TX_STATE.CONFIRMED) {
        return result;
      }
      return new Promise(() => {});
    });

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(
        () => resolve({ state: WITHDRAW_TX_STATE.SUBMITTED, source: "timeout" }),
        timeoutMs,
      );
    });

    const outcome = await Promise.race([
      decisiveReceiptPromise,
      decisiveBalancePromise,
      timeoutPromise,
    ]);

    if (outcome.state === WITHDRAW_TX_STATE.CONFIRMED) {
      await updateBalance();
      showStatus("Withdrawal successful!", "success");
      setUIState(2);
      amountInput.value = "";
      await sleep(2000);
      setBtnLoading(false, false);
      setUIState(1);
      return;
    }

    if (outcome.state === WITHDRAW_TX_STATE.FAILED) {
      showStatus("Withdrawal failed on chain.", "error");
      setBtnLoading(false);
      setUIState(1);
      return;
    }

    showStatus(
      "Withdrawal submitted but not confirmed yet. Please check again shortly.",
      "info",
    );
    setBtnLoading(false);
    setUIState(1);
  } catch (err) {
    console.error(err);
    showStatus(err.reason || err.message || "Transaction failed", "error");
    setBtnLoading(false);
    setUIState(1);
  }
}

function showStatus(msg, type) {
  statusEl.innerText = msg;
  statusEl.className =
    type === "error"
      ? "error-msg"
      : type === "success"
        ? "success-msg"
        : "info-msg";
}

function setBtnLoading(loading, shouldResetText = true) {
  actionBtn.disabled = loading;
  if (loading) {
    const originalText = actionBtn.innerText;
    actionBtn.innerHTML = `<div class="loader"></div> Processing...`;
  } else if (shouldResetText) {
    actionBtn.innerText = "Withdraw";
  }
}

connectBtn.addEventListener("click", connect);
actionBtn.addEventListener("click", handleAction);

// 页面卸载时取消轮询
window.addEventListener("beforeunload", () => {
  setPollCancelFlag(true);
});

async function checkLoginStatus() {
  const session = await resolveSessionContext();
  if (!session.isLoggedIn) {
    if (session.reason === "address_mismatch") {
      enterLoggedOutState("Wallet account changed. Please login again.");
      return;
    }
    enterLoggedOutState();
    return;
  }

  try {
    account = session.loginAddress;
    signer = await provider.getSigner();

    usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
    inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);
    liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);

    try {
      decimals = await usdcContract.decimals();
    } catch (e) {
      decimals = 6;
    }

    connectBtn.style.display = "none";
    bridgeUI.style.display = "block";
    showStatus("Restored Session", "success");
    updateNavBtn(true, account);
    updateBalance();
  } catch (err) {
    console.log("Session check failed", err);
    enterLoggedOutState();
  }
}

async function init() {
  initWalletUx();

  if (
    !ensureMetaMaskInstalled({
      statusEl,
      connectBtn,
      bridgeUI,
      flowLabel: "the inbox withdraw flow",
    })
  ) {
    return;
  }

  const navActionBtn = document.getElementById("navActionBtn");
  if (navActionBtn) {
    navActionBtn.addEventListener("click", () => {
      if (navActionBtn.dataset.loggedIn === "true") {
        setAuthToken("");
        location.reload();
      } else {
        connect();
      }
    });
  }

  provider = new ethers.BrowserProvider(window.ethereum);
  detachAccountsChanged = watchWalletAccountChanges(() => {
    checkLoginStatus();
  });
  window.addEventListener("beforeunload", () => {
    detachAccountsChanged();
  });
  checkLoginStatus();
}

init();
