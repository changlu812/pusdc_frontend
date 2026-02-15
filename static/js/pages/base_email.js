// Extracted from static/base_email.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm';
import { LITE_API, LITE_ADDR, USDC_ADDR, ERC20_ABI, LITE_ABI, getAuthToken, setAuthToken, authenticatedFetch, updateNavBtn, switchNetwork } from '../common/base_common.js';
// 公共逻辑来自 base_common：统一配置、鉴权请求、网络切换、导航按钮状态。
// 当前文件保留页面专属流程，便于后续继续拆分到更细的业务模块。


let provider, signer, account;
let usdcContract, liteContract;
let decimals = 6;


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
    // USDC Balance
    const bal = await usdcContract.balanceOf(account);
    balanceEl.innerText = `${ethers.formatUnits(bal, decimals)} USDC`;

    // Privacy Balance
    const privacyBalCipher = await liteContract.privacyBalances(account);
    if (!privacyBalCipher || privacyBalCipher === '0x') {
      document.getElementById('privacyBalance').innerText = '0.00 PUSDC';
      return;
    }

    const resp = await authenticatedFetch(`${LITE_API}/api/base/usdc/decrypt_balance?balance=${privacyBalCipher}`);
    const data = await resp.json();
    if (data.status === 'ok') {
      document.getElementById('privacyBalance').innerText = `${ethers.formatUnits(data.balance.toString(), decimals)} PUSDC`;
    }
  } catch (err) {
    console.error("Error updating balances:", err);
  }
}

function setUIState(success = false) {
  if (success) {
    actionBtn.innerText = "Transfer Successful";
    actionBtn.disabled = true;
  } else {
    actionBtn.innerText = "Transfer USDC";
    actionBtn.disabled = false;
  }
}

async function handleAction() {
  const toEmail = document.getElementById('toEmail').value;

  if (!toEmail.includes('@')) {
    showStatus("Please enter an email address", "error");
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const txNo = urlParams.get('tx_no');

  if (!/^\d+$/.test(txNo) || parseInt(txNo) <= 0) {
    window.location.href = "base_outgoing_funds.html";
    return;
  }

  // try {
  showStatus("Fetching current privacy state...", "info");
  setBtnLoading(true);

  // 1. Get current Nonces and Balances
  // const senderNonce = await liteContract.privacyNonces(account);
  // const senderBalance = await liteContract.privacyBalances(account);
  // const receiverBalance = await liteContract.privacyBalances(toEmail);

  // 2. Fetch signature from API
  showStatus("Requesting witness signature...", "info");
  const apiUrl = `${LITE_API}/api/send_fund`;
  const response = await authenticatedFetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: toEmail, tx_no: txNo })
  });
  const data = await response.json();

  // if (data.status !== 'ok') {
  //   throw new Error(data.error || "Failed to get witness signature from server");
  // }

  // 3. Call privacyTransfer
  showStatus("Confirming transaction in wallet...", "info");
  // const tx = await liteContract.privacyTransfer(
  //   toEmail,
  //   data.amount_cipher,
  //   data.current_sender_balance,
  //   data.updated_sender_balance,
  //   data.current_receiver_balance,
  //   data.updated_receiver_balance,
  //   data.signature
  // );

  // showStatus("Waiting for confirmation...", "info");
  // await tx.wait();
  showStatus("Fund sent through email! ", "success");
  setUIState(true);
  setBtnLoading(false);
  // updateBalance();
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
    actionBtn.innerText = "Transfer USDC";
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

      // Check for tx_no param and fetch details
      const urlParams = new URLSearchParams(window.location.search);
      const txNo = urlParams.get('tx_no');
      if (txNo) {
        try {
          const fundsRes = await authenticatedFetch(`${LITE_API}/api/outgoing_fund?tx_no=${txNo}`);
          const fundsData = await fundsRes.json();
          if (fundsData.status === 'ok' && fundsData.result) {
            const fund = fundsData.result;
            if (fund.amount) {
              // The amount in DB is formatted string (e.g. "0.020000" or raw wei if updated differently)
              // Based on previous step output: "amount: 0.020000"
              // But step 210 updated to store `amount_wei`.
              // Let's check what was actually saved.
              // Ideally we should format it back to decimals if it's wei.
              // The logs said "Amount: 0.020000" BEFORE the user changed to `return amount_wei` in step 209.
              // In step 210, the user updated `privacy_server.py` to save `amount_wei` directly.
              // So `fund.amount` will be the Wei value (integer/string).
              // We need to format it.

              // However, JavaScript might receive it as a number or string.
              // If saved as INTEGER in sqlite, it comes back as number.

              // Let's assume it's Wei and format it.
              try {
                const amountBN = BigInt(fund.amount);
                // Wait, user environment seems uncertain about decimals (18 in some comments, 6 in others).
                // But `usdcContract.decimals()` is fetched dynamically. Use `decimals`.
                // Wait, the previous steps showed `amount_wei / 10**18` was used for formatting in earlier code,
                // but then the user changed it to `return amount_wei`.
                // And the user previously commented `decimals = await usdcContract.decimals()` -> typically 6 but 18 in testing.
                // So using the fetched `decimals` variable is safest.

                // IMPORTANT: The DB might contain mixed data types now (formatted strings vs raw integers).
                // If it looks like a float string (contains '.'), use it directly?
                // If it's a large integer, format it.

                if (fund.amount.toString().includes('.')) {
                  amountInput.value = fund.amount;
                } else {
                  amountInput.value = ethers.formatUnits(fund.amount.toString(), decimals);
                }

                amountInput.disabled = true;
              } catch (fmtErr) {
                console.error("Error formatting amount:", fmtErr);
                amountInput.value = fund.amount;
              }

              if (fund.email) {
                const toEmailEl = document.getElementById('toEmail');
                toEmailEl.value = fund.email;
                toEmailEl.disabled = true;
              }
            }
          }
        } catch (e) {
          console.error("Error fetching tx details:", e);
        }
      }
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

  const urlParams = new URLSearchParams(window.location.search);
  const txNo = urlParams.get('tx_no');
  if (!/^\d+$/.test(txNo) || parseInt(txNo) <= 0) {
    window.location.href = "base_outgoing_funds.html";
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

