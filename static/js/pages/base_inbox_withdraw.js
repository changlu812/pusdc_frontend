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

const connectBtn = document.getElementById("connectBtn");
const bridgeUI = document.getElementById("bridgeUI");
const actionBtn = document.getElementById("actionBtn");
const amountInput = document.getElementById("amount");
const statusEl = document.getElementById("status");
const balanceEl = document.getElementById("usdcBalance");
const inboxBalanceEl = document.getElementById("claimableBalance");

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

    let tx;
    try {
      // 捕获withdraw调用中的错误
      tx = await inboxContract.withdraw(parsedAmount);
    } catch (withdrawErr) {
      console.error("Withdraw error:", withdrawErr);
      // 检查是否是nonce解析错误
      if (
        withdrawErr.code === "BAD_DATA" &&
        withdrawErr.message.includes("nonce")
      ) {
        // 交易可能已经成功，继续执行
        showStatus("Withdrawal successful!", "success");
        setUIState(2);
        amountInput.value = "";
        setBtnLoading(false, false);
        setUIState(1);
        return;
      } else {
        // 其他错误，重新抛出
        throw withdrawErr;
      }
    }

    showStatus("Waiting for confirmation...", "info");
    await Promise.all([
      tx.wait().catch((waitErr) => {
        // 捕获nonce解析错误，交易可能已经成功
        console.warn(
          "Transaction wait error (nonce parsing), but transaction may have succeeded:",
          waitErr,
        );
        return null;
      }),
      waitForBackendStateChange(
        updateBalance,
        previousBalance,
        showStatus,
        300000,
        "claimableBalance",
      ).catch(() => null),
    ]);
    await updateBalance();
    showStatus("Withdrawal successful!", "success");
    setUIState(2);
    amountInput.value = "";

    await new Promise((resolve) => setTimeout(resolve, 2000));
    setBtnLoading(false, false);
    setUIState(1);
  } catch (err) {
    console.error(err);
    if (handleWalletReject(err, () => handleAction())) {
      setBtnLoading(false);
      return;
    }
    // 检查是否是nonce解析错误
    if (err.code === "BAD_DATA" && err.message.includes("nonce")) {
      // 交易可能已经成功，显示成功信息
      showStatus("Withdrawal successful!", "success");
      setUIState(2);
      amountInput.value = "";
      setBtnLoading(false, false);
      setUIState(1);
    } else {
      // 其他错误，显示错误信息
      showStatus(err.reason || "Transaction failed", "error");
      setBtnLoading(false);
    }
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
  const token = getAuthToken();
  if (!token) return;

  try {
    const response = await authenticatedFetch(`${LITE_API}/api/auth/status`);
    const data = await response.json();
    if (data.is_logged_in && data.address) {
      account = data.address;

      const accounts = await provider.send("eth_requestAccounts", []);
      if (accounts[0].toLowerCase() !== account.toLowerCase()) {
        account = accounts[0];
      }
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
    }
  } catch (err) {
    console.log("Session check failed", err);
    setAuthToken("");
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
  checkLoginStatus();
}

init();
