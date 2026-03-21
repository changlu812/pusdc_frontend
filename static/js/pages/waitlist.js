import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.16.0/+esm";
import { LITE_API, setAuthToken, getAuthToken } from "../common/base_common.js";
import {
    initWalletUx,
    ensureMetaMaskInstalled,
    handleWalletReject,
} from "../common/wallet_ux.js";

const connectWalletBtn = document.getElementById("connectWalletBtn");
const walletBtnText = document.getElementById("walletBtnText");
const walletAddressEl = document.getElementById("walletAddress");
const emailInput = document.getElementById("emailInput");
const submitBtn = document.getElementById("submitBtn");
const submitBtnText = document.getElementById("submitBtnText");
const submitLoader = document.getElementById("submitLoader");
const statusEl = document.getElementById("status");

let provider = null;
let signer = null;
let account = null;
let isConnected = false;

function showStatus(msg, type) {
    statusEl.className = `status-area ${type}`;
    statusEl.textContent = msg;
}

function updateSubmitButton() {
    if (isConnected && emailInput.value && emailInput.checkValidity()) {
        submitBtn.disabled = false;
        submitBtn.classList.add("ready");
        submitBtnText.textContent = "Join Waitlist";
    } else {
        submitBtn.disabled = true;
        submitBtn.classList.remove("ready");
        if (!isConnected) {
            submitBtnText.textContent = "Connect Wallet to Join";
        } else {
            submitBtnText.textContent = "Enter Valid Email";
        }
    }
}

async function connectWallet() {
    if (
        !ensureMetaMaskInstalled({
            statusEl,
            connectBtn: connectWalletBtn,
            flowLabel: "the waitlist signup",
        })
    ) {
        return;
    }

    try {
        provider = new ethers.BrowserProvider(window.ethereum);
        
        showStatus("Connecting to wallet...", "info");
        
        const accounts = await provider.send("eth_requestAccounts", []);
        account = accounts[0];
        signer = await provider.getSigner();

        const chainId = (await provider.getNetwork()).chainId;
        if (chainId !== 8453n) {
            showStatus("Please switch to Base Mainnet", "info");
            try {
                await window.ethereum.request({
                    method: "wallet_switchEthereumChain",
                    params: [{ chainId: "0x2105" }],
                });
            } catch (switchError) {
                showStatus("Please switch to Base Mainnet manually", "error");
                return;
            }
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const msg = `Login to PUSDC Gateway at ${timestamp}`;

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

        isConnected = true;
        const shortAddr = account.slice(0, 6) + "..." + account.slice(-4);
        walletBtnText.textContent = `Connected: ${shortAddr}`;
        connectWalletBtn.classList.add("connected");
        walletAddressEl.style.display = "block";
        walletAddressEl.textContent = account;

        showStatus("Wallet connected & logged in!", "success");
        updateSubmitButton();

    } catch (err) {
        console.error(err);
        if (handleWalletReject(err, connectWallet)) {
            return;
        }
        showStatus("Connection failed: " + (err.message || "Unknown error"), "error");
    }
}

async function submitWaitlist(e) {
    e.preventDefault();

    if (!isConnected) {
        showStatus("Please connect your wallet first", "error");
        return;
    }

    const email = emailInput.value;
    if (!email || !emailInput.checkValidity()) {
        showStatus("Please enter a valid email address", "error");
        return;
    }

    const token = getAuthToken();
    if (!token) {
        showStatus("Please reconnect your wallet", "error");
        return;
    }

    submitBtn.disabled = true;
    submitBtnText.style.display = "none";
    submitLoader.style.display = "block";

    try {
        showStatus("Submitting your info...", "info");

        const response = await fetch(`${LITE_API}/api/waitlist_join`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                email: email,
                wallet_address: account,
            }),
        });

        const data = await response.json();

        if (response.ok) {
            showStatus("You're on the list! We'll be in touch soon.", "success");
            submitBtnText.textContent = "Joined Successfully";
            submitBtn.classList.remove("ready");
            submitBtn.style.background = "var(--success)";
            emailInput.disabled = true;
            connectWalletBtn.disabled = true;
        } else {
            throw new Error(data.error || "Failed to join waitlist");
        }
    } catch (err) {
        console.error(err);
        showStatus(err.message || "Failed to join waitlist", "error");
    } finally {
        submitBtnText.style.display = "inline";
        submitLoader.style.display = "none";
        updateSubmitButton();
    }
}

connectWalletBtn.addEventListener("click", connectWallet);
emailInput.addEventListener("input", updateSubmitButton);
emailInput.addEventListener("change", updateSubmitButton);
document.getElementById("waitlistForm").addEventListener("submit", submitWaitlist);

initWalletUx();

if (typeof window.ethereum !== "undefined") {
    provider = new ethers.BrowserProvider(window.ethereum);
    
    window.ethereum.on("accountsChanged", (accounts) => {
        if (accounts.length === 0) {
            isConnected = false;
            account = null;
            walletBtnText.textContent = "Connect MetaMask";
            connectWalletBtn.classList.remove("connected");
            walletAddressEl.style.display = "none";
            updateSubmitButton();
            showStatus("", "");
        } else if (accounts[0] !== account) {
            walletAddressEl.textContent = accounts[0];
        }
    });
}

updateSubmitButton();
