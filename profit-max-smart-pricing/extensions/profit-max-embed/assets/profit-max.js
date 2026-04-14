/**
 * profit-max.js — ProfitMax Smart Pricing storefront snippet
 *
 * Injected into the merchant's Shopify theme. Runs in the customer's browser.
 * Plain ES2020 JavaScript — no imports, no build step.
 *
 * Sections:
 *   1.   Initialisation        — persistent cookie ID + session ID
 *   2.   Product page detect   — bail early on non-product pages
 *   1.5. Variant UI suppression — hide _pm_price option group and experiment variants
 *          Phase A (synchronous): CSS injection + window.Shopify.product patching
 *          Phase B (post-config): flat variant select cleanup + MutationObserver
 *   3.   Fetch config          — load active experiment for this product
 *   4.   Visitor assignment    — weighted-random variant selection, cached in sessionStorage
 *   5.   Price display         — update visible price elements with the assigned price
 *   6.   Add-to-cart           — intercept form submissions and fetch calls to swap variant IDs
 *   7.   Impression tracking   — fire-and-forget POST on first assignment per session
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Guard — if the snippet is loaded more than once, do nothing the second time.
  // ---------------------------------------------------------------------------
  if (window.__profitMax && window.__profitMax.initialised) return;

  window.__profitMax = window.__profitMax || {};
  window.__profitMax.initialised = true;

  // ===========================================================================
  // SECTION 1 — INITIALISATION
  //
  // _pm_cid : persistent visitor ID stored as a first-party cookie (1-year TTL,
  //           reset on every page load so active visitors never expire).
  // _pm_sid : session ID stored in sessionStorage — resets each browser session.
  // ===========================================================================

  /** Generate a UUID v4 using Math.random (no crypto dependency). */
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /** Read a cookie value by name, or null if absent. */
  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** Write a cookie with the given name, value, and max-age in seconds. */
  function setCookie(name, value, maxAgeSeconds) {
    var expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
    document.cookie =
      name + '=' + encodeURIComponent(value) +
      '; expires=' + expires +
      '; path=/' +
      '; SameSite=Lax';
  }

  var ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

  // Read or generate the persistent visitor cookie.
  var cookieId = getCookie('_pm_cid');
  if (!cookieId) {
    cookieId = generateUUID();
  }
  // Always reset the expiry so active visitors keep their ID alive.
  setCookie('_pm_cid', cookieId, ONE_YEAR_SECONDS);

  // Read or generate the session ID (resets when the browser session ends).
  var sessionId = sessionStorage.getItem('_pm_sid');
  if (!sessionId) {
    sessionId = generateUUID();
    sessionStorage.setItem('_pm_sid', sessionId);
  }

  // Expose IDs on the namespace in case other scripts need them.
  window.__profitMax.cookieId = cookieId;
  window.__profitMax.sessionId = sessionId;

  // ===========================================================================
  // SECTION 2 — PRODUCT PAGE DETECTION
  //
  // Detected via window.Shopify.product or a <meta name="product-id"> tag.
  // Bail early on non-product pages — everything below is product-specific.
  // ===========================================================================

  /** Extract the trailing numeric ID from a Shopify GID string. */
  function numericIdFromGid(gid) {
    return String(gid).split('/').pop();
  }

  /** Build a Shopify GID from a resource type and numeric ID. */
  function buildGid(type, numericId) {
    return 'gid://shopify/' + type + '/' + numericId;
  }

  var productNumericId = null;

  if (window.Shopify && window.Shopify.product && window.Shopify.product.id) {
    // Method 1: window.Shopify.product (most themes, Shopify's standard object).
    productNumericId = String(window.Shopify.product.id);
  } else {
    // Method 2: <meta name="product-id"> tag (some themes inject this).
    var productMeta = document.querySelector('meta[name="product-id"]');
    if (productMeta) {
      productNumericId = productMeta.getAttribute('content');
    }
  }

  if (!productNumericId) {
    // Method 3: window.__st — Shopify's internal analytics object, present on
    // storefronts that don't expose window.Shopify.product. Contains rtyp
    // (resource type, e.g. "product") and rid (numeric resource ID).
    try {
      if (window.__st && window.__st.rtyp === 'product' && window.__st.rid) {
        productNumericId = String(window.__st.rid);
      }
    } catch (e) {
      console.warn('[ProfitMax] window.__st read failed:', e);
    }
  }

  if (!productNumericId) {
    // Not a product page — nothing for this snippet to do.
    return;
  }

  var shop = window.Shopify && window.Shopify.shop;
  if (!shop) {
    console.warn('[ProfitMax] window.Shopify.shop is unavailable — snippet cannot run.');
    return;
  }

  // The full GID used as the ProductId in all API calls.
  var productGid = buildGid('Product', productNumericId);

  // ===========================================================================
  // SECTION 1.5 — VARIANT UI SUPPRESSION
  //
  // Experiment variants are real Shopify product variants created with a hidden
  // "_pm_price" option. Without suppression, Shopify themes render this option
  // as a visible picker, letting customers choose their own price.
  //
  // This section runs in two phases:
  //
  //   Phase A (synchronous, before config fetch):
  //     - Inject CSS to immediately hide _pm_price elements before paint.
  //     - Patch window.Shopify.product to strip _pm_price from the options array
  //       so JS-driven theme pickers never see it.
  //
  //   Phase B (called from the async flow, after config is fetched):
  //     - Remove experiment variant <option> elements from flat variant selects.
  //     - Filter experiment variants out of window.Shopify.product.variants.
  //     - Start a MutationObserver to re-run cleanup for themes that rebuild
  //       their pickers asynchronously (e.g. after section re-renders).
  //
  // The multi-layer approach is required because themes vary widely: some use
  // <select name="options[N]">, some use <fieldset> with radio inputs, some use
  // custom elements, and some read window.Shopify.product rather than the DOM.
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Phase A — synchronous, runs before the async config fetch
  // ---------------------------------------------------------------------------

  /**
   * Inject a <style> tag that hides _pm_price elements immediately.
   *
   * The :has() selector (Chrome 105+, Safari 15.4+, Firefox 121+) lets us target
   * the option group *container* from CSS alone. For older browsers that don't
   * support :has(), the JS DOM-walking fallback in hidePmPriceOptionGroups()
   * handles it after the DOM is ready.
   */
  (function injectSuppressCSS() {
    try {
      var style = document.createElement('style');
      style.textContent =
        // Direct suppression of inputs, selects, labels, and attributes referencing _pm_price.
        '[name="_pm_price"],[name="options[_pm_price]"],[id*="_pm_price"],[for*="_pm_price"],' +
        '[data-option*="pm_price"]' +
        '{display:none!important}' +
        // Container suppression via :has() — only on structurally unambiguous option
        // group elements (fieldset, li). We deliberately avoid div:has() because the
        // product section itself is typically a div containing the form which contains
        // the _pm_price input — matching it would hide the entire product.
        'fieldset:has([name*="_pm_price"]),' +
        'li:has([name*="_pm_price"])' +
        '{display:none!important}';
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {
      console.warn('[ProfitMax] CSS injection failed:', e);
    }
  })();

  /**
   * Patch window.Shopify.product to remove the _pm_price option from the options
   * array and fix each variant's positional options array to match.
   *
   * Many themes (including Dawn) read this object when initialising their variant
   * picker JS. Patching it synchronously, before those scripts run, means the
   * picker is built without _pm_price ever being visible.
   *
   * Experiment variant filtering (requires knowing the variant IDs from config)
   * is deferred to Phase B.
   */
  var pmOptionIndex = -1;
  try {
    var shopifyProduct = window.Shopify && window.Shopify.product;
    if (shopifyProduct && Array.isArray(shopifyProduct.options)) {
      pmOptionIndex = shopifyProduct.options.indexOf('_pm_price');
      if (pmOptionIndex !== -1) {
        // Remove _pm_price from the named options list.
        shopifyProduct.options.splice(pmOptionIndex, 1);
        // Fix each variant's positional options array so indices stay consistent.
        (shopifyProduct.variants || []).forEach(function (v) {
          if (Array.isArray(v.options)) v.options.splice(pmOptionIndex, 1);
        });
      }
    }
  } catch (e) {
    console.warn('[ProfitMax] Shopify.product options patching failed:', e);
  }
  window.__profitMax.pmOptionIndex = pmOptionIndex;

  /**
   * Walk up the DOM from a _pm_price element to find and hide its option group
   * container. Stops at the first ancestor that is unambiguously an option group:
   *   - a <fieldset> or <li> (strong structural signals), or
   *   - a <div>/<section> whose siblings also contain option selectors, meaning
   *     this node is one option group among several.
   * Falls back to hiding the original element if no container is found.
   */
  // Matches class names that strongly indicate an option group wrapper.
  var OPTION_GROUP_CLASS_RE = /option|swatch|variant|selector|picker/i;

  function hideOptionContainer(startEl) {
    try {
      var node = startEl;
      for (var depth = 0; depth < 6; depth++) {
        var tag = node.tagName ? node.tagName.toLowerCase() : '';

        // <fieldset> and <li> are structurally unambiguous option group containers.
        if (tag === 'fieldset' || tag === 'li') {
          node.style.setProperty('display', 'none', 'important');
          return;
        }

        if (!node.parentElement) break;

        // A div/section whose class name signals it is an option group wrapper.
        // We check the *current* node's class before climbing to its parent, so
        // we never accidentally hide a high-level product or page section.
        if ((tag === 'div' || tag === 'section') &&
            OPTION_GROUP_CLASS_RE.test(node.className)) {
          node.style.setProperty('display', 'none', 'important');
          return;
        }

        node = node.parentElement;
      }

      // Fallback: hide only the element we started from, not any ancestor.
      // This is safe — it suppresses the input/select itself without touching
      // anything further up the tree.
      startEl.style.setProperty('display', 'none', 'important');
    } catch (e) {
      console.warn('[ProfitMax] hideOptionContainer error:', e);
    }
  }

  /**
   * Find all DOM representations of the _pm_price option and hide their
   * containing option group blocks. Uses multiple strategies to cover the range
   * of theme structures in the wild.
   */
  function hidePmPriceOptionGroups() {
    try {
      // Strategy 1 — <select name*="_pm_price"> (common in older themes).
      document.querySelectorAll('select[name*="_pm_price"]').forEach(hideOptionContainer);

      // Strategy 2 — radio/checkbox inputs named after _pm_price.
      // De-duplicate by parent element to avoid calling hideOptionContainer
      // multiple times for the same group (one per input vs. one per group).
      var seenParents = new Set();
      document.querySelectorAll('input[name*="_pm_price"]').forEach(function (el) {
        var parent = el.parentElement;
        if (parent && seenParents.has(parent)) return;
        if (parent) seenParents.add(parent);
        hideOptionContainer(el);
      });

      // Strategy 3 — positional naming (e.g. name="options[2]" where index 2
      // is _pm_price). Themes that use option index rather than option name.
      if (pmOptionIndex !== -1) {
        var productForm = document.querySelector('form[action*="/cart/add"]');
        if (productForm) {
          var indexedSelect = productForm.querySelector(
            'select[name="options[' + pmOptionIndex + ']"]'
          );
          if (indexedSelect) hideOptionContainer(indexedSelect);

          // Some themes use a data attribute for option index.
          var dataOptionEl = productForm.querySelector(
            '[data-option-index="' + pmOptionIndex + '"]'
          );
          if (dataOptionEl) {
            dataOptionEl.style.setProperty('display', 'none', 'important');
          }
        }
      }

      // Strategy 4 — labels or legends whose visible text is exactly "_pm_price".
      // Catches themes that render option names as visible headings.
      document.querySelectorAll('label, legend, span, p').forEach(function (el) {
        if (el.textContent.trim() === '_pm_price') hideOptionContainer(el);
      });
    } catch (e) {
      console.warn('[ProfitMax] hidePmPriceOptionGroups error:', e);
    }
  }

  // Run the DOM walk once the document body is available.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hidePmPriceOptionGroups);
  } else {
    hidePmPriceOptionGroups();
  }

  // ---------------------------------------------------------------------------
  // Phase B — called from the async flow once experiment variant IDs are known
  // ---------------------------------------------------------------------------

  /**
   * Remove experiment variants from the visible UI and from window.Shopify.product.
   *
   * @param {Set<string>} experimentVariantNumerics  Numeric variant IDs to suppress.
   */
  function suppressExperimentVariants(experimentVariantNumerics) {
    try {
      // Filter experiment variants out of window.Shopify.product.variants so that
      // any JS-driven picker that reads the object after config load stays clean.
      var sp = window.Shopify && window.Shopify.product;
      if (sp && Array.isArray(sp.variants)) {
        sp.variants = sp.variants.filter(function (v) {
          return !experimentVariantNumerics.has(String(v.id));
        });
      }

      // Remove experiment variant <option> elements from flat variant selects.
      // Older and some custom themes render a single <select name="id"> listing
      // every variant by numeric ID.
      document.querySelectorAll('select[name="id"]').forEach(function (sel) {
        sel.querySelectorAll('option').forEach(function (opt) {
          if (experimentVariantNumerics.has(opt.value)) opt.remove();
        });
      });

      // Re-run _pm_price group hiding — some themes build their option UI after
      // page load (e.g. via fetch or section re-render). The CSS :has() rule
      // handles static HTML; this catches dynamically inserted elements.
      hidePmPriceOptionGroups();

      // MutationObserver — watch for the theme injecting new variant picker
      // markup after our initial cleanup (e.g. after a Shopify section refresh,
      // product form swap, or lazy-loaded section). Disconnects after 15 seconds
      // since all legitimate theme initialisation completes well before that.
      try {
        var observer = new MutationObserver(function (mutations) {
          var hasNewNodes = mutations.some(function (m) { return m.addedNodes.length > 0; });
          if (!hasNewNodes) return;
          hidePmPriceOptionGroups();
          document.querySelectorAll('select[name="id"] option').forEach(function (opt) {
            if (experimentVariantNumerics.has(opt.value)) opt.remove();
          });
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(function () { observer.disconnect(); }, 15000);
      } catch (e) {
        console.warn('[ProfitMax] MutationObserver setup failed:', e);
      }
    } catch (e) {
      console.warn('[ProfitMax] suppressExperimentVariants error:', e);
    }
  }

  // ===========================================================================
  // Async main flow — wrapped in an immediately-invoked async function so we
  // can use await without requiring top-level await support.
  // ===========================================================================
  (async function () {
    try {

      // =======================================================================
      // SECTION 3 — FETCH EXPERIMENT CONFIG
      //
      // Config is fetched from the app's experiment-config endpoint, exposed via
      // Shopify's app proxy at: https://{shop}/apps/profit-max/api/experiment-config
      // =======================================================================

      var configUrl =
        'https://' + shop + '/apps/profit-max/api/experiment-config' +
        '?productId=' + encodeURIComponent(productGid) +
        '&merchantId=' + encodeURIComponent(shop);

      var configRes;
      try {
        configRes = await fetch(configUrl);
      } catch (e) {
        console.warn('[ProfitMax] Config fetch network error:', e);
        return;
      }

      if (!configRes.ok) {
        console.warn('[ProfitMax] Config fetch failed with status:', configRes.status);
        return;
      }

      var config;
      try {
        config = await configRes.json();
      } catch (e) {
        console.warn('[ProfitMax] Config response is not valid JSON:', e);
        return;
      }

      // { active: false } means no active experiment — nothing to do.
      if (config.active === false) return;

      var assignments = config.assignments;
      var experimentDatetimeSubmitted = config.experimentDatetimeSubmitted;

      if (!Array.isArray(assignments) || assignments.length === 0) {
        console.warn('[ProfitMax] Config returned no assignments.');
        return;
      }

      // Build the set of experiment variant numeric IDs now that we have config,
      // then complete Phase B of the variant UI suppression.
      var experimentVariantNumerics = new Set(
        assignments.map(function (a) { return numericIdFromGid(a.experimentVariantId); })
      );
      suppressExperimentVariants(experimentVariantNumerics);

      // =======================================================================
      // SECTION 4 — VISITOR ASSIGNMENT
      //
      // Check sessionStorage for an existing assignment for this product.
      // If absent, use the per-variant probabilities from config to randomly
      // assign the visitor to one experiment variant per base variant.
      // The assignment is persisted in sessionStorage so the same visitor sees
      // the same prices across page navigations within the session.
      //
      // Stored shape: { [baseVariantGid]: { experimentVariantId, price } }
      // (The price is stored alongside the ID so Section 5 can use it directly
      // without re-scanning the config on subsequent page loads.)
      // =======================================================================

      var assignKey = 'pm_assign' + productNumericId;
      var assignmentMap = null;
      var isNewAssignment = false;

      var stored = sessionStorage.getItem(assignKey);
      if (stored) {
        try {
          assignmentMap = JSON.parse(stored);
        } catch (e) {
          // Corrupt entry — re-assign below.
          assignmentMap = null;
        }
      }

      if (!assignmentMap) {
        isNewAssignment = true;
        assignmentMap = {};

        // Group all assignment rows by their base variant ID.
        var byBase = {};
        for (var i = 0; i < assignments.length; i++) {
          var a = assignments[i];
          if (!byBase[a.baseVariantId]) byBase[a.baseVariantId] = [];
          byBase[a.baseVariantId].push(a);
        }

        // For each base variant, do a weighted-random draw over the candidates.
        var baseVariantIds = Object.keys(byBase);
        for (var j = 0; j < baseVariantIds.length; j++) {
          var baseId = baseVariantIds[j];
          var candidates = byBase[baseId];

          var rand = Math.random();
          var cumulative = 0;
          // Default to the last candidate to handle floating-point rounding at 1.0.
          var chosen = candidates[candidates.length - 1];
          for (var k = 0; k < candidates.length; k++) {
            cumulative += Number(candidates[k].probability);
            if (rand < cumulative) {
              chosen = candidates[k];
              break;
            }
          }

          assignmentMap[baseId] = {
            experimentVariantId: chosen.experimentVariantId,
            price: chosen.price,
          };
        }

        sessionStorage.setItem(assignKey, JSON.stringify(assignmentMap));
      }

      // =======================================================================
      // SECTION 5 — PRICE DISPLAY
      //
      // For each base variant in the assignment, find the price element on the
      // page and update its text to the assigned experiment price. Best-effort —
      // logs a warning if nothing is found but never throws.
      // =======================================================================

      var priceSelectors = ['.price__regular', '.price', '[data-product-price]'];

      var baseIds = Object.keys(assignmentMap);
      for (var m = 0; m < baseIds.length; m++) {
        var assignedPrice = assignmentMap[baseIds[m]].price;
        if (!assignedPrice) continue;

        var found = false;
        for (var n = 0; n < priceSelectors.length; n++) {
          var els = document.querySelectorAll(priceSelectors[n]);
          if (els.length > 0) {
            found = true;
            for (var p = 0; p < els.length; p++) {
              els[p].textContent = assignedPrice;
            }
            break; // stop at the first selector that yields elements
          }
        }

        if (!found) {
          console.warn('[ProfitMax] No price element found for base variant:', baseIds[m]);
        }
      }

      // =======================================================================
      // SECTION 6 — ADD-TO-CART INTERCEPTION
      //
      // When a customer adds to cart, swap any base variant ID for the assigned
      // experiment variant ID before the request reaches Shopify.
      //
      // Two interception points:
      //   a) form[action*="/cart/add"] submit events (capture phase)
      //   b) window.fetch calls whose URL contains /cart/add
      // =======================================================================

      // Build a map of numeric variant ID → numeric experiment variant ID.
      // Also include GID → GID for bodies that use full GID strings.
      var variantSwapMap = {};
      for (var q = 0; q < baseIds.length; q++) {
        var baseGid = baseIds[q];
        var expGid = assignmentMap[baseGid].experimentVariantId;
        variantSwapMap[numericIdFromGid(baseGid)] = numericIdFromGid(expGid);
        variantSwapMap[baseGid] = expGid;
      }

      // --- 6a: form submission interception ---
      // Listen in the capture phase so we mutate the form before the native submit fires.
      document.addEventListener('submit', function (event) {
        try {
          var form = event.target;
          if (!form || typeof form.action !== 'string') return;
          if (!form.action.includes('/cart/add')) return;

          var idInput = form.querySelector('input[name="id"]');
          if (!idInput) return;

          var swapped = variantSwapMap[String(idInput.value)];
          if (swapped) {
            idInput.value = swapped;
          }
        } catch (e) {
          console.warn('[ProfitMax] Error in form submit interceptor:', e);
        }
      }, true /* capture */);

      // --- 6b: fetch interception ---
      // Patch window.fetch once per page (guarded by __profitMax.fetchPatched).
      if (!window.__profitMax.fetchPatched) {
        window.__profitMax.fetchPatched = true;

        var originalFetch = window.fetch;

        window.fetch = async function (input, init) {
          try {
            var url = typeof input === 'string'
              ? input
              : (input instanceof Request ? input.url : String(input));

            if (url.includes('/cart/add')) {
              var body = init && init.body;

              if (body) {
                // Swap base variant IDs in a parsed JSON body object.
                // Returns true if any ID was changed.
                function swapParsedBody(parsed) {
                  var changed = false;
                  if (parsed.id) {
                    var swapped = variantSwapMap[String(parsed.id)];
                    if (swapped) { parsed.id = swapped; changed = true; }
                  }
                  // Handle the items array used by the multi-item cart API.
                  if (Array.isArray(parsed.items)) {
                    for (var i = 0; i < parsed.items.length; i++) {
                      if (parsed.items[i].id) {
                        var itemSwapped = variantSwapMap[String(parsed.items[i].id)];
                        if (itemSwapped) { parsed.items[i].id = itemSwapped; changed = true; }
                      }
                    }
                  }
                  return changed;
                }

                if (typeof body === 'string') {
                  // Try JSON first, fall back to URL-encoded form data.
                  try {
                    var parsed = JSON.parse(body);
                    if (swapParsedBody(parsed)) {
                      init = Object.assign({}, init, { body: JSON.stringify(parsed) });
                    }
                  } catch (e) {
                    var params = new URLSearchParams(body);
                    var variantId = params.get('id');
                    if (variantId && variantSwapMap[variantId]) {
                      params.set('id', variantSwapMap[variantId]);
                      init = Object.assign({}, init, { body: params.toString() });
                    }
                  }

                } else if (body instanceof URLSearchParams) {
                  var variantId = body.get('id');
                  if (variantId && variantSwapMap[variantId]) {
                    var newParams = new URLSearchParams(body);
                    newParams.set('id', variantSwapMap[variantId]);
                    init = Object.assign({}, init, { body: newParams });
                  }

                } else if (body instanceof FormData) {
                  var rawId = body.get('id');
                  if (rawId && variantSwapMap[String(rawId)]) {
                    var newFormData = new FormData();
                    body.forEach(function (value, key) {
                      newFormData.append(
                        key,
                        key === 'id' ? (variantSwapMap[String(value)] || value) : value
                      );
                    });
                    init = Object.assign({}, init, { body: newFormData });
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[ProfitMax] Error in fetch interceptor:', e);
          }

          return originalFetch.call(this, input, init);
        };
      }

      // =======================================================================
      // SECTION 7 — IMPRESSION TRACKING
      //
      // On the first assignment for this product this session, POST an impression
      // event to the app. Fire-and-forget — errors are only logged, never thrown.
      //
      // Uses the first base variant's assignment as the representative variant
      // for this impression event.
      // =======================================================================

      if (isNewAssignment) {
        try {
          var firstBaseId = Object.keys(assignmentMap)[0];
          var firstAssignment = assignmentMap[firstBaseId];

          // Extract the referrer domain for TrafficSource (null if no referrer).
          var referrerDomain = null;
          try {
            if (document.referrer) {
              referrerDomain = new URL(document.referrer).hostname;
            }
          } catch (e) { /* ignore malformed referrer */ }

          var impressionBody = {
            CookieId: cookieId,
            SessionId: sessionId,
            MerchantId: shop,
            ExperimentDatetimeSubmitted: experimentDatetimeSubmitted,
            ProductId: productGid,
            ExperimentVariantId: firstAssignment.experimentVariantId,
            Price: firstAssignment.price,
            Currency: (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || '',
            DeviceType: screen.width < 768 ? 'mobile' : 'desktop',
            TrafficSource: referrerDomain,
            ReferrerURL: document.referrer || null,
            UserAgent: navigator.userAgent,
          };

          fetch('https://' + shop + '/apps/profit-max/api/impression', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(impressionBody),
          }).catch(function (e) {
            console.warn('[ProfitMax] Impression POST failed:', e);
          });

        } catch (e) {
          console.warn('[ProfitMax] Error building impression payload:', e);
        }
      }

    } catch (e) {
      // Top-level catch — the snippet must never surface uncaught errors that
      // could break the merchant's storefront.
      console.warn('[ProfitMax] Unexpected error in main flow:', e);
    }
  })();

})();
