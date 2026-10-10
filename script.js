/**
 * MyCyberWorld Bot - Mini App Frontend Logic
 * Flat services + wallet + offer banner + referral + help/support + Telegram.
 *
 * Design:
 * - Wallet: Blue theme, ₹ Indian format, English only
 * - Payment flow: QR in Telegram (Mini App closes)
 * - Range: ₹300 - ₹50,000
 * - Offer banner: reads offers.json, session-based dismiss
 * - Referral: collapsible card + toggle + localStorage persistence (Phase 6.1)
 * - Help/Support: deep link with base64url payload (Phase 6.2)
 * - Service submit: deep link with base64url payload (Phase 8.0.9)
 *   ↳ Fixes tg.sendData() failure on Desktop + Telegram Web K
 *   ↳ Fallback: sendData for long payloads (mobile only)
 *   ↳ v2.10: Uses short numeric `id` (fits 64-char limit for emails)
 * - Balance refresh: deep link (?start=balance) — Phase 8.0.x
 * - Wallet cache: localStorage fallback for menu-button open — Phase 8.0.x
 */

// ==================== TELEGRAM WEB APP INIT ====================
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

try {
    if (tg.setHeaderColor) tg.setHeaderColor("#0f172a");
    if (tg.setBackgroundColor) tg.setBackgroundColor("#0f172a");
} catch (e) { /* Ignore */ }

try {
    if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
        const nameEl = document.getElementById("user-name");
        if (nameEl) {
            nameEl.textContent = tg.initDataUnsafe.user.first_name || "Investigator";
        }
    }
} catch (e) { /* Ignore */ }


// ==================== STATE ====================
let allServices = [];
let walletConfig = null;
let walletBalance = 0;
let isSubmitting = false;

// Offer banner state (Phase 4.3)
let allOffers = [];
let offerBannerDismissed = false;  // session-based (resets on reload)

// Referral section state (Phase 6.1)
const REFERRAL_STORAGE_KEY = "mcw_referral_expanded";

// Help section state (Phase 6.2)
const HELP_MESSAGE_MAX_LEN = 2000;

// Wallet cache key (Phase 8.0.x — menu button fix)
const WALLET_CACHE_KEY = "mcw_last_balance";


// ==================== HELPER FUNCTIONS ====================

function safeAlert(message) {
    try {
        if (tg.showAlert) tg.showAlert(message);
        else alert(message);
    } catch (e) { alert(message); }
}

function haptic(type = "light") {
    try {
        if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred(type);
    } catch (e) { /* Ignore */ }
}

function getInputMode(type) {
    if (type === "tel" || type === "number") return "numeric";
    if (type === "email") return "email";
    return "text";
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

function setDisplay(elementId, displayValue) {
    const el = document.getElementById(elementId);
    if (el) el.style.display = displayValue;
}

/**
 * Indian format with dynamic currency symbol from wallet config.
 * e.g., 5000 -> "₹5,000"
 */
function formatINR(amount) {
    const num = Number(amount) || 0;
    const symbol = (walletConfig && walletConfig.currency_symbol) || "₹";
    return symbol + num.toLocaleString("en-IN");
}


// ==================== WALLET: INIT BALANCE (Phase 8.0.x — cached fallback) ====================
// Priority:
//   1. URL param (?balance=X) — from /start "Open Panel" button (fresh)
//   2. localStorage cache — from previous open (may be stale, better than 0)
//   3. Fallback: 0 + hint to refresh
//
// Why: Menu button URL has NO ?balance= param — cache ensures no ₹0 flash.
function initWalletBalanceFromURL() {
    let loadedFromUrl = false;

    // --- 1. Try URL param (fresh from /start) ---
    try {
        const params = new URLSearchParams(window.location.search);
        const bal = params.get("balance");
        if (bal !== null && !isNaN(Number(bal))) {
            walletBalance = Number(bal);
            loadedFromUrl = true;

            // Save to localStorage for next menu-button open
            try {
                localStorage.setItem(WALLET_CACHE_KEY, String(walletBalance));
            } catch (e) { /* localStorage may be blocked in WebView */ }
        }
    } catch (e) { /* Ignore */ }

    // --- 2. If no URL param → try localStorage cache (menu button case) ---
    if (!loadedFromUrl) {
        try {
            const cached = localStorage.getItem(WALLET_CACHE_KEY);
            if (cached !== null && !isNaN(Number(cached))) {
                walletBalance = Number(cached);
                console.log("[Wallet] Loaded cached balance:", walletBalance);
            }
        } catch (e) { /* Ignore */ }
    }
}


// ==================== WALLET: RENDER ====================
function renderWallet() {
    const balanceEl = document.getElementById("wallet-balance");
    const hintEl = document.getElementById("wallet-hint");

    if (!balanceEl) return;

    balanceEl.textContent = formatINR(walletBalance);

    if (hintEl) {
        if (walletBalance <= 0) {
            hintEl.textContent = "👋 Add money to start";
        } else {
            hintEl.textContent = "Available Balance";
        }
    }
}


// ==================== BONUS CALCULATION ====================
function getBonusPercent(amount) {
    if (!walletConfig || !walletConfig.bonus_tiers) return 0;
    const amt = Number(amount) || 0;
    for (const tier of walletConfig.bonus_tiers) {
        if (amt >= tier.min && amt <= tier.max) return tier.percent;
    }
    return 0;
}

function calculateBonus(amount) {
    const amt = Number(amount) || 0;
    const percent = getBonusPercent(amt);
    return Math.round(amt * (percent / 100));
}


// ==================== REFERRAL SECTION (Phase 6.1 — Collapsible) ====================

/**
 * Initialize referral section:
 *   - Toggle collapse/expand with localStorage persistence
 *   - Link + copy + share buttons
 *   - Graceful no-op if user_id unavailable (browser test)
 */
function initReferralSection() {
    // --- Get user_id from Telegram SDK ---
    let userId = null;
    try {
        userId = tg.initDataUnsafe?.user?.id;
    } catch (e) {
        console.warn("[Referral] Could not read user_id from SDK:", e);
    }

    if (!userId) {
        console.warn("[Referral] No user_id — hiding referral section");
        const section = document.getElementById("referral-section");
        if (section) section.style.display = "none";
        return;
    }

    // --- Setup toggle button (collapsible) ---
    const toggle = document.getElementById("referral-toggle");
    const content = document.getElementById("referral-content");

    if (toggle && content) {
        // Restore previous state from localStorage (default: collapsed)
        let isExpanded = false;
        try {
            isExpanded = localStorage.getItem(REFERRAL_STORAGE_KEY) === "true";
        } catch (e) { /* Ignore — WebView may block localStorage */ }

        // Apply initial state
        applyReferralState(toggle, content, isExpanded);

        // Click handler
        toggle.addEventListener("click", () => {
            haptic("light");
            const currentlyExpanded =
                toggle.getAttribute("aria-expanded") === "true";
            const newState = !currentlyExpanded;

            applyReferralState(toggle, content, newState);

            // Persist preference
            try {
                localStorage.setItem(REFERRAL_STORAGE_KEY, String(newState));
            } catch (e) { /* Ignore */ }
        });
    }

    // --- Build referral link ---
    const link = `https://t.me/MyCyberWorldBot?start=ref_${userId}`;

    // --- Set link in input field ---
    const linkInput = document.getElementById("referral-link");
    if (linkInput) linkInput.value = link;

    // --- Copy button ---
    const copyBtn = document.getElementById("referral-copy-btn");
    if (copyBtn) {
        copyBtn.addEventListener("click", async () => {
            haptic("light");

            // Try modern clipboard API first
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(link);
                    safeAlert("✅ Referral link copied!");
                    return;
                }
            } catch (e) {
                console.warn("[Referral] clipboard.writeText failed:", e);
            }

            // Fallback: select + execCommand (works in older WebViews)
            try {
                if (linkInput) {
                    linkInput.select();
                    linkInput.setSelectionRange(0, 99999); // for iOS
                    const ok = document.execCommand("copy");
                    if (ok) {
                        safeAlert("✅ Referral link copied!");
                        return;
                    }
                }
            } catch (e) {
                console.warn("[Referral] execCommand fallback failed:", e);
            }

            // Final fallback
            safeAlert("Copy failed. Long-press the link to copy manually.");
        });
    }

    // --- Share button ---
    const shareBtn = document.getElementById("referral-share-btn");
    if (shareBtn) {
        shareBtn.addEventListener("click", () => {
            haptic("medium");

            const shareText =
                "🎁 Join My Cyber World and get ₹25 welcome bonus on your first payment!";
            const shareUrl =
                `https://t.me/share/url?url=${encodeURIComponent(link)}` +
                `&text=${encodeURIComponent(shareText)}`;

            try {
                if (tg.openTelegramLink) {
                    tg.openTelegramLink(shareUrl);
                } else {
                    window.open(shareUrl, "_blank");
                }
            } catch (e) {
                console.warn("[Referral] Share failed:", e);
                safeAlert("Could not open share. Please copy the link instead.");
            }
        });
    }

    console.log("[Referral] Section initialized for user:", userId);
}


/**
 * Apply expanded/collapsed state to referral toggle + content.
 *
 * @param {HTMLElement} toggle  - Toggle button element
 * @param {HTMLElement} content - Collapsible content wrapper
 * @param {boolean}     expanded - True for expanded, false for collapsed
 */
function applyReferralState(toggle, content, expanded) {
    if (!toggle || !content) return;

    toggle.setAttribute("aria-expanded", String(expanded));

    if (expanded) {
        content.classList.add("expanded");
    } else {
        content.classList.remove("expanded");
    }
}


// ==================== HELP / SUPPORT SECTION (Phase 6.2) ====================

/**
 * Initialize help section:
 *   - Bind "Help & Support" button
 *   - Hide if no Telegram user_id (browser test)
 */
function initHelpSection() {
    // --- Get user_id from Telegram SDK ---
    let userId = null;
    try {
        userId = tg.initDataUnsafe?.user?.id;
    } catch (e) {
        console.warn("[Help] Could not read user_id from SDK:", e);
    }

    if (!userId) {
        console.warn("[Help] No user_id — hiding help section");
        const section = document.getElementById("help-section");
        if (section) section.style.display = "none";
        return;
    }

    // --- Bind "Help & Support" button ---
    const btn = document.getElementById("help-open-btn");
    if (btn) {
        btn.addEventListener("click", () => {
            haptic("medium");
            openHelpModal();
        });
    }

    console.log("[Help] Section initialized for user:", userId);
}


/**
 * Open help modal (dynamic).
 * Contains: textarea + char counter + submit.
 */
function openHelpModal() {
    document.querySelector(".modal-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal">
            <button class="close-btn" id="modal-close" aria-label="Close">✕</button>
            <div class="modal-handle"></div>

            <h2 class="modal-title">❓ Help &amp; Support</h2>
            <p class="modal-subtitle">
                Describe your issue. Admin will reply as soon as possible.
            </p>

            <label class="form-label" for="help-message">Your Message</label>
            <textarea
                id="help-message"
                class="form-input"
                placeholder="Type your message (max ${HELP_MESSAGE_MAX_LEN} characters)..."
                maxlength="${HELP_MESSAGE_MAX_LEN}"
                rows="5"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="sentences"
                spellcheck="false"
            ></textarea>
            <div class="char-counter-row">
                <span class="char-counter" id="help-char-counter">0 / ${HELP_MESSAGE_MAX_LEN}</span>
            </div>
            <div class="form-error" id="form-error"></div>

            <button class="submit-btn" id="help-submit-btn" type="button">
                <span id="help-submit-text">📩 Send Message</span>
            </button>

            <p class="wallet-hint-text">
                ⏱️ Rate limit: 1 message per 5 minutes
            </p>
        </div>
    `;

    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add("active"), 10);

    // Close handlers
    document.getElementById("modal-close").addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal();
    });

    // --- Char counter ---
    const msgInput = document.getElementById("help-message");
    const counterEl = document.getElementById("help-char-counter");
    if (msgInput && counterEl) {
        msgInput.addEventListener("input", () => {
            const len = msgInput.value.length;
            counterEl.textContent = len + " / " + HELP_MESSAGE_MAX_LEN;
            counterEl.classList.toggle(
                "warning",
                len > 1800 && len < HELP_MESSAGE_MAX_LEN
            );
            counterEl.classList.toggle(
                "danger",
                len >= HELP_MESSAGE_MAX_LEN
            );
            clearFormError();
        });
    }

    // --- Submit ---
    const submitBtn = document.getElementById("help-submit-btn");
    if (submitBtn) {
        submitBtn.addEventListener("click", handleHelpSubmit);
    }

    // Auto-focus textarea
    setTimeout(() => msgInput?.focus(), 300);
}


/**
 * Base64url encode (URL-safe, no padding).
 * Used for deep-link payloads (?start=help_<base64> or ?start=svc_<base64>).
 */
function b64urlEncode(str) {
    try {
        const utf8 = new TextEncoder().encode(str);
        let binary = "";
        utf8.forEach((b) => { binary += String.fromCharCode(b); });
        return btoa(binary)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");
    } catch (e) {
        console.warn("[b64urlEncode] failed:", e);
        return "";
    }
}


/**
 * Handle help modal submit.
 *
 * PRIMARY: Deep link (works on ALL Telegram clients including Desktop).
 *   Format: https://t.me/MyCyberWorldBot?start=help_<base64url>
 *   Bot decodes it in /start handler and creates support message.
 *
 * FALLBACK: sendData (mobile — for messages that exceed URL length limit).
 */
function handleHelpSubmit() {
    if (isSubmitting) return;

    clearFormError();

    const msgInput = document.getElementById("help-message");
    if (!msgInput) return;

    const message = (msgInput.value || "").trim();

    if (!message) {
        showFormError("Please enter your message.");
        haptic("heavy");
        return;
    }

    if (message.length > HELP_MESSAGE_MAX_LEN) {
        showFormError(`Message too long (max ${HELP_MESSAGE_MAX_LEN} chars).`);
        haptic("heavy");
        return;
    }

    isSubmitting = true;
    const btn = document.getElementById("help-submit-btn");
    const btnText = document.getElementById("help-submit-text");
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = `<span class="btn-spinner"></span> Sending...`;

    haptic("medium");

    // ============ PRIMARY: Deep link (all platforms) ============
    // Telegram ?start= param max 64 chars total.
    // 'help_' = 5 chars. Base64 of ~40 ASCII bytes ≈ 54 chars.
    // So limit to first 40 chars of message.
    const shortMsg = message.substring(0, 40);
    const encoded = b64urlEncode(shortMsg);

    if (encoded && (5 + encoded.length) <= 64) {
        const deepLink =
            `https://t.me/MyCyberWorldBot?start=help_${encoded}`;
        try {
            if (typeof tg.openTelegramLink === "function") {
                console.log("[Help] Deep link:", deepLink);
                tg.openTelegramLink(deepLink);
                // Auto-close Mini App after deep link (Phase 8.0.x)
                setTimeout(() => {
                    try { tg.close(); } catch (e) { console.warn(e); }
                }, 300);
                return;
            }
        } catch (e) {
            console.warn("[Help] openTelegramLink failed:", e);
        }
    }

    // ============ FALLBACK: sendData (mobile only) ============
    try {
        tg.sendData(JSON.stringify({ type: "support", message: message }));
        console.log("[Help] sendData fallback used");
        setTimeout(() => {
            try { tg.close(); } catch (e) { console.warn(e); }
        }, 500);
    } catch (error) {
        console.error("[Help] All methods failed:", error);
        isSubmitting = false;
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = "📩 Send Message";
        safeAlert(
            "Message could not be sent automatically. " +
            "Please type in the bot chat:\n\n/support " + message
        );
    }
}


// ==================== OFFER BANNER (Phase 4.3) ====================

/**
 * Fetch offers.json and show banner if there are active offers.
 * Silent on failure — banner stays hidden.
 */
async function loadOffers() {
    try {
        const response = await fetch(`offers.json?v=${Date.now()}`);
        if (!response.ok) {
            console.warn("[Offers] offers.json not found or empty");
            return;
        }

        const data = await response.json();
        allOffers = data.offers || [];

        if (allOffers.length === 0) {
            console.log("[Offers] No active offers");
            return;
        }

        // Pick offer with highest bonus_percent (best for user)
        const best = allOffers.reduce(
            (a, b) => (Number(b.bonus_percent) > Number(a.bonus_percent)) ? b : a
        );

        showOfferBanner(best);

    } catch (error) {
        // Silent fail — banner stays hidden
        console.warn("[Offers] Load failed:", error);
    }
}

/**
 * Populate and show offer banner.
 * Respects session-based dismiss flag.
 */
function showOfferBanner(offer) {
    if (offerBannerDismissed) return;

    const bannerEl = document.getElementById("offer-banner");
    const titleEl = document.getElementById("offer-title");
    const descEl = document.getElementById("offer-desc");
    const timerEl = document.getElementById("offer-timer");

    if (!bannerEl) return;

    if (titleEl) {
        titleEl.textContent = offer.title || "Special Offer";
    }

    if (descEl) {
        const pct = Number(offer.bonus_percent) || 0;
        const min = formatINR(offer.min_topup);
        const max = formatINR(offer.max_topup);
        descEl.textContent = `${pct}% bonus on ${min} – ${max}`;
    }

    if (timerEl) {
        timerEl.textContent = offer.time_remaining || "—";
    }

    bannerEl.style.display = "flex";
}

/**
 * Hide offer banner and mark dismissed for this session.
 * Note: Mini App is not persisted — next open = banner shows again.
 */
function hideOfferBanner() {
    const bannerEl = document.getElementById("offer-banner");
    if (bannerEl) {
        bannerEl.style.display = "none";
    }
    offerBannerDismissed = true;
    haptic("light");
}


// ==================== ADD MONEY MODAL ====================
function openAddMoneyModal() {
    if (!walletConfig) {
        safeAlert("Wallet not configured. Please retry.");
        return;
    }

    document.querySelector(".modal-overlay")?.remove();

    const presetHTML = walletConfig.preset_amounts
        .map(amt => `<button class="amount-chip" data-amount="${amt}" type="button">${formatINR(amt)}</button>`)
        .join("");

    const minFmt = formatINR(walletConfig.min_topup);
    const maxFmt = formatINR(walletConfig.max_topup);
    const expiry = walletConfig.topup_expiry_minutes || 5;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal wallet-modal">
            <button class="close-btn" id="modal-close" aria-label="Close">✕</button>
            <div class="modal-handle"></div>

            <h2 class="modal-title">💰 Add Money to Wallet</h2>
            <p class="modal-subtitle">Choose an amount or enter custom</p>

            <div class="amount-grid" id="amount-grid">
                ${presetHTML}
            </div>

            <label class="form-label">
                Or enter custom (${minFmt} - ${maxFmt})
            </label>
            <input
                type="tel"
                class="form-input"
                id="custom-amount"
                placeholder="Enter amount"
                autocomplete="off"
                inputmode="numeric"
            />
            <div class="form-error" id="form-error"></div>

            <div class="bonus-preview" id="bonus-preview" style="display:none;">
                <div class="bonus-row">
                    <span>Amount:</span>
                    <span id="preview-amount">₹0</span>
                </div>
                <div class="bonus-row bonus-row-highlight" id="preview-bonus-row">
                    <span>Bonus (<span id="preview-percent">0</span>%):</span>
                    <span id="preview-bonus">₹0</span>
                </div>
                <div class="bonus-row bonus-row-total">
                    <span>Total Credit:</span>
                    <span id="preview-total">₹0</span>
                </div>
            </div>

            <button class="submit-btn" id="topup-submit-btn" type="button">
                <span id="topup-submit-text">Proceed to Pay</span>
            </button>

            <p class="wallet-hint-text">
                ⏱️ QR valid for ${expiry} minutes
            </p>
        </div>
    `;

    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add("active"), 10);

    // Close handlers
    document.getElementById("modal-close").addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal();
    });

    // Amount chips
    document.querySelectorAll(".amount-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            haptic("light");
            document.querySelectorAll(".amount-chip").forEach(c => c.classList.remove("active"));
            chip.classList.add("active");
            const amount = parseInt(chip.dataset.amount, 10);
            const customEl = document.getElementById("custom-amount");
            if (customEl) customEl.value = "";
            clearFormError();
            updateBonusPreview(amount);
        });
    });

    // Custom input
    const customInput = document.getElementById("custom-amount");
    if (customInput) {
        customInput.addEventListener("input", () => {
            document.querySelectorAll(".amount-chip").forEach(c => c.classList.remove("active"));
            clearFormError();
            const val = parseInt(customInput.value.replace(/\D/g, ""), 10) || 0;
            updateBonusPreview(val);
        });
    }

    // Submit
    document.getElementById("topup-submit-btn").addEventListener("click", handleTopupSubmit);

    setTimeout(() => customInput?.focus(), 300);
}


// ==================== BONUS PREVIEW ====================
function updateBonusPreview(amount) {
    const previewEl = document.getElementById("bonus-preview");
    const bonusRowEl = document.getElementById("preview-bonus-row");
    if (!previewEl) return;

    if (!amount || amount < walletConfig.min_topup || amount > walletConfig.max_topup) {
        previewEl.style.display = "none";
        return;
    }

    const bonus = calculateBonus(amount);
    const percent = getBonusPercent(amount);
    const total = amount + bonus;

    document.getElementById("preview-amount").textContent = formatINR(amount);
    document.getElementById("preview-percent").textContent = percent;
    document.getElementById("preview-bonus").textContent = formatINR(bonus);
    document.getElementById("preview-total").textContent = formatINR(total);

    // Hide bonus row if 0%
    if (bonusRowEl) {
        bonusRowEl.style.display = percent > 0 ? "flex" : "none";
    }

    previewEl.style.display = "block";
}


// ==================== HANDLE TOPUP SUBMIT ====================
function handleTopupSubmit() {
    if (isSubmitting) return;

    clearFormError();

    // Get amount from chip or custom
    let amount = 0;
    const activeChip = document.querySelector(".amount-chip.active");
    if (activeChip) {
        amount = parseInt(activeChip.dataset.amount, 10);
    } else {
        const customEl = document.getElementById("custom-amount");
        amount = parseInt((customEl?.value || "").replace(/\D/g, ""), 10) || 0;
    }

    // Validate
    if (!amount || amount < walletConfig.min_topup) {
        showFormError(`Minimum top-up is ${formatINR(walletConfig.min_topup)}`);
        haptic("heavy");
        return;
    }
    if (amount > walletConfig.max_topup) {
        showFormError(`Maximum top-up is ${formatINR(walletConfig.max_topup)}`);
        haptic("heavy");
        return;
    }

    // Submit
    isSubmitting = true;
    const btn = document.getElementById("topup-submit-btn");
    const btnText = document.getElementById("topup-submit-text");
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = `<span class="btn-spinner"></span> Sending...`;

    haptic("medium");

    const payload = { type: "topup", amount: amount };

    try {
        tg.sendData(JSON.stringify(payload));
        setTimeout(() => {
            try { tg.close(); } catch (e) { console.warn(e); }
        }, 300);
    } catch (error) {
        console.error("sendData failed:", error);
        isSubmitting = false;
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = "Proceed to Pay";
        safeAlert("Failed to send data. Please try again.");
    }
}


// ==================== LOAD SERVICES + WALLET CONFIG ====================
async function loadServices() {
    try {
        const response = await fetch(`services.json?v=${Date.now()}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        allServices = data.services || [];
        walletConfig = data.wallet || null;

        renderWallet();
        renderServices();
        setDisplay("loading", "none");

    } catch (error) {
        console.error("Failed to load services:", error);
        setDisplay("loading", "none");
        setDisplay("error-state", "block");
    }
}


// ==================== RENDER ALL SERVICES (FLAT) ====================
function renderServices() {
    const app = document.getElementById("app");
    if (!app) return;

    app.innerHTML = "";

    const activeServices = allServices
        .filter(s => s.is_active !== false)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

    if (activeServices.length === 0) {
        app.innerHTML = `
            <p style="text-align:center;color:#94a3b8;padding:40px;">
                No services available.
            </p>
        `;
        return;
    }

    const countEl = document.createElement("div");
    countEl.className = "services-count";
    countEl.innerHTML = `<span>📋 ${activeServices.length} Services Available</span>`;
    app.appendChild(countEl);

    activeServices.forEach(service => {
        app.appendChild(createServiceCard(service));
    });
}


// ==================== CREATE SERVICE CARD ====================
function createServiceCard(service) {
    const div = document.createElement("div");
    div.className = "service-card";

    div.innerHTML = `
        <div class="service-info">
            <div class="service-name">${escapeHtml(service.name)}</div>
            <div class="service-desc">${escapeHtml(service.description || "")}</div>
        </div>
        <div class="service-price">${formatINR(service.price || 0)}</div>
    `;

    div.addEventListener("click", () => {
        haptic("medium");
        openServiceModal(service);
    });

    return div;
}


// ==================== OPEN SERVICE MODAL ====================
function openServiceModal(service) {
    document.querySelector(".modal-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal">
            <button class="close-btn" id="modal-close" aria-label="Close">✕</button>
            <div class="modal-handle"></div>

            <h2 class="modal-title">${escapeHtml(service.name)}</h2>
            <p class="modal-subtitle">${escapeHtml(service.description || "")}</p>

            <label class="form-label">${escapeHtml(service.input_label || "Enter value")}</label>
            <input
                type="${escapeHtml(service.input_type || "text")}"
                class="form-input"
                id="input-value"
                placeholder="${escapeHtml(service.input_placeholder || "")}"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                inputmode="${getInputMode(service.input_type)}"
            />
            <div class="form-error" id="form-error"></div>

            ${service.requires_consent ? `
                <div class="consent-box">
                    <input type="checkbox" id="consent-checkbox">
                    <label for="consent-checkbox">
                        I confirm I am the owner or have valid written authorization to investigate this data. I will use it only for lawful purposes.
                    </label>
                </div>
            ` : ""}

            <button class="submit-btn" id="submit-btn" type="button">
                <span id="submit-text">Submit & Authorize — ${formatINR(service.price || 0)}</span>
            </button>
        </div>
    `;

    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add("active"), 10);

    document.getElementById("modal-close").addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal();
    });

    document.getElementById("submit-btn").addEventListener("click", () => {
        handleSubmit(service);
    });

    const inputEl = document.getElementById("input-value");
    if (inputEl) {
        inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") handleSubmit(service);
        });
    }

    setTimeout(() => {
        const el = document.getElementById("input-value");
        if (el) el.focus();
    }, 300);
}


// ==================== CLOSE MODAL ====================
function closeModal() {
    const overlay = document.querySelector(".modal-overlay");
    if (overlay) {
        overlay.classList.remove("active");
        setTimeout(() => overlay.remove(), 300);
    }
}


// ==================== FORM ERROR HANDLING ====================
function showFormError(message) {
    const errEl = document.getElementById("form-error");
    const inputEl = document.getElementById("input-value")
        || document.getElementById("custom-amount")
        || document.getElementById("help-message");

    if (errEl) {
        errEl.textContent = message;
        errEl.classList.add("visible");
    }
    if (inputEl) {
        inputEl.classList.add("error");
        inputEl.focus();
    }
}

function clearFormError() {
    const errEl = document.getElementById("form-error");
    const inputEl = document.getElementById("input-value")
        || document.getElementById("custom-amount")
        || document.getElementById("help-message");

    if (errEl) errEl.classList.remove("visible");
    if (inputEl) inputEl.classList.remove("error");
}


// ==================== VALIDATE INPUT (per feature) ====================
function validateInput(service, value) {
    const feature = service.api_feature || "";

    if (feature === "lookup_number" || feature === "num_to_name" ||
        feature === "num_to_all_info" || feature === "hitech_num_info") {
        const clean = value.replace(/\D/g, "");
        if (clean.length !== 10 || !/^[6-9]/.test(clean)) {
            return "Please enter a valid 10-digit Indian mobile number.";
        }
    }

    if (feature === "aadhaar_info" || feature === "aadhaar_family" ||
        feature === "aadhaar_to_ration") {
        const clean = value.replace(/\D/g, "");
        if (clean.length !== 12) {
            return "Please enter a valid 12-digit Aadhaar number.";
        }
    }

    if (feature === "pan_info") {
        if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(value)) {
            return "Please enter a valid PAN (format: AAAAA9999A).";
        }
    }

    if (feature === "upi_to_info") {
        if (!/^[a-z0-9._-]{2,}@[a-z]{2,}$/i.test(value)) {
            return "Please enter a valid UPI ID (e.g., user@okicici).";
        }
    }

    if (feature === "email_to_number") {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            return "Please enter a valid email address.";
        }
    }

    if (feature === "vehicle_to_number" || feature === "vehicle_full_address" ||
        feature === "vehicle_challan" || feature === "rc_to_pdf" ||
        feature === "num_to_vehicle") {
        if (value.replace(/\s/g, "").length < 5) {
            return "Please enter a valid vehicle registration number.";
        }
    }

    if (feature === "tg_id_to_number") {
        if (!/^\d{5,15}$/.test(value)) {
            return "Please enter a valid numeric Telegram ID.";
        }
    }

    if (feature === "instagram_info") {
        if (!/^[a-zA-Z0-9._]{1,30}$/.test(value.replace("@", ""))) {
            return "Please enter a valid Instagram username.";
        }
    }

    if (feature === "website_scraper") {
        if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value.replace(/^https?:\/\//, ""))) {
            return "Please enter a valid website URL.";
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 8.0.7 — New API validators
    // ═══════════════════════════════════════════════════════════════

    // tg_to_num_backup — Telegram ID (numeric, 5-15 digits)
    if (feature === "tg_to_num_backup") {
        if (!/^\d{5,15}$/.test(value)) {
            return "Please enter a valid numeric Telegram ID (5-15 digits).";
        }
    }

    // ration_info — Ration card number (min 8 digits)
    if (feature === "ration_info") {
        if (value.replace(/\D/g, "").length < 8) {
            return "Please enter a valid ration card number.";
        }
    }

    // vehicle_to_num_backup — Vehicle registration (min 5 chars)
    if (feature === "vehicle_to_num_backup") {
        if (value.replace(/\s/g, "").length < 5) {
            return "Please enter a valid vehicle registration number.";
        }
    }

    return null;
}


// ==================== HANDLE SERVICE SUBMIT ====================
function handleSubmit(service) {
    if (isSubmitting) return;

    clearFormError();

    const inputEl = document.getElementById("input-value");
    if (!inputEl) return;

    const inputValue = (inputEl.value || "").trim();

    if (!inputValue) {
        showFormError("Please enter a value.");
        haptic("heavy");
        return;
    }

    const validationError = validateInput(service, inputValue);
    if (validationError) {
        showFormError(validationError);
        haptic("heavy");
        return;
    }

    if (service.requires_consent) {
        const consentEl = document.getElementById("consent-checkbox");
        if (!consentEl || !consentEl.checked) {
            safeAlert("Please confirm authorization before proceeding.");
            haptic("heavy");
            return;
        }
    }

    isSubmitting = true;
    const btn = document.getElementById("submit-btn");
    const btnText = document.getElementById("submit-text");

    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = `<span class="btn-spinner"></span> Submitting...`;

    haptic("medium");

    // ═══════════════════════════════════════════════════════════════
    // PRIMARY: Deep link (works on ALL platforms — Phase 8.0.9)
    //   - Telegram Desktop ✅
    //   - Telegram Web K ✅ (bug that broke sendData)
    //   - Telegram Web A ✅
    //   - Telegram Mobile ✅
    //
    // v2.10: Uses SHORT numeric id (e.g., 11) instead of code (e.g.,
    // email_lookup). Reduces payload size so long inputs (emails) fit
    // within Telegram's 64-char /start limit.
    //
    // Compact keys {s, i} → {"s":"11","i":"user@example.com"} fits!
    // Bot's start_command detects "svc_" prefix → resolves short_id
    // → full service_code → processes.
    //
    // Fallback: if service.id is null (old services.json), uses code.
    // ═══════════════════════════════════════════════════════════════
    // v2.10: Use short numeric id (falls back to code for old services.json)
    const serviceKey = (service.id != null) ? String(service.id) : service.code;
    const compactPayload = { s: serviceKey, i: inputValue };
    let encoded = "";
    try {
        encoded = b64urlEncode(JSON.stringify(compactPayload));
    } catch (e) {
        console.warn("[Service] b64urlEncode failed:", e);
    }

    if (encoded && (4 + encoded.length) <= 64) {
        const deepLink = `https://t.me/MyCyberWorldBot?start=svc_${encoded}`;
        try {
            if (typeof tg.openTelegramLink === "function") {
                console.log("[Service] Deep link:", deepLink);
                tg.openTelegramLink(deepLink);
                // ✅ Auto-close Mini App after opening bot chat (Phase 8.0.x fix)
                setTimeout(() => {
                    try { tg.close(); } catch (e) { console.warn(e); }
                }, 300);
                return;
            }
        } catch (e) {
            console.warn("[Service] Deep link failed, falling back to sendData:", e);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // FALLBACK: sendData (mobile only)
    //   - Triggered when payload > 64 chars (e.g., very long inputs)
    //   - Works reliably on Telegram Mobile
    //   - On Desktop/Web K, long payloads still fail — acceptable edge case
    // ═══════════════════════════════════════════════════════════════
    const payload = {
        service_code: service.code,
        input_value: inputValue
    };

    try {
        tg.sendData(JSON.stringify(payload));

        setTimeout(() => {
            try { tg.close(); } catch (e) { console.warn(e); }
        }, 300);

    } catch (error) {
        console.error("sendData failed:", error);
        isSubmitting = false;
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = `Submit & Authorize — ${formatINR(service.price || 0)}`;
        safeAlert("Failed to send data. Please try again.");
    }
}


// ==================== WALLET REFRESH HANDLER (Phase 8.0.x — deep link) ====================
function handleWalletRefresh() {
    haptic("light");

    // Show "Refreshing..." hint
    const hintEl = document.getElementById("wallet-hint");
    if (hintEl) hintEl.textContent = "⏳ Refreshing...";

    // ═══════════════════════════════════════════════════════════════
    // PRIMARY: Deep link (works on ALL platforms — Phase 8.0.x)
    // Format: https://t.me/MyCyberWorldBot?start=balance
    // Bot's start_command detects "balance" arg → calls handle_balance_check
    //   → sends fresh balance message + new "Open Panel (₹X)" button
    // ═══════════════════════════════════════════════════════════════
    const deepLink = `https://t.me/MyCyberWorldBot?start=balance`;
    try {
        if (typeof tg.openTelegramLink === "function") {
            console.log("[Balance] Deep link:", deepLink);
            tg.openTelegramLink(deepLink);
            // Auto-close Mini App after opening bot chat
            setTimeout(() => {
                try { tg.close(); } catch (e) { console.warn(e); }
            }, 300);
            return;
        }
    } catch (e) {
        console.warn("[Balance] Deep link failed, falling back to sendData:", e);
    }

    // ═══════════════════════════════════════════════════════════════
    // FALLBACK: sendData (mobile only)
    // ═══════════════════════════════════════════════════════════════
    try {
        tg.sendData(JSON.stringify({ type: "check_balance" }));
        setTimeout(() => {
            try { tg.close(); } catch (e) { console.warn(e); }
        }, 500);
    } catch (e) {
        console.warn("Balance refresh failed:", e);
        // Restore hint on failure
        if (hintEl) {
            hintEl.textContent = walletBalance <= 0
                ? "👋 Add money to start"
                : "Available Balance";
        }
        renderWallet();
    }
}


// ==================== INIT ====================
document.addEventListener("DOMContentLoaded", () => {
    // Read initial balance (URL param OR localStorage cache)
    initWalletBalanceFromURL();

    // Wallet refresh button
    const refreshBtn = document.getElementById("wallet-refresh");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", handleWalletRefresh);
    }

    // Add Money button
    const addMoneyBtn = document.getElementById("add-money-btn");
    if (addMoneyBtn) {
        addMoneyBtn.addEventListener("click", () => {
            haptic("medium");
            openAddMoneyModal();
        });
    }

    // Offer banner close button (Phase 4.3)
    const offerCloseBtn = document.getElementById("offer-close");
    if (offerCloseBtn) {
        offerCloseBtn.addEventListener("click", hideOfferBanner);
    }

    // Referral section (Phase 6.1 — collapsible)
    initReferralSection();

    // Help section (Phase 6.2 — support)
    initHelpSection();

    // Load services + wallet config
    loadServices();

    // Load active offers (independent, silent on failure) — Phase 4.3
    loadOffers();
});