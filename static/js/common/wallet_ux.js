const REJECT_MODAL_ID = "walletUxRejectModal";
const REJECT_RETRY_BTN_ID = "walletUxRetryBtn";
const REJECT_LATER_BTN_ID = "walletUxLaterBtn";

let retryHandler = null;
let modalBound = false;

function ensureRejectModal() {
  let modal = document.getElementById(REJECT_MODAL_ID);
  if (!modal) {
    modal = document.createElement("div");
    modal.id = REJECT_MODAL_ID;
    modal.className = "wallet-ux-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="wallet-ux-modal-content" role="dialog" aria-modal="true" aria-labelledby="walletUxRejectTitle">
        <h3 id="walletUxRejectTitle">Wallet action was canceled</h3>
        <p>Wallet action was canceled by user. You can retry the current wallet flow.</p>
        <div class="wallet-ux-modal-actions">
          <button id="${REJECT_RETRY_BTN_ID}" class="wallet-ux-btn wallet-ux-btn-primary" type="button">Retry signature</button>
          <button id="${REJECT_LATER_BTN_ID}" class="wallet-ux-btn wallet-ux-btn-secondary" type="button">Maybe later</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  if (!modalBound) {
    const retryBtn = document.getElementById(REJECT_RETRY_BTN_ID);
    const laterBtn = document.getElementById(REJECT_LATER_BTN_ID);

    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        const currentRetry = retryHandler;
        hideWalletRejectModal();
        if (typeof currentRetry === "function") {
          currentRetry();
        }
      });
    }

    if (laterBtn) {
      laterBtn.addEventListener("click", () => {
        hideWalletRejectModal();
      });
    }

    modalBound = true;
  }
}

export function initWalletUx() {
  ensureRejectModal();
}

export function isUserRejectedError(error) {
  const codes = [
    error?.code,
    error?.info?.error?.code,
    error?.error?.code,
    error?.data?.code,
  ];

  if (codes.some((code) => Number(code) === 4001)) {
    return true;
  }

  if (
    codes.some(
      (code) =>
        typeof code === "string" && code.toUpperCase() === "ACTION_REJECTED",
    )
  ) {
    return true;
  }

  const message = [
    error?.shortMessage,
    error?.reason,
    error?.message,
    error?.info?.error?.message,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    message.includes("user rejected") ||
    message.includes("user denied") ||
    message.includes("request rejected") ||
    message.includes("rejected the request") ||
    message.includes("denied transaction signature") ||
    message.includes("denied message signature")
  );
}

export function showWalletRejectModal(onRetry) {
  ensureRejectModal();
  retryHandler = onRetry;
  const modal = document.getElementById(REJECT_MODAL_ID);
  if (!modal) {
    return;
  }
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

export function hideWalletRejectModal() {
  const modal = document.getElementById(REJECT_MODAL_ID);
  if (!modal) {
    return;
  }
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  retryHandler = null;
}

export function handleWalletReject(error, onRetry) {
  if (!isUserRejectedError(error)) {
    return false;
  }
  showWalletRejectModal(onRetry);
  return true;
}

export function ensureMetaMaskInstalled({
  statusEl,
  connectBtn,
  bridgeUI,
  flowLabel = "this flow",
}) {
  if (typeof window.ethereum !== "undefined") {
    return true;
  }

  if (connectBtn) {
    connectBtn.style.display = "none";
  }
  if (bridgeUI) {
    bridgeUI.style.display = "none";
  }

  let targetStatusEl = statusEl;
  if (!targetStatusEl) {
    const host =
      bridgeUI?.parentElement || connectBtn?.parentElement || document.body;
    targetStatusEl = host.querySelector("#status");
    if (!targetStatusEl) {
      targetStatusEl = document.createElement("div");
      targetStatusEl.id = "status";
      host.appendChild(targetStatusEl);
    }
  }

  if (targetStatusEl) {
    targetStatusEl.style.display = "block";
    targetStatusEl.className = "info-msg";
    targetStatusEl.innerHTML = `
      <div class="wallet-ux-install-card">
        <div class="wallet-ux-install-title">Please install MetaMask</div>
        <div class="wallet-ux-install-desc">MetaMask is required to continue using ${flowLabel}.</div>
        <div class="wallet-ux-install-actions">
          <a class="wallet-ux-btn wallet-ux-btn-primary" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">Install MetaMask</a>
          <button id="walletUxRefreshBtn" class="wallet-ux-btn wallet-ux-btn-secondary" type="button">I installed it, refresh</button>
        </div>
      </div>
    `;
    const refreshBtn = targetStatusEl.querySelector("#walletUxRefreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        window.location.reload();
      });
    }
  }

  return false;
}
