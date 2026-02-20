// Extracted from static/base_outgoing_funds.html.
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
// const actionBtn = document.getElementById('actionBtn');
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
    inboxContract = new ethers.Contract(INBOX_ADDR, INBOX_ABI, signer);

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
    fetchOutgoingFunds();
  } catch (err) {
    console.error(err);
    showStatus("Connection failed: " + err.message, "error");
  }
}

async function updateBalance() {
  try {
    // Wallet Balance
    const bal = await usdcContract.balanceOf(account);
    balanceEl.innerText = `${ethers.formatUnits(bal, decimals)} USDC`;

    // Hidden Balance
    const privacyBalCipher = await liteContract.privacyBalances(account);
    if (!privacyBalCipher || privacyBalCipher === '0x') {
      document.getElementById('privacyBalance').innerText = '0.00 PUSDC';
    } else {
      const resp = await authenticatedFetch(`${LITE_API}/api/base/usdc/decrypt_balance?balance=${privacyBalCipher}`);
      const data = await resp.json();
      if (data.status === 'ok') {
        document.getElementById('privacyBalance').innerText = `${ethers.formatUnits(data.balance.toString(), decimals)} PUSDC`;
      }
    }

    // Claimable Balance
    const inboxBalance = await inboxContract.inboxBalances(account);
    const claimableBalanceEl = document.getElementById('claimableBalance');
    if (claimableBalanceEl) {
      claimableBalanceEl.innerText = `${ethers.formatUnits(inboxBalance.toString(), decimals)} USDC`;
    }
  } catch (err) {
    console.error("Error updating balances:", err);
  }
}

// function setUIState(success = false) {
//   if (success) {
//     actionBtn.innerText = "Transfer Successful";
//     actionBtn.disabled = true;
//   } else {
//     actionBtn.innerText = "Transfer PUSDC";
//     actionBtn.disabled = false;
//   }
// }

async function handleAction() {
  const amount = amountInput.value;
  const toAddr = document.getElementById('toAddr').value;

  if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
    showStatus("Please enter a valid amount", "error");
    return;
  }
  if (!toAddr.includes('@')) {
    showStatus("Please enter an email address", "error");
    return;
  }

  const parsedAmount = ethers.parseUnits(amount, decimals);

  // try {
  showStatus("Fetching current privacy state...", "info");
  setBtnLoading(true);

  // 1. Get current Nonces and Balances
  // const senderNonce = await liteContract.privacyNonces(account);
  // const senderBalance = await liteContract.privacyBalances(account);
  // const receiverBalance = await liteContract.privacyBalances(toAddr);

  // 2. Fetch signature from API
  showStatus("Requesting witness signature...", "info");
  // const apiUrl = `${LITE_API}/api/base/usdc/sign_transfer?from_addr=${account}&to_addr=${toAddr}&amount=${parsedAmount.toString()}&nonce=${(senderNonce + 1n).toString()}&sender_balance=${senderBalance || '0x'}&receiver_balance=${receiverBalance || '0x'}`;

  // const response = await authenticatedFetch(apiUrl);
  // const data = await response.json();

  // if (data.status !== 'ok') {
  //   throw new Error(data.error || "Failed to get witness signature from server");
  // }

  // 3. Call privacyTransfer
  showStatus("Confirming transaction in wallet...", "info");
  // const tx = await liteContract.privacyTransfer(
  //   toAddr,
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
  // setUIState(true);
  setBtnLoading(false);
  updateBalance();
  fetchOutgoingFunds();
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

// function setBtnLoading(loading) {
//   actionBtn.disabled = loading;
//   if (loading) {
//     actionBtn.innerHTML = `<div class="loader"></div> Processing...`;
//   } else {
//     actionBtn.innerText = "Transfer PUSDC";
//   }
// }

connectBtn.addEventListener('click', connect);
// actionBtn.addEventListener('click', handleAction);

async function fetchOutgoingFunds() {
  try {
    const response = await authenticatedFetch(`${LITE_API}/api/outgoing_funds`);
    const data = await response.json();
    if (data.status === 'ok') {
      renderOutgoingFunds(data.result);
    }
  } catch (err) {
    console.error("Error fetching outgoing funds:", err);
  }
}

function renderOutgoingFunds(funds) {
  const container = document.getElementById('bridgeUI');
  let tableHtml = `
    <div style="margin-top: 32px;">
      <h3 style="margin-bottom: 16px; font-size: 18px;">Outgoing Funds History</h3>
      <p class="outgoing-funds-tip">Tip: Click any record in Outgoing Funds History to send an email for that fund.</p>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border); text-align: left;">
              <th style="padding: 12px 8px; color: var(--text-dim);">TX No</th>
              <th style="padding: 12px 8px; color: var(--text-dim);">Email</th>
              <th style="padding: 12px 8px; color: var(--text-dim);">Amount</th>
              <th style="padding: 12px 8px; color: var(--text-dim);">Date</th>
            </tr>
          </thead>
          <tbody>
  `;

  if (funds.length === 0) {
    tableHtml += `
      <tr>
        <td colspan="4" style="padding: 24px; text-align: center; color: var(--text-dim);">
          No outgoing funds found
        </td>
      </tr>
    `;
  } else {
    funds.forEach(fund => {
      const date = new Date(fund.created_at).toLocaleDateString();
      // Assuming amount is stored, if not we might need to fetch or display differently
      // Since the DB schema has amount but it might be null based on previous steps, let's handle gracefully
      const amountDisplay = fund.amount ? `${ethers.formatUnits(fund.amount, decimals)} USDC` : '-';
      const emailDisplay = fund.email ? fund.email : '-';

      tableHtml += `
        <tr style="border-bottom: 1px solid var(--border); cursor: pointer;" onclick="window.location.href='base_email.html?tx_no=${fund.tx_no}'">
          <td style="padding: 12px 8px;">#${fund.tx_no}</td>
          <td style="padding: 12px 8px;">${emailDisplay}</td>
          <td style="padding: 12px 8px;">${amountDisplay}</td>
          <td style="padding: 12px 8px; color: var(--text-dim);">${date}</td>
        </tr>
      `;
    });
  }

  tableHtml += `
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Append or replace
  const existingTable = document.getElementById('outgoingFundsTable');
  if (existingTable) {
    existingTable.remove();
  }

  const tableDiv = document.createElement('div');
  tableDiv.id = 'outgoingFundsTable';
  tableDiv.innerHTML = tableHtml;
  container.appendChild(tableDiv);
}

async function checkLoginStatus() {
  const token = getAuthToken();
  if (!token) return;

  try {
    const response = await authenticatedFetch(`${LITE_API}/api/auth/status`);
    const data = await response.json();
    if (data.is_logged_in && data.address) {
      account = data.address;
      // const accounts = await provider.send("eth_requestAccounts", []);
      // if (accounts[0].toLowerCase() !== account.toLowerCase()) {
      //   account = accounts[0];
      // }
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
      fetchOutgoingFunds();
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
  checkLoginStatus();
}

init();





