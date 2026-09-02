import { BRIDGE_SOURCE, COMMAND_SOURCE } from "./protocol.js";

// Click-to-select element picker, ported from the Electron pane's
// buildElementSelectorScript in
// packages/app/src/desktop/browser/pane/element-selector.electron.ts.
//
// Two things change in how it is driven. The Electron host evaluates that script on
// demand and polls window.__paseoSelectorResult for the answer; here the script
// is injected once into <head> and both directions travel over postMessage, so
// the overlay is built on 'start-select' rather than at evaluation time — at
// <head> time there is no page to point at yet. And its per-evaluation session
// token, which existed only to tell one executeJavaScript round from the next,
// is replaced by the sender + COMMAND_SOURCE check every bridge command carries.
//
// The 'selection' payload is field-for-field BrowserElementSelection, so
// buildBrowserElementAttachment consumes it with no shim.
export const SELECTOR_SCRIPT = `
(function() {
  'use strict';
  var BRIDGE = ${JSON.stringify(BRIDGE_SOURCE)};
  var COMMAND = ${JSON.stringify(COMMAND_SOURCE)};
  var HANDLE = '__paseoSelector';

  // Two live copies would each arm their own overlay, and the first one's
  // stopImmediatePropagation then hides the click from the second — which never
  // tears down, leaving its stylesheet and eleven capture handlers on the page.
  var previous = window[HANDLE];
  if (previous && typeof previous.destroy === 'function') {
    try { previous.destroy(); } catch (error) { /* already gone */ }
  }

  var active = false;
  var destroyed = false;
  var style = null;
  var hoverLabel = null;
  var last = null;

  function send(type, payload) {
    try { window.parent.postMessage({ source: BRIDGE, type: type, payload: payload }, '*'); }
    catch (error) { /* parent gone */ }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, function(ch) {
      return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;';
    });
  }

  // Everything interpolated below lands in text position inside a span, and
  // escapeHtml neutralises the two characters that matter there — so the label
  // renders the page's own markup as text instead of re-parsing it.
  function describeElement(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : 'node';
    var parts = ['<span class="__paseo-tag">' + escapeHtml(tag) + '</span>'];
    if (el.id) {
      parts.push('<span class="__paseo-id">#' + escapeHtml(el.id) + '</span>');
    }
    if (el.classList && el.classList.length) {
      var cls = Array.prototype.slice.call(el.classList, 0, 2)
        .filter(function(c) { return c.indexOf('__paseo') !== 0; })
        .map(function(c) { return '.' + escapeHtml(c); })
        .join('');
      if (cls) parts.push('<span class="__paseo-cls">' + cls + '</span>');
    }
    var comp = getReactSource(el);
    if (comp && comp.componentName) {
      parts.push('<span class="__paseo-comp">&lt;' + escapeHtml(comp.componentName) + '&gt;</span>');
    }
    var rect = el.getBoundingClientRect();
    parts.push('<span class="__paseo-dim">' + Math.round(rect.width) + '×' + Math.round(rect.height) + '</span>');
    return { html: parts.join(''), rect: rect };
  }

  function positionLabel(rect, e) {
    var lw = hoverLabel.offsetWidth || 0;
    var lh = hoverLabel.offsetHeight || 0;
    var top = rect.top - lh - 6;
    if (top < 4) top = rect.bottom + 6;
    if (top + lh > window.innerHeight - 4) top = Math.max(4, e.clientY - lh - 6);
    var left = rect.left;
    if (left + lw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - lw - 4);
    if (left < 4) left = 4;
    hoverLabel.style.top = Math.round(top) + 'px';
    hoverLabel.style.left = Math.round(left) + 'px';
  }

  function onMove(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    // A pointer event can land on the document itself, which has no classList.
    if (!el || el.nodeType !== 1) return;
    if (last) last.classList.remove('__paseo-hover');
    el.classList.add('__paseo-hover');
    last = el;
    try {
      var info = describeElement(el);
      hoverLabel.innerHTML = info.html;
      hoverLabel.style.display = 'block';
      positionLabel(info.rect, e);
    } catch (err) {
      hoverLabel.style.display = 'none';
    }
  }

  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    var path = [];
    while (el && el.nodeType === 1) {
      var seg = el.tagName.toLowerCase();
      if (el.id) { path.unshift('#' + el.id); break; }
      var sib = el, nth = 1;
      while (sib = sib.previousElementSibling) { if (sib.tagName === el.tagName) nth++; }
      if (nth > 1) seg += ':nth-of-type(' + nth + ')';
      path.unshift(seg);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  function getReactSource(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].startsWith('__reactFiber$') || keys[i].startsWith('__reactInternalInstance$')) {
        var fiber = el[keys[i]];
        while (fiber) {
          if (fiber._debugSource) {
            return {
              fileName: fiber._debugSource.fileName || null,
              lineNumber: fiber._debugSource.lineNumber || null,
              columnNumber: fiber._debugSource.columnNumber || null,
              componentName: (fiber.type && (typeof fiber.type === 'string' ? fiber.type : fiber.type.displayName || fiber.type.name)) || null
            };
          }
          if (fiber._debugOwner) { fiber = fiber._debugOwner; }
          else if (fiber.return) { fiber = fiber.return; }
          else break;
        }
      }
    }
    return null;
  }

  function getParentChain(el, depth) {
    var chain = [];
    var cur = el.parentElement;
    for (var i = 0; i < (depth || 5) && cur; i++) {
      var desc = cur.tagName.toLowerCase();
      if (cur.id) desc += '#' + cur.id;
      // Filtering our own marker classes out, the way the hover label already
      // does: __paseo-select-mode sits on <html> for as long as the picker is
      // open, and this chain is read back to the agent as the page's ancestry.
      if (cur.className && typeof cur.className === 'string') {
        var cls = cur.className.trim().replace(/  +/g, ' ').split(' ')
          .filter(function(c) { return c && c.indexOf('__paseo') !== 0; })
          .slice(0, 2).join('.');
        if (cls) desc += '.' + cls;
      }
      chain.push(desc);
      cur = cur.parentElement;
    }
    return chain;
  }

  function getChildSummary(el, max) {
    var kids = [];
    for (var i = 0; i < Math.min(el.children.length, max || 8); i++) {
      var c = el.children[i];
      var desc = c.tagName.toLowerCase();
      if (c.id) desc += '#' + c.id;
      kids.push(desc);
    }
    if (el.children.length > (max || 8)) kids.push('...(' + el.children.length + ' total)');
    return kids;
  }

  function getRelevantStyles(el) {
    var cs = window.getComputedStyle(el);
    var pick = ['display','position','width','height','color','background-color','font-size','font-family','padding','margin','border','flex','grid-template-columns','gap','overflow','opacity','z-index'];
    var out = {};
    pick.forEach(function(p) {
      var v = cs.getPropertyValue(p);
      if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[p] = v;
    });
    return out;
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var el = e.target;
    // Nothing below tolerates a non-element target, and an exception thrown in
    // a capture listener would leave the overlay up with no selection sent.
    if (!el || el.nodeType !== 1) return;
    if (last) last.classList.remove('__paseo-hover');
    hoverLabel.style.display = 'none';
    var rect = el.getBoundingClientRect();
    // Read before teardown, after the hover class comes off: the rest of the
    // overlay lives on <html>, so outerHTML is the page's own markup.
    var result = {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').substring(0, 500),
      selector: buildSelector(el),
      url: location.href,
      outerHTML: el.outerHTML.substring(0, 2000),
      computedStyles: getRelevantStyles(el),
      boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      reactSource: getReactSource(el),
      parentChain: getParentChain(el, 5),
      children: getChildSummary(el, 8)
    };
    teardown();
    send('selection', result);
  }

  function onKey(e) {
    if (e.key === 'Escape') cancel();
  }

  // The page keeps running underneath, so every route a click could take into
  // it — a link, a submit, a synthesised pointer or touch sequence — is
  // swallowed. Pointing at an element must not also press the button it is on.
  function blockEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  var CAPTURED = ['mousemove','click','keydown','mousedown','mouseup','pointerdown','pointerup','touchstart','touchend','focus','submit'];

  function handlerFor(name) {
    if (name === 'mousemove') return onMove;
    if (name === 'click') return onClick;
    if (name === 'keydown') return onKey;
    return blockEvent;
  }

  function listen(add) {
    for (var i = 0; i < CAPTURED.length; i++) {
      var name = CAPTURED[i];
      if (add) document.addEventListener(name, handlerFor(name), true);
      else document.removeEventListener(name, handlerFor(name), true);
    }
  }

  function start() {
    if (destroyed || active) return;
    // The overlay writes into <head> and onto <html>, and this script runs while
    // <head> is still parsing — there is no page to point at yet. Report the
    // cancel so the app's selecting state does not stick.
    if (document.readyState === 'loading' || !document.head || !document.documentElement) {
      send('select-cancelled', {});
      return;
    }
    active = true;
    style = document.createElement('style');
    // Named because the user can open eruda on this same page and read the
    // element tree: an anonymous <style> and a mystery class look like the
    // app's own markup. The hover label carries its name in its class already.
    style.id = 'paseo-selector-styles';
    style.textContent = [
      '.__paseo-hover { outline: 2px solid #3b82f6 !important; outline-offset: 2px !important; cursor: crosshair !important; }',
      '.__paseo-select-mode, .__paseo-select-mode * { cursor: crosshair !important; pointer-events: auto !important; user-select: none !important; }',
      '.__paseo-select-mode *, .__paseo-select-mode *::before, .__paseo-select-mode *::after { animation: none !important; transition: none !important; }',
      '.__paseo-select-mode a, .__paseo-select-mode button, .__paseo-select-mode input, .__paseo-select-mode select, .__paseo-select-mode textarea, .__paseo-select-mode [role="button"], .__paseo-select-mode [onclick] { pointer-events: none !important; }',
      '.__paseo-select-mode iframe, .__paseo-select-mode video, .__paseo-select-mode audio { pointer-events: none !important; }',
      '.__paseo-hover-label { position: fixed; z-index: 2147483647; pointer-events: none; max-width: 360px; padding: 4px 8px; border-radius: 6px; background: rgba(24,24,27,0.96); color: #fff; font: 500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow: 0 2px 10px rgba(0,0,0,0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.__paseo-hover-label .__paseo-tag { color: #93c5fd; }',
      '.__paseo-hover-label .__paseo-id { color: #fca5a5; }',
      '.__paseo-hover-label .__paseo-cls { color: #fcd34d; }',
      '.__paseo-hover-label .__paseo-dim { color: #a1a1aa; margin-left: 6px; }',
      '.__paseo-hover-label .__paseo-comp { color: #86efac; margin-left: 6px; }'
    ].join('\\n');
    document.head.appendChild(style);
    document.documentElement.classList.add('__paseo-select-mode');
    hoverLabel = document.createElement('div');
    hoverLabel.className = '__paseo-hover-label';
    hoverLabel.style.display = 'none';
    document.documentElement.appendChild(hoverLabel);
    listen(true);
  }

  function teardown() {
    if (!active) return;
    active = false;
    listen(false);
    document.documentElement.classList.remove('__paseo-select-mode');
    if (last) { last.classList.remove('__paseo-hover'); last = null; }
    if (hoverLabel && hoverLabel.parentNode) hoverLabel.parentNode.removeChild(hoverLabel);
    hoverLabel = null;
    if (style) { style.remove(); style = null; }
  }

  function cancel() {
    teardown();
    // Sent even when nothing was active: a frame that reloaded mid-selection has
    // no overlay left to tear down, and staying silent there would leave the app
    // showing 'selecting' with no way out.
    send('select-cancelled', {});
  }

  // Only the embedder may drive this frame — same reasoning as the navigation
  // half. A nested third-party frame (ad, checkout widget, video embed) can
  // reach window.parent and executes inside the preview origin, so anything it
  // makes us post is authentic on every check the parent can run.
  //
  // Neither command carries an operand, so there is nothing further to validate:
  // the selector reads location.href and never navigates.
  function onCommand(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== COMMAND) return;
    if (data.command === 'start-select') start();
    else if (data.command === 'cancel-select') cancel();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    teardown();
    window.removeEventListener('message', onCommand);
    if (window[HANDLE] === handle) { delete window[HANDLE]; }
  }

  window.addEventListener('message', onCommand);

  var handle = { destroy: destroy };
  window[HANDLE] = handle;
})();
`;
