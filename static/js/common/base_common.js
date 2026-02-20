// base_* 页面共享模块
// 目标：把高重复且稳定的配置/工具统一维护，降低多页面改动成本。

// 后端 API 根地址。后续若切环境，只需改这一处。
// export const LITE_API = "http://127.0.0.1:8093";
export const LITE_API = "https://api.pusdc.xyz";

// 合约地址集中管理，避免分散在多个页面脚本里。
export const INBOX_ADDR = "0x5F40E750B1c5dCe3c55942e35DA0D4Ec83cBd80D";
export const LITE_ADDR = "0x9c2f26F7Da88A8B9b0C35332510AB3763C73BD61";
export const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// 常用 ABI：统一保留完整字段，页面按需调用。
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function allowance(address owner, address spender) public view returns (uint256)",
  "function balanceOf(address account) public view returns (uint256)",
  "function decimals() public view returns (uint8)",
];

export const LITE_ABI = [
  "function privacyDeposit(uint256 amount, bytes amountCipher, bytes currentBalanceCipher, bytes updatedBalanceCipher, bytes signature) external",
  "function privacyWithdraw(uint256 amount, bytes amountCipher, bytes currentBalanceCipher, bytes updatedBalanceCipher, bytes signature) external",
  "function privacyTransfer(address toAddr, bytes amountCipher, bytes currentSenderBalanceCipher, bytes updatedSenderBalanceCipher, bytes currentReceiverBalanceCipher, bytes updatedReceiverBalanceCipher, bytes signature) external",
  "function privacyBalances(address) public view returns (bytes)",
  "function privacyNonces(address) public view returns (uint256)",
  "function chain_identifier() public view returns (string)",
  "function tick() public view returns (string)",
  "function erc20() public view returns (address)",
  "function witness() public view returns (address)",
  "function live() public view returns (bool)",
  "function total() public view returns (uint256)",
  "event PrivacyDeposit(address indexed addr, uint256 amount)",
  "event PrivacyWithdraw(address indexed addr, uint256 amount)",
  "event PrivacyTransfer(address indexed fromAddr, address indexed toAddr, bytes amountCipher)",
];

export const INBOX_ABI = [
  "function chain_identifier() public view returns (string)",
  "function erc20() public view returns (address)",
  "function witness() public view returns (address)",
  "function total() public view returns (uint256)",
  "function withdraw(uint256 amount) external",
  "function sendFund(uint256 amount) external",
  "function acceptFund(uint256 txNo, address toAddr, uint256 convertAmount, bytes signature) external",
  "function revokeFund(uint256 txNo) external",
  "function inboxTransfers(uint256 txNo) public view returns (address fromAddr, address toAddr, uint256 amount, bool finished)",
  "function inboxBalances(address) public view returns (uint256)",
];

const TOKEN_KEY = "pusdc_auth_token";

// 读取/写入登录 token。保持旧键名，避免影响现有会话。
export const getAuthToken = () => localStorage.getItem(TOKEN_KEY);
export const setAuthToken = (token) => localStorage.setItem(TOKEN_KEY, token);

// 自动附带 Bearer token 的 fetch 包装。
export const authenticatedFetch = async (url, options = {}) => {
  const token = getAuthToken();
  const headers = {
    ...options.headers,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { ...options, headers });
};

// 统一更新导航按钮文案和登录状态标记。
export const updateNavBtn = (isLoggedIn, address = null) => {
  const btn = document.getElementById("navActionBtn");
  if (btn) {
    if (isLoggedIn && address) {
      const shortAddr = address.slice(0, 6) + "..." + address.slice(-4);
      btn.innerText = shortAddr;
    } else {
      btn.innerText = isLoggedIn ? "Switch Account" : "Connect Wallet";
    }
    btn.dataset.loggedIn = isLoggedIn ? "true" : "false";
  }
};

// 统一网络切换逻辑：目标链为 Base Mainnet (8453)。
export async function switchNetwork() {
  if (typeof window.ethereum === "undefined") {
    return false;
  }

  const chainIdHex = "0x2105";
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
    return true;
  } catch (switchError) {
    if (switchError.code === 4902) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chainIdHex,
              chainName: "Base Mainnet",
              rpcUrls: ["https://mainnet.base.org/"],
              nativeCurrency: {
                name: "ETH",
                symbol: "ETH",
                decimals: 18,
              },
              blockExplorerUrls: ["https://basescan.org/"],
            },
          ],
        });
        return true;
      } catch (addError) {
        console.error("Failed to add network:", addError);
      }
    }
    console.error("Failed to switch network:", switchError);
  }
  return false;
}

// 轮询状态管理
export let pollCancelFlag = false;
export const setPollCancelFlag = (value) => {
  pollCancelFlag = value;
};

/**
 * 轮询等待后端状态变化（检测余额更新）
 * @param {Function} updateBalance - 页面的 updateBalance 函数
 * @param {string} previousBalance - 交易前的 privacy balance 文本
 * @param {Function} showStatus - 页面的 showStatus 函数
 * @param {number} timeoutMs - 超时时间（毫秒），默认 5 分钟
 * @param {string} balanceElementId - 需要对比的余额 DOM id，默认 privacyBalance
 */
export async function waitForBackendStateChange(
  updateBalance,
  previousBalance,
  showStatus,
  timeoutMs = 300000,
  balanceElementId = "privacyBalance",
) {
  const startTime = Date.now();
  let interval = 1000; // 初始 1 秒

  showStatus("Waiting for backend to confirm transaction...", "info");

  while (Date.now() - startTime < timeoutMs) {
    if (pollCancelFlag) {
      pollCancelFlag = false;
      throw new Error("Poll cancelled");
    }

    await new Promise((resolve) => setTimeout(resolve, interval));

    try {
      await updateBalance();
      const balanceEl = document.getElementById(balanceElementId);
      const currentBalance = balanceEl ? balanceEl.innerText : "";

      if (currentBalance !== previousBalance) {
        return true;
      }
    } catch (err) {
      // 继续轮询
    }

    interval = Math.min(interval * 1.5, 10000);
  }

  throw new Error("Timeout waiting for backend");
}
