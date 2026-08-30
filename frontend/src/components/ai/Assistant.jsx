// The assistant.
//
// Not a chatbot in a corner. It runs the same tools the buttons run, against the same
// API, under the same authorisation — the value is that an admin can say
// "mark everyone paid except Karim" instead of tapping twenty-two times.
//
// Three things make it safe to point at production data:
//
//   1. It only ever calls tools from the registry. There is no free-form data path.
//   2. High-risk tools return a confirmation card and execute on approval, never on
//      interpretation alone.
//   3. Every mutation is written to an audit trail with who, what, when and "via
//      assistant". An AI that can change data invisibly is not acceptable.
//
// It also knows what is on screen, so "mark George paid" does not need the game named.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sparkles, Send, X, Check, AlertTriangle, Loader2, ChevronDown, History, Bot,
} from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { Button, Card } from '../ui/index.jsx';
import { interpret, resolveTool } from '../../ai/interpreter.js';
import { RISK } from '../../ai/tools.js';
import { aiService } from '../../api/services.js';
import { relativeTime } from '../../lib/format.js';

const SUGGESTIONS = [
  'Who hasn’t paid?',
  'Mark everyone paid except Karim',
  'Generate teams',
  'Black won 6-4',
  'Give me a summary of tonight',
];

function Bubble({ role, children, tone }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-[var(--radius-lg)] px-3.5 py-2.5 text-sm',
          isUser
            ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
            : tone === 'error'
              ? 'bg-[var(--danger-soft)] text-[var(--danger-soft-fg)]'
              : 'bg-[var(--bg-sunken)] text-[var(--fg-primary)]'
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The gate. A high-risk tool renders this and waits. */
function ConfirmationCard({ card, onConfirm, onCancel, pending }) {
  return (
    <Card className={cn('overflow-hidden', card.destructive && 'ring-1 ring-[var(--danger)]')}>
      <div
        className={cn(
          'flex items-center gap-2 px-4 py-2.5',
          card.destructive ? 'bg-[var(--danger-soft)]' : 'bg-[var(--bg-sunken)]'
        )}
      >
        <AlertTriangle
          className={cn('size-4', card.destructive ? 'text-[var(--danger)]' : 'text-[var(--fg-secondary)]')}
          aria-hidden="true"
        />
        <span className="display text-base">{card.title}</span>
      </div>

      <div className="p-4">
        <ul className="space-y-0.5 text-sm">
          {card.lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {card.note && (
          <p className="mt-2 text-xs text-[var(--fg-secondary)]">{card.note}</p>
        )}

        <div className="mt-4 flex gap-2">
          <Button variant="secondary" size="sm" className="flex-1" onClick={onCancel}>
            No, stop
          </Button>
          <Button
            variant={card.destructive ? 'danger' : 'primary'}
            size="sm"
            className="flex-1"
            loading={pending}
            onClick={onConfirm}
          >
            {card.confirmLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function Assistant({ context, onResult, className, onClose }) {
  const [messages, setMessages] = useState([
    {
      id: 'intro',
      role: 'assistant',
      text: context?.gameLabel
        ? `I can see ${context.gameLabel}. Ask me to mark payments, record goals, set the score, build teams, or cancel it.`
        : 'Ask me to run a game — payments, goals, teams, scores, schedules.',
    },
  ]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState([]);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, confirmation]);

  const push = useCallback((message) => {
    setMessages((m) => [...m, { id: `${Date.now()}-${Math.random()}`, ...message }]);
  }, []);

  /** Execute one tool and report. Shared by direct runs and confirmed runs. */
  const execute = useCallback(
    async (toolName, args, extraContext = {}) => {
      const tool = resolveTool(toolName);
      if (!tool) {
        push({ role: 'assistant', text: 'That is not something I can do.', tone: 'error' });
        return;
      }

      setPending(true);
      try {
        const result = await tool.run(args, { ...context, ...extraContext });
        push({ role: 'assistant', text: result.summary });

        // The audit trail. In production the backend writes this as part of executing
        // the tool -- the client cannot be the record of its own actions.
        await aiService.record({
          tool: toolName,
          args,
          actor: context?.actorName ?? 'Admin',
          gameId: args.gameId ?? context?.gameId ?? null,
          summary: result.summary,
        });

        onResult?.(result);
      } catch (error) {
        push({ role: 'assistant', text: error.message, tone: 'error' });
      } finally {
        setPending(false);
      }
    },
    [context, push, onResult]
  );

  const submit = useCallback(
    async (raw) => {
      const text = (raw ?? input).trim();
      if (!text || pending) return;

      push({ role: 'user', text });
      setInput('');
      setConfirmation(null);

      const interpretation = interpret(text, context);

      if (interpretation.error) {
        push({ role: 'assistant', text: interpretation.error, tone: 'error' });
        return;
      }

      const tool = resolveTool(interpretation.tool);
      const mergedContext = { ...context, ...(interpretation.context ?? {}) };

      if (tool.risk === RISK.HIGH) {
        push({ role: 'assistant', text: interpretation.rationale });
        setConfirmation({
          card: tool.confirm(interpretation.args, mergedContext),
          tool: interpretation.tool,
          args: interpretation.args,
          context: interpretation.context,
        });
        return;
      }

      // Some phrasings are two actions ("scored two and had one assist").
      const chain = interpretation.chain ?? [{ tool: interpretation.tool, args: interpretation.args }];
      for (const step of chain) {
        await execute(step.tool, step.args, interpretation.context);
      }
    },
    [input, pending, context, push, execute]
  );

  const openAudit = async () => {
    setShowAudit((v) => !v);
    if (!showAudit) {
      const { actions } = await aiService.history();
      setAudit(actions ?? []);
    }
  };

  return (
    <div className={cn('flex h-full flex-col bg-[var(--bg-surface)]', className)}>
      <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <span className="grid size-8 place-items-center rounded-[var(--radius-md)] bg-[var(--accent-soft)]">
          <Sparkles className="size-4 text-[var(--accent)]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="display text-base leading-none">Assistant</p>
          {context?.gameLabel && (
            <p className="mt-0.5 truncate text-[0.6875rem] text-[var(--fg-muted)]">
              {context.gameLabel}
            </p>
          )}
        </div>

        <button
          onClick={openAudit}
          className={cn(
            'grid size-8 place-items-center rounded-[var(--radius-md)] transition-colors',
            showAudit ? 'bg-[var(--bg-sunken)] text-[var(--fg-primary)]' : 'text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)]'
          )}
          aria-label="Action history"
          aria-pressed={showAudit}
        >
          <History className="size-4" />
        </button>

        {onClose && (
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-[var(--radius-md)] text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)]"
            aria-label="Close assistant"
          >
            <X className="size-4" />
          </button>
        )}
      </header>

      {showAudit ? (
        <div className="flex-1 overflow-y-auto p-4">
          <p className="eyebrow mb-3 text-[0.625rem]">Action history</p>
          {audit.length === 0 ? (
            <p className="text-sm text-[var(--fg-secondary)]">
              Nothing yet. Anything the assistant changes is recorded here.
            </p>
          ) : (
            <ol className="space-y-2">
              {audit.map((entry) => (
                <li key={entry.id} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[0.6875rem] text-[var(--accent)]">{entry.tool}</span>
                    <span className="text-[0.625rem] text-[var(--fg-muted)]">
                      {relativeTime(entry.at)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm">{entry.summary}</p>
                  <p className="mt-1 text-[0.625rem] text-[var(--fg-muted)]">
                    {entry.actor} · via assistant
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.map((message) => (
            <Bubble key={message.id} role={message.role} tone={message.tone}>
              {message.text}
            </Bubble>
          ))}

          {confirmation && (
            <ConfirmationCard
              card={confirmation.card}
              pending={pending}
              onCancel={() => {
                setConfirmation(null);
                push({ role: 'assistant', text: 'Left it alone.' });
              }}
              onConfirm={async () => {
                const { tool, args, context: extra } = confirmation;
                setConfirmation(null);
                await execute(tool, args, extra);
              }}
            />
          )}

          {pending && (
            <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Working
            </div>
          )}

          <div ref={endRef} />
        </div>
      )}

      {!showAudit && (
        <>
          {messages.length <= 1 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => submit(suggestion)}
                  className="rounded-full border border-[var(--border-default)] px-2.5 py-1 text-[0.6875rem] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--fg-primary)]"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="flex items-end gap-2 border-t border-[var(--border-subtle)] p-3 pb-safe"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
              rows={1}
              placeholder="Tell me what happened…"
              className="max-h-28 min-h-11 flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2.5 text-sm focus:border-[var(--accent)]"
              aria-label="Message the assistant"
            />
            <Button type="submit" size="icon" disabled={!input.trim() || pending} aria-label="Send">
              <Send className="size-4" />
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

/* ==========================================================================
   AssistantDock — desktop side panel, mobile bottom sheet
   ========================================================================== */

export function AssistantDock({ context, onResult }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Desktop: a collapsible column beside the pitch. */}
      <aside
        className={cn(
          'hidden xl:flex xl:flex-col border-l border-[var(--border-subtle)] transition-[width] duration-200',
          open ? 'w-[22rem]' : 'w-0 overflow-hidden'
        )}
        aria-hidden={!open}
      >
        {open && (
          <div className="sticky top-14 h-[calc(100svh-3.5rem)]">
            <Assistant context={context} onResult={onResult} onClose={() => setOpen(false)} />
          </div>
        )}
      </aside>

      {/* Mobile: full-height sheet. */}
      {open && (
        <div className="fixed inset-0 z-50 xl:hidden" role="dialog" aria-modal="true" aria-label="Assistant">
          <button
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
            aria-label="Close assistant"
          />
          <div className="absolute inset-x-0 bottom-0 top-16 overflow-hidden rounded-t-[var(--radius-2xl)]">
            <Assistant context={context} onResult={onResult} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}

      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-20 right-4 z-40 flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-3 text-[var(--accent-fg)] shadow-[var(--shadow-lg)] transition-transform active:scale-95 md:bottom-6"
          aria-label="Open assistant"
        >
          <Sparkles className="size-5" />
          <span className="display text-sm">Ask AI</span>
        </button>
      )}
    </>
  );
}

export default Assistant;
