import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";

// Runs inside the previewed page, injected into <head> so the history patch is
// installed before the page's own JavaScript. A route change during hydration
// is otherwise unobserved and the parent's first URL is already stale.
//
// Posts with targetOrigin '*': the daemon writing this script cannot know the
// app's origin. The payload carries no secrets, and the parent authenticates by
// checking event.source and event.origin on its side.
//
// Leaves window.__paseoNavigationBridge behind, matching __paseoSelector and
// __paseoAnnotationMarkers: a teardown handle a second copy of this script (or
// a test) can call to take the previous instance off the window.
export const NAVIGATION_SCRIPT = `
(function() {
  'use strict';
  var BRIDGE = ${JSON.stringify(BRIDGE_SOURCE)};
  var COMMAND = ${JSON.stringify(COMMAND_SOURCE)};
  var STORAGE_KEY = '__paseo_nav';
  var HANDLE = '__paseoNavigationBridge';

  // Two live copies in one document would each keep their own stack and their
  // own seq counter, so the parent would see two interleaved monotonic
  // sequences and discard half of them as stale.
  var previous = window[HANDLE];
  if (previous && typeof previous.destroy === 'function') {
    try { previous.destroy(); } catch (error) { /* already gone */ }
  }

  var docId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  var stack = [];
  var index = -1;
  var seq = 0;
  var lastHref = null;
  var lastTitle = null;
  var destroyed = false;

  function send(type, payload) {
    try { window.parent.postMessage({ source: BRIDGE, type: type, payload: payload }, '*'); }
    catch (error) { /* parent gone */ }
  }

  // sessionStorage is partitioned or blocked for third-party frames in some
  // browsers, so it is an enhancement across full page loads and never the
  // source of truth. Every access is guarded.
  // Restore only when this document replaced another one in the SAME browsing
  // context, which is the only case that leaves a real back entry to traverse.
  // The app re-points the preview by remounting the iframe element rather than
  // assigning src, so a parent-driven navigation starts a fresh context with no
  // back entry of its own — while sessionStorage, keyed by origin and not by
  // context, still holds the previous context's stack. Restoring it there makes
  // this script report canGoBack for a frame that cannot go back: the toolbar
  // lights Back and history.back() silently does nothing. document.referrer
  // names the predecessor, and is a same-origin URL only after an in-page
  // navigation; after a remount it is the embedder's origin, or empty.
  function hasSameOriginPredecessor() {
    return document.referrer.indexOf(location.origin + '/') === 0;
  }

  function load() {
    if (!hasSameOriginPredecessor()) return;
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && Array.isArray(saved.stack) && typeof saved.index === 'number') {
        stack = saved.stack.filter(function(entry) { return typeof entry === 'string'; });
        index = Math.min(saved.index, stack.length - 1);
      }
    } catch (error) { stack = []; index = -1; }
  }

  function save() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ stack: stack, index: index })); }
    catch (error) { /* storage blocked */ }
  }

  function report(href, title) {
    seq += 1;
    send('navigation', {
      docId: docId,
      seq: seq,
      url: href,
      title: title,
      canGoBack: index > 0,
      canGoForward: index >= 0 && index < stack.length - 1
    });
  }

  // Two axes, deliberately separate. 'moved' drives the stack; the title drives
  // only a re-report. This script runs in <head>, so the first report always
  // predates <title> being parsed — without the title half, an ordinary page
  // that never route-changes would leave the parent showing an empty tab title
  // forever, since 'load' and 'pageshow' arrive on an unchanged href.
  function observe(mode) {
    if (destroyed) return;
    var href = location.href;
    var title = document.title || '';
    var moved = mode === 'replace' || href !== lastHref;
    if (!moved && title === lastTitle) return;
    lastHref = href;
    lastTitle = title;
    if (moved) {
      if (mode === 'replace' && index >= 0) {
        stack[index] = href;
      } else if (mode === 'push') {
        stack = stack.slice(0, index + 1);
        stack.push(href);
        index = stack.length - 1;
      } else {
        var existing = stack.indexOf(href);
        if (existing >= 0) { index = existing; }
        else { stack = stack.slice(0, index + 1); stack.push(href); index = stack.length - 1; }
      }
      save();
    }
    report(href, title);
  }

  function onAuto() { observe('auto'); }

  // Only the embedder may drive this frame. Task 6 posts app window ->
  // iframe.contentWindow, so event.source is window.parent for a real command.
  // The parent's own event.source/event.origin checks protect the parent from
  // spoofed inbound messages; they cannot protect this frame, because a nested
  // third-party frame (ad, checkout widget, video embed) executes here, inside
  // the preview origin, and everything it causes us to post is then perfectly
  // authentic on both of the parent's checks.
  function onCommand(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== COMMAND) return;
    switch (data.command) {
      case 'back': if (index > 0) history.back(); break;
      case 'forward': if (index < stack.length - 1) history.forward(); break;
      case 'reload': location.reload(); break;
      case 'goto': gotoUrl(data.url); break;
    }
  }

  // location.assign takes any string, and a javascript: URL navigating its own
  // window runs in this document's origin. Same allowlist the app applies before
  // it puts a URL in an iframe (ALLOWED_IFRAME_PROTOCOLS in
  // packages/app/src/desktop/browser/pane/web-preview-url.ts). Unparseable
  // fails closed, unlike there, where a bad string is handled downstream.
  function gotoUrl(url) {
    if (typeof url !== 'string' || !url) return;
    var target;
    try { target = new URL(url, location.href); } catch (error) { return; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
    location.assign(target.href);
  }

  var originalPush = history.pushState;
  var originalReplace = history.replaceState;
  function patchedPush() {
    var result = originalPush.apply(this, arguments);
    observe('push');
    return result;
  }
  function patchedReplace() {
    var result = originalReplace.apply(this, arguments);
    observe('replace');
    return result;
  }
  history.pushState = patchedPush;
  history.replaceState = patchedReplace;

  window.addEventListener('popstate', onAuto);
  window.addEventListener('hashchange', onAuto);
  window.addEventListener('pageshow', onAuto);
  window.addEventListener('load', onAuto);
  window.addEventListener('message', onCommand);

  // Catches navigations no event covers — a same-document change made by a
  // router that writes location directly.
  var poll = setInterval(function() {
    if (location.href !== lastHref || (document.title || '') !== lastTitle) observe('auto');
  }, 250);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    // Only unwind our own patch: restoring blindly would drop whatever else
    // wrapped history after us.
    if (history.pushState === patchedPush) { history.pushState = originalPush; }
    if (history.replaceState === patchedReplace) { history.replaceState = originalReplace; }
    window.removeEventListener('popstate', onAuto);
    window.removeEventListener('hashchange', onAuto);
    window.removeEventListener('pageshow', onAuto);
    window.removeEventListener('load', onAuto);
    window.removeEventListener('message', onCommand);
    clearInterval(poll);
    if (window[HANDLE] === handle) { delete window[HANDLE]; }
  }

  var handle = { destroy: destroy, docId: docId };
  window[HANDLE] = handle;

  load();
  send('ready', { docId: docId });
  observe('auto');
})();
`;
