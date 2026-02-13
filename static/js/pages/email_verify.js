// Extracted from static/email_verify.html.
// Keep page-specific bootstrap logic here; move shared helpers to static/js/common/.

// 复用 email_common 的共享工具：API 配置、token 存取、URL 参数读取。
const { LITE_API, setAuthToken, getQueryParam } = window.PUSDCEmailCommon;
let currentEmail = "";
let currentToken = "";

async function verify() {
  const token = getQueryParam("token");

  if (!token) {
    showError("Missing Token", "No verification token found in the URL.");
    return;
  }

  try {
    const response = await fetch(
      `${LITE_API}/api/auth/email/verify?token=${token}`,
    );
    const data = await response.json();

    if (response.ok && data.status === "ok") {
      currentEmail = data.email;
      currentToken = token;

      // Show OTP Verification Step
      showOTPStep(data.email, data.code_2fa);
    } else {
      showError(
        "Invalid Link",
        data.error || "The link you clicked is invalid or has expired.",
      );
    }
  } catch (err) {
    showError(
      "Connection Error",
      "Could not reach the server. Please check your internet connection.",
    );
  }
}

function showOTPStep(email, secret) {
  document.getElementById("verifying").style.display = "none";

  // Re-use main card for OTP
  const card = document.getElementById("mainCard");
  // Adding glassmorphism-friendly styles for code and input
  const style = ``;

  card.innerHTML =
    style +
    `
          <div style="text-align: center;">
              <h1 style="margin-bottom: 8px;">Two-Factor Auth</h1>
              <p style="margin-bottom: 24px; color: var(--text-dim);">Scan the code or enter the secret manually to get your OTP.</p>
              
              <div class="qr-container">
                  <canvas id="qrcode"></canvas>
              </div>
              
              <div class="otp-code">
                  SECRET: ${secret}
              </div>

              <div style="margin-bottom: 4px;">
                  <input type="text" id="otpInput" class="otp-input" maxlength="6" placeholder="000000" inputmode="numeric">
              </div>

              <button id="verifyOtpBtn" class="btn" style="width: 100%; font-weight: 700;">Verify & Log In</button>
              
              <div id="otpStatus" style="margin-top: 16px; font-size: 14px; min-height: 20px; font-weight: 500;"></div>
          </div>
      `;

  // Generate QR Code
  const otpUrl = `otpauth://totp/PUSDC:${email}?secret=${secret}&issuer=PUSDC`;
  QRCode.toCanvas(document.getElementById("qrcode"), otpUrl, {
    width: 180,
    margin: 0,
    color: { dark: "#000000", light: "#ffffff" },
  });

  document
    .getElementById("verifyOtpBtn")
    .addEventListener("click", handleOTPVerification);
  document
    .getElementById("otpInput")
    .addEventListener("keypress", (e) => {
      if (e.key === "Enter") handleOTPVerification();
    });
  document.getElementById("otpInput").focus();
}

async function handleOTPVerification() {
  const otp = document.getElementById("otpInput").value.trim();
  const btn = document.getElementById("verifyOtpBtn");
  const status = document.getElementById("otpStatus");

  if (otp.length !== 6 || isNaN(otp)) {
    status.innerText = "Enter the 6-digit code";
    status.style.color = "var(--error)";
    return;
  }

  btn.disabled = true;
  btn.innerHTML = "Verifying...";

  try {
    const response = await fetch(
      `${LITE_API}/api/auth/email/otp_verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: currentEmail,
          token: currentToken,
          otp: otp,
        }),
      },
    );

    const data = await response.json();

    if (response.ok && data.status === "ok") {
      setAuthToken(data.token);

      // Show Success
      document.getElementById("mainCard").innerHTML = `
                  <div style="color: var(--success); font-size: 64px; margin-bottom: 24px;">✓</div>
                  <h1>Success!</h1>
                  <p style="color: var(--text-dim);">You are now securely logged in.</p>
                  <p style="margin-top: 8px;">Redirecting you now...</p>
              `;

      setTimeout(() => {
        window.location.href = "base_deposit.html";
      }, 1500);
    } else {
      status.innerText = data.error || "Invalid OTP code";
      status.style.color = "var(--error)";
      btn.disabled = false;
      btn.innerText = "Verify & Log In";
    }
  } catch (err) {
    status.innerText = "Connection failed";
    status.style.color = "var(--error)";
    btn.disabled = false;
    btn.innerText = "Verify & Log In";
  }
}

function showError(title, msg) {
  document.getElementById("verifying").style.display = "none";
  document.getElementById("errorState").style.display = "block";
  document.getElementById("errorTitle").innerText = title;
  document.getElementById("errorMsg").innerText = msg;
}

// Start verification
verify();

