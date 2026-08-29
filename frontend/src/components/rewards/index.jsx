// Rewards and achievements.
//
// Achievements are meant to feel collectible, so they are cards with a tier and a
// visible lock state rather than rows in a list. A locked one shows how far away it is:
// "47 / 100" is motivating in a way that a grey badge is not.

import {
  Trophy, Shield, Target, Wand2, Crown, Crosshair, Infinity as InfinityIcon, Flag, BrickWall,
  Lock, Gift, Check, Clock,
} from 'lucide-react';
import { cn } from '../../lib/cn.js';
import { Badge, Button, Card, Progress } from '../ui/index.jsx';
import { compact, relativeTime } from '../../lib/format.js';

const ICONS = {
  trophy: Trophy, shield: Shield, target: Target, wand: Wand2, crown: Crown,
  crosshair: Crosshair, infinity: InfinityIcon, flag: Flag, brick: BrickWall,
};

const TIERS = {
  bronze: { ring: '#b87333', glow: 'rgb(184 115 51 / 0.16)', label: 'Bronze' },
  silver: { ring: '#9aa5b1', glow: 'rgb(154 165 177 / 0.16)', label: 'Silver' },
  gold: { ring: '#f5c451', glow: 'rgb(245 196 81 / 0.18)', label: 'Gold' },
  platinum: { ring: '#7fd8c2', glow: 'rgb(127 216 194 / 0.18)', label: 'Platinum' },
};

export function AchievementCard({ achievement, className }) {
  const Icon = ICONS[achievement.icon] ?? Trophy;
  const tier = TIERS[achievement.tier] ?? TIERS.bronze;
  const earned = !!achievement.earnedAt;
  const progress = Math.min(1, (achievement.progress ?? 0) / (achievement.target ?? 1));

  return (
    <Card
      className={cn(
        'relative overflow-hidden p-4 transition-transform',
        earned ? 'card-interactive' : 'opacity-80',
        className
      )}
      style={earned ? { boxShadow: `0 0 0 1px ${tier.ring}40, 0 0 22px -8px ${tier.glow}` } : undefined}
    >
      <div className="flex items-start gap-3">
        <div
          className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)]"
          style={{
            background: earned ? tier.glow : 'var(--bg-sunken)',
            color: earned ? tier.ring : 'var(--fg-muted)',
          }}
        >
          {earned ? <Icon className="size-5" aria-hidden="true" /> : <Lock className="size-4" aria-hidden="true" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="display text-lg leading-tight">{achievement.name}</p>
            {earned && (
              <span className="text-[0.625rem] font-semibold uppercase tracking-wide" style={{ color: tier.ring }}>
                {tier.label}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-[var(--fg-secondary)]">{achievement.description}</p>

          {earned ? (
            <p className="mt-2 flex items-center gap-1 text-[0.6875rem] text-[var(--fg-muted)]">
              <Check className="size-3" aria-hidden="true" />
              Earned {relativeTime(achievement.earnedAt)}
            </p>
          ) : (
            <div className="mt-2.5">
              <Progress value={progress * 100} label={achievement.name} />
              <p className="mt-1 text-[0.6875rem] text-[var(--fg-muted)] tnum">
                {achievement.progress} / {achievement.target}
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ==========================================================================
   RewardCard
   ========================================================================== */

const BLOCKED_COPY = {
  INSUFFICIENT_POINTS: (b) => `${compact(b.short)} more points`,
  OUT_OF_STOCK: () => 'Out of stock',
  LIMIT_REACHED: () => 'Already claimed',
  NOT_ENOUGH_GAMES: (b) => `${b.needs} more game${b.needs === 1 ? '' : 's'}`,
};

export function RewardCard({ reward, balance = 0, onRedeem, redeeming, className }) {
  const progress = Math.min(1, balance / reward.pointCost);
  const blocked = reward.blockedBy ?? [];
  const canRedeem = reward.canRedeem ?? blocked.length === 0;

  return (
    <Card className={cn('flex flex-col p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="display text-xl leading-tight">{reward.name}</p>
          {reward.description && (
            <p className="mt-1 text-xs text-[var(--fg-secondary)]">{reward.description}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="display text-2xl tnum text-[var(--accent)]">{compact(reward.pointCost)}</p>
          <p className="eyebrow text-[0.5625rem]">points</p>
        </div>
      </div>

      {reward.stockRemaining != null && reward.stockRemaining <= 10 && (
        <p className="mt-2 text-[0.6875rem] text-[var(--trophy)]">
          {reward.stockRemaining === 0 ? 'None left' : `Only ${reward.stockRemaining} left`}
        </p>
      )}

      {!canRedeem && progress < 1 && (
        <div className="mt-3">
          <Progress value={progress * 100} label={`Progress towards ${reward.name}`} />
          <p className="mt-1.5 text-[0.6875rem] text-[var(--fg-muted)] tnum">
            {compact(balance)} / {compact(reward.pointCost)}
          </p>
        </div>
      )}

      <div className="mt-4 flex-1" />

      <Button
        className="w-full"
        variant={canRedeem ? 'primary' : 'secondary'}
        disabled={!canRedeem}
        loading={redeeming}
        onClick={() => onRedeem?.(reward)}
      >
        {canRedeem
          ? 'Claim reward'
          : blocked.length > 0
            ? (BLOCKED_COPY[blocked[0].code]?.(blocked[0]) ?? 'Not available')
            : 'Not available'}
      </Button>
    </Card>
  );
}

/* ==========================================================================
   PointsMeter — the balance, and the next thing worth saving for
   ========================================================================== */

export function PointsMeter({ balance, nextReward, className }) {
  const progress = nextReward ? Math.min(1, balance / nextReward.pointCost) : 1;

  return (
    <Card className={cn('floodlit relative overflow-hidden p-5 sm:p-6', className)}>
      <p className="eyebrow">Your points</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="display text-6xl leading-none tnum">{compact(balance)}</span>
        <span className="display text-2xl text-[var(--accent)]">SF</span>
      </div>

      {nextReward && (
        <div className="mt-6">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="text-[var(--fg-secondary)]">Next up</span>
            <span className="font-semibold">{nextReward.name}</span>
          </div>
          <Progress value={progress * 100} label={`Progress towards ${nextReward.name}`} />
          <p className="mt-1.5 text-xs text-[var(--fg-muted)] tnum">
            {compact(balance)} / {compact(nextReward.pointCost)}
            {progress < 1 && ` · ${compact(nextReward.pointCost - balance)} to go`}
          </p>
        </div>
      )}
    </Card>
  );
}

/* ==========================================================================
   RedemptionRow
   ========================================================================== */

const STATUS_COPY = {
  pending: { label: 'Preparing', tone: 'info', icon: Clock },
  fulfilling: { label: 'Preparing', tone: 'info', icon: Clock },
  fulfilled: { label: 'Ready', tone: 'accent', icon: Check },
  refunded: { label: 'Refunded', tone: 'neutral', icon: null },
  failed: { label: 'Refunded', tone: 'neutral', icon: null },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: null },
};

export function RedemptionRow({ redemption, onCopyCode, className }) {
  const status = STATUS_COPY[redemption.status] ?? STATUS_COPY.pending;
  const Icon = status.icon;

  return (
    <div className={cn('flex items-center gap-3 px-4 py-3', className)}>
      <div className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--bg-sunken)]">
        <Gift className="size-4 text-[var(--fg-secondary)]" aria-hidden="true" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{redemption.rewardName}</p>
        <p className="text-xs text-[var(--fg-muted)] tnum">
          −{compact(redemption.pointsSpent)} points · {relativeTime(redemption.createdAt)}
        </p>
      </div>

      {redemption.status === 'fulfilled' && redemption.discountCode ? (
        <button
          onClick={() => onCopyCode?.(redemption.discountCode)}
          className="rounded-[var(--radius-sm)] border border-dashed border-[var(--accent)] px-2.5 py-1.5 font-mono text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          {redemption.discountCode}
        </button>
      ) : (
        <Badge tone={status.tone} size="sm">
          {Icon && <Icon className="size-3" aria-hidden="true" />} {status.label}
        </Badge>
      )}
    </div>
  );
}
