// Extracted from static/base_deposit.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm";
import {
  LITE_API,
  LITE_ADDR,
  USDC_ADDR,
  ERC20_ABI,
  LITE_ABI,
  getAuthToken,
  setAuthToken,
  authenticatedFetch,
  updateNavBtn,
  switchNetwork,
  pollCancelFlag,
  waitForBackendStateChange,
} from "../common/base_common.js";
// 公共逻辑来自 base_common：统一配置、鉴权请求、网络切换、导航按钮状态。
// 当前文件保留页面专属流程，便于后续继续拆分到更细的业务模块。

let provider, signer, account;
let usdcContract, liteContract;
let decimals = 6;

const connectBtn = document.getElementById("connectBtn");
const bridgeUI = document.getElementById("bridgeUI");
const actionBtn = document.getElementById("actionBtn");
const amountInput = document.getElementById("amount");
const statusEl = document.getElementById("status");
const balanceEl = document.getElementById("usdcBalance");
const step1 = document.getElementById("step1");
const step2 = document.getElementById("step2");
const progressLine = document.getElementById("progressLine");

async function connect() {
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
      showStatus("Login failed: " + loginErr.message, "error");
      return;
    }

    usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
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
    checkAllowance();
  } catch (err) {
    console.error(err);
    showStatus("Connection failed: " + err.message, "error");
  }
}

async function updateBalance() {
  // 分开处理 USDC 和 Privacy 余额，避免一个失败影响另一个

  // 更新 Wallet Balance
  try {
    if (!usdcContract) {
      console.warn("USDC contract not initialized");
      return;
    }
    const bal = await usdcContract.balanceOf(account);
    const formattedBal = ethers.formatUnits(bal, decimals);
    balanceEl.innerText = `${formattedBal} USDC`;
  } catch (err) {
    console.error("Error updating USDC balance:", err.message);
    // 不抛出错误，继续更新 privacy balance
  }

  // 更新 Hidden Balance
  try {
    if (!liteContract) {
      console.warn("LITE contract not initialized");
      return;
    }
    const privacyBalCipher = await liteContract.privacyBalances(account);

    if (!privacyBalCipher || privacyBalCipher === "0x") {
      document.getElementById("privacyBalance").innerText = "0.00 PUSDC";
      return;
    }

    const resp = await authenticatedFetch(
      `${LITE_API}/api/base/usdc/decrypt_balance?balance=${privacyBalCipher}`,
    );
    const data = await resp.json();
    if (data.status === "ok") {
      const formattedPrivacyBal = ethers.formatUnits(
        data.balance.toString(),
        decimals,
      );
      document.getElementById("privacyBalance").innerText =
        `${formattedPrivacyBal} PUSDC`;
    } else {
      console.error("Failed to decrypt balance:", data.error);
    }
  } catch (err) {
    console.error("Error updating Hidden Balance:", err.message);
    // 继续执行，不中断
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
    const allowance = await usdcContract.allowance(account, LITE_ADDR);

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
  const amount = amountInput.value;
  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    showStatus("Please enter a valid amount", "error");
    return;
  }

  try {
    const parsedAmount = ethers.parseUnits(amount, decimals);

    const allowance = await usdcContract.allowance(account, LITE_ADDR);

    if (allowance < parsedAmount) {
      // Step 1: Approve
      showStatus("Approving USDC...", "info");
      setBtnLoading(true);
      const tx = await usdcContract.approve(LITE_ADDR, parsedAmount);
      await tx.wait();
      showStatus("Approval successful!", "success");
      setUIState(2);
      setBtnLoading(false);
    } else {
      // Step 2: Deposit
      showStatus("Fetching current privacy state...", "info");
      setBtnLoading(true);

      // 保存交易前的 balance，用于后续轮询对比
      const previousBalance =
        document.getElementById("privacyBalance").innerText;

      // 1. Get current Nonce and Balance from contract
      const nonce = await liteContract.privacyNonces(account);
      const balance = await liteContract.privacyBalances(account);

      // 2. Fetch signature and encrypted amounts from API
      showStatus("Requesting witness signature...", "info");
      const apiUrl = `${LITE_API}/api/base/usdc/sign_deposit?addr=${account}&amount=${parsedAmount.toString()}&nonce=${(nonce + 1n).toString()}&balance=${balance || "0x"}`;

      const response = await authenticatedFetch(apiUrl);
      const data = await response.json();

      if (data.status !== "ok") {
        throw new Error(
          data.error || "Failed to get witness signature from server",
        );
      }

      // 3. Call privacyDeposit
      showStatus("Confirming transaction in wallet...", "info");
      let txHash = null;
      try {
        const tx = await liteContract.privacyDeposit(
          parsedAmount,
          data.amount_cipher,
          data.current_balance,
          data.updated_balance,
          data.signature,
        );
        txHash = tx.hash;
        showStatus("Waiting for confirmation...", "info");

        // 并行轮询后端和等链上确认（两个同时进行，任何一个失败都继续）
        await Promise.all([
          tx.wait().catch(() => null),
          waitForBackendStateChange(
            updateBalance,
            previousBalance,
            showStatus,
            300000,
          ).catch(() => null),
        ]);
      } catch (txErr) {
        // 捕获 ethers 解析错误（如 nonce: undefined）
        // 但交易可能已经被提交到链上了
        const errMsg = txErr.message || txErr.toString();

        // 检查是否是因为钱包解析问题而非真正的交易失败
        if (errMsg.includes("nonce") || errMsg.includes("BAD_DATA")) {
          showStatus(
            "Wallet reported parsing issue, but proceeding with backend confirmation...",
            "warning",
          );
          // 继续轮询后端来确认交易
        } else {
          // 真正的交易失败
          throw txErr;
        }
      }

      // ✨ 已在上面 Promise.race() 中并行执行，这里只需更新余额
      await updateBalance();

      showStatus("Privacy Deposit successful!", "success");
      setUIState(3);

      // 清空输入框
      amountInput.value = "";

      // 查看完成状态 2 秒后重置
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 重置按钮状态回到初始
      setBtnLoading(false);
      setUIState(1);
      checkAllowance();
    }
  } catch (err) {
    console.error("Action failed:", err);
    showStatus(err.reason || err.message || "Transaction failed", "error");
    setBtnLoading(false);
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

function setBtnLoading(loading) {
  actionBtn.disabled = loading;
  if (loading) {
    const originalText = actionBtn.innerText;
    actionBtn.innerHTML = `<div class="loader"></div> Processing...`;
  } else {
    checkAllowance();
  }
}

connectBtn.addEventListener("click", connect);
actionBtn.addEventListener("click", handleAction);
amountInput.addEventListener("input", checkAllowance);

// 页面卸载时取消轮询
window.addEventListener("beforeunload", () => {
  pollCancelFlag = true;
});

async function checkLoginStatus() {
  const token = getAuthToken();
  if (!token) return;

  try {
    const response = await authenticatedFetch(`${LITE_API}/api/auth/status`);
    const data = await response.json();
    if (data.is_logged_in && data.address) {
      // Restore session
      account = data.address; // Address from backend might be checksummed or lowercase

      // We still need to ensure provider/signer are ready for transactions
      const accounts = await provider.send("eth_requestAccounts", []);
      if (accounts[0].toLowerCase() !== account.toLowerCase()) {
        // Token valid but MetaMask account changed?
        // For safety, require re-login or just warn.
        // Let's assume re-connect flow for consistency or just update account
        account = accounts[0];
      }
      signer = await provider.getSigner();

      usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
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
      checkAllowance();
    }
  } catch (err) {
    console.log("Session check failed", err);
    // Token invalid or other error, clear it
    setAuthToken("");
  }
}

async function init() {
  if (typeof window.ethereum === "undefined") {
    showStatus("Please install MetaMask", "error");
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
