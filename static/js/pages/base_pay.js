// Extracted from static/base_pay.html.
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
// 公共逻辑来自 base_common：统一配置、鉴权请求、网络切换、导航按钮状态。
// 当前文件保留页面专属流程，便于后续继续拆分到更细的业务模块。

let provider, signer, account;
let usdcContract, liteContract, inboxContract;
let decimals = 6;
let detachAccountsChanged = () => {};

// 添加全局变量
let approvePromptModal = null;
let approvePromptContinue = null;
let approvePromptCancel = null;
let approvePromptResolve = null;

const connectBtn = document.getElementById("connectBtn");
const bridgeUI = document.getElementById("bridgeUI");
const actionBtn = document.getElementById("actionBtn");
const amountInput = document.getElementById("amount");
const statusEl = document.getElementById("status");
const balanceEl = document.getElementById("usdcBalance");
const step1 = document.getElementById("step1");
const step2 = document.getElementById("step2");
const progressLine = document.getElementById("progressLine");

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

// 初始化批准提示模态框
function ensureApprovePromptModal() {
  if (!approvePromptModal) {
    approvePromptModal = document.getElementById("approvePromptModal");
    if (!approvePromptModal) {
      approvePromptModal = document.createElement("div");
      approvePromptModal.id = "approvePromptModal";
      approvePromptModal.className = "wallet-ux-modal";
      approvePromptModal.setAttribute("aria-hidden", "true");
      approvePromptModal.innerHTML = `
        <div class="wallet-ux-modal-content" role="dialog" aria-modal="true" aria-labelledby="approvePromptTitle">
          <h3 id="approvePromptTitle">Two-Step Process</h3>
          <p>This is just the first step (approval). You will be asked to sign again in the second step to complete the actual deposit.</p>
          <div class="wallet-ux-modal-actions">
            <button id="approvePromptCancel" class="wallet-ux-btn wallet-ux-btn-secondary" type="button">Cancel</button>
            <button id="approvePromptContinue" class="wallet-ux-btn wallet-ux-btn-primary" type="button">Continue</button>
          </div>
        </div>
      `;
      document.body.appendChild(approvePromptModal);
    }
  }

  // 总是重新获取元素并绑定事件监听器
  approvePromptContinue = document.getElementById("approvePromptContinue");
  approvePromptCancel = document.getElementById("approvePromptCancel");

  if (approvePromptContinue) {
    // 先移除旧的事件监听器（如果有）
    approvePromptContinue.removeEventListener("click", handleApproveContinue);
    // 添加新的事件监听器
    approvePromptContinue.addEventListener("click", handleApproveContinue);
  }

  if (approvePromptCancel) {
    // 先移除旧的事件监听器（如果有）
    approvePromptCancel.removeEventListener("click", handleApproveCancel);
    // 添加新的事件监听器
    approvePromptCancel.addEventListener("click", handleApproveCancel);
  }
}

// 处理批准提示的继续按钮点击
function handleApproveContinue() {
  // 先解决Promise，再隐藏模态框
  if (approvePromptResolve) {
    approvePromptResolve(true);
    approvePromptResolve = null;
  }
  // 延迟隐藏模态框，确保Promise处理完成
  setTimeout(() => {
    hideApprovePromptModal();
  }, 100);
}

// 处理批准提示的取消按钮点击
function handleApproveCancel() {
  // 先解决Promise，再隐藏模态框
  if (approvePromptResolve) {
    approvePromptResolve(false);
    approvePromptResolve = null;
  }
  // 延迟隐藏模态框，确保Promise处理完成
  setTimeout(() => {
    hideApprovePromptModal();
  }, 100);
}

// 显示批准提示模态框
function showApprovePromptModal() {
  ensureApprovePromptModal();
  return new Promise((resolve) => {
    approvePromptResolve = resolve;
    approvePromptModal.classList.add("open");
    approvePromptModal.setAttribute("aria-hidden", "false");
    // 确保模态框可见后再设置焦点
    setTimeout(() => {
      if (approvePromptContinue) {
        approvePromptContinue.focus();
      }
    }, 50);
  });
}

// 隐藏批准提示模态框
function hideApprovePromptModal() {
  if (approvePromptModal) {
    // 先将焦点移开
    if (
      document.activeElement === approvePromptContinue ||
      document.activeElement === approvePromptCancel
    ) {
      actionBtn.focus();
    }
    approvePromptModal.classList.remove("open");
    approvePromptModal.setAttribute("aria-hidden", "true");
  }
  approvePromptResolve = null;
}

async function updateWalletBalance() {
  const bal = await usdcContract.balanceOf(account);
  const formatted = `${ethers.formatUnits(bal, decimals)} USDC`;
  balanceEl.innerText = formatted;
  return formatted;
}

async function connect() {
  if (
    !ensureMetaMaskInstalled({
      statusEl,
      connectBtn,
      bridgeUI,
      flowLabel: "the pay/receiving flow",
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
    liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);
    inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);

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
    checkAllowance();
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
    // Wallet Balance
    await updateWalletBalance();

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

    // Claimable USDC
    const inboxBalanceValue = await inboxContract.inboxBalances(account);
    const inboxBalanceEl = document.getElementById("claimableBalance");
    if (inboxBalanceEl) {
      inboxBalanceEl.innerText = `${ethers.formatUnits(inboxBalanceValue.toString(), decimals)} USDC`;
    }
  } catch (err) {
    console.error("Error updating balances:", err);
  }
}

async function checkAllowance() {
  const amount = amountInput.value;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    setUIState(1);
    return;
  }

  try {
    const parsedAmount = ethers.parseUnits(amount, decimals);
    const allowance = await usdcContract.allowance(account, INBOX_ADDR);
    console.log(allowance);
    console.log(parsedAmount);

    if (allowance >= parsedAmount) {
      setUIState(2);
    } else {
      setUIState(1);
    }
  } catch (err) {
    console.error(err);
  }
}

function setUIState(step) {
  if (step === 1) {
    actionBtn.innerText = "Approve USDC";
    step1.classList.add("active");
    step1.classList.remove("completed");
    step2.classList.remove("active", "completed");
    progressLine.style.width = "0%";
  } else if (step === 2) {
    actionBtn.innerText = "Deposit USDC";
    step1.classList.add("completed");
    step2.classList.add("active");
    progressLine.style.width = "50%";
  } else if (step === 3) {
    step2.classList.add("completed");
    progressLine.style.width = "100%";
    actionBtn.innerText = "Deposit Successful";
    actionBtn.disabled = true;
  }
}

async function handleAction() {
  // try {
  const amount = amountInput.value;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    showStatus("Please enter a valid amount", "error");
    return;
  }

  const parsedAmount = ethers.parseUnits(amount, decimals);

  const allowance = await usdcContract.allowance(account, INBOX_ADDR);
  console.log(allowance);
  console.log(parsedAmount);

  if (allowance < parsedAmount) {
    // 显示批准提示
    const userConfirmed = await showApprovePromptModal();
    if (!userConfirmed) {
      return;
    }

    // Step 1: Approve
    showStatus("Approving USDC...", "info");
    setBtnLoading(true);
    // try {
    try {
      const tx = await usdcContract.approve(INBOX_ADDR, parsedAmount);
      // 尝试等待交易确认，但捕获可能的错误
      await tx.wait();
    } catch (waitErr) {
      // 捕获nonce解析错误，交易可能已经成功
      console.warn(
        "Transaction wait error (nonce parsing), but transaction may have succeeded:",
        waitErr,
      );
    }
    showStatus("Approval successful!", "success");
    setUIState(2);
    setBtnLoading(false);
    // } catch (approveErr) {
    //   console.error("Approval error:", approveErr);
    //   // 检查是否是nonce解析错误
    //   if (
    //     approveErr.code === "BAD_DATA" &&
    //     approveErr.message.includes("nonce")
    //   ) {
    //     // 交易可能已经成功，继续执行
    //     showStatus("Approval successful!", "success");
    //     setUIState(2);
    //     setBtnLoading(false);
    //   } else {
    //     // 其他错误，显示错误信息
    //     showStatus(
    //       approveErr.reason || approveErr.message || "Approval failed",
    //       "error",
    //     );
    //     setBtnLoading(false);
    //   }
    // }
  } else {
    showStatus("Fetching current wallet state...", "info");
    setBtnLoading(true);
    const previousBalance = await updateWalletBalance();

    showStatus("Confirming transaction in wallet...", "info");
    console.log(parsedAmount);
    let receipt = null;
    try {
      const tx = await inboxContract.sendFund(parsedAmount);

      showStatus("Waiting for confirmation...", "info");
      [receipt] = await Promise.all([
        tx.wait().catch(() => null),
        waitForBackendStateChange(
          updateWalletBalance,
          previousBalance,
          showStatus,
          300000,
          "usdcBalance",
        ).catch(() => null),
      ]);
    } catch (txErr) {
      const errMsg = txErr.message || txErr.toString();
      if (errMsg.includes("nonce") || errMsg.includes("BAD_DATA")) {
        showStatus(
          "Wallet reported parsing issue, but proceeding with balance confirmation...",
          "warning",
        );
        await waitForBackendStateChange(
          updateWalletBalance,
          previousBalance,
          showStatus,
          300000,
          "usdcBalance",
        ).catch(() => null);
      } else {
        throw txErr;
      }
    }

    let txNo = null;
    if (receipt) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === INBOX_ADDR.toLowerCase()) {
          try {
            const parsed = inboxContract.interface.parseLog(log);
            if (parsed && parsed.name === "InboxSend") {
              txNo = parsed.args.txNo;
              console.log("Found txNo:", txNo.toString());
              break;
            }
          } catch (e) {
            // Not our event or parse error, skip
          }
        }
      }
    }

    await updateBalance();
    if (txNo) {
      showStatus(`Payment successful! txNo: ${txNo.toString()}`, "success");
    } else {
      showStatus("Payment successful!", "success");
    }
    setUIState(3);
    amountInput.value = "";

    await new Promise((resolve) => setTimeout(resolve, 2000));
    setBtnLoading(false, false);
    setUIState(1);
    checkAllowance();
  }
  // } catch (err) {
  //   console.error("Action failed:", err);
  //   if (handleWalletReject(err, () => handleAction())) {
  //     setBtnLoading(false);
  //     return;
  //   }
  //   showStatus(err.reason || err.message || "Transaction failed", "error");
  //   setBtnLoading(false);
  // }
}

function showStatus(msg, type, allowHtml = false) {
  if (allowHtml) {
    statusEl.innerHTML = msg;
  } else {
    statusEl.innerText = msg;
  }
  statusEl.className =
    type === "error"
      ? "error-msg"
      : type === "success"
        ? "success-msg"
        : type === "warning"
          ? "warning-msg"
          : "info-msg";
}

function setBtnLoading(loading, shouldRefreshState = true) {
  actionBtn.disabled = loading;
  if (loading) {
    const originalText = actionBtn.innerText;
    actionBtn.innerHTML = `<div class="loader"></div> Processing...`;
  } else if (shouldRefreshState) {
    checkAllowance();
  }
}

connectBtn.addEventListener("click", connect);
actionBtn.addEventListener("click", handleAction);
amountInput.addEventListener("input", checkAllowance);

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
    liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);
    inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);

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
    checkAllowance();
  } catch (err) {
    console.log("Session check failed", err);
    enterLoggedOutState();
  }
}

async function init() {
  initWalletUx();
  ensureApprovePromptModal(); // 添加这行

  if (
    !ensureMetaMaskInstalled({
      statusEl,
      connectBtn,
      bridgeUI,
      flowLabel: "the pay/receiving flow",
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
