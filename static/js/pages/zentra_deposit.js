// Extracted from static/base_deposit.html.
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

async function connect() {
    if (
        !ensureMetaMaskInstalled({
            statusEl,
            connectBtn,
            bridgeUI,
            flowLabel: "the deposit/receiving flow",
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

        // usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
        // liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);

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
    // 分开处理 USDC 和 Privacy 余额，避免一个失败影响另一个

    // 更新 Wallet Balance
    try {
        // console.log("account:", account);
        const publicRes = await fetch(`${ZENTRA_API_URL}/api/get_latest_state?prefix=${NETWORK_NAME}-USDC-balance:${account.toLowerCase()}`);
        const publicData = await parseJsonWithBigInt(publicRes);
        const bal = publicData.result;
        // console.log("USDC Balance:", bal);
        const formattedBal = ethers.formatUnits(bal, 6);
        balanceEl.innerText = `${formattedBal} USDC`;

    } catch (err) {
        console.error("Error updating USDC balance:", err.message);
        // 不抛出错误，继续更新 privacy balance
    }

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
            // 显示批准提示
            const userConfirmed = await showApprovePromptModal();
            if (!userConfirmed) {
                return;
            }

            // Step 1: Approve
            showStatus("Approving USDC...", "info");
            setBtnLoading(true);
            try {
                const tx = await usdcContract.approve(LITE_ADDR, parsedAmount);
                // 尝试等待交易确认，但捕获可能的错误
                try {
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
            } catch (approveErr) {
                console.error("Approval error:", approveErr);
                // 检查是否是nonce解析错误
                if (
                    approveErr.code === "BAD_DATA" &&
                    approveErr.message.includes("nonce")
                ) {
                    // 交易可能已经成功，继续执行
                    showStatus("Approval successful!", "success");
                    setUIState(2);
                    setBtnLoading(false);
                } else {
                    // 其他错误，显示错误信息
                    showStatus(
                        approveErr.reason || approveErr.message || "Approval failed",
                        "error",
                    );
                    setBtnLoading(false);
                }
            }
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
        if (handleWalletReject(err, () => handleAction())) {
            setBtnLoading(false);
            return;
        }
        showStatus(err.reason || err.message || "Transaction failed", "error");
        setBtnLoading(false);
    }
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

        // usdcContract = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
        // liteContract = new ethers.Contract(LITE_ADDR, LITE_ABI, signer);

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
            flowLabel: "the deposit/receiving flow",
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
