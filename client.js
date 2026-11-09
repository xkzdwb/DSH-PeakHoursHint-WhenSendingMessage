// peak-hint — Client half: append the current billing phase ("现在高峰时段" /
// "现在低谷时段") to every composer placeholder.
//
// Why the DOM: the placeholder is host-rendered text inside the composer
// (`[data-composer-placeholder]`, see @deepseek-ai/dsh-client-ui-conversation), and
// the slot catalog exposes no extension point for that string. The host owns the
// text node, so this half never touches it: it sets two data attributes on the
// placeholder element and one CSS rule turns them into a trailing phrase. React
// re-renders replace the text node but keep attributes it does not manage; when the
// element itself appears (new composer, returning draft), a MutationObserver puts
// the attributes back.
//
// The phase comes from the Host half's read-only route, which owns the calendar
// rules (weekday windows + China statutory holidays). It is polled every 30s,
// which is enough to cross a window boundary; a hidden page refreshes when it
// becomes visible again.

window.__ModuleLoader__.load({
  id: 'dsh-peak-hours-hint',
  factory(require) {
    const ROUTE = '/plugin-peak-hint/state';
    // No devtools are available in the desktop shell, so this half reports what it
    // did (or threw) to the Host half, which echoes the last report on ROUTE.
    const PING = '/plugin-peak-hint/ping';
    const PHASE_ATTR = 'data-peak-phase';
    const HINT_ATTR = 'data-peak-hint';
    const POLL_MS = 30000;

    const report = (fields) => {
      try {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined && value !== null) params.set(key, String(value).slice(0, 280));
        }
        fetch(`${PING}?${params}`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
      } catch {
        /* Reporting is diagnostics; it must never break the hint itself. */
      }
    };

    const DICT = {
      en: {
        peak: 'peak hours now',
        offpeak: 'off-peak hours',
      },
      zh: {
        peak: '现在高峰时段',
        offpeak: '现在低谷时段',
      },
    };

    // The phase inherits the placeholder's own color, size, line clamp and ellipsis;
    // only the separator and the phrase itself are new.
    const CSS = `
[data-composer-placeholder][data-peak-phase]::after {
  content: ' · ' attr(data-peak-hint);
}
`;

    return {
      inject: [],
      apply(ctx) {
        const locale = ctx.get('locale');
        const doc = document;

        ctx.effect(() => {
          try {
            return start();
          } catch (error) {
            report({ note: 'effect-failed', error: String((error && error.stack) || error) });
            throw error;
          }
        }, 'peak-hint: composer placeholder');

        function start() {
          let phase = null;
          let disposed = false;
          let timer = 0;
          let reported = null;

          const readLocale = () => {
            try {
              const snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined;
              return (snapshot && snapshot.active) || '';
            } catch {
              return '';
            }
          };

          const label = () => {
            if (phase !== 'peak' && phase !== 'offpeak') return '';
            const active = readLocale();
            const base = typeof active === 'string' ? active.split('-')[0] : 'en';
            const dict = DICT[active] || DICT[base] || DICT.en;
            return dict[phase];
          };

          const decorate = (node) => {
            node.setAttribute(PHASE_ATTR, phase);
            node.setAttribute(HINT_ATTR, label());
          };

          const paint = () => {
            if (!phase) return;
            for (const node of doc.querySelectorAll('[data-composer-placeholder]')) decorate(node);
          };

          const clear = () => {
            for (const node of doc.querySelectorAll('[data-composer-placeholder]')) {
              node.removeAttribute(PHASE_ATTR);
              node.removeAttribute(HINT_ATTR);
            }
          };

          const schedule = () => {
            clearTimeout(timer);
            if (!disposed) timer = setTimeout(() => void refresh(), POLL_MS);
          };

          const refresh = async () => {
            if (disposed) return;
            try {
              const response = await fetch(ROUTE, {
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { accept: 'application/json' },
              });
              if (response.ok) {
                const data = await response.json();
                if (data && (data.phase === 'peak' || data.phase === 'offpeak')) {
                  phase = data.phase;
                  paint();
                  if (reported !== phase) {
                    reported = phase;
                    report({
                      note: 'ready',
                      phase,
                      applied: '1',
                      placeholders: doc.querySelectorAll('[data-composer-placeholder]').length,
                    });
                  }
                }
              } else {
                report({ note: 'fetch-status', error: `HTTP ${response.status}` });
              }
            } catch {
              /* Host not answering: keep the last known phase rather than flicker. */
              report({ note: 'fetch-failed', error: 'request to state route failed' });
            }
            schedule();
          };

          // Composers mount and unmount as sessions and draft states change. Only a
          // subtree that actually contains a placeholder is worth repainting.
          // The added node is decorated directly instead of repainting the whole
          // document: the observer may fire before the element is queryable.
          const observer = new MutationObserver((records) => {
            if (!phase) return;
            for (const record of records) {
              for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches?.('[data-composer-placeholder]')) {
                  decorate(node);
                  return;
                }
                const inner = node.querySelectorAll?.('[data-composer-placeholder]');
                if (inner && inner.length > 0) {
                  for (const found of inner) decorate(found);
                  return;
                }
              }
            }
          });

          const onVisible = () => {
            if (doc.visibilityState === 'visible') {
              clearTimeout(timer);
              void refresh();
            }
          };

          // A package bundle's client half gets no builtin globals (those are for
          // dynamic halves), so the rule is inserted with a plain <style> tag.
          // `data-plugin` is the tag the module loader inventories for this id.
          const styleTag = doc.createElement('style');
          styleTag.setAttribute('data-plugin', 'dsh-peak-hours-hint');
          styleTag.textContent = CSS;
          doc.head.appendChild(styleTag);
          const unsubscribe = typeof locale?.subscribe === 'function' ? locale.subscribe(() => paint()) : undefined;
          doc.addEventListener('visibilitychange', onVisible);
          observer.observe(doc.body, { childList: true, subtree: true });
          void refresh();

          return () => {
            disposed = true;
            clearTimeout(timer);
            doc.removeEventListener('visibilitychange', onVisible);
            observer.disconnect();
            if (unsubscribe) unsubscribe();
            styleTag.remove();
            clear();
          };
        }
      },
    };
  },
});
