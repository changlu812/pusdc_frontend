// Extracted from static/base_email.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm";
import {
  PUSDC_API,
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
} from "../common/base_common.js";
import {
  initWalletUx,
  ensureMetaMaskInstalled,
  handleWalletReject,
} from "../common/wallet_ux.js";

const TRANSFER_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  REVOKED: "REVOKED",
});

const STATUS_META = Object.freeze({
  [TRANSFER_STATUS.DRAFT]: {
    label: "Draft",
    hint: "Enter the recipient email and send the notification.",
  },
  [TRANSFER_STATUS.PENDING]: {
    label: "Pending",
    hint: "Recipient has not collected yet. You can still revoke this payment.",
  },
  [TRANSFER_STATUS.COMPLETED]: {
    label: "Completed",
    hint: "This payment has already been collected.",
  },
  [TRANSFER_STATUS.REVOKED]: {
    label: "Revoked",
    hint: "This payment has been revoked by the sender.",
  },
});

const BUTTON_LABELS = Object.freeze({
  send: "Send email",
  resend: "Resend email",
  revoke: "Revoke payment",
});

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const REVOKE_TX_STATE = Object.freeze({
  SUBMITTED: "SUBMITTED",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
});

let provider, signer, account;
let usdcContract, liteContract, inboxContract;
let decimals = 6;

let currentFund = null;
let currentStatus = TRANSFER_STATUS.DRAFT;
let activeAction = null;
let detailRequestSeq = 0;
let detachAccountsChanged = () => {};

let revokeConfirmModal = null;
let revokeConfirmResolve = null;

const connectBtn = document.getElementById("connectBtn");
const bridgeUI = document.getElementById("bridgeUI");
const actionBtn = document.getElementById("actionBtn");
const resendBtn = document.getElementById("resendBtn");
const revokeBtn = document.getElementById("revokeBtn");
const amountInput = document.getElementById("amount");
const statusEl = document.getElementById("status");
const stateNoteEl = document.getElementById("stateNote");
const balanceEl = document.getElementById("usdcBalance");
const emailInput = document.getElementById("toEmail");

const urlParams = new URLSearchParams(window.location.search);
const currentTxNo = urlParams.get("tx_no");

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

function isValidTxNo(txNo) {
  return /^\d+$/.test(txNo || "") && parseInt(txNo, 10) > 0;
}

function isZeroAddress(addr) {
  return (addr || "").toLowerCase() === ZERO_ADDRESS;
}

function normalizeTransferStatus(fund, chainTransfer) {
  const rawStatus = typeof fund?.status === "string" ? fund.status.toUpperCase() : "";
  if (STATUS_META[rawStatus]) {
    return rawStatus;
  }

  if (chainTransfer?.finished) {
    return isZeroAddress(chainTransfer.toAddr)
      ? TRANSFER_STATUS.REVOKED
      : TRANSFER_STATUS.COMPLETED;
  }

  return fund?.email ? TRANSFER_STATUS.PENDING : TRANSFER_STATUS.DRAFT;
}

function formatAmountForInput(amountRaw) {
  if (amountRaw === undefined || amountRaw === null || amountRaw === "") {
    return "";
  }

  const raw = amountRaw.toString();
  if (raw.includes(".")) {
    return raw;
  }

  try {
    return ethers.formatUnits(raw, decimals);
  } catch (err) {
    return raw;
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

function setActionLoading(action, loading) {
  activeAction = loading ? action : null;

  const buttons = [actionBtn, resendBtn, revokeBtn];
  buttons.forEach((btn) => {
    if (btn) btn.disabled = loading;
  });

  if (actionBtn) {
    actionBtn.innerHTML =
      loading && action === "send"
        ? `<div class="loader"></div> Sending...`
        : BUTTON_LABELS.send;
  }
  if (resendBtn) {
    resendBtn.innerHTML =
      loading && action === "resend"
        ? `<div class="loader"></div> Resending...`
        : BUTTON_LABELS.resend;
  }
  if (revokeBtn) {
    revokeBtn.innerHTML =
      loading && action === "revoke"
        ? `<div class="loader"></div> Revoking...`
        : BUTTON_LABELS.revoke;
  }
}

function renderByStatus(status) {
  const meta = STATUS_META[status] || STATUS_META[TRANSFER_STATUS.DRAFT];

  if (stateNoteEl) {
    stateNoteEl.innerText = `${meta.label} · ${meta.hint}`;
  }

  if (emailInput) {
    emailInput.disabled = status !== TRANSFER_STATUS.DRAFT;
  }
  amountInput.disabled = true;

  if (!actionBtn || !resendBtn || !revokeBtn) {
    return;
  }

  actionBtn.style.display = "none";
  resendBtn.style.display = "none";
  revokeBtn.style.display = "none";

  if (status === TRANSFER_STATUS.DRAFT) {
    actionBtn.style.display = "flex";
  } else if (status === TRANSFER_STATUS.PENDING) {
    resendBtn.style.display = "flex";
    revokeBtn.style.display = "flex";
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
    .map((value) => String(value).toUpperCase());

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
        return { state: REVOKE_TX_STATE.CONFIRMED, source: "receipt_wait" };
      }
      if (receipt?.status === 0) {
        return { state: REVOKE_TX_STATE.FAILED, source: "receipt_wait" };
      }
      candidateHash =
        candidateHash || receipt?.hash || receipt?.transactionHash || null;
    } catch (waitErr) {
      candidateHash = candidateHash || extractTxHash(waitErr);
      if (!isSubmissionUncertainError(waitErr) && !candidateHash) {
        return {
          state: REVOKE_TX_STATE.SUBMITTED,
          source: "receipt_wait_error",
          error: waitErr,
        };
      }
    }
  }

  const receipt = await waitForReceiptByHash(candidateHash, timeoutMs);
  if (!receipt) {
    return { state: REVOKE_TX_STATE.SUBMITTED, source: "receipt_timeout" };
  }
  if (receipt.status === 1) {
    return { state: REVOKE_TX_STATE.CONFIRMED, source: "receipt_hash" };
  }
  return { state: REVOKE_TX_STATE.FAILED, source: "receipt_hash" };
}

function readBalanceSnapshot() {
  return {
    usdc: balanceEl?.innerText || "",
    privacy: document.getElementById("privacyBalance")?.innerText || "",
    claimable: document.getElementById("claimableBalance")?.innerText || "",
  };
}

function hasBalanceChanged(previousSnapshot) {
  const currentSnapshot = readBalanceSnapshot();
  return (
    currentSnapshot.usdc !== previousSnapshot.usdc ||
    currentSnapshot.privacy !== previousSnapshot.privacy ||
    currentSnapshot.claimable !== previousSnapshot.claimable
  );
}

async function waitForBalanceOutcome(previousSnapshot, timeoutMs = 300000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(2500);
    try {
      await updateBalance();
      if (hasBalanceChanged(previousSnapshot)) {
        return { state: REVOKE_TX_STATE.CONFIRMED, source: "balance_diff" };
      }
    } catch (err) {
      // Keep polling when balance refresh is temporarily unavailable.
    }
  }
  return { state: REVOKE_TX_STATE.SUBMITTED, source: "balance_timeout" };
}

async function fetchFundDetail(txNo) {
  const response = await authenticatedFetch(`${PUSDC_API}/api/outgoing_fund?tx_no=${txNo}`);
  const data = await response.json();

  if (!response.ok || data.status !== "ok" || !data.result) {
    throw new Error(data.error || "Failed to load transfer detail");
  }

  return data.result;
}

async function fetchChainTransfer(txNo) {
  if (!inboxContract) return null;

  try {
    const transfer = await inboxContract.inboxTransfers(BigInt(txNo));
    return {
      fromAddr: transfer.fromAddr ?? transfer[0],
      toAddr: transfer.toAddr ?? transfer[1],
      amount: (transfer.amount ?? transfer[2])?.toString(),
      finished: Boolean(transfer.finished ?? transfer[3]),
    };
  } catch (err) {
    console.warn("Unable to query chain transfer status", err);
    return null;
  }
}

function renderFundDetail() {
  if (!currentFund) return;

  amountInput.value = formatAmountForInput(currentFund.amount);
  if (emailInput) {
    emailInput.value = currentFund.email || "";
  }

  renderByStatus(currentStatus);
}

async function refreshFundDetail({ silent = false } = {}) {
  if (!isValidTxNo(currentTxNo)) return;
  const requestSeq = ++detailRequestSeq;

  try {
    const fund = await fetchFundDetail(currentTxNo);
    if (requestSeq !== detailRequestSeq) return;

    currentFund = fund;
    currentStatus = normalizeTransferStatus(fund, null);
    renderFundDetail();

    fetchChainTransfer(currentTxNo)
      .then((chainTransfer) => {
        if (requestSeq !== detailRequestSeq || !chainTransfer) return;
        const resolvedStatus = normalizeTransferStatus(fund, chainTransfer);
        if (resolvedStatus !== currentStatus) {
          currentStatus = resolvedStatus;
          renderFundDetail();
        }
      })
      .catch((err) => {
        console.warn("Failed to hydrate chain state for detail page", err);
      });
  } catch (err) {
    console.error("Error loading transfer detail:", err);
    if (!silent) {
      showStatus(err.message || "Failed to load transfer detail", "error");
    }
  }
}

async function submitSendFund(email, action) {
  if (activeAction) return;

  setActionLoading(action, true);
  try {
    const formData = new URLSearchParams();
    formData.append("email", email);
    formData.append("tx_no", currentTxNo);

    const response = await authenticatedFetch(`${PUSDC_API}/api/send_fund`, {
      method: "POST",
      body: formData,
    });
    const data = await response.json();

    if (!response.ok || data.status !== "ok") {
      throw new Error(data.error || "Failed to send email notification");
    }

    return data;
  } finally {
    setActionLoading(action, false);
  }
}

async function handleSendEmail() {
  if (currentStatus !== TRANSFER_STATUS.DRAFT) {
    return;
  }

  const toEmail = (emailInput?.value || "").trim();
  if (!toEmail.includes("@")) {
    showStatus("Please enter an email address", "error");
    return;
  }

  try {
    showStatus("Sending notification email...", "info");
    await submitSendFund(toEmail, "send");
    showStatus("Email sent. Waiting for recipient to collect.", "success");
    await refreshFundDetail({ silent: true });
  } catch (err) {
    console.error(err);
    showStatus(err.message || "Failed to send email", "error");
  }
}

async function handleResendEmail() {
  if (currentStatus !== TRANSFER_STATUS.PENDING) {
    return;
  }

  const toEmail = (currentFund?.email || "").trim();
  if (!toEmail.includes("@")) {
    showStatus("No valid recipient email found for resend", "error");
    return;
  }

  try {
    showStatus("Resending notification email...", "info");
    await submitSendFund(toEmail, "resend");
    showStatus("Email resent successfully.", "success");
    await refreshFundDetail({ silent: true });
  } catch (err) {
    console.error(err);
    showStatus(err.message || "Failed to resend email", "error");
  }
}

function closeRevokeModal(result) {
  const activeEl = document.activeElement;
  if (revokeConfirmModal && activeEl && revokeConfirmModal.contains(activeEl)) {
    activeEl.blur();
  }

  if (revokeConfirmModal) {
    revokeConfirmModal.classList.remove("open");
    revokeConfirmModal.setAttribute("aria-hidden", "true");
  }

  if (revokeConfirmResolve) {
    revokeConfirmResolve(result);
    revokeConfirmResolve = null;
  }

  if (revokeBtn && typeof revokeBtn.focus === "function") {
    revokeBtn.focus();
  }
}

function ensureRevokeModal() {
  if (revokeConfirmModal) return;

  revokeConfirmModal = document.createElement("div");
  revokeConfirmModal.id = "revokeConfirmModal";
  revokeConfirmModal.className = "wallet-ux-modal";
  revokeConfirmModal.setAttribute("aria-hidden", "true");
  revokeConfirmModal.innerHTML = `
    <div class="wallet-ux-modal-content" role="dialog" aria-modal="true" aria-labelledby="revokeConfirmTitle">
      <h3 id="revokeConfirmTitle">Revoke Payment</h3>
      <p>Revoking will cancel this payment and return the unclaimed amount to your balance. This action cannot be undone.</p>
      <div class="wallet-ux-modal-actions">
        <button id="revokeConfirmCancel" class="wallet-ux-btn wallet-ux-btn-secondary" type="button">Cancel</button>
        <button id="revokeConfirmContinue" class="wallet-ux-btn wallet-ux-btn-primary" type="button">Confirm revoke</button>
      </div>
    </div>
  `;
  document.body.appendChild(revokeConfirmModal);

  const cancelBtn = document.getElementById("revokeConfirmCancel");
  const continueBtn = document.getElementById("revokeConfirmContinue");

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => closeRevokeModal(false));
  }
  if (continueBtn) {
    continueBtn.addEventListener("click", () => closeRevokeModal(true));
  }

  revokeConfirmModal.addEventListener("click", (event) => {
    if (event.target === revokeConfirmModal) {
      closeRevokeModal(false);
    }
  });
}

function confirmRevoke() {
  ensureRevokeModal();
  revokeConfirmModal.classList.add("open");
  revokeConfirmModal.setAttribute("aria-hidden", "false");

  return new Promise((resolve) => {
    revokeConfirmResolve = resolve;
  });
}

async function syncRevokeStatus(maxAttempts = 12, intervalMs = 2500) {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const chainTransfer = await fetchChainTransfer(currentTxNo);
      const isRevokedOnChain =
        !!chainTransfer?.finished && isZeroAddress(chainTransfer?.toAddr);
      if (isRevokedOnChain) {
        currentStatus = TRANSFER_STATUS.REVOKED;
        renderFundDetail();
        return true;
      }
    } catch (err) {
      // Keep polling when RPC temporarily fails.
    }
    await sleep(intervalMs);
  }
  await refreshFundDetail({ silent: true });
  return false;
}

async function handleRevokePayment() {
  if (currentStatus !== TRANSFER_STATUS.PENDING || activeAction) {
    return;
  }
  if (!inboxContract) {
    showStatus("Wallet not ready. Please connect wallet first.", "error");
    return;
  }

  const confirmed = await confirmRevoke();
  if (!confirmed) return;

  setActionLoading("revoke", true);
  try {
    showStatus("Please confirm revoke transaction in wallet...", "info");
    const previousSnapshot = readBalanceSnapshot();
    const timeoutMs = 300000;
    let tx = null;
    let txHash = null;

    try {
      tx = await inboxContract.revokeFund(BigInt(currentTxNo));
      txHash = tx?.hash || null;
    } catch (revokeErr) {
      const uncertain = isSubmissionUncertainError(revokeErr);
      if (uncertain) {
        console.log(
          "Revoke submission uncertain (nonce/BAD_DATA). Continue confirmation:",
          revokeErr,
        );
      } else {
        console.error("Revoke submission error:", revokeErr);
      }
      if (handleWalletReject(revokeErr, () => handleRevokePayment())) {
        return;
      }

      txHash = extractTxHash(revokeErr);
      if (!uncertain && !txHash) {
        throw revokeErr;
      }

      showStatus("Transaction submitted. Waiting for confirmation...", "info");
    }

    showStatus("Waiting for confirmation...", "info");

    const receiptOutcomePromise = waitForReceiptOutcome(tx, txHash, timeoutMs);
    const balanceOutcomePromise = waitForBalanceOutcome(
      previousSnapshot,
      timeoutMs,
    );

    const decisiveReceiptPromise = receiptOutcomePromise.then((result) => {
      if (
        result.state === REVOKE_TX_STATE.CONFIRMED ||
        result.state === REVOKE_TX_STATE.FAILED
      ) {
        return result;
      }
      return new Promise(() => {});
    });

    const decisiveBalancePromise = balanceOutcomePromise.then((result) => {
      if (result.state === REVOKE_TX_STATE.CONFIRMED) {
        return result;
      }
      return new Promise(() => {});
    });

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(
        () => resolve({ state: REVOKE_TX_STATE.SUBMITTED, source: "timeout" }),
        timeoutMs,
      );
    });

    const outcome = await Promise.race([
      decisiveReceiptPromise,
      decisiveBalancePromise,
      timeoutPromise,
    ]);

    if (outcome.state === REVOKE_TX_STATE.CONFIRMED) {
      await updateBalance();
      showStatus("Payment revoked successfully.", "success");
      syncRevokeStatus(12, 2500).catch((err) => {
        console.warn("Background revoke status sync failed:", err);
      });
      return;
    }

    if (outcome.state === REVOKE_TX_STATE.FAILED) {
      showStatus("Revoke failed on chain.", "error");
      return;
    }

    showStatus(
      "Revoke submitted but not confirmed yet. Please check again shortly.",
      "info",
    );
  } catch (err) {
    if (isSubmissionUncertainError(err)) {
      console.log(
        "Revoke flow uncertain (nonce/BAD_DATA). Keep syncing status:",
        err,
      );
      await updateBalance();
      showStatus(
        "Revoke submitted. Finalizing status in background...",
        "info",
      );
      syncRevokeStatus(12, 2500)
        .then((synced) => {
          showStatus(
            synced
              ? "Payment revoked successfully."
              : "Revoke submitted but not confirmed yet. Please check again shortly.",
            synced ? "success" : "info",
          );
        })
        .catch((syncErr) => {
          console.warn("Background revoke status sync failed:", syncErr);
        });
      return;
    }
    console.error(err);
    if (handleWalletReject(err, () => handleRevokePayment())) {
      return;
    }
    showStatus(err.shortMessage || err.message || "Failed to revoke payment", "error");
  } finally {
    setActionLoading("revoke", false);
  }
}

async function updateBalance() {
  if (!account || !usdcContract || !liteContract || !inboxContract) {
    return;
  }

  try {
    const bal = await usdcContract.balanceOf(account);
    if (balanceEl) balanceEl.innerText = `${ethers.formatUnits(bal, decimals)} USDC`;
  } catch (err) {
    console.error("Error fetching wallet balance:", err);
  }

  try {
    const privacyBalCipher = await liteContract.privacyBalances(account);
    const privacyBalanceEl = document.getElementById("privacyBalance");
    if (privacyBalanceEl) {
      if (!privacyBalCipher || privacyBalCipher === "0x") {
        privacyBalanceEl.innerText = "0.00 PUSDC";
      } else {
        const resp = await authenticatedFetch(
          `${PUSDC_API}/api/base/usdc/decrypt_balance?balance=${privacyBalCipher}`,
        );
        const data = await resp.json();
        if (data.status === "ok") {
          privacyBalanceEl.innerText = `${ethers.formatUnits(data.balance.toString(), decimals)} PUSDC`;
        }
      }
    }
  } catch (err) {
    console.error("Error fetching hidden balance:", err);
  }

  try {
    const inboxBalanceValue = await inboxContract.inboxBalances(account);
    const claimableBalanceEl = document.getElementById("claimableBalance");
    if (claimableBalanceEl) {
      claimableBalanceEl.innerText = `${ethers.formatUnits(inboxBalanceValue.toString(), decimals)} USDC`;
    }
  } catch (err) {
    console.error("Error fetching claimable balance:", err);
  }
}

async function setupContracts() {
  usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
  liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);
  inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);

  try {
    decimals = await usdcContract.decimals();
  } catch (err) {
    console.warn("Could not fetch decimals. Falling back to 6.");
    decimals = 6;
  }
}

async function connect() {
  if (
    !ensureMetaMaskInstalled({
      statusEl,
      connectBtn,
      bridgeUI,
      flowLabel: "the email payout flow",
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
        showStatus("Please switch to Base Mainnet (Chain ID 8453) manually", "error");
        return;
      }
      provider = new ethers.BrowserProvider(window.ethereum);
    }

    const accounts = await provider.send("eth_requestAccounts", []);
    account = accounts[0];
    signer = await provider.getSigner();

    const timestamp = Math.floor(Date.now() / 1000);
    const msg = `Login to PUSDC Gateway at ${timestamp}`;
    try {
      showStatus("Please sign login message...", "info");
      const signature = await signer.signMessage(msg);
      const loginRes = await fetch(`${PUSDC_API}/api/auth/login`, {
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
        showStatus("Logged in", "success");
      } else {
        throw new Error(loginData.error || "Login failed");
      }
    } catch (err) {
      console.error(err);
      if (handleWalletReject(err, () => connect())) {
        return;
      }
      showStatus(`Login failed: ${err.message}`, "error");
      return;
    }

    await setupContracts();

    connectBtn.style.display = "none";
    bridgeUI.style.display = "block";
    updateNavBtn(true, account);
    await updateBalance();
    await refreshFundDetail({ silent: true });
  } catch (err) {
    console.error(err);
    if (handleWalletReject(err, () => connect())) {
      return;
    }
    showStatus(`Connection failed: ${err.message}`, "error");
  }
}

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

    await setupContracts();

    connectBtn.style.display = "none";
    bridgeUI.style.display = "block";
    showStatus("Restored Session", "success");
    updateNavBtn(true, account);
    await updateBalance();
    await refreshFundDetail({ silent: true });
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
      flowLabel: "the email payout flow",
    })
  ) {
    return;
  }

  if (!isValidTxNo(currentTxNo)) {
    window.location.href = "/base/outgoing_funds";
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

  connectBtn.addEventListener("click", connect);
  if (actionBtn) actionBtn.addEventListener("click", handleSendEmail);
  if (resendBtn) resendBtn.addEventListener("click", handleResendEmail);
  if (revokeBtn) revokeBtn.addEventListener("click", handleRevokePayment);

  provider = new ethers.BrowserProvider(window.ethereum);
  detachAccountsChanged = watchWalletAccountChanges(() => {
    checkLoginStatus();
  });
  window.addEventListener("beforeunload", () => {
    detachAccountsChanged();
  });
  renderByStatus(currentStatus);
  checkLoginStatus();
}

init();
