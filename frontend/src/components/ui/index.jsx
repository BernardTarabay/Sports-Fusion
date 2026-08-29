// Design system primitives.
//
// Grouped in one module because they share vocabulary and are always imported together.
// Anything with real behavioural complexity (dialogs, tabs, tooltips) is built on Radix
// rather than hand-rolled -- focus trapping and aria wiring is exactly the code you do
// not want to reinvent, and getting it wrong locks out keyboard and screen-reader users.

import { forwardRef } from 'react';
import { Link } from 'react-router';
import * as RadixTabs from '@radix-ui/react-tabs';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { initials } from '../../lib/format.js';

/* ========================================================================== */
/* Button                                                                      */
/* ========================================================================== */

const BUTTON_VARIANTS = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] shadow-sm',
  secondary:
    'bg-[var(--bg-surface)] text-[var(--fg-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-sunken)]',
  ghost: 'text-[var(--fg-secondary)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg-primary)]',
  danger: 'bg-[var(--danger)] text-white hover:brightness-110',
  trophy: 'bg-[var(--trophy)] text-[#231a02] hover:brightness-105 shadow-sm',
  inverse: 'bg-[var(--fg-primary)] text-[var(--bg-surface)] hover:opacity-90',
};

const BUTTON_SIZES = {
  // pointer-coarse raises this on touch devices only. 32px is fine under a mouse and
  // too small under a thumb -- and this app is used outdoors, at night, one-handed,
  // by someone also watching a football match.
  sm: 'h-8 pointer-coarse:h-11 px-3 pointer-coarse:px-4 text-[0.8125rem] gap-1.5 rounded-[var(--radius-sm)]',
  // 44px: the minimum comfortable touch target, and most of this app is used on a phone.
  md: 'h-11 px-4 text-sm gap-2 rounded-[var(--radius-md)]',
  lg: 'h-13 px-6 text-base gap-2.5 rounded-[var(--radius-md)]',
  icon: 'h-10 w-10 rounded-[var(--radius-md)]',
};

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', className, as, to, href, loading, disabled, children, ...props },
  ref
) {
  const classes = cn(
    'inline-flex items-center justify-center font-medium select-none',
    'transition-[background-color,border-color,color,transform,opacity] duration-150',
    'active:scale-[0.97] disabled:opacity-45 disabled:pointer-events-none',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className
  );

  const content = (
    <>
      {loading && (
        <span
          className="size-4 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"
          aria-hidden="true"
        />
      )}
      {children}
    </>
  );

  if (to) return <Link ref={ref} to={to} className={classes} {...props}>{content}</Link>;
  if (href) return <a ref={ref} href={href} className={classes} {...props}>{content}</a>;

  const Component = as ?? 'button';
  return (
    <Component
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </Component>
  );
});

/* ========================================================================== */
/* Card                                                                        */
/* ========================================================================== */

export function Card({ className, interactive, glow, as: Component = 'div', ...props }) {
  return (
    <Component
      className={cn(
        'card',
        interactive && 'card-interactive',
        glow && 'shadow-[var(--shadow-glow)]',
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('px-4 pt-4 pb-3 sm:px-5 sm:pt-5', className)} {...props} />;
}
export function CardBody({ className, ...props }) {
  return <div className={cn('px-4 pb-4 sm:px-5 sm:pb-5', className)} {...props} />;
}

/* ========================================================================== */
/* Badge                                                                       */
/* ========================================================================== */

const BADGE_TONES = {
  neutral: 'bg-[var(--bg-sunken)] text-[var(--fg-secondary)]',
  accent: 'bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]',
  trophy: 'bg-[var(--trophy-soft)] text-[var(--trophy-soft-fg)]',
  danger: 'bg-[var(--danger-soft)] text-[var(--danger-soft-fg)]',
  info: 'bg-[var(--info-soft)] text-[var(--info-soft-fg)]',
  outline: 'border border-[var(--border-default)] text-[var(--fg-secondary)]',
  solid: 'bg-[var(--fg-primary)] text-[var(--bg-surface)]',
};

export function Badge({ tone = 'neutral', size = 'md', className, children, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-medium rounded-full whitespace-nowrap',
        size === 'sm' ? 'text-[0.6875rem] px-2 py-0.5' : 'text-xs px-2.5 py-1',
        BADGE_TONES[tone],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/* ========================================================================== */
/* Avatar                                                                      */
/* ========================================================================== */

const AVATAR_SIZES = { xs: 'size-6 text-[0.625rem]', sm: 'size-8 text-xs', md: 'size-10 text-sm', lg: 'size-14 text-lg', xl: 'size-20 text-2xl' };

/**
 * Initials on a colour derived from the name, so a roster of 22 is visually
 * distinguishable without a single uploaded photo.
 */
export function Avatar({ name, src, size = 'md', className, ring }) {
  const hue = [...(name ?? '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  return (
    <span
      className={cn(
        'relative inline-grid place-items-center rounded-full font-semibold shrink-0 overflow-hidden',
        AVATAR_SIZES[size],
        ring && 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-surface)]',
        className
      )}
      style={
        src
          ? undefined
          : {
              background: `oklch(0.72 0.09 ${hue})`,
              color: 'oklch(0.22 0.05 ' + hue + ')',
            }
      }
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}

/* ========================================================================== */
/* Tabs                                                                        */
/* ========================================================================== */

export function Tabs({ value, onValueChange, children, className, ...props }) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} className={className} {...props}>
      {children}
    </RadixTabs.Root>
  );
}

export function TabsList({ className, children, ...props }) {
  return (
    <RadixTabs.List
      className={cn(
        // min-w-0: without it a flex item will not shrink below its content, and the
        // scroll container widens its parent instead of scrolling.
        'flex min-w-0 max-w-full gap-1 overflow-x-auto scrollbar-none p-1 rounded-[var(--radius-md)] bg-[var(--bg-sunken)]',
        className
      )}
      {...props}
    >
      {children}
    </RadixTabs.List>
  );
}

export function TabsTrigger({ className, children, ...props }) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'shrink-0 px-3.5 h-9 pointer-coarse:h-11 rounded-[var(--radius-sm)] text-sm font-medium whitespace-nowrap',
        'text-[var(--fg-secondary)] transition-colors',
        'data-[state=active]:bg-[var(--bg-surface)] data-[state=active]:text-[var(--fg-primary)] data-[state=active]:shadow-sm',
        className
      )}
      {...props}
    >
      {children}
    </RadixTabs.Trigger>
  );
}

export const TabsContent = RadixTabs.Content;

/* ========================================================================== */
/* Modal / Drawer                                                              */
/* ========================================================================== */

/**
 * One component, two presentations. On phones it is a bottom sheet, because a centred
 * dialog on a 375px screen is a bad bottom sheet.
 */
export function Modal({ open, onOpenChange, title, description, children, footer, size = 'md' }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-[fadeIn_150ms_ease-out]" />
        <RadixDialog.Content
          className={cn(
            'fixed z-50 bg-[var(--bg-surface)] shadow-[var(--shadow-lg)] focus:outline-none',
            'inset-x-0 bottom-0 rounded-t-[var(--radius-2xl)] max-h-[88svh] overflow-y-auto',
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2',
            'sm:rounded-[var(--radius-xl)] sm:max-h-[85vh] w-full',
            size === 'sm' && 'sm:max-w-sm',
            size === 'md' && 'sm:max-w-md',
            size === 'lg' && 'sm:max-w-2xl',
            size === 'xl' && 'sm:max-w-4xl'
          )}
        >
          {/* Grab handle: signals "drag me" on touch, hidden on desktop. */}
          <div className="sm:hidden sticky top-0 flex justify-center pt-3 pb-1 bg-[var(--bg-surface)]">
            <div className="h-1 w-10 rounded-full bg-[var(--border-strong)]" />
          </div>

          <div className="flex items-start justify-between gap-4 px-5 pt-4 sm:pt-5">
            <div className="min-w-0">
              <RadixDialog.Title className="display text-xl sm:text-2xl">{title}</RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-1 text-sm text-[var(--fg-secondary)]">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <button
                className="shrink-0 grid place-items-center size-9 -mr-1 rounded-[var(--radius-md)] text-[var(--fg-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg-primary)]"
                aria-label="Close"
              >
                <X className="size-5" />
              </button>
            </RadixDialog.Close>
          </div>

          <div className="px-5 py-4">{children}</div>

          {footer && (
            <div className="sticky bottom-0 flex gap-2 px-5 py-4 pb-safe border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/* ========================================================================== */
/* Tooltip                                                                     */
/* ========================================================================== */

export const TooltipProvider = RadixTooltip.Provider;

export function Tooltip({ label, children, side = 'top' }) {
  if (!label) return children;
  return (
    <RadixTooltip.Root delayDuration={250}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-56 rounded-[var(--radius-sm)] bg-[var(--fg-primary)] px-2.5 py-1.5 text-xs font-medium text-[var(--bg-surface)] shadow-[var(--shadow-md)]"
        >
          {label}
          <RadixTooltip.Arrow className="fill-[var(--fg-primary)]" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/* ========================================================================== */
/* Form controls                                                               */
/* ========================================================================== */

export const Input = forwardRef(function Input({ className, invalid, ...props }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full h-11 px-3.5 rounded-[var(--radius-md)] text-sm',
        'bg-[var(--bg-surface)] text-[var(--fg-primary)]',
        'border border-[var(--border-default)] placeholder:text-[var(--fg-muted)]',
        'transition-colors focus:border-[var(--accent)]',
        'aria-[invalid=true]:border-[var(--danger)]',
        className
      )}
      {...props}
    />
  );
});

export const Select = forwardRef(function Select({ className, children, ...props }, ref) {
  // Styling lives in .select-field (styles/index.css). It cannot live in utility classes:
  // the chevron is a data URI containing spaces, and a class attribute is split on
  // whitespace, which shredded the class list and left the control transparent.
  return (
    <select ref={ref} className={cn('select-field', className)} {...props}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, htmlFor, children, className }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-[var(--fg-primary)]">
          {label}
        </label>
      )}
      {children}
      {/* Errors are announced, not just coloured -- red text is invisible to a screen
          reader and to a good portion of players. */}
      {error ? (
        <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>
      ) : hint ? (
        <p className="text-xs text-[var(--fg-muted)]">{hint}</p>
      ) : null}
    </div>
  );
}

/** Segmented control: the mobile-friendly alternative to a row of radio buttons. */
export function Segmented({ options, value, onChange, className, size = 'md' }) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-sunken)] overflow-x-auto scrollbar-none max-w-full',
        className
      )}
    >
      {options.map((option) => {
        // `value` or `key`, because both get written and silently accepting only one
        // means the other passes the whole option object to onChange -- which does not
        // throw, does not warn, and leaves the control looking dead. `??` rather than
        // `||` so a legitimate 0 or '' still counts.
        const key = option.value ?? option.key ?? option;
        const label = option.label ?? option;
        const active = key === value;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              'shrink-0 rounded-[var(--radius-sm)] font-medium whitespace-nowrap transition-colors',
              size === 'sm'
                ? 'h-7 pointer-coarse:h-10 px-2.5 pointer-coarse:px-3.5 text-xs'
                : 'h-9 pointer-coarse:h-11 px-3.5 text-sm',
              active
                ? 'bg-[var(--bg-surface)] text-[var(--fg-primary)] shadow-sm'
                : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* ========================================================================== */
/* Feedback states                                                             */
/* ========================================================================== */

export function Skeleton({ className, ...props }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" {...props} />;
}

/**
 * Empty states say what to do next, never "No data found". An empty screen is a
 * conversation, and the product has an opinion about what should happen.
 */
export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center text-center py-14 px-6', className)}>
      {Icon && (
        <div className="grid place-items-center size-14 rounded-full bg-[var(--bg-sunken)] mb-4">
          <Icon className="size-6 text-[var(--fg-muted)]" aria-hidden="true" />
        </div>
      )}
      <h3 className="display text-xl text-[var(--fg-primary)]">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-xs text-sm text-[var(--fg-secondary)]">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', description, onRetry, className }) {
  return (
    <div className={cn('flex flex-col items-center text-center py-12 px-6', className)} role="alert">
      <h3 className="display text-xl">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-[var(--fg-secondary)]">{description}</p>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/* ========================================================================== */
/* Progress                                                                    */
/* ========================================================================== */

export function Progress({ value, max = 100, tone = 'accent', className, label }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const colour =
    tone === 'danger' ? 'var(--danger)' : tone === 'trophy' ? 'var(--trophy)' : 'var(--accent)';

  return (
    <div
      className={cn('h-2 w-full rounded-full bg-[var(--bg-sunken)] overflow-hidden', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-[var(--ease-out-quint)]"
        style={{ width: `${pct}%`, background: colour }}
      />
    </div>
  );
}

/* ========================================================================== */
/* Layout helpers                                                              */
/* ========================================================================== */

export function SectionHeading({ eyebrow, title, action, className }) {
  return (
    <div className={cn('flex items-end justify-between gap-4 mb-4', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h2 className="display text-2xl sm:text-3xl">{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function StatCard({ label, value, sub, tone = 'neutral', icon: Icon, className }) {
  return (
    <Card className={cn('p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="eyebrow text-[0.6875rem]">{label}</p>
        {Icon && <Icon className="size-4 text-[var(--fg-muted)] shrink-0" aria-hidden="true" />}
      </div>
      <p
        className={cn(
          'display text-3xl mt-2 tnum',
          tone === 'accent' && 'text-[var(--accent)]',
          tone === 'trophy' && 'text-[var(--trophy)]',
          tone === 'danger' && 'text-[var(--danger)]'
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-[var(--fg-secondary)]">{sub}</p>}
    </Card>
  );
}
