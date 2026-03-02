// Extracted from static/base_email.html.
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

async function fetchFundDetail(txNo) {
  const response = await authenticatedFetch(`${LITE_API}/api/outgoing_fund?tx_no=${txNo}`);
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

    const response = await authenticatedFetch(`${LITE_API}/api/send_fund`, {
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
  if (revokeConfirmModal) {
    revokeConfirmModal.classList.remove("open");
    revokeConfirmModal.setAttribute("aria-hidden", "true");
  }

  if (revokeConfirmResolve) {
    revokeConfirmResolve(result);
    revokeConfirmResolve = null;
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
    const tx = await inboxContract.revokeFund(BigInt(currentTxNo));
    showStatus("Waiting for transaction confirmation...", "info");
    await tx.wait();
    showStatus("Payment revoked successfully.", "success");
    await refreshFundDetail({ silent: true });
  } catch (err) {
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
          `${LITE_API}/api/base/usdc/decrypt_balance?balance=${privacyBalCipher}`,
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
    window.location.href = "base_outgoing_funds.html";
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
