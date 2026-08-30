// Rewards.
//
// Point values are entirely server-driven. Nothing here hardcodes what a game is worth
// or what a shirt costs -- the business model will change, and when it does this page
// should not need a deploy.

import { useState } from 'react';
import { Gift, Trophy, History, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useRewards, useRedeemReward, useCopy } from '../hooks/index.js';
import { useSession } from '../state/session.jsx';
import {
  Card, Tabs, TabsList, TabsTrigger, TabsContent, Skeleton, EmptyState, ErrorState,
  SectionHeading, Modal, Button,
} from '../components/ui/index.jsx';
import {
  RewardCard, AchievementCard, PointsMeter, RedemptionRow,
} from '../components/rewards/index.jsx';
import { compact, relativeTime } from '../lib/format.js';
import { STORE_URL } from '../lib/links.js';

const REASON_COPY = {
  game_played: 'Played a game',
  on_time_bonus: 'Arrived on time',
  motm: 'Man of the Match',
  referral: 'Referred a player',
  streak: 'Attendance streak',
  redemption: 'Reward claimed',
  refund: 'Refunded',
  expiry: 'Expired',
  manual_grant: 'Awarded',
  correction: 'Adjustment',
};

export default function Rewards() {
  const { isAuthenticated } = useSession();
  const { data, isLoading, isError, refetch } = useRewards(isAuthenticated);
  const redeem = useRedeemReward();
  const { copy } = useCopy();
  const [confirming, setConfirming] = useState(null);

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <EmptyState
          icon={Gift}
          title="Sign in to see your rewards"
          description="Every game you play earns points towards kit, free games and more."
          action={<Button to="/login">Sign in</Button>}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Skeleton className="h-40 rounded-[var(--radius-lg)]" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-44 rounded-[var(--radius-lg)]" />)}
        </div>
      </div>
    );
  }

  if (isError) {
    return <div className="mx-auto max-w-3xl px-4 py-16"><ErrorState onRetry={refetch} /></div>;
  }

  const { balance, rewards, history, redemptions, achievements } = data;
  // The cheapest reward still out of reach is the one worth showing progress towards.
  const nextReward = [...rewards]
    .filter((r) => r.pointCost > balance)
    .sort((a, b) => a.pointCost - b.pointCost)[0];

  const earned = achievements.filter((a) => a.earnedAt);
  const locked = achievements.filter((a) => !a.earnedAt);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Sports Fusion</p>
          <h1 className="display text-4xl sm:text-5xl">Rewards</h1>
        </div>
        {/* Points redeem into the shop, so the shop should be one tap from the points. */}
        <Button as="a" href={STORE_URL} target="_blank" rel="noreferrer" variant="secondary">
          Visit the store
        </Button>
      </header>

      <PointsMeter balance={balance} nextReward={nextReward} />

      <div className="mt-8">
        <Tabs defaultValue="catalogue">
          <TabsList className="mb-6">
            <TabsTrigger value="catalogue">Rewards</TabsTrigger>
            <TabsTrigger value="achievements">Achievements</TabsTrigger>
            <TabsTrigger value="history">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="catalogue" className="space-y-8 focus:outline-none">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rewards.map((reward) => (
                <RewardCard
                  key={reward.id}
                  reward={reward}
                  balance={balance}
                  redeeming={redeem.isPending && confirming?.id === reward.id}
                  onRedeem={setConfirming}
                />
              ))}
            </div>

            {redemptions.length > 0 && (
              <div>
                <SectionHeading eyebrow="Yours" title="Claimed" />
                <Card className="divide-y divide-[var(--border-subtle)]">
                  {redemptions.map((redemption) => (
                    <RedemptionRow
                      key={redemption.id}
                      redemption={redemption}
                      onCopyCode={async (code) => {
                        if (await copy(code)) toast.success('Code copied');
                      }}
                    />
                  ))}
                </Card>
              </div>
            )}
          </TabsContent>

          <TabsContent value="achievements" className="space-y-8 focus:outline-none">
            {earned.length > 0 && (
              <div>
                <SectionHeading eyebrow={`${earned.length} earned`} title="Your collection" />
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {earned.map((a) => <AchievementCard key={a.slug} achievement={a} />)}
                </div>
              </div>
            )}

            {locked.length > 0 && (
              <div>
                <SectionHeading eyebrow="In progress" title="Still to come" />
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {locked.map((a) => <AchievementCard key={a.slug} achievement={a} />)}
                </div>
              </div>
            )}

            {achievements.length === 0 && (
              <EmptyState
                icon={Trophy}
                title="No achievements yet"
                description="Your first one is waiting for you."
              />
            )}
          </TabsContent>

          <TabsContent value="history" className="focus:outline-none">
            {history.length === 0 ? (
              <EmptyState
                icon={History}
                title="Nothing here yet"
                description="Points from your first game will show up here."
              />
            ) : (
              <Card className="divide-y divide-[var(--border-subtle)]">
                {history.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{REASON_COPY[entry.reason] ?? entry.reason}</p>
                      <p className="text-xs text-[var(--fg-muted)]">
                        {entry.note} · {relativeTime(entry.at)}
                      </p>
                    </div>
                    <span
                      className={`display text-xl tnum ${
                        entry.delta > 0 ? 'text-[var(--accent)]' : 'text-[var(--fg-secondary)]'
                      }`}
                    >
                      {entry.delta > 0 ? '+' : ''}{compact(entry.delta)}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Modal
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `Claim ${confirming.name}?` : ''}
        description={
          confirming
            ? `${compact(confirming.pointCost)} points will come off your balance straight away.`
            : ''
        }
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setConfirming(null)}>
              Not yet
            </Button>
            <Button
              className="flex-1"
              loading={redeem.isPending}
              onClick={() => {
                redeem.mutate({ slug: confirming.slug });
                setConfirming(null);
              }}
            >
              <Check className="size-4" /> Claim it
            </Button>
          </>
        }
      >
        {confirming && (
          <div className="space-y-3 text-sm text-[var(--fg-secondary)]">
            <p>{confirming.description}</p>
            <div className="flex items-baseline justify-between rounded-[var(--radius-md)] bg-[var(--bg-sunken)] px-3 py-2.5">
              <span>Balance after</span>
              <span className="display text-xl tnum text-[var(--fg-primary)]">
                {compact(data.balance - confirming.pointCost)}
              </span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
