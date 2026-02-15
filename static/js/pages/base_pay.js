// Extracted from static/base_pay.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm';
import { LITE_API, LITE_ADDR, USDC_ADDR, INBOX_ADDR, ERC20_ABI, LITE_ABI, INBOX_ABI, getAuthToken, setAuthToken, authenticatedFetch, updateNavBtn, switchNetwork } from '../common/base_common.js';
// 公共逻辑来自 base_common：统一配置、鉴权请求、网络切换、导航按钮状态。
// 当前文件保留页面专属流程，便于后续继续拆分到更细的业务模块。


let provider, signer, account;
let usdcContract, liteContract, inboxContract;
let decimals = 6;


const connectBtn = document.getElementById('connectBtn');
const bridgeUI = document.getElementById('bridgeUI');
const actionBtn = document.getElementById('actionBtn');
const amountInput = document.getElementById('amount');
const statusEl = document.getElementById('status');
const balanceEl = document.getElementById('usdcBalance');
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const progressLine = document.getElementById('progressLine');


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

    // Auth Login Flow
    const timestamp = Math.floor(Date.now() / 1000);
    const msg = `Login to PUSDC Gateway at ${timestamp}`;

    try {
      showStatus("Please sign the login message...", "info");
      const signature = await signer.signMessage(msg);

      const loginRes = await fetch(`${LITE_API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: account,
          signature,
          timestamp: timestamp.toString()
        })
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
    inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);

    try {
      decimals = await usdcContract.decimals();
    } catch (e) {
      console.warn("Using default decimals 6");
      decimals = 6;
    }

    connectBtn.style.display = 'none';
    bridgeUI.style.display = 'block';
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
  // try {
  // Wallet Balance
  const bal = await usdcContract.balanceOf(account);
  balanceEl.innerText = `${ethers.formatUnits(bal, decimals)} USDC`;

  // Hidden Balance
  // const privacyBalCipher = await liteContract.privacyBalances(account);
  // if (!privacyBalCipher || privacyBalCipher === '0x') {
  //   document.getElementById('privacyBalance').innerText = '0.00 PUSDC';
  //   return;
  // }

  // const resp = await authenticatedFetch(`${LITE_API}/api/base/usdc/decrypt_balance?balance=${privacyBalCipher}`);
  // const data = await resp.json();
  // if (data.status === 'ok') {
  //   document.getElementById('privacyBalance').innerText = `${ethers.formatUnits(data.balance.toString(), decimals)} PUSDC`;
  // }

  // Claimable USDC
  const inboxBalance = await inboxContract.inboxBalances(account);
  console.log(inboxBalance);
  console.log(decimals);
  // if (!inboxBalance || inboxBalance === '0x') {
  //   document.getElementById('inboxBalance').innerText = '0.00 PUSDC';
  //   return;
  // }

  document.getElementById('inboxBalance').innerText = `${ethers.formatUnits(inboxBalance.toString(), decimals)} USDC`;
  // } catch (err) {
  //   console.error("Error updating balances:", err);
  // }
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
    step1.classList.add('active');
    step1.classList.remove('completed');
    step2.classList.remove('active', 'completed');
    progressLine.style.width = '0%';
  } else if (step === 2) {
    actionBtn.innerText = "Deposit USDC";
    step1.classList.add('completed');
    step2.classList.add('active');
    progressLine.style.width = '50%';
  } else if (step === 3) {
    step2.classList.add('completed');
    progressLine.style.width = '100%';
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

  const parsedAmount = ethers.parseUnits(amount, decimals);

  const allowance = await usdcContract.allowance(account, INBOX_ADDR);
  console.log(allowance);
  console.log(parsedAmount);

  if (allowance < parsedAmount) {
    // Step 1: Approve
    showStatus("Approving USDC...", "info");
    setBtnLoading(true);
    const tx = await usdcContract.approve(INBOX_ADDR, parsedAmount);
    await tx.wait();
    showStatus("Approval successful!", "success");
    setUIState(2);
    setBtnLoading(false);
  } else {
    // Step 2: Deposit
    showStatus("Fetching current privacy state...", "info");
    setBtnLoading(true);

    // 1. Get current Nonce and Balance from contract
    // const nonce = await liteContract.privacyNonces(account);
    // const balance = await liteContract.privacyBalances(account);

    // 2. Fetch signature and encrypted amounts from API
    // showStatus("Requesting witness signature...", "info");
    // const apiUrl = `${LITE_API}/api/base/usdc/sign_deposit?addr=${account}&amount=${parsedAmount.toString()}&nonce=${(nonce + 1n).toString()}&balance=${balance || '0x'}`;

    // const response = await authenticatedFetch(apiUrl);
    // const data = await response.json();

    // if (data.status !== 'ok') {
    //   throw new Error(data.error || "Failed to get witness signature from server");
    // }

    // 3. Call privacyDeposit
    showStatus("Confirming transaction in wallet...", "info");
    console.log(parsedAmount);
    const tx = await inboxContract.sendFund(
      parsedAmount
    );
    // const tx = await liteContract.privacyDeposit(
    //   parsedAmount,
    //   data.amount_cipher,
    //   data.current_balance,
    //   data.updated_balance,
    //   data.signature
    // );

    showStatus("Waiting for confirmation...", "info");
    await tx.wait();
    showStatus("Privacy Deposit successful!", "success");
    setUIState(3);
    setBtnLoading(false);
    updateBalance();
  }
  // } catch (err) {
  //   console.error(err);
  //   showStatus(err.reason || "Transaction failed", "error");
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
    const originalText = actionBtn.innerText;
    actionBtn.innerHTML = `<div class="loader"></div> Processing...`;
  } else {
    checkAllowance();
  }
}

connectBtn.addEventListener('click', connect);
actionBtn.addEventListener('click', handleAction);
amountInput.addEventListener('input', checkAllowance);

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
      inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);

      try { decimals = await usdcContract.decimals(); } catch (e) { decimals = 6; }

      connectBtn.style.display = 'none';
      bridgeUI.style.display = 'block';
      showStatus("Restored Session", "success");
      updateNavBtn(true, account);
      updateBalance();
      checkAllowance();
    }
  } catch (err) {
    console.log("Session check failed", err);
    // Token invalid or other error, clear it
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
  checkLoginStatus();
}

init();





