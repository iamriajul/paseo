import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";

export const ERUDA_CDN_URL = "https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js";

// Loaded from a CDN rather than bundled: keeping ~1.4 MB out of the server
// package is worth devtools being unavailable on a fully offline client.
export const ERUDA_SCRIPT = `
(function() {
  'use strict';
  var BRIDGE = ${JSON.stringify(BRIDGE_SOURCE)};
  var COMMAND = ${JSON.stringify(COMMAND_SOURCE)};
  var loading = false;
  var ready = false;

  function send(type, payload) {
    try { window.parent.postMessage({ source: BRIDGE, type: type, payload: payload }, '*'); }
    catch (error) { /* parent gone */ }
  }

  function initEruda() {
    if (ready || typeof window.eruda === 'undefined') return;
    window.eruda.init({ defaults: { theme: 'Dark' } });
    window.eruda.hide();
    // The Paseo toolbar owns the toggle; eruda's floating button would be a
    // second control for the same thing, overlapping the previewed page.
    try { window.eruda._entryBtn._$el[0].style.display = 'none'; } catch (error) {}
    ready = true;
    send('eruda-ready', {});
  }

  function load(onReady) {
    if (ready) { onReady(); return; }
    if (loading) return;
    loading = true;
    var tag = document.createElement('script');
    tag.src = ${JSON.stringify(ERUDA_CDN_URL)};
    // Three ways this fetch ends without devtools: the request fails, the
    // response defines no window.eruda, and init() throws on whatever it did
    // define. All three have to clear the loading flag and say so — a load that
    // ends silently with it still set wedges the toggle for the life of the
    // document, and the button reads dead with no error anywhere.
    tag.onload = function() {
      try { initEruda(); } catch (error) { /* handled by the !ready check */ }
      if (!ready) { loading = false; send('eruda-failed', {}); return; }
      onReady();
    };
    tag.onerror = function() { loading = false; send('eruda-failed', {}); };
    (document.head || document.documentElement).appendChild(tag);
  }

  window.addEventListener('message', function(event) {
    // Sender check first. A previewed page may embed third-party frames (ads,
    // checkout widgets, video), and a descendant frame can reach window.parent
    // — so a source-string-only check hands any embedded frame the ability to
    // drive this bridge, a capability the web platform otherwise denies it.
    // Task 6 posts app-window -> iframe.contentWindow, so event.source here is
    // exactly window.parent.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== COMMAND || data.command !== 'toggle-eruda') return;
    load(function() {
      if (!window.eruda) return;
      if (window.eruda._isShow) window.eruda.hide();
      else window.eruda.show();
    });
  });
})();
`;
