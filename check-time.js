(() => {
  const now = () => performance.now();
  const fmt = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}ms` : 'n/a');
  const fmtBytes = (b) => {
    if (!Number.isFinite(b)) return 'n/a';
    const u = ['B','KB','MB','GB','TB'];
    let v = b, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  const state = {
    startedAt: now(),
    navigation: null,
    resources: [],
    marks: {},
    longTasks: [],
    layoutShifts: [],
    paints: { fp: null, fcp: null, lcp: null },
    cls: 0,
    inp: null,
    ttfb: null,
    domContentLoaded: null,
    loadEvent: null,
    domInteractive: null,
    domComplete: null,
    resourceSummary: null,
    bytes: { transfer: 0, decoded: 0, encoded: 0 },
    counts: { resources: 0, images: 0, scripts: 0, styles: 0, fonts: 0, xhr: 0, fetch: 0, other: 0 },
    render: {
      rafSamples: 0,
      rafTotal: 0,
      rafMax: 0,
      rafOver50: 0,
      rafOver16: 0,
      rafOver100: 0,
      rafLastTs: null
    },
    io: {
      xhr: [],
      fetch: [],
      errors: []
    },
    jsHeap: null,
    env: {
      url: location.href,
      ua: navigator.userAgent,
      deviceMemory: navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      connection: safe(() => {
        const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!c) return null;
        return {
          effectiveType: c.effectiveType,
          downlink: c.downlink,
          rtt: c.rtt,
          saveData: c.saveData
        };
      }, null)
    }
  };

  const NS = 'check-time';
  if (window.__CHECK_TIME__) return;
  Object.defineProperty(window, '__CHECK_TIME__', { value: { state }, enumerable: false });

  const log = (...a) => console.log(`[${NS}]`, ...a);
  const warn = (...a) => console.warn(`[${NS}]`, ...a);

  const supported = {
    perf: typeof performance !== 'undefined' && performance.getEntriesByType,
    po: typeof PerformanceObserver !== 'undefined'
  };

  function getNavTiming() {
    const nav = performance.getEntriesByType('navigation')?.[0];
    if (nav) {
      return {
        type: nav.type,
        startTime: nav.startTime,
        unloadEventStart: nav.unloadEventStart,
        unloadEventEnd: nav.unloadEventEnd,
        redirectCount: nav.redirectCount,
        redirectStart: nav.redirectStart,
        redirectEnd: nav.redirectEnd,
        fetchStart: nav.fetchStart,
        domainLookupStart: nav.domainLookupStart,
        domainLookupEnd: nav.domainLookupEnd,
        connectStart: nav.connectStart,
        secureConnectionStart: nav.secureConnectionStart,
        connectEnd: nav.connectEnd,
        requestStart: nav.requestStart,
        responseStart: nav.responseStart,
        responseEnd: nav.responseEnd,
        domInteractive: nav.domInteractive,
        domContentLoadedEventStart: nav.domContentLoadedEventStart,
        domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
        domComplete: nav.domComplete,
        loadEventStart: nav.loadEventStart,
        loadEventEnd: nav.loadEventEnd,
        transferSize: nav.transferSize,
        encodedBodySize: nav.encodedBodySize,
        decodedBodySize: nav.decodedBodySize
      };
    }

    const t = performance.timing;
    if (t && t.navigationStart) {
      const base = t.navigationStart;
      const rel = (x) => (x ? x - base : 0);
      return {
        type: 'unknown',
        startTime: 0,
        fetchStart: rel(t.fetchStart),
        domainLookupStart: rel(t.domainLookupStart),
        domainLookupEnd: rel(t.domainLookupEnd),
        connectStart: rel(t.connectStart),
        secureConnectionStart: rel(t.secureConnectionStart),
        connectEnd: rel(t.connectEnd),
        requestStart: rel(t.requestStart),
        responseStart: rel(t.responseStart),
        responseEnd: rel(t.responseEnd),
        domInteractive: rel(t.domInteractive),
        domContentLoadedEventStart: rel(t.domContentLoadedEventStart),
        domContentLoadedEventEnd: rel(t.domContentLoadedEventEnd),
        domComplete: rel(t.domComplete),
        loadEventStart: rel(t.loadEventStart),
        loadEventEnd: rel(t.loadEventEnd)
      };
    }

    return null;
  }

  function summarizeResources() {
    const entries = performance.getEntriesByType('resource') || [];
    const counts = { resources: 0, images: 0, scripts: 0, styles: 0, fonts: 0, xhr: 0, fetch: 0, other: 0 };
    const bytes = { transfer: 0, encoded: 0, decoded: 0 };
    const byInitiator = new Map();

    for (const e of entries) {
      counts.resources++;
      const it = (e.initiatorType || 'other').toLowerCase();
      if (it === 'img' || it === 'image') counts.images++;
      else if (it === 'script') counts.scripts++;
      else if (it === 'link' || it === 'css') counts.styles++;
      else if (it === 'css') counts.styles++;
      else if (it === 'font') counts.fonts++;
      else if (it === 'xmlhttprequest') counts.xhr++;
      else if (it === 'fetch') counts.fetch++;
      else counts.other++;

      const ts = e.transferSize ?? 0;
      const enc = e.encodedBodySize ?? 0;
      const dec = e.decodedBodySize ?? 0;
      bytes.transfer += ts;
      bytes.encoded += enc;
      bytes.decoded += dec;

      const cur = byInitiator.get(it) || { count: 0, transfer: 0, encoded: 0, decoded: 0, totalDuration: 0, maxDuration: 0 };
      cur.count += 1;
      cur.transfer += ts;
      cur.encoded += enc;
      cur.decoded += dec;
      cur.totalDuration += (e.duration || 0);
      cur.maxDuration = Math.max(cur.maxDuration, (e.duration || 0));
      byInitiator.set(it, cur);
    }

    const initiators = {};
    for (const [k, v] of byInitiator.entries()) initiators[k] = v;

    return { counts, bytes, initiators, entriesCount: entries.length };
  }

  function startRAFTracking() {
    const r = state.render;
    const step = (ts) => {
      if (r.rafLastTs != null) {
        const dt = ts - r.rafLastTs;
        r.rafSamples++;
        r.rafTotal += dt;
        r.rafMax = Math.max(r.rafMax, dt);
        if (dt > 16.67) r.rafOver16++;
        if (dt > 50) r.rafOver50++;
        if (dt > 100) r.rafOver100++;
      }
      r.rafLastTs = ts;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function observe(type, handler, opts) {
    if (!supported.po) return null;
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handler(entry);
      });
      po.observe({ type, buffered: true, ...(opts || {}) });
      return po;
    } catch {
      return null;
    }
  }

  observe('paint', (e) => {
    if (e.name === 'first-paint') state.paints.fp = e.startTime;
    if (e.name === 'first-contentful-paint') state.paints.fcp = e.startTime;
  });

  observe('largest-contentful-paint', (e) => {
    state.paints.lcp = e.startTime;
  });

  observe('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    state.layoutShifts.push({
      value: e.value,
      startTime: e.startTime,
      sources: safe(() => (e.sources || []).slice(0, 3).map(s => ({
        node: s.node ? (s.node.tagName || '').toLowerCase() : null,
        previousRect: s.previousRect,
        currentRect: s.currentRect
      })), [])
    });
    state.cls += e.value;
  });

  observe('longtask', (e) => {
    state.longTasks.push({
      name: e.name,
      startTime: e.startTime,
      duration: e.duration,
      attribution: safe(() => (e.attribution || []).slice(0, 3).map(a => ({
        name: a.name,
        entryType: a.entryType,
        startTime: a.startTime,
        duration: a.duration,
        containerType: a.containerType,
        containerName: a.containerName,
        containerId: a.containerId
      })), [])
    });
  });

  observe('event', (e) => {
    if (e.name !== 'click' && e.name !== 'keydown' && e.name !== 'pointerdown') return;
    const dur = e.duration;
    if (!Number.isFinite(dur)) return;
    if (!state.inp || dur > state.inp.duration) {
      state.inp = { name: e.name, startTime: e.startTime, duration: dur, interactionId: e.interactionId };
    }
  }, { durationThreshold: 16 });

  function patchNetwork() {
    const XHR = window.XMLHttpRequest;
    if (XHR && !XHR.__checktime_patched) {
      function PatchedXHR() {
        const xhr = new XHR();
        let start = 0;
        let url = '';
        let method = '';
        const open = xhr.open;
        const send = xhr.send;

        xhr.open = function(m, u) {
          method = m;
          url = String(u);
          return open.apply(xhr, arguments);
        };

        xhr.send = function() {
          start = now();
          const onEnd = () => {
            const end = now();
            state.io.xhr.push({
              method,
              url,
              status: safe(() => xhr.status, null),
              duration: end - start,
              responseType: safe(() => xhr.responseType, ''),
              contentType: safe(() => xhr.getResponseHeader('content-type'), null)
            });
            xhr.removeEventListener('loadend', onEnd);
          };
          xhr.addEventListener('loadend', onEnd);
          return send.apply(xhr, arguments);
        };

        return xhr;
      }
      PatchedXHR.__checktime_patched = true;
      window.XMLHttpRequest = PatchedXHR;
    }

    const origFetch = window.fetch;
    if (origFetch && !origFetch.__checktime_patched) {
      const patched = function(input, init) {
        const start = now();
        const method = (init && init.method) ? String(init.method) : 'GET';
        const url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
        return origFetch(input, init).then((res) => {
          const end = now();
          state.io.fetch.push({
            method,
            url,
            status: res.status,
            ok: res.ok,
            duration: end - start,
            type: res.type,
            redirected: res.redirected
          });
          return res;
        }).catch((err) => {
          const end = now();
          state.io.fetch.push({
            method,
            url,
            status: null,
            ok: false,
            duration: end - start,
            error: String(err && err.message ? err.message : err)
          });
          throw err;
        });
      };
      patched.__checktime_patched = true;
      window.fetch = patched;
    }

    window.addEventListener('error', (e) => {
      state.io.errors.push({
        type: 'error',
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno
      });
    });

    window.addEventListener('unhandledrejection', (e) => {
      state.io.errors.push({
        type: 'unhandledrejection',
        reason: String(e.reason && e.reason.message ? e.reason.message : e.reason)
      });
    });
  }

  function getHeap() {
    return safe(() => {
      const m = performance.memory;
      if (!m) return null;
      return {
        usedJSHeapSize: m.usedJSHeapSize,
        totalJSHeapSize: m.totalJSHeapSize,
        jsHeapSizeLimit: m.jsHeapSizeLimit
      };
    }, null);
  }

  function finalizeNavigation() {
    const nav = getNavTiming();
    state.navigation = nav;

    if (nav) {
      state.ttfb = nav.responseStart;
      state.domInteractive = nav.domInteractive;
      state.domContentLoaded = nav.domContentLoadedEventEnd;
      state.domComplete = nav.domComplete;
      state.loadEvent = nav.loadEventEnd;
    }
  }

  function printReport(reason) {
    finalizeNavigation();
    const res = summarizeResources();
    state.resourceSummary = res;
    state.bytes = res.bytes;
    state.counts = res.counts;
    state.jsHeap = getHeap();

    const r = state.render;
    const avgRaf = r.rafSamples ? (r.rafTotal / r.rafSamples) : null;

    const nav = state.navigation || {};
    const dns = (nav.domainLookupEnd && nav.domainLookupStart) ? (nav.domainLookupEnd - nav.domainLookupStart) : null;
    const tcp = (nav.connectEnd && nav.connectStart) ? (nav.connectEnd - nav.connectStart) : null;
    const tls = (nav.secureConnectionStart && nav.connectEnd && nav.secureConnectionStart > 0) ? (nav.connectEnd - nav.secureConnectionStart) : null;
    const req = (nav.responseStart && nav.requestStart) ? (nav.responseStart - nav.requestStart) : null;
    const dl = (nav.responseEnd && nav.responseStart) ? (nav.responseEnd - nav.responseStart) : null;

    const topResources = safe(() => {
      const entries = performance.getEntriesByType('resource') || [];
      const list = entries
        .slice()
        .sort((a,b) => (b.duration || 0) - (a.duration || 0))
        .slice(0, 10)
        .map(e => ({
          name: (e.name || '').slice(0, 140),
          initiatorType: e.initiatorType,
          duration: +(e.duration || 0).toFixed(2),
          transferSize: e.transferSize ?? null,
          encodedBodySize: e.encodedBodySize ?? null,
          decodedBodySize: e.decodedBodySize ?? null
        }));
      return list;
    }, []);

    const longTasksTotal = state.longTasks.reduce((s, t) => s + (t.duration || 0), 0);

    const tableSummary = {
      reason,
      url: state.env.url,
      FP: state.paints.fp != null ? fmt(state.paints.fp) : 'n/a',
      FCP: state.paints.fcp != null ? fmt(state.paints.fcp) : 'n/a',
      LCP: state.paints.lcp != null ? fmt(state.paints.lcp) : 'n/a',
      CLS: state.cls.toFixed(4),
      INP: state.inp ? `${state.inp.name} ${fmt(state.inp.duration)}` : 'n/a',
      TTFB: state.ttfb != null ? fmt(state.ttfb) : 'n/a',
      DCL: state.domContentLoaded != null ? fmt(state.domContentLoaded) : 'n/a',
      Load: state.loadEvent != null ? fmt(state.loadEvent) : 'n/a',
      'DNS': dns != null ? fmt(dns) : 'n/a',
      'TCP': tcp != null ? fmt(tcp) : 'n/a',
      'TLS': tls != null ? fmt(tls) : 'n/a',
      'Req wait': req != null ? fmt(req) : 'n/a',
      'DL': dl != null ? fmt(dl) : 'n/a',
      'Resources': res.entriesCount,
      'Transfer': fmtBytes(res.bytes.transfer),
      'Encoded': fmtBytes(res.bytes.encoded),
      'Decoded': fmtBytes(res.bytes.decoded),
      'Long tasks': state.longTasks.length,
      'Long tasks total': fmt(longTasksTotal),
      'rAF avg': avgRaf != null ? fmt(avgRaf) : 'n/a',
      'rAF max': fmt(r.rafMax),
      'Frames >16ms': r.rafOver16,
      'Frames >50ms': r.rafOver50,
      'Frames >100ms': r.rafOver100,
      'XHR': state.io.xhr.length,
      'fetch': state.io.fetch.length,
      'errors': state.io.errors.length
    };

    const detail = {
      env: state.env,
      navigation: state.navigation,
      paints: state.paints,
      cls: { value: state.cls, shifts: state.layoutShifts.slice(0, 20) },
      inp: state.inp,
      resources: {
        counts: res.counts,
        bytes: res.bytes,
        initiators: res.initiators,
        topByDuration: topResources
      },
      longTasks: {
        count: state.longTasks.length,
        totalDuration: longTasksTotal,
        top: state.longTasks.slice().sort((a,b) => (b.duration||0)-(a.duration||0)).slice(0, 10)
      },
      render: state.render,
      heap: state.jsHeap,
      io: {
        xhrTop: state.io.xhr.slice().sort((a,b) => b.duration - a.duration).slice(0, 10),
        fetchTop: state.io.fetch.slice().sort((a,b) => b.duration - a.duration).slice(0, 10),
        errors: state.io.errors.slice(0, 20)
      }
    };

    console.groupCollapsed(`[${NS}] report (${reason})`);
    console.table(tableSummary);
    console.groupCollapsed(`[${NS}] details`);
    log(detail);
    console.groupEnd();
    console.groupEnd();

    window.__CHECK_TIME__.lastReport = { at: Date.now(), reason, summary: tableSummary, detail };
  }

  function exposeAPI() {
    const api = {
      report: (reason = 'manual') => printReport(reason),
      state,
      mark: (name) => { performance.mark(`${NS}:${name}`); state.marks[name] = now(); },
      measure: (name, start, end) => safe(() => {
        performance.measure(`${NS}:${name}`, `${NS}:${start}`, `${NS}:${end}`);
        const e = performance.getEntriesByName(`${NS}:${name}`).slice(-1)[0];
        log(`measure "${name}":`, e ? fmt(e.duration) : 'n/a');
        return e || null;
      }, null),
      clear: () => safe(() => {
        performance.clearMarks();
        performance.clearMeasures();
      }, undefined)
    };
    window.__CHECK_TIME__ = { ...window.__CHECK_TIME__, ...api };
  }

  patchNetwork();
  startRAFTracking();
  exposeAPI();

  document.addEventListener('DOMContentLoaded', () => {
    state.domContentLoadedAt = now();
    queueMicrotask(() => printReport('DOMContentLoaded'));
  }, { once: true });

  window.addEventListener('load', () => {
    state.loadAt = now();
    setTimeout(() => printReport('load+2s'), 2000);
  }, { once: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      printReport('pagehide');
    }
  });

  log('loaded. Use window.__CHECK_TIME__.report() for manual report.');
})();
