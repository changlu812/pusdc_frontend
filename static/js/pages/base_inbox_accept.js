// Extracted from static/base_inbox_accept.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm';
import { LITE_API, LITE_ADDR, USDC_ADDR, INBOX_ADDR, ERC20_ABI, LITE_ABI, INBOX_ABI, getAuthToken, setAuthToken, authenticatedFetch, updateNavBtn, switchNetwork } from '../common/base_common.js';
// 公共逻辑来自 base_common：统一配置、鉴权请求、网络切换、导航按钮状态。
// 当前文件保留页面专属流程，便于后续继续拆分到更细的业务模块。


let provider, signer, account;
let usdcContract, liteContract;
let decimals = 6;
let currentEmail = "";


const connectBtn = document.getElementById('connectBtn');
const bridgeUI = document.getElementById('bridgeUI');
const actionBtn = document.getElementById('actionBtn');
const amountInput = document.getElementById('amount');
const statusEl = document.getElementById('status');
const balanceEl = document.getElementById('usdcBalance');


async function connect() {
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

    // Login
    const timestamp = Math.floor(Date.now() / 1000);
    const msg = `Login to PUSDC Gateway at ${timestamp}`;
    try {
      showStatus("Please sign login message...", "info");
      const signature = await signer.signMessage(msg);
      const loginRes = await fetch(`${LITE_API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account, signature, timestamp: timestamp.toString() })
      });
      const loginData = await loginRes.json();
      if (loginRes.ok && loginData.token) {
        setAuthToken(loginData.token);
        showStatus("Logged in", "success");
      } else {
        throw new Error(loginData.error || "Login failed");
      }
    } catch (e) {
      console.error(e);
      showStatus("Login failed: " + e.message, "error");
      return;
    }

    usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
    liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);

    try {
      decimals = await usdcContract.decimals();
    } catch (e) {
      console.warn("Could not fetch decimals, using default 18. This usually happens if the address is not a contract.");
      decimals = 6;
    }

    connectBtn.style.display = 'none';
    bridgeUI.style.display = 'block';
    updateNavBtn(true, account);
    updateBalance();
  } catch (err) {
    console.error(err);
    showStatus("Connection failed: " + err.message, "error");
  }
}

async function updateBalance() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const txNo = urlParams.get('tx_no');
    const credential = urlParams.get('credential');

    // Load basic info first without needing account
    const resp = await fetch(`${LITE_API}/api/outgoing_fund?tx_no=${txNo}&credential=${credential}`);
    const data = await resp.json();

    if (data['2fa'] == null) {
      showStatus("2FA not enabled", "error");
      window.location.href = `/email_authenticator.html?tx_no=${txNo}&credential=${credential}`;
      // return;
    }
    if (data.status === 'ok' && data.result) {
      document.getElementById('amount').value = ethers.formatUnits(data.result.amount, decimals);
      document.getElementById('toEmail').value = data.result.email;
      currentEmail = data.result.email;
      document.getElementById('otpSection').style.display = 'block';
    }

    if (account) {
      // Wallet Balance
      const bal = await usdcContract.balanceOf(account);
      balanceEl.innerText = `${ethers.formatUnits(bal, decimals)} USDC`;

      // Hidden Balance
      const privacyBalCipher = await liteContract.privacyBalances(account);
      if (!privacyBalCipher || privacyBalCipher === '0x') {
        document.getElementById('privacyBalance').innerText = '0.00 PUSDC';
      } else {
        // Attempt to decrypt if possible, or just show cipher
        document.getElementById('privacyBalance').innerText = '(Encrypted)';
      }
    }
  } catch (err) {
    console.error("Error updating details:", err);
  }
}

function setUIState(success = false) {
  if (success) {
    actionBtn.innerText = "Transfer Successful";
    actionBtn.disabled = true;
  } else {
    actionBtn.innerText = "Collect USDC";
    actionBtn.disabled = false;
  }
}

async function handleAction() {
  const amount = amountInput.value;
  const toEmail = document.getElementById('toEmail').value;

  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    showStatus("Please enter a valid amount", "error");
    return;
  }
  if (!toEmail.includes('@')) {
    showStatus("Please enter an email address", "error");
    return;
  }

  if (!account) {
    showStatus("Please connect wallet to submit transaction...", "info");
    await connect(); // Trigger connect on demand
    if (!account) return;
  }

  // try {
  // showStatus("Fetching current privacy state...", "info");
  setBtnLoading(true);
  const otp = document.getElementById("otpInput").value.trim();

  if (otp.length !== 6 || isNaN(otp)) {
    showStatus("Enter the 6-digit code", "error");
    setBtnLoading(false);
    return;
  }

  // try {
  showStatus("Verifying OTP...", "info");
  const urlParams = new URLSearchParams(window.location.search);
  const txNo = urlParams.get('tx_no');
  const credential = urlParams.get('credential');

  // We'll use a new endpoint or reuse current one if possible
  // For now, let's assume we need to verify OTP for this tx
  const response = await fetch(`${LITE_API}/api/collect_fund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_no: txNo,
      credential: credential,
      otp: otp,
      address: account,
    }),
  });

  const data = await response.json();
  if (data.status === "error") {
    showStatus("OTP Verified Failed!", "error");
  } else {
    showStatus("OTP Verified Success!", "success");
  }

  const inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);
  console.log(txNo, account, 0, data.signature);
  const tx = await inboxContract.acceptFund(txNo, account, 0, data.signature);
  await tx.wait();
  showStatus("Transfer successful!", "success");
  setUIState(true);
  setBtnLoading(false);
  updateBalance();


  showStatus("Confirming transaction in wallet...", "info");
  // ... rest of transaction logic ...

  setUIState(true);
  setBtnLoading(false);
  updateBalance();
  // } catch (err) {
  //   console.error(err);
  //   showStatus(err.message || "Transfer failed", "error");
  //   setBtnLoading(false);
  // }
}

function showStatus(msg, type) {
  statusEl.innerText = msg;
  statusEl.className = type === 'error' ? 'error-msg' : (type === 'success' ? 'success-msg' : 'info-msg');
}

function setBtnLoading(loading) {
  actionBtn.disabled = loading;
  if (loading) {
    actionBtn.innerHTML = `<div class="loader"></div> Processing...`;
  } else {
    actionBtn.innerText = "Collect USDC";
  }
}

connectBtn.addEventListener('click', connect);
actionBtn.addEventListener('click', handleAction);

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
      liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);

      try { decimals = await usdcContract.decimals(); } catch (e) { decimals = 6; }

      connectBtn.style.display = 'none';
      bridgeUI.style.display = 'block';
      showStatus("Restored Session", "success");
      updateNavBtn(true, account);
      updateBalance();
    }
  } catch (err) {
    console.log("Session check failed", err);
    setAuthToken('');
  }
}

async function init() {
  if (typeof window.ethereum === 'undefined') {
    showStatus("Please install MetaMask", "error");
    return;
  }

  const navActionBtn = document.getElementById('navActionBtn');
  if (navActionBtn) {
    navActionBtn.addEventListener('click', () => {
      if (navActionBtn.dataset.loggedIn === 'true') {
        setAuthToken('');
        location.reload();
      } else {
        connect();
      }
    });
  }

  provider = new ethers.BrowserProvider(window.ethereum);

  // Show UI immediately
  connectBtn.style.display = 'block';
  bridgeUI.style.display = 'block';
  updateBalance();

  // Check if already logged in (optional for balance display)
  checkLoginStatus();
}

init();

