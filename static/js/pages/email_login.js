// Extracted from static/email_login.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

const sendBtn = document.getElementById("sendBtn");
const resendBtn = document.getElementById("resendBtn");
const emailInput = document.getElementById("email");
const statusEl = document.getElementById("status");
const loginForm = document.getElementById("loginForm");
const successState = document.getElementById("successState");
const header = document.querySelector(".header");

// 复用 email_common 中的共享配置，避免多页面重复维护 API 地址。
const { LITE_API } = window.PUSDCEmailCommon;

async function handleSendLink() {
  const email = emailInput.value.trim();
  if (!email || !email.includes("@")) {
    showStatus("Please enter a valid email address", "error");
    return;
  }

  setLoading(true);
  try {
    const response = await fetch(`${LITE_API}/api/auth/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const data = await response.json();

    if (response.ok) {
      showSuccess();
    } else {
      showStatus(data.error || "Failed to send login link", "error");
    }
  } catch (err) {
    showStatus("Connection error. Please try again.", "error");
  } finally {
    setLoading(false);
  }
}

function showStatus(msg, type) {
  statusEl.innerText = msg;
  statusEl.className =
    type === "error" ? "status-error" : "status-success";
  statusEl.style.display = "block";
}

function setLoading(loading) {
  sendBtn.disabled = loading;
  if (loading) {
    sendBtn.innerHTML = '<div class="loader"></div> Sending...';
  } else {
    sendBtn.innerHTML = "Send Login Link";
  }
}

function showSuccess() {
  loginForm.style.display = "none";
  header.style.display = "none";
  successState.style.display = "block";
  document.getElementById("loginCard").style.transform = "scale(1.02)";
}

sendBtn.addEventListener("click", handleSendLink);
resendBtn.addEventListener("click", handleSendLink);

emailInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") handleSendLink();
});

