/**
 * profit-max.js — ProfitMax Smart Pricing storefront snippet
 *
 * Sections:
 *   1.   Initialisation        — persistent cookie ID + session ID
 *   2.   Page type detection   — product page vs collection/list page vs exit
 *   1.5. Variant UI suppression — hide _pm_price option group and experiment variants
 *   3.   Fetch config          — load active experiment for this product
 *   4.   Visitor assignment    — weighted-random variant selection, cached in sessionStorage
 *   5.   Price display         — apply experiment price, watch for theme variant-switch rewrites
 *   6.   Add-to-cart           — intercept form submissions and fetch calls to swap variant IDs
 *   7.   Impression tracking   — fire-and-forget POST on first assignment per session
 *   C.   Collection pages      — batch-fetch, assign, and display experiment prices on list pages
 */

(function () {
  'use strict';

  if (window.__profitMax && window.__profitMax.initialised) return;
  window.__profitMax = window.__profitMax || {};
  window.__profitMax.initialised = true;

  // ===========================================================================
  // CURRENCY
  //
  // Prices are stored in the shop's base currency. Apply Shopify.currency.rate
  // first if the visitor has switched display currency, then format.
  //
  // Priority:
  //   1. window.Shopify.money_format — Shopify always sets this and it uses
  //      the exact symbol and format the merchant has configured (e.g. "${{amount}}").
  //      This guarantees we match the surrounding page (no "US$" vs "$" mismatch).
  //   2. Intl.NumberFormat — fallback if money_format is absent.
  //   3. Bare decimal — last resort.
  // ===========================================================================

  function formatMoney(priceDecimal) {
    try {
      var amount = parseFloat(priceDecimal);
      if (isNaN(amount)) return String(priceDecimal);

      var rate = (window.Shopify &&
                  window.Shopify.currency &&
                  parseFloat(window.Shopify.currency.rate)) || 1;
      amount = amount * rate;

      // Priority 1: money_format — matches the exact symbol and format the
      // merchant has configured, so our prices look identical to the theme's.
      // Check both Shopify globals; themes set one or both.
      var moneyFormat =
        (window.Shopify && window.Shopify.money_format) ||
        (window.ShopifyAnalytics && window.ShopifyAnalytics.meta &&
         window.ShopifyAnalytics.meta.currency &&
         window.ShopifyAnalytics.meta.currency.moneyFormat) || '';

      if (moneyFormat) {
        var rounded   = Math.round(amount);
        var decimal   = amount.toFixed(2);
        var commaD    = decimal.replace('.', ',');
        var commaI    = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        // Use a regex so we match whichever placeholder the format string uses,
        // and handle optional spaces inside {{ }}.
        return moneyFormat.replace(/\{\{\s*(amount[^}]*?)\s*\}\}/, function (_, key) {
          switch (key.trim()) {
            case 'amount':                              return decimal;
            case 'amount_no_decimals':                  return String(rounded);
            case 'amount_with_comma_separator':         return commaD;
            case 'amount_no_decimals_with_comma_separator': return commaI;
            default:                                    return decimal;
          }
        });
      }

      // Priority 2: Intl.NumberFormat — use navigator.languages[0] (includes
      // region, e.g. "en-US") so USD renders as "$" not "US$".
      var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || '';
      if (currency) {
        try {
          return new Intl.NumberFormat(navigator.languages && navigator.languages[0] || 'en-US', {
            style: 'currency', currency: currency,
            minimumFractionDigits: 2, maximumFractionDigits: 2,
          }).format(amount);
        } catch (e) { /* invalid currency code */ }
      }

      return amount.toFixed(2);
    } catch (e) {
      return String(priceDecimal);
    }
  }

  // ===========================================================================
  // SECTION 1 — INITIALISATION
  // ===========================================================================

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, maxAgeSeconds) {
    var expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
    document.cookie =
      name + '=' + encodeURIComponent(value) +
      '; expires=' + expires + '; path=/; SameSite=Lax';
  }

  var ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

  var cookieId = getCookie('_pm_cid') || generateUUID();
  setCookie('_pm_cid', cookieId, ONE_YEAR_SECONDS);

  var sessionId = sessionStorage.getItem('_pm_sid') || generateUUID();
  sessionStorage.setItem('_pm_sid', sessionId);

  window.__profitMax.cookieId  = cookieId;
  window.__profitMax.sessionId = sessionId;

  // ===========================================================================
  // SHARED HELPERS
  // ===========================================================================

  function numericIdFromGid(gid) { return String(gid).split('/').pop(); }
  function buildGid(type, id)    { return 'gid://shopify/' + type + '/' + id; }

  var shop = window.Shopify && window.Shopify.shop;

  /** Remove the anti-flicker class set by the inline script in the Liquid block. */
  function revealPrices() {
    document.documentElement.classList.remove('pm-prices-loading');
  }

  /**
   * Perform a weighted-random draw from a list of candidates each having a
   * `probability` field. Returns the chosen candidate.
   *
   * @param {Array<{probability: number|string}>} candidates
   */
  function weightedDraw(candidates) {
    var rand = Math.random();
    var cumulative = 0;
    for (var k = 0; k < candidates.length; k++) {
      cumulative += Number(candidates[k].probability);
      if (rand < cumulative) return candidates[k];
    }
    return candidates[candidates.length - 1]; // floating-point safety
  }

  /**
   * Build an assignmentMap ({ baseVariantGid → { experimentVariantId, price } })
   * from a flat array of assignment rows, using weighted-random selection per
   * base variant. Caches the result in sessionStorage under `cacheKey`.
   *
   * If a valid cached map already exists under `cacheKey`, returns it directly
   * without re-drawing so the same visitor sees the same prices.
   *
   * @param {string} cacheKey
   * @param {Array<{baseVariantId, experimentVariantId, price, probability}>} assignments
   * @returns {{ map: Object, isNew: boolean }}
   */
  function buildOrLoadAssignment(cacheKey, assignments) {
    var stored = sessionStorage.getItem(cacheKey);
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') return { map: parsed, isNew: false };
      } catch (e) { /* corrupt — re-draw */ }
    }

    var byBase = {};
    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i];
      if (!byBase[a.baseVariantId]) byBase[a.baseVariantId] = [];
      byBase[a.baseVariantId].push(a);
    }

    var map = {};
    var bases = Object.keys(byBase);
    for (var j = 0; j < bases.length; j++) {
      var chosen = weightedDraw(byBase[bases[j]]);
      map[bases[j]] = { experimentVariantId: chosen.experimentVariantId, price: chosen.price };
    }

    try { sessionStorage.setItem(cacheKey, JSON.stringify(map)); } catch (e) { /* quota */ }
    return { map: map, isNew: true };
  }

  // ===========================================================================
  // SECTION 2 — PAGE TYPE DETECTION
  // ===========================================================================

  var productNumericId = null;

  if (window.Shopify && window.Shopify.product && window.Shopify.product.id) {
    productNumericId = String(window.Shopify.product.id);
  } else {
    var productMeta = document.querySelector('meta[name="product-id"]');
    if (productMeta) productNumericId = productMeta.getAttribute('content');
  }

  if (!productNumericId) {
    try {
      if (window.__st && window.__st.rtyp === 'product' && window.__st.rid) {
        productNumericId = String(window.__st.rid);
      }
    } catch (e) { console.warn('[ProfitMax] window.__st read failed:', e); }
  }

  var isProductPage = !!productNumericId;
  var isListPage    = !isProductPage &&
    document.querySelectorAll('a[href*="/products/"]').length > 0;

  if (!isProductPage && !isListPage) return;
  if (!shop) {
    console.warn('[ProfitMax] window.Shopify.shop unavailable — exiting.');
    return;
  }

  // ===========================================================================
  // SECTION C — COLLECTION / LIST PAGE PRICE INJECTION
  //
  // Strategy (fastest path first):
  //
  //   Path 1 — window.__pmConfig (zero network requests):
  //     The head snippet injected into layout/theme.liquid embeds the full
  //     experiment config as an inline JS variable. window.__pmPageProductIds
  //     lists all product GIDs visible on this page (also injected by Liquid).
  //     We can assign and display prices synchronously with no fetch at all.
  //
  //   Path 2 — batch API fetch (fallback if head snippet is absent):
  //     Collect product IDs from [data-product-id] attributes and JSON blobs,
  //     fetch /api/collection-prices, assign, display.
  //
  // In both paths, assignments are cached in sessionStorage under
  // 'pm_assign<numericId>' — the same key used on product pages — so prices
  // are consistent when the visitor navigates through to a product page.
  // ===========================================================================

  if (isListPage) {
    (async function () {
      try {
        var CARD_PRICE_SELECTORS =
          '.price__regular, .price, [data-product-price], .price-item, .product__price';

        /**
         * Apply experiment prices to all product cards using a priceMap of
         *   gid → [{ baseVariantId, experimentVariantId, price, probability }]
         */
        function applyCardPrices(priceMap) {
          // Cards with data-product-id (most themes, including Dawn).
          document.querySelectorAll('[data-product-id]').forEach(function (card) {
            var numId = card.getAttribute('data-product-id');
            if (!numId) return;
            var gid = buildGid('Product', numId);
            var assignments = priceMap[gid];
            if (!Array.isArray(assignments) || assignments.length === 0) return;
            var result = buildOrLoadAssignment('pm_assign' + numId, assignments);
            var firstBase = Object.keys(result.map)[0];
            if (!firstBase) return;
            var formatted = formatMoney(result.map[firstBase].price);
            card.querySelectorAll(CARD_PRICE_SELECTORS).forEach(function (el) {
              el.textContent = formatted;
            });
          });
        }

        // ------------------------------------------------------------------
        // Path 1: use window.__pmConfig + window.__pmPageProductIds
        // ------------------------------------------------------------------
        var pmConfig = window.__pmConfig;
        var pmPageIds = window.__pmPageProductIds; // array of GIDs from Liquid

        if (pmConfig && typeof pmConfig === 'object' && Array.isArray(pmPageIds) && pmPageIds.length > 0) {
          // Build a priceMap from the inline config, restricted to this page's products.
          var inlinePriceMap = {};
          for (var pi = 0; pi < pmPageIds.length; pi++) {
            var gid = pmPageIds[pi];
            var productCfg = pmConfig[gid];
            if (productCfg && Array.isArray(productCfg.assignments)) {
              inlinePriceMap[gid] = productCfg.assignments;
            }
          }
          applyCardPrices(inlinePriceMap);
          return; // done — no network fetch needed
        }

        // ------------------------------------------------------------------
        // Path 2: batch API fetch fallback
        // ------------------------------------------------------------------
        var productGidSet = new Set();

        document.querySelectorAll('[data-product-id]').forEach(function (el) {
          var id = el.getAttribute('data-product-id');
          if (id) productGidSet.add(buildGid('Product', id));
        });

        document.querySelectorAll('script[type="application/json"]').forEach(function (el) {
          try {
            var data = JSON.parse(el.textContent || '');
            if (Array.isArray(data.products)) {
              data.products.forEach(function (p) {
                if (p && p.id) productGidSet.add(buildGid('Product', p.id));
              });
            }
          } catch (e) { /* ignore */ }
        });

        if (productGidSet.size === 0) return;

        var productIds = Array.from(productGidSet);
        var fetchCacheKey = 'pm_batch_' + productIds.slice().sort().join(',');
        var priceMap = null;

        var cachedBatch = sessionStorage.getItem(fetchCacheKey);
        if (cachedBatch) {
          try { priceMap = JSON.parse(cachedBatch); } catch (e) { priceMap = null; }
        }

        if (!priceMap) {
          var url =
            'https://' + shop + '/apps/profit-max/api/collection-prices' +
            '?merchantId=' + encodeURIComponent(shop) +
            '&productIds=' + encodeURIComponent(productIds.join(','));

          var res;
          try { res = await fetch(url); } catch (e) {
            console.warn('[ProfitMax] Collection prices fetch failed:', e);
            return;
          }
          if (!res.ok) return;

          var body;
          try { body = await res.json(); } catch (e) { return; }
          priceMap = body.prices || {};
          try { sessionStorage.setItem(fetchCacheKey, JSON.stringify(priceMap)); } catch (e) { /* quota */ }
        }

        applyCardPrices(priceMap);

      } catch (e) {
        console.warn('[ProfitMax] Collection page error:', e);
      } finally {
        revealPrices();
      }
    })();
    return;
  }

  // ===========================================================================
  // PRODUCT PAGE FLOW
  // ===========================================================================

  var productGid = buildGid('Product', productNumericId);
  var PRICE_SELECTORS = '.price__regular, .price, [data-product-price], .price-item, .product__price';

  // ---------------------------------------------------------------------------
  // Product section scoping
  //
  // All price-element reads and writes MUST be scoped to the main product
  // section to avoid accidentally updating price elements in "Related products"
  // or "Recently viewed" carousels further down the page.
  //
  // We try specific data attributes first (most reliable), then walk up from
  // the product form, caching the result so the DOM lookup only happens once.
  // ---------------------------------------------------------------------------
  var pm_productSection = null;

  function getProductSection() {
    if (pm_productSection) return pm_productSection;
    try {
      var candidates = [
        document.querySelector('[data-section-type="product"]'),
        document.querySelector('[data-product-form]'),
        document.querySelector('#MainProduct-template'),
        document.querySelector('[id^="MainProduct"]'),
      ];
      for (var ci = 0; ci < candidates.length; ci++) {
        if (candidates[ci]) { pm_productSection = candidates[ci]; return pm_productSection; }
      }
      // Walk up from the form to its closest meaningful ancestor.
      var form = document.querySelector('form[action*="/cart/add"]');
      if (form) {
        var ancestor = form.closest('[class*="product"]') || form.closest('section') || form.parentElement;
        if (ancestor && ancestor !== document.body) { pm_productSection = ancestor; return pm_productSection; }
      }
    } catch (e) { /* ignore */ }
    // Absolute fallback — should never reach here on a valid product page.
    pm_productSection = document.body;
    return pm_productSection;
  }

  /** querySelectorAll scoped to the product section. */
  function queryPriceEls() {
    return getProductSection().querySelectorAll(PRICE_SELECTORS);
  }

  // Last price string we applied. Used by the MutationObserver to distinguish
  // our own writes from the theme's — see watchPriceElements().
  var pm_lastAppliedPrice = null;

  // ===========================================================================
  // SECTION 1.5 — VARIANT UI SUPPRESSION (Phase A — synchronous)
  // ===========================================================================

  (function injectSuppressCSS() {
    try {
      var style = document.createElement('style');
      style.textContent =
        '[name="_pm_price"],[name="options[_pm_price]"],[id*="_pm_price"],' +
        '[for*="_pm_price"],[data-option*="pm_price"]{display:none!important}' +
        'fieldset:has([name*="_pm_price"]),li:has([name*="_pm_price"]){display:none!important}';
      (document.head || document.documentElement).appendChild(style);
    } catch (e) { console.warn('[ProfitMax] CSS injection failed:', e); }
  })();

  var pmOptionIndex = -1;
  try {
    var shopifyProduct = window.Shopify && window.Shopify.product;
    if (shopifyProduct && Array.isArray(shopifyProduct.options)) {
      pmOptionIndex = shopifyProduct.options.indexOf('_pm_price');
      if (pmOptionIndex !== -1) {
        shopifyProduct.options.splice(pmOptionIndex, 1);
        (shopifyProduct.variants || []).forEach(function (v) {
          if (Array.isArray(v.options)) v.options.splice(pmOptionIndex, 1);
        });
      }
    }
  } catch (e) { console.warn('[ProfitMax] Shopify.product options patching failed:', e); }
  window.__profitMax.pmOptionIndex = pmOptionIndex;

  var OPTION_GROUP_CLASS_RE = /option|swatch|variant|selector|picker/i;

  function hideOptionContainer(startEl) {
    try {
      var node = startEl;
      for (var depth = 0; depth < 6; depth++) {
        var tag = node.tagName ? node.tagName.toLowerCase() : '';
        if (tag === 'fieldset' || tag === 'li') {
          node.style.setProperty('display', 'none', 'important');
          return;
        }
        if (!node.parentElement) break;
        if ((tag === 'div' || tag === 'section') && OPTION_GROUP_CLASS_RE.test(node.className)) {
          node.style.setProperty('display', 'none', 'important');
          return;
        }
        node = node.parentElement;
      }
      startEl.style.setProperty('display', 'none', 'important');
    } catch (e) { console.warn('[ProfitMax] hideOptionContainer error:', e); }
  }

  function hidePmPriceOptionGroups() {
    try {
      document.querySelectorAll('select[name*="_pm_price"]').forEach(hideOptionContainer);

      var seenParents = new Set();
      document.querySelectorAll('input[name*="_pm_price"]').forEach(function (el) {
        var parent = el.parentElement;
        if (parent && seenParents.has(parent)) return;
        if (parent) seenParents.add(parent);
        hideOptionContainer(el);
      });

      if (pmOptionIndex !== -1) {
        var productForm = document.querySelector('form[action*="/cart/add"]');
        if (productForm) {
          var sel = productForm.querySelector('select[name="options[' + pmOptionIndex + ']"]');
          if (sel) hideOptionContainer(sel);
          var dataEl = productForm.querySelector('[data-option-index="' + pmOptionIndex + '"]');
          if (dataEl) dataEl.style.setProperty('display', 'none', 'important');
        }
      }

      document.querySelectorAll('label, legend, span, p').forEach(function (el) {
        if (el.textContent.trim() === '_pm_price') hideOptionContainer(el);
      });
    } catch (e) { console.warn('[ProfitMax] hidePmPriceOptionGroups error:', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hidePmPriceOptionGroups);
  } else {
    hidePmPriceOptionGroups();
  }

  function suppressExperimentVariants(experimentVariantNumerics) {
    try {
      var sp = window.Shopify && window.Shopify.product;
      if (sp && Array.isArray(sp.variants)) {
        // Splice in-place rather than replacing the array. Themes (e.g. Dawn)
        // capture a reference to window.Shopify.product.variants at init time;
        // replacing the array leaves their internal copy unaffected, so their
        // variant picker can still find and select experiment variants. Mutating
        // the same array object updates every reference simultaneously.
        for (var vi = sp.variants.length - 1; vi >= 0; vi--) {
          if (experimentVariantNumerics.has(String(sp.variants[vi].id))) {
            sp.variants.splice(vi, 1);
          }
        }
      }
      document.querySelectorAll('select[name="id"]').forEach(function (sel) {
        sel.querySelectorAll('option').forEach(function (opt) {
          if (experimentVariantNumerics.has(opt.value)) opt.remove();
        });
      });

      hidePmPriceOptionGroups();
      try {
        var obs = new MutationObserver(function (mutations) {
          if (!mutations.some(function (m) { return m.addedNodes.length > 0; })) return;
          hidePmPriceOptionGroups();
          document.querySelectorAll('select[name="id"] option').forEach(function (opt) {
            if (experimentVariantNumerics.has(opt.value)) opt.remove();
          });
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(function () { obs.disconnect(); }, 15000);
      } catch (e) { console.warn('[ProfitMax] Variant suppression observer failed:', e); }
    } catch (e) { console.warn('[ProfitMax] suppressExperimentVariants error:', e); }
  }

  // ===========================================================================
  // SECTION 5 HELPERS — PRICE DISPLAY + VARIANT SWITCHING
  //
  // applyExperimentPrices() — determines which base variant is selected,
  // looks up the visitor's assigned experiment price for that variant, and
  // writes it to price elements scoped to the product section only (so
  // related-products carousels elsewhere on the page are not affected).
  //
  // watchPriceElements() — installs four listeners so prices stay correct
  // after the customer switches size/colour:
  //   a) MutationObserver on product-section price elements — detects theme writes
  //   b) Form 'change' event — hides prices before the theme can paint originals
  //   c) Custom variant-change events — some themes dispatch these
  //   d) Section-scoped MutationObserver — catches full section re-renders
  // ===========================================================================

  // Maps experiment variant numeric ID → base variant GID.
  // Populated after assignment is built. Used so that if a theme's picker
  // selects an experiment variant (because it cached the original variants array
  // before our splice), we can still resolve the correct base variant.
  var expToBaseGid = {};

  function getSelectedBaseVariantGid() {
    try {
      var idInput = document.querySelector('form[action*="/cart/add"] input[name="id"]');
      var rawId = (idInput && idInput.value) ||
        (document.querySelector('form[action*="/cart/add"] select[name="id"]') || {}).value;
      if (!rawId) return null;

      // If rawId is an experiment variant, resolve to its base variant GID.
      return expToBaseGid[rawId] || buildGid('ProductVariant', rawId);
    } catch (e) { /* ignore */ }
    return null;
  }

  function applyExperimentPrices(assignmentMap) {
    try {
      var selectedBase = getSelectedBaseVariantGid();
      var assignedPrice = null;

      if (selectedBase && assignmentMap[selectedBase]) {
        assignedPrice = assignmentMap[selectedBase].price;
      } else if (!selectedBase) {
        var firstBase = Object.keys(assignmentMap)[0];
        if (firstBase) assignedPrice = assignmentMap[firstBase].price;
      }
      // If selectedBase is known but has no experiment variant, leave alone.
      if (!assignedPrice) return;

      var formatted = formatMoney(assignedPrice);
      // Record what we're about to write so the MutationObserver can
      // distinguish our writes from the theme's.
      pm_lastAppliedPrice = formatted;

      // Only write to price elements in the product section.
      queryPriceEls().forEach(function (el) {
        if (el.textContent !== formatted) el.textContent = formatted;
      });
    } catch (e) {
      console.warn('[ProfitMax] applyExperimentPrices error:', e);
    }
  }

  function hidePriceEls() {
    queryPriceEls().forEach(function (el) { el.style.visibility = 'hidden'; });
  }

  function showPriceEls() {
    queryPriceEls().forEach(function (el) { el.style.visibility = ''; });
  }

  function watchPriceElements(assignmentMap) {
    try {
      var revealTimer = null;

      function scheduleReapply(delayMs) {
        clearTimeout(revealTimer);
        revealTimer = setTimeout(function () {
          applyExperimentPrices(assignmentMap);
          showPriceEls();
        }, delayMs);
      }

      // -----------------------------------------------------------------------
      // (a) MutationObserver on price elements within the product section.
      //
      // Re-entry guard: MutationObserver callbacks are microtasks delivered
      // AFTER the synchronous code that caused the mutation. A boolean flag
      // set and cleared in the same synchronous call is already false by the
      // time the callback runs. Instead we track the last price string we
      // wrote and skip callbacks where every mutated target already holds it.
      // -----------------------------------------------------------------------
      var priceObserver = new MutationObserver(function (mutations) {
        // Skip if every mutation target already shows our price (our own write).
        var allOurs = mutations.every(function (m) {
          return m.target.textContent === pm_lastAppliedPrice;
        });
        if (allOurs) return;

        hidePriceEls();
        scheduleReapply(50);
      });

      queryPriceEls().forEach(function (el) {
        priceObserver.observe(el, { childList: true, subtree: true, characterData: true });
      });

      // -----------------------------------------------------------------------
      // (b) Product form 'change' event — fires BEFORE the theme JS runs.
      //
      // Hides prices at the moment the customer clicks a different variant,
      // before the theme has a chance to paint the original price.
      // -----------------------------------------------------------------------
      var productForm = document.querySelector('form[action*="/cart/add"]');
      if (productForm) {
        productForm.addEventListener('change', function () {
          hidePriceEls();
          scheduleReapply(200);
        });
      }

      // -----------------------------------------------------------------------
      // (c) Custom variant-change events (some themes / pickers use these
      // instead of or in addition to the form 'change' event).
      // -----------------------------------------------------------------------
      ['variant:change', 'variantChange', 'on:variant:change'].forEach(function (evtName) {
        document.addEventListener(evtName, function () {
          hidePriceEls();
          scheduleReapply(200);
        });
      });

      // -----------------------------------------------------------------------
      // (d) Section-scoped observer for section re-renders.
      //
      // Some themes replace the product section HTML entirely on variant change
      // (e.g. Dawn's section rendering). The old observed elements are gone and
      // new ones appear with the original prices. We watch the product section
      // (NOT the whole body) so unrelated insertions (carousel lazy-loads etc.)
      // don't trigger re-applies.
      // -----------------------------------------------------------------------
      var sectionObserver = new MutationObserver(function (mutations) {
        var hasNewPriceEls = false;
        for (var mi = 0; mi < mutations.length; mi++) {
          var added = mutations[mi].addedNodes;
          for (var ai = 0; ai < added.length; ai++) {
            var node = added[ai];
            if (node.nodeType !== 1) continue;
            if ((node.matches && node.matches(PRICE_SELECTORS)) ||
                (node.querySelector && node.querySelector(PRICE_SELECTORS))) {
              hasNewPriceEls = true;
              break;
            }
          }
          if (hasNewPriceEls) break;
        }
        if (!hasNewPriceEls) return;

        // Re-attach observer to new price elements and re-apply.
        queryPriceEls().forEach(function (el) {
          priceObserver.observe(el, { childList: true, subtree: true, characterData: true });
        });
        hidePriceEls();
        scheduleReapply(50);
      });
      sectionObserver.observe(getProductSection(), { childList: true, subtree: true });

    } catch (e) {
      console.warn('[ProfitMax] watchPriceElements error:', e);
    }
  }

  // ===========================================================================
  // ASYNC MAIN FLOW
  // ===========================================================================
  (async function () {
    try {

      // =======================================================================
      // SECTION 3 — LOAD EXPERIMENT CONFIG
      //
      // Path 1: window.__pmConfig — embedded by the Liquid head snippet,
      //   available synchronously with zero network latency.
      //
      // Path 2: fetch from /api/experiment-config — fallback when the head
      //   snippet is absent (e.g. merchant hasn't redeployed yet, or the
      //   metafield hasn't synced after a fresh install).
      // =======================================================================

      var assignments = null;
      var experimentDatetimeSubmitted = null;

      var pmConfig = window.__pmConfig;
      var pmPageId = window.__pmPageProductId; // numeric string set by Liquid
      var pmProductGid = pmPageId ? buildGid('Product', pmPageId) : productGid;

      if (pmConfig && typeof pmConfig === 'object') {
        var inlineCfg = pmConfig[pmProductGid] || pmConfig[productGid];
        if (inlineCfg && Array.isArray(inlineCfg.assignments) && inlineCfg.assignments.length > 0) {
          assignments = inlineCfg.assignments;
          experimentDatetimeSubmitted = inlineCfg.experimentDatetimeSubmitted;
        }
        // __pmConfig present but product not in it → no active experiment.
        if (!assignments) { revealPrices(); return; }
      } else {
        // Path 2: fetch from API.
        var configUrl =
          'https://' + shop + '/apps/profit-max/api/experiment-config' +
          '?productId=' + encodeURIComponent(productGid) +
          '&merchantId=' + encodeURIComponent(shop);

        var configRes;
        try { configRes = await fetch(configUrl); }
        catch (e) {
          console.warn('[ProfitMax] Config fetch network error:', e);
          revealPrices(); return;
        }

        if (!configRes.ok) {
          console.warn('[ProfitMax] Config fetch failed:', configRes.status);
          revealPrices(); return;
        }

        var config;
        try { config = await configRes.json(); }
        catch (e) {
          console.warn('[ProfitMax] Config JSON parse error:', e);
          revealPrices(); return;
        }

        if (config.active === false) { revealPrices(); return; }
        assignments = config.assignments;
        experimentDatetimeSubmitted = config.experimentDatetimeSubmitted;
      }

      if (!Array.isArray(assignments) || assignments.length === 0) {
        console.warn('[ProfitMax] Config has no assignments.');
        revealPrices(); return;
      }

      var experimentVariantNumerics = new Set(
        assignments.map(function (a) { return numericIdFromGid(a.experimentVariantId); })
      );
      suppressExperimentVariants(experimentVariantNumerics);

      // =======================================================================
      // SECTION 4 — VISITOR ASSIGNMENT
      //
      // Uses the shared buildOrLoadAssignment helper which checks sessionStorage
      // first. If the visitor came via a collection page where we already ran
      // assignment (Section C above), their prices are already cached and we
      // reuse them — ensuring catalogue → product page price consistency.
      // =======================================================================

      var assignKey = 'pm_assign' + productNumericId;
      var result = buildOrLoadAssignment(assignKey, assignments);
      var assignmentMap = result.map;
      var isNewAssignment = result.isNew;

      // Build the reverse map: experiment variant numeric ID → base variant GID.
      // This lets getSelectedBaseVariantGid() handle the case where a theme's
      // picker (holding a stale reference to the unfiltered variants array) has
      // put an experiment variant ID into input[name="id"].
      var baseGids = Object.keys(assignmentMap);
      for (var ri = 0; ri < baseGids.length; ri++) {
        var expNumId = numericIdFromGid(assignmentMap[baseGids[ri]].experimentVariantId);
        expToBaseGid[expNumId] = baseGids[ri];
      }

      // =======================================================================
      // SECTION 5 — PRICE DISPLAY
      // =======================================================================

      applyExperimentPrices(assignmentMap);
      revealPrices();
      watchPriceElements(assignmentMap);

      // =======================================================================
      // SECTION 6 — ADD-TO-CART INTERCEPTION
      // =======================================================================

      var variantSwapMap = {};
      var baseIds = Object.keys(assignmentMap);
      for (var q = 0; q < baseIds.length; q++) {
        var baseGid = baseIds[q];
        var expGid  = assignmentMap[baseGid].experimentVariantId;
        variantSwapMap[numericIdFromGid(baseGid)] = numericIdFromGid(expGid);
        variantSwapMap[baseGid] = expGid;
      }

      document.addEventListener('submit', function (event) {
        try {
          var form = event.target;
          if (!form || !form.action || !form.action.includes('/cart/add')) return;
          var idInput = form.querySelector('input[name="id"]');
          if (!idInput) return;
          var swapped = variantSwapMap[String(idInput.value)];
          if (swapped) idInput.value = swapped;
        } catch (e) { console.warn('[ProfitMax] form submit interceptor error:', e); }
      }, true);

      if (!window.__profitMax.fetchPatched) {
        window.__profitMax.fetchPatched = true;
        var originalFetch = window.fetch;

        window.fetch = async function (input, init) {
          try {
            var url = typeof input === 'string' ? input
              : (input instanceof Request ? input.url : String(input));

            if (url.includes('/cart/add')) {
              var body = init && init.body;
              if (body) {
                function swapParsed(parsed) {
                  var changed = false;
                  if (parsed.id) { var sw = variantSwapMap[String(parsed.id)]; if (sw) { parsed.id = sw; changed = true; } }
                  if (Array.isArray(parsed.items)) {
                    for (var i = 0; i < parsed.items.length; i++) {
                      if (parsed.items[i].id) { var isw = variantSwapMap[String(parsed.items[i].id)]; if (isw) { parsed.items[i].id = isw; changed = true; } }
                    }
                  }
                  return changed;
                }
                if (typeof body === 'string') {
                  try {
                    var parsed = JSON.parse(body);
                    if (swapParsed(parsed)) init = Object.assign({}, init, { body: JSON.stringify(parsed) });
                  } catch (e) {
                    var params = new URLSearchParams(body);
                    var vid = params.get('id');
                    if (vid && variantSwapMap[vid]) { params.set('id', variantSwapMap[vid]); init = Object.assign({}, init, { body: params.toString() }); }
                  }
                } else if (body instanceof URLSearchParams) {
                  var vid2 = body.get('id');
                  if (vid2 && variantSwapMap[vid2]) { var np = new URLSearchParams(body); np.set('id', variantSwapMap[vid2]); init = Object.assign({}, init, { body: np }); }
                } else if (body instanceof FormData) {
                  var rawId = body.get('id');
                  if (rawId && variantSwapMap[String(rawId)]) {
                    var nfd = new FormData();
                    body.forEach(function (v, k) { nfd.append(k, k === 'id' ? (variantSwapMap[String(v)] || v) : v); });
                    init = Object.assign({}, init, { body: nfd });
                  }
                }
              }
            }
          } catch (e) { console.warn('[ProfitMax] fetch interceptor error:', e); }
          return originalFetch.call(this, input, init);
        };
      }

      // =======================================================================
      // SECTION 7 — IMPRESSION TRACKING
      // =======================================================================

      if (isNewAssignment) {
        try {
          var firstBase = Object.keys(assignmentMap)[0];
          var firstA    = assignmentMap[firstBase];
          var referrerDomain = null;
          try { if (document.referrer) referrerDomain = new URL(document.referrer).hostname; } catch (e) { /* ignore */ }

          fetch('https://' + shop + '/apps/profit-max/api/impression', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              CookieId: cookieId,
              SessionId: sessionId,
              MerchantId: shop,
              ExperimentDatetimeSubmitted: experimentDatetimeSubmitted,
              ProductId: productGid,
              ExperimentVariantId: firstA.experimentVariantId,
              Price: firstA.price,
              Currency: (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || '',
              DeviceType: screen.width < 768 ? 'mobile' : 'desktop',
              TrafficSource: referrerDomain,
              ReferrerURL: document.referrer || null,
              UserAgent: navigator.userAgent,
            }),
          }).catch(function (e) { console.warn('[ProfitMax] Impression POST failed:', e); });
        } catch (e) { console.warn('[ProfitMax] Impression build error:', e); }
      }

    } catch (e) {
      console.warn('[ProfitMax] Unexpected error in main flow:', e);
      revealPrices();
    }
  })();

})();
