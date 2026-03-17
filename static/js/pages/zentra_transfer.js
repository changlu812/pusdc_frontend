// Extracted from static/base_transfer.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm";
import {
    LITE_API,
    ZENTRA_API_URL,
    ZEN_PROTOCOL,
    ZEN_ADDR,
    NETWORK_NAME,
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

let provider, signer, account;
let decimals = 6;
let detachAccountsChanged = () => { };

// Global variables for Modal
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
          <p>This is just the first step (approval). You will be asked to sign again in the second step to complete the actual transfer.</p>
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
            flowLabel: "the transfer flow",
        })
    ) {
        return;
    }

    try {
        const network = await provider.getNetwork();
        if (network.chainId !== 84532n) {
            showStatus("Switching to Base Sepolia...", "info");
            const switched = await switchNetwork();
            if (!switched) {
                showStatus(
                    "Please switch to Base Sepolia (Chain ID 84532) manually",
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
    const toAddr = document.getElementById("toAddr").value;

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
        showStatus("Please enter a valid amount", "error");
        return;
    }
    if (!ethers.isAddress(toAddr)) {
        showStatus("Please enter a valid recipient address", "error");
        return;
    }

    const parsedAmount = ethers.parseUnits(amount, decimals);

    try {
        showStatus("Fetching current privacy state...", "info");
        setBtnLoading(true);

        const previousBalance =
            document.getElementById("privacyBalance").innerText;

        // 1. Get current Nonces and Balances
        const res = await fetchZentraState(`${ZENTRA_API_URL}/api/get_latest_state?prefix=${NETWORK_NAME}-PUSDC-privacy_nonce:${account.toLowerCase()}`);
        const nonce = res.result;

        const res2 = await fetchZentraState(`${ZENTRA_API_URL}/api/get_latest_state?prefix=${NETWORK_NAME}-PUSDC-privacy_balance:${account.toLowerCase()}`);
        const senderBalance = res2.result;

        const res3 = await fetchZentraState(`${ZENTRA_API_URL}/api/get_latest_state?prefix=${NETWORK_NAME}-PUSDC-privacy_balance:${toAddr.toLowerCase()}`);
        const receiverBalance = res3.result;

        // 2. Fetch signature from API
        showStatus("Requesting witness signature...", "info");
        const apiUrl = `${LITE_API}/api/zentra/usdc/sign_transfer?from_addr=${account}&to_addr=${toAddr}&amount=${parsedAmount.toString()}&nonce=${(nonce + 1n).toString()}&sender_balance=${senderBalance || "0x"}&receiver_balance=${receiverBalance || "0x"}`;

        const response = await authenticatedFetch(apiUrl);
        const data = await response.json();

        if (data.status !== "ok") {
            throw new Error(
                data.error || "Failed to get witness signature from server",
            );
        }

        // 3. Call privacyTransfer
        showStatus("Confirming transaction in wallet...", "info");
        try {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const signer = await provider.getSigner();

            const payload = {
                p: ZEN_PROTOCOL,
                f: "privacy_transfer",
                a: ["PUSDC", toAddr, data.amount_cipher, nonce + 1, data.signature]
            };
            const callPayload = JSON.stringify(payload);

            const tx = await signer.sendTransaction({
                to: ZEN_ADDR,
                data: ethers.hexlify(ethers.toUtf8Bytes(callPayload))
            });

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
        showStatus("Privacy Transfer successful!", "success");
        actionBtn.innerText = "Transfer Successful";
        actionBtn.disabled = true;

        amountInput.value = "";
        document.getElementById("toAddr").value = "";

        await new Promise((resolve) => setTimeout(resolve, 2000));

        setBtnLoading(false);
        actionBtn.innerText = "Transfer PUSDC";
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
        actionBtn.innerHTML = `<div class="loader"></div> Processing...`;
    }
}

connectBtn.addEventListener("click", connect);
actionBtn.addEventListener("click", handleAction);

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
            flowLabel: "the transfer flow",
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
