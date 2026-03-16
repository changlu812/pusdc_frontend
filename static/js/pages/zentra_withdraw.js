// Extracted from static/base_withdraw.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm";
import {
    LITE_API,
    ZENTRA_API_URL,
    ZEN_PROTOCOL,
    ZEN_ADDR,
    NETWORK_NAME,
    // LITE_ADDR,
    // USDC_ADDR,
    // ERC20_ABI,
    // LITE_ABI,
    getAuthToken,
    setAuthToken,
    authenticatedFetch,
    updateNavBtn,
    resolveSessionContext,
    watchWalletAccountChanges,
    switchNetwork,
    pollCancelFlag,
    waitForBackendStateChange,
    parseJsonWithBigInt,
    fetchZentraState,
} from "../common/zentra_common.js";
import {
    initWalletUx,
    ensureMetaMaskInstalled,
    handleWalletReject,
} from "../common/wallet_ux.js";
// 公共逻辑来自 base_common：统一配置、鉴权请求、网络切换、导航按钮状态。
// 当前文件保留页面专属流程，便于后续继续拆分到更细的业务模块。

let provider, signer, account;
let usdcContract, liteContract;
let decimals = 6;
let detachAccountsChanged = () => { };

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

    approvePromptContinue = document.getElementById("approvePromptContinue");
    approvePromptCancel = document.getElementById("approvePromptCancel");

    if (approvePromptContinue) {
        approvePromptContinue.removeEventListener("click", handleApproveContinue);
        approvePromptContinue.addEventListener("click", handleApproveContinue);
    }

    if (approvePromptCancel) {
        approvePromptCancel.removeEventListener("click", handleApproveCancel);
        approvePromptCancel.addEventListener("click", handleApproveCancel);
    }
}

function handleApproveContinue() {
    if (approvePromptResolve) {
        approvePromptResolve(true);
        approvePromptResolve = null;
    }
    setTimeout(() => {
        hideApprovePromptModal();
    }, 100);
}

function handleApproveCancel() {
    if (approvePromptResolve) {
        approvePromptResolve(false);
        approvePromptResolve = null;
    }
    setTimeout(() => {
        hideApprovePromptModal();
    }, 100);
}

function showApprovePromptModal() {
    ensureApprovePromptModal();
    return new Promise((resolve) => {
        approvePromptResolve = resolve;
        approvePromptModal.classList.add("open");
        approvePromptModal.setAttribute("aria-hidden", "false");
        setTimeout(() => {
            if (approvePromptContinue) {
                approvePromptContinue.focus();
            }
        }, 50);
    });
}

function hideApprovePromptModal() {
    if (approvePromptModal) {
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

async function connect() {
    if (
        !ensureMetaMaskInstalled({
            statusEl,
            connectBtn,
            bridgeUI,
            flowLabel: "the withdraw flow",
        })
    ) {
        return;
    }

    try {
        const network = await provider.getNetwork();
        if (network.chainId !== 84532n) {
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

        // Login
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
                showStatus("Logged in", "success");
            } else {
                throw new Error(loginData.error || "Login failed");
            }
        } catch (e) {
            console.error(e);
            if (handleWalletReject(e, () => connect())) {
                return;
            }
            showStatus("Login failed: " + e.message, "error");
            return;
        }

        try {
            // decimals = await usdcContract.decimals();
            decimals = 6;
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
        if (handleWalletReject(err, () => connect())) {
            return;
        }
        showStatus("Connection failed: " + err.message, "error");
    }
}

async function updateBalance() {
    try {
        const publicData = await fetchZentraState(`${ZENTRA_API_URL}/api/get_latest_state?prefix=${NETWORK_NAME}-USDC-balance:${account.toLowerCase()}`);
        const bal = publicData.result;
        const formattedBal = ethers.formatUnits(bal, 6);
        balanceEl.innerText = `${formattedBal} USDC`;
    } catch (err) {
        console.error("Error updating USDC balance:", err.message);
    }

    try {
        const resp = await authenticatedFetch(
            `${LITE_API}/api/zentra/usdc/decrypt_balance`,
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
        showStatus("Fetching current privacy state...", "info");
        setBtnLoading(true);

        const previousBalance =
            document.getElementById("privacyBalance").innerText;

        const res = await fetchZentraState(`${ZENTRA_API_URL}/api/get_latest_state?prefix=${NETWORK_NAME}-PUSDC-privacy_nonce:${account.toLowerCase()}`);
        const nonce = res.result;

        const res2 = await fetchZentraState(`${ZENTRA_API_URL}/api/get_latest_state?prefix=${NETWORK_NAME}-PUSDC-privacy_balance:${account.toLowerCase()}`);
        const balance = res2.result;
        console.log(balance);

        showStatus("Requesting witness signature...", "info");
        const apiUrl = `${LITE_API}/api/zentra/usdc/sign_withdraw?addr=${account}&amount=${parsedAmount.toString()}&nonce=${(nonce + 1n).toString()}&balance=${balance || "0x"}`;
        const response = await authenticatedFetch(apiUrl);
        const data = await response.json();
        console.log(data);

        if (data.status !== "ok") {
            throw new Error(
                data.error || "Failed to get witness signature from server",
            );
        }

        showStatus("Confirming transaction in wallet...", "info");
        let txHash = null;
        try {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signer = await provider.getSigner();

            const payload = {
                p: ZEN_PROTOCOL,
                f: "privacy_withdraw",
                a: ["PUSDC", data.amount, data.amount_cipher, data.current_balance, nonce + 1n, data.signature]
            };
            console.log(payload);
            const callPayload = JSON.stringify(payload);

            const tx = await signer.sendTransaction({
                to: ZEN_ADDR,
                data: ethers.hexlify(ethers.toUtf8Bytes(callPayload))
            });

            txHash = tx.hash;
            showStatus("Waiting for confirmation...", "info");

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
            const errMsg = txErr.message || txErr.toString();
            if (errMsg.includes("nonce") || errMsg.includes("BAD_DATA")) {
                showStatus(
                    "Wallet reported parsing issue, but proceeding with backend confirmation...",
                    "warning",
                );
            } else {
                throw txErr;
            }
        }

        await updateBalance();
        showStatus("Privacy Withdrawal successful!", "success");
        actionBtn.innerText = "Withdrawal Successful";
        actionBtn.disabled = true;

        amountInput.value = "";
        await new Promise((resolve) => setTimeout(resolve, 2000));

        setBtnLoading(false);
        actionBtn.innerText = "Withdraw USDC";
        actionBtn.disabled = false;
    } catch (err) {
        console.error("Action failed:", err);
        if (handleWalletReject(err, () => handleAction())) {
            setBtnLoading(false);
            return;
        }
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
    }
}

connectBtn.addEventListener("click", connect);
actionBtn.addEventListener("click", handleAction);

// 页面卸载时取消轮询
window.addEventListener("beforeunload", () => {
    pollCancelFlag = true;
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

        try {
            // decimals = await usdcContract.decimals();
            decimals = 6;
        } catch (e) {
            decimals = 6;
        }

        connectBtn.style.display = "none";
        bridgeUI.style.display = "block";
        showStatus("Restored Session", "success");
        updateNavBtn(true, account);
        updateBalance();
    } catch (err) {
        console.log("Session check failed", err);
        enterLoggedOutState();
    }
}

async function init() {
    initWalletUx();
    ensureApprovePromptModal();

    if (
        !ensureMetaMaskInstalled({
            statusEl,
            connectBtn,
            bridgeUI,
            flowLabel: "the withdraw flow",
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
