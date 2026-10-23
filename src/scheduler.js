// Scheduler: the only component that acts without a user request.
// On each tick it evaluates the deterministic rules against the event store
// (using the virtual clock) and materializes their outputs idempotently.
// It writes inbox rows ONLY — it never sends any external notification.
import { evaluateRules } from './rules.js';

export function createScheduler({ store, clock, tickMs = 3000 }) {
  let timer = null;

  function tick() {
    const nowIso = clock.nowIso();
    for (const senior of store.listSeniors()) {
      const checkinEvents = store.getEvents(senior.id, { type: 'checkin_recorded' });
      const actions = evaluateRules({ senior, checkinEvents, nowIso });

      for (const action of actions) {
        if (action.kind === 'card') {
          const card = store.addCard({
            created_ts: nowIso,
            senior_id: senior.id,
            severity: action.severity,
            title: action.title,
            body: action.body,
            quote: action.quote,
            suggested_action: action.suggested_action,
            source: action.source,
            dedupe_key: action.dedupe_key,
          });
          if (card) {
            store.appendEvent({
              ts: nowIso,
              senior_id: senior.id,
              type: 'family_card_created',
              payload: { card_id: card.id, rule_id: action.rule_id, severity: card.severity, title: card.title },
            });
            store.audit({
              ts_virtual: nowIso,
              direction: 'system',
              method: 'scheduler.rule_fired',
              detail: { rule_id: action.rule_id, card_id: card.id, title: card.title, delivery: 'family_inbox_only' },
            });
          }
        } else if (action.kind === 'proactive') {
          const fu = store.addFollowup({
            senior_id: senior.id,
            due_ts: nowIso, // due immediately: companion should speak first
            reason: action.reason,
            created_ts: nowIso,
            dedupe_key: action.dedupe_key,
          });
          if (fu) {
            store.audit({
              ts_virtual: nowIso,
              direction: 'system',
              method: 'scheduler.proactive_prompt_queued',
              detail: { rule_id: action.rule_id, reason: action.reason },
            });
          }
        }
      }

      // Fire due follow-ups -> proactive prompt events the companion speaks.
      for (const fu of store.dueFollowups(nowIso)) {
        store.markFollowupFired(fu.id);
        store.appendEvent({
          ts: nowIso,
          senior_id: fu.senior_id,
          type: 'proactive_prompt',
          payload: { followup_id: fu.id, reason: fu.reason, served: false },
        });
        store.audit({
          ts_virtual: nowIso,
          direction: 'system',
          method: 'scheduler.followup_fired',
          detail: { followup_id: fu.id, reason: fu.reason },
        });
      }
    }
  }

  return {
    start() {
      if (!timer) timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tickOnce: tick,
  };
}
