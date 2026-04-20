/**
 * profit-max.js — ProfitMax Smart Pricing storefront snippet
 *
 * Sections:
 *   1.   Initialisation        — persistent cookie ID + session ID
 *   2.   Page type detection   — product page vs collection/list page vs exit
 *   1.5. Variant UI suppression — hide _pm_price option group and experiment variants
 *   3.   Fetch config          — load active experiment for this product
 *   4.   Visitor assignment    — weighted-random variant selection, cached in localStorage
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

  // Debug mode: add ?pm_debug=1 to any storefront URL to enable console logging.
  var DEBUG = location.search.indexOf('pm_debug=1') !== -1;
  function dbg() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[ProfitMax]');
    console.log.apply(console, args);
  }

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
        (window.Shopify && window.Shopify.moneyFormat) ||
        (window.theme && window.theme.moneyFormat) ||
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

      // Priority 2: Intl.NumberFormat — always use 'en-US' locale so the shop's
      // currency formats with a bare symbol (e.g. "$" not "US$"). The visitor's
      // locale is irrelevant here; we want the symbol to match the theme's output.
      var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || '';
      if (currency) {
        try {
          return new Intl.NumberFormat('en-US', {
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

  // Cancel the Liquid safety-timeout so prices stay hidden until we explicitly
  // reveal them after writing experiment prices.
  if (window.__pmSafetyTimer) {
    clearTimeout(window.__pmSafetyTimer);
    window.__pmSafetyTimer = null;
    dbg('cancelled safety timer');
  }

  /** Reveal prices by adding the pm-prices-ready class.
   *  The embed block's CSS hides prices by default (opacity:0) and
   *  transitions them to opacity:1 when html.pm-prices-ready is set. */
  function revealPrices() {
    document.documentElement.classList.add('pm-prices-ready');
  }

  /**
   * Resolve __pmConfig into a plain object.  Handles three cases:
   *   1. Already an object (Liquid | json on a parsed Hash) — return as-is.
   *   2. A JSON string (Liquid double-encoded, or | json on the raw value) — parse it.
   *   3. Absent / invalid / error — return null.
   */
  function resolveConfig() {
    var raw = window.__pmConfig;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
        window.__pmConfig = raw;
      } catch (e) { return null; }
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.error) return raw;
    return null;
  }

  var pmConfigResolved = resolveConfig();
  dbg('resolvedConfig:', pmConfigResolved ? Object.keys(pmConfigResolved).length + ' products' : 'null');

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
   * Build a fingerprint from assignments so we can detect when the experiment
   * has changed (new activation with different variants/prices). Uses sorted
   * experimentVariantId+price pairs — deterministic regardless of row order.
   */
  function assignmentFingerprint(assignments) {
    var parts = [];
    for (var i = 0; i < assignments.length; i++) {
      parts.push(assignments[i].experimentVariantId + ':' + assignments[i].price);
    }
    return parts.sort().join(',');
  }

  /**
   * Build an assignmentMap ({ baseVariantGid → { experimentVariantId, price } })
   * from a flat array of assignment rows, using weighted-random selection per
   * base variant. Caches the result in localStorage under `cacheKey`.
   *
   * If a valid cached map already exists under `cacheKey` with a matching
   * fingerprint, returns it directly without re-drawing so the same
   * visitor sees the same prices across tabs and page loads.
   *
   * @param {string} cacheKey
   * @param {Array<{baseVariantId, experimentVariantId, price, probability}>} assignments
   * @returns {{ map: Object, isNew: boolean }}
   */
  function buildOrLoadAssignment(cacheKey, assignments) {
    var fp = assignmentFingerprint(assignments);
    var stored = localStorage.getItem(cacheKey);
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object' && parsed._fp === fp && parsed.map) {
          dbg('cache hit for', cacheKey);
          return { map: parsed.map, isNew: false };
        }
        dbg('cache miss for', cacheKey, '— stored fp:', parsed && parsed._fp ? parsed._fp.substring(0, 60) + '...' : 'none', '| new fp:', fp.substring(0, 60) + '...');
      } catch (e) { /* corrupt — re-draw */ }
    } else {
      dbg('cache empty for', cacheKey);
    }

    var byBase = {};
    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i];
      if (!byBase[a.baseVariantId]) byBase[a.baseVariantId] = [];
      byBase[a.baseVariantId].push(a);
    }

    var map = {};
    var bases = Object.keys(byBase);

    // Check if all base variants share the same set of price points.
    // If so, do ONE draw and assign the same price to every base variant.
    var allSamePrices = bases.length > 1;
    if (allSamePrices) {
      var refPrices = byBase[bases[0]].map(function (a) { return a.price; }).sort().join(',');
      for (var c = 1; c < bases.length; c++) {
        var cmpPrices = byBase[bases[c]].map(function (a) { return a.price; }).sort().join(',');
        if (cmpPrices !== refPrices) { allSamePrices = false; break; }
      }
    }

    if (allSamePrices && bases.length > 1) {
      // Single draw — pick a price, then find each base variant's experiment variant at that price.
      var chosen = weightedDraw(byBase[bases[0]]);
      var chosenPrice = chosen.price;
      dbg('single-draw assignment: all variants share prices, chose', chosenPrice);
      for (var j = 0; j < bases.length; j++) {
        var match = null;
        for (var m = 0; m < byBase[bases[j]].length; m++) {
          if (byBase[bases[j]][m].price === chosenPrice) { match = byBase[bases[j]][m]; break; }
        }
        map[bases[j]] = match
          ? { experimentVariantId: match.experimentVariantId, price: match.price }
          : { experimentVariantId: chosen.experimentVariantId, price: chosenPrice };
      }
    } else {
      // Independent draws — base variants have different price points.
      for (var j = 0; j < bases.length; j++) {
        var chosen = weightedDraw(byBase[bases[j]]);
        map[bases[j]] = { experimentVariantId: chosen.experimentVariantId, price: chosen.price };
      }
    }

    try { localStorage.setItem(cacheKey, JSON.stringify({ _fp: fp, map: map })); } catch (e) { /* quota */ }
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

  dbg('page type:', isProductPage ? 'product id=' + productNumericId : isListPage ? 'list' : 'other');
  dbg('shop:', shop);
  dbg('money_format:', window.Shopify && window.Shopify.money_format);
  dbg('__pmConfig keys:', pmConfigResolved ? Object.keys(pmConfigResolved) : 'absent');

  if (!isProductPage && !isListPage) { revealPrices(); return; }
  if (!shop) {
    console.warn('[ProfitMax] window.Shopify.shop unavailable — exiting.');
    revealPrices(); return;
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
  // In both paths, assignments are cached in localStorage under
  // 'pm_assign<numericId>' — the same key used on product pages — so prices
  // are consistent when the visitor navigates through to a product page.
  // ===========================================================================

  var CARD_PRICE_SELECTORS =
    '.price__regular, .price, [data-product-price], .price-item, .product__price';

  /**
   * Apply experiment prices to all product cards on the page using a configMap of
   *   gid → { experimentDatetimeSubmitted, assignments: [{ baseVariantId, experimentVariantId, price, probability }] }
   *
   * Used on collection pages and for recommendation sections on product pages.
   */
  function applyCardPrices(configMap) {
    var allCardEls = document.querySelectorAll('[data-product-id]');
    dbg('applyCardPrices: configMap keys=', Object.keys(configMap), 'elements with data-product-id=', allCardEls.length);

    var seenNumIds = {};
    allCardEls.forEach(function (card) {
      var numId = card.getAttribute('data-product-id');
      if (!numId) return;
      if (seenNumIds[numId]) return;

      var gid = buildGid('Product', numId);
      var productCfg = configMap[gid];
      var assignments = productCfg && productCfg.assignments;
      if (!Array.isArray(assignments) || assignments.length === 0) {
        seenNumIds[numId] = true;
        dbg('no experiment for card product', gid);
        return;
      }

      var result = buildOrLoadAssignment('pm_assign' + numId, assignments);
      var firstBase = Object.keys(result.map)[0];
      if (!firstBase) { seenNumIds[numId] = true; return; }
      var formatted = formatMoney(result.map[firstBase].price);

      var priceEls = card.querySelectorAll(CARD_PRICE_SELECTORS);
      if (priceEls.length > 0) {
        dbg('card', numId, '→ price=', formatted, 'price els found=', priceEls.length);
        priceEls.forEach(function (el) { el.textContent = formatted; });
        seenNumIds[numId] = true;
      }
    });
  }

  if (isListPage) {
    (async function () {
      try {

        // ------------------------------------------------------------------
        // Path 1: use window.__pmConfig + window.__pmPageProductIds
        //
        // Applies prices for products already in the inline config, and queues
        // any products missing from the config for an API fetch (Path 2).
        // This handles newly-activated experiments that haven't been synced
        // into the head snippet yet.
        // ------------------------------------------------------------------
        var pmConfig = pmConfigResolved;
        var pmPageIds = window.__pmPageProductIds; // array of GIDs from Liquid
        var productGidSet = new Set();

        if (pmConfig && Array.isArray(pmPageIds) && pmPageIds.length > 0) {
          dbg('collection path 1: __pmConfig has', Object.keys(pmConfig).length, 'products, page has', pmPageIds.length, 'ids');
          var inlinePriceMap = {};
          for (var pi = 0; pi < pmPageIds.length; pi++) {
            var pgid = pmPageIds[pi];
            var productCfg = pmConfig[pgid];
            if (productCfg && Array.isArray(productCfg.assignments)) {
              inlinePriceMap[pgid] = productCfg;
            } else {
              // Product is on the page but not in __pmConfig — may be a newly-
              // activated experiment. Queue it for the API fetch below.
              productGidSet.add(pgid);
            }
          }
          dbg('inlinePriceMap keys:', Object.keys(inlinePriceMap), '| queued for fetch:', productGidSet.size);
          applyCardPrices(inlinePriceMap);
          if (productGidSet.size === 0) return; // all products covered — no fetch needed
          dbg('collection: falling through to fetch', productGidSet.size, 'product(s) missing from __pmConfig');
        } else {
          // ------------------------------------------------------------------
          // Path 2: __pmConfig absent — collect all product IDs from the DOM
          // ------------------------------------------------------------------
          dbg('collection path 2: __pmConfig absent or no page ids, using API fetch');

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
        }

        if (productGidSet.size === 0) {
          dbg('collection fetch: no products queued — nothing to fetch');
          return;
        }

        var productIds = Array.from(productGidSet);

        // Fetch experiment config from API — no session cache here.
        // Caching experiment *existence* causes stale results when a new
        // experiment is activated mid-session (the cache would still say
        // "no experiment" for the new product). The per-product assignment
        // is cached separately by buildOrLoadAssignment under pm_assign<id>.
        var url =
          'https://' + shop + '/apps/profit-max/api/collection-prices' +
          '?merchantId=' + encodeURIComponent(shop) +
          '&productIds=' + encodeURIComponent(productIds.join(','));

        dbg('collection fetch URL:', url);
        var res;
        try { res = await fetch(url); } catch (e) {
          console.warn('[ProfitMax] Collection prices fetch failed:', e);
          return;
        }
        if (!res.ok) {
          console.warn('[ProfitMax] Collection prices fetch status:', res.status);
          return;
        }

        var body;
        try { body = await res.json(); } catch (e) { return; }
        var priceMap = body.prices || {};
        dbg('collection fetch returned', Object.keys(priceMap).length, 'products with experiments');

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
  // Price element scoping
  //
  // We want to update the main product price without touching price elements
  // inside "Related products" / "Recently viewed" carousels lower on the page.
  //
  // Strategy: find all matching price elements on the page, then exclude any
  // that live inside a container whose class/id signals it is a carousel or
  // recommendations section. This is more reliable than trying to identify the
  // "main product section" container, which varies wildly between themes.
  //
  // We also prefer elements that are closer to (or inside) the cart form,
  // falling back to the full filtered set when no form-adjacent elements exist.
  // ---------------------------------------------------------------------------

  // Class/id patterns that identify related-product containers to exclude.
  var CAROUSEL_RE = /related|recommend|compl[ei]ment|recently[_-]?view|cross[_-]?sell|upsell|bundle|also|similar/i;

  function isInsideCarousel(el) {
    var node = el.parentElement;
    for (var d = 0; d < 10 && node && node !== document.body; d++) {
      if (CAROUSEL_RE.test(node.className || '') || CAROUSEL_RE.test(node.id || '')) return true;
      node = node.parentElement;
    }
    return false;
  }

  /** Return all product-price elements that are NOT inside a carousel/recommendations block.
   *  Results are cached; pass forceRefresh=true after section re-renders to re-scan the DOM. */
  var _cachedPriceEls = null;
  function queryPriceEls(forceRefresh) {
    if (_cachedPriceEls && !forceRefresh) return _cachedPriceEls;
    var all = Array.prototype.slice.call(document.querySelectorAll(PRICE_SELECTORS));
    var filtered = all.filter(function (el) { return !isInsideCarousel(el); });
    // Prefer elements inside or near the cart form if any exist there.
    var form = document.querySelector('form[action*="/cart/add"]');
    if (form) {
      var formParent = form.parentElement || form;
      var nearForm = filtered.filter(function (el) { return formParent.contains(el) || el.contains(form); });
      if (nearForm.length > 0) {
        dbg('queryPriceEls: near-form set, count=' + nearForm.length, nearForm);
        _cachedPriceEls = nearForm;
        return nearForm;
      }
    }
    var result = filtered.length > 0 ? filtered : all;
    dbg('queryPriceEls: count=' + result.length + (filtered.length === 0 ? ' (unfiltered fallback)' : ''), result);
    _cachedPriceEls = result;
    return result;
  }

  // Last formatted price string we applied. Used by the MutationObserver to
  // distinguish our own DOM writes from the theme's — see watchPriceElements().
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
        // Scope the observer to the product form's section rather than the
        // entire document.body, so unrelated DOM insertions (chat widgets,
        // lazy-loaded images, analytics) don't trigger unnecessary re-scans.
        var suppressRoot = document.querySelector('form[action*="/cart/add"]');
        if (suppressRoot) {
          // Walk up to a reasonable ancestor (section or product container).
          var node = suppressRoot.parentElement;
          for (var sd = 0; sd < 6 && node && node !== document.body; sd++) {
            var stag = (node.tagName || '').toLowerCase();
            if (stag === 'section' || /product/i.test(node.id || '') || /product/i.test(node.className || '')) {
              suppressRoot = node;
              break;
            }
            node = node.parentElement;
          }
        } else {
          suppressRoot = document.body;
        }
        var obs = new MutationObserver(function (mutations) {
          if (!mutations.some(function (m) { return m.addedNodes.length > 0; })) return;
          hidePmPriceOptionGroups();
          document.querySelectorAll('select[name="id"] option').forEach(function (opt) {
            if (experimentVariantNumerics.has(opt.value)) opt.remove();
          });
        });
        obs.observe(suppressRoot, { childList: true, subtree: true });
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

      dbg('applyExperimentPrices: selectedBase=', selectedBase, 'mapKeys=', Object.keys(assignmentMap));

      if (selectedBase && assignmentMap[selectedBase]) {
        assignedPrice = assignmentMap[selectedBase].price;
        dbg('matched selectedBase, price=', assignedPrice);
      } else if (!selectedBase) {
        var firstBase = Object.keys(assignmentMap)[0];
        if (firstBase) assignedPrice = assignmentMap[firstBase].price;
        dbg('no selectedBase, using first, price=', assignedPrice);
      } else {
        dbg('selectedBase not in assignmentMap — leaving price unchanged');
      }

      if (!assignedPrice) return;

      var formatted = formatMoney(assignedPrice);
      pm_lastAppliedPrice = formatted;
      dbg('writing price "' + formatted + '" to', queryPriceEls().length, 'elements');

      queryPriceEls().forEach(function (el) {
        if (el.textContent !== formatted) el.textContent = formatted;
      });
    } catch (e) {
      console.warn('[ProfitMax] applyExperimentPrices error:', e);
    }
  }

  function hidePriceEls() {
    document.documentElement.classList.remove('pm-prices-ready');
  }

  function showPriceEls() {
    document.documentElement.classList.add('pm-prices-ready');
  }

  function watchPriceElements(assignmentMap) {
    try {
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

        // Theme just overwrote a price — hide, rewrite, reveal synchronously.
        // No delay: the observer fires after the theme's DOM write but before
        // the browser paints, so this prevents the base price from ever appearing.
        hidePriceEls();
        applyExperimentPrices(assignmentMap);
        showPriceEls();
      });

      queryPriceEls().forEach(function (el) {
        priceObserver.observe(el, { childList: true, subtree: true, characterData: true });
      });

      // -----------------------------------------------------------------------
      // (b) Product form 'change' event — fires BEFORE the theme JS runs.
      //
      // Hide prices immediately (synchronously) so the base price is never
      // visible, then reapply experiment price in the next animation frame.
      // The MutationObserver (a) provides a safety net if the theme updates
      // prices asynchronously.
      // -----------------------------------------------------------------------
      var productForm = document.querySelector('form[action*="/cart/add"]');
      if (productForm) {
        productForm.addEventListener('change', function () {
          hidePriceEls();
          requestAnimationFrame(function () {
            applyExperimentPrices(assignmentMap);
            showPriceEls();
          });
        });
      }

      // -----------------------------------------------------------------------
      // (c) Custom variant-change events (some themes / pickers use these
      // instead of or in addition to the form 'change' event).
      // -----------------------------------------------------------------------
      ['variant:change', 'variantChange', 'on:variant:change'].forEach(function (evtName) {
        document.addEventListener(evtName, function () {
          hidePriceEls();
          requestAnimationFrame(function () {
            applyExperimentPrices(assignmentMap);
            showPriceEls();
          });
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

        // Invalidate cached price elements, re-attach observer, reapply synchronously.
        hidePriceEls();
        queryPriceEls(true).forEach(function (el) {
          priceObserver.observe(el, { childList: true, subtree: true, characterData: true });
        });
        applyExperimentPrices(assignmentMap);
        showPriceEls();
      });

      // Find the best ancestor to watch for section re-renders: walk up from
      // the cart form looking for a <section> or element with "product" in
      // its id/class. Fall back to document.body.
      var sectionRoot = (function () {
        var form = document.querySelector('form[action*="/cart/add"]');
        if (form) {
          var node = form.parentElement;
          for (var d = 0; d < 8 && node && node !== document.body; d++) {
            var tag = (node.tagName || '').toLowerCase();
            if (tag === 'section') return node;
            if (/product/i.test(node.id || '') || /product/i.test(node.className || '')) return node;
            node = node.parentElement;
          }
          return form.parentElement || document.body;
        }
        return document.body;
      })();
      dbg('sectionObserver root:', sectionRoot.tagName, sectionRoot.id || sectionRoot.className || '');
      sectionObserver.observe(sectionRoot, { childList: true, subtree: true });

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
      // Path 1 (fast): window.__pmConfig — embedded by the Liquid head snippet,
      //   zero network latency. Used only when the product IS present; absence
      //   is NOT treated as "no experiment" because the metafield may be stale
      //   (e.g. an experiment that predates the first sync).
      //
      // Path 2 (fallback): fetch /api/experiment-config — used whenever the
      //   product was not found via the inline config.
      // =======================================================================

      var assignments = null;
      var experimentDatetimeSubmitted = null;

      // Try fast path.
      try {
        var pmConfig = pmConfigResolved;
        if (pmConfig) {
          var pmPageId = window.__pmPageProductId; // numeric ID from Liquid
          var pmGid = pmPageId ? buildGid('Product', pmPageId) : productGid;
          dbg('checking __pmConfig for', pmGid, '(also trying', productGid, ')');
          var inlineCfg = pmConfig[pmGid] || pmConfig[productGid];
          if (inlineCfg && Array.isArray(inlineCfg.assignments) && inlineCfg.assignments.length > 0) {
            assignments = inlineCfg.assignments;
            experimentDatetimeSubmitted = inlineCfg.experimentDatetimeSubmitted;
            dbg('config from __pmConfig, assignments:', assignments.length);
          } else {
            dbg('product not in __pmConfig, falling back to API fetch');
          }
        } else {
          dbg('__pmConfig absent, using API fetch');
        }
      } catch (e) { /* ignore — fall through to API fetch */ }

      // Fall back to API when product not found in inline config.
      if (!assignments) {
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

        if (config.active === false) {
          dbg('API says no active experiment for this product');
          revealPrices(); return;
        }
        assignments = config.assignments;
        experimentDatetimeSubmitted = config.experimentDatetimeSubmitted;
        dbg('config from API fetch, assignments:', assignments.length);
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
      // Uses the shared buildOrLoadAssignment helper which checks localStorage
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

      // =======================================================================
      // SECTION 8 — RECOMMENDATION SECTION PRICING
      //
      // Product pages often have "You may also like" / "Related products"
      // sections containing product cards. Apply experiment prices to those
      // cards using the same logic as collection pages.
      // =======================================================================

      try {
        var recoCards = document.querySelectorAll('[data-product-id]');
        var recoProductIds = new Set();
        recoCards.forEach(function (el) {
          var id = el.getAttribute('data-product-id');
          // Exclude the main product — it's already handled above.
          if (id && id !== productNumericId) recoProductIds.add(buildGid('Product', id));
        });

        if (recoProductIds.size > 0) {
          dbg('recommendation section: found', recoProductIds.size, 'other product(s)');

          // Try inline config first.
          var recoConfigMap = {};
          var recoMissing = [];
          var pmCfg = pmConfigResolved;
          if (pmCfg) {
            recoProductIds.forEach(function (gid) {
              if (pmCfg[gid] && Array.isArray(pmCfg[gid].assignments)) {
                recoConfigMap[gid] = pmCfg[gid];
              } else {
                recoMissing.push(gid);
              }
            });
          } else {
            recoMissing = Array.from(recoProductIds);
          }

          // Apply prices for products found in inline config.
          if (Object.keys(recoConfigMap).length > 0) {
            applyCardPrices(recoConfigMap);
          }

          // Fetch any missing from API.
          if (recoMissing.length > 0) {
            try {
              var recoUrl =
                'https://' + shop + '/apps/profit-max/api/collection-prices' +
                '?merchantId=' + encodeURIComponent(shop) +
                '&productIds=' + encodeURIComponent(recoMissing.join(','));
              dbg('recommendation fetch URL:', recoUrl);
              var recoRes = await fetch(recoUrl);
              if (recoRes.ok) {
                var recoBody = await recoRes.json();
                var recoPrices = recoBody.prices || {};
                if (Object.keys(recoPrices).length > 0) {
                  applyCardPrices(recoPrices);
                }
              }
            } catch (e) { dbg('recommendation fetch error:', e); }
          }
        }
      } catch (e) { dbg('recommendation section error:', e); }

      // Watch for lazy-loaded recommendation sections (Dawn fetches these async).
      // When new product cards appear, collect their IDs, check inline config,
      // and fetch from API for any missing — same logic as the initial scan above.
      try {
        var recoTimer = null;
        var recoObserver = new MutationObserver(function (mutations) {
          var hasCards = false;
          for (var mi = 0; mi < mutations.length; mi++) {
            var added = mutations[mi].addedNodes;
            for (var ai = 0; ai < added.length; ai++) {
              var node = added[ai];
              if (node.nodeType !== 1) continue;
              if ((node.getAttribute && node.getAttribute('data-product-id')) ||
                  (node.querySelector && node.querySelector('[data-product-id]'))) {
                hasCards = true;
                break;
              }
            }
            if (hasCards) break;
          }
          if (!hasCards) return;

          clearTimeout(recoTimer);
          recoTimer = setTimeout(async function () {
            dbg('lazy-loaded product cards detected, applying recommendation prices');

            var lazyIds = new Set();
            document.querySelectorAll('[data-product-id]').forEach(function (el) {
              var id = el.getAttribute('data-product-id');
              if (id && id !== productNumericId) lazyIds.add(buildGid('Product', id));
            });
            if (lazyIds.size === 0) return;

            var lazyCfgMap = {};
            var lazyMissing = [];
            var lazyCfg = pmConfigResolved;
            if (lazyCfg) {
              lazyIds.forEach(function (gid) {
                if (lazyCfg[gid] && Array.isArray(lazyCfg[gid].assignments)) {
                  lazyCfgMap[gid] = lazyCfg[gid];
                } else {
                  lazyMissing.push(gid);
                }
              });
            } else {
              lazyMissing = Array.from(lazyIds);
            }

            if (Object.keys(lazyCfgMap).length > 0) applyCardPrices(lazyCfgMap);

            if (lazyMissing.length > 0) {
              try {
                var lazyUrl =
                  'https://' + shop + '/apps/profit-max/api/collection-prices' +
                  '?merchantId=' + encodeURIComponent(shop) +
                  '&productIds=' + encodeURIComponent(lazyMissing.join(','));
                dbg('lazy recommendation fetch URL:', lazyUrl);
                var lazyRes = await fetch(lazyUrl);
                if (lazyRes.ok) {
                  var lazyBody = await lazyRes.json();
                  var lazyPrices = lazyBody.prices || {};
                  if (Object.keys(lazyPrices).length > 0) applyCardPrices(lazyPrices);
                }
              } catch (e) { dbg('lazy recommendation fetch error:', e); }
            }
          }, 100);
        });
        recoObserver.observe(document.body, { childList: true, subtree: true });
        // Stop watching after 30s — recommendations should have loaded by then.
        setTimeout(function () { recoObserver.disconnect(); }, 30000);
      } catch (e) { dbg('recommendation observer error:', e); }

    } catch (e) {
      console.warn('[ProfitMax] Unexpected error in main flow:', e);
      revealPrices();
    }
  })();

})();
