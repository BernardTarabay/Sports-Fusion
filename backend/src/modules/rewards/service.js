// Rewards: catalogue, redemption, fulfilment, refunds, and liability.
//
// THE SHAPE OF A REDEMPTION, AND WHY IT IS SPLIT IN TWO
//
// Deducting points is a database write we control. Issuing a Shopify discount code is an
// external call we do not. Doing both in one transaction means either holding a
// transaction open across a network call, or being unable to roll back the half that
// already happened.
//
// So redemption is synchronous and fulfilment is asynchronous:
//
//   1. redeem()   -- locks the player row, checks the balance and stock, deducts the
//                    points, reserves the stock, creates a `pending` redemption. All in
//                    one transaction. The player cannot spend those points again the
//                    instant this commits.
//   2. fulfil()   -- the worker claims the pending row, calls Shopify, and settles it to
//                    `fulfilled` with a code. If Shopify permanently refuses, it REFUNDS
//                    the points and returns the stock.
//
// The failure mode this rules out is the expensive one: points taken and nothing
// delivered, with no record of what was owed.

import { withTransaction, query } from '../../database/pool.js';
import { publish, EventTypes } from '../../lib/events.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { createDiscountCode, generateCode } from '../../integrations/shopify/client.js';

// How long a player has to use a code before it expires. Long enough not to be a trick,
// short enough that outstanding liability does not accumulate forever.
const CODE_VALIDITY_DAYS = 90;
const MAX_FULFILMENT_ATTEMPTS = 4;
const STALE_FULFILLING_MINUTES = 10;

function shapeReward(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    pointCost: row.point_cost,
    fulfilmentType: row.fulfilment_type,
    discountPercent: row.discount_percent == null ? null : Number(row.discount_percent),
    valueAmount: row.value_amount == null ? null : Number(row.value_amount),
    currency: row.currency,
    stockRemaining: row.stock_remaining,
    maxPerPlayer: row.max_per_player,
    minGamesPlayed: row.min_games_played,
    isActive: row.is_active,
  };
}

export async function listCatalogue({ playerId, includeInactive = false } = {}) {
  const { rows } = await query(
    `SELECT rc.*,
            (SELECT count(*)::int FROM reward_redemptions rr
              WHERE rr.reward_id = rc.id AND rr.player_id = $1
                AND rr.status NOT IN ('cancelled', 'refunded', 'failed')) AS redeemed_by_player
       FROM reward_catalogue rc
      WHERE ($2 OR rc.is_active)
      ORDER BY rc.sort_order, rc.point_cost`,
    [playerId ?? null, includeInactive]
  );

  let player = null;
  if (playerId) {
    const { rows: playerRows } = await query(
      `SELECT p.points_balance,
              (SELECT count(*)::int FROM registrations r
                WHERE r.player_id = p.id AND r.attendance IN ('attended', 'late')) AS games
         FROM players p WHERE p.id = $1`,
      [playerId]
    );
    player = playerRows[0] ?? null;
  }

  return rows.map((row) => {
    const reward = shapeReward(row);
    if (!player) return reward;

    // Tell the player exactly why they cannot have it, rather than showing a dead button.
    const reasons = [];
    if (player.points_balance < row.point_cost) {
      reasons.push({ code: 'INSUFFICIENT_POINTS', short: row.point_cost - player.points_balance });
    }
    if (row.stock_remaining === 0) reasons.push({ code: 'OUT_OF_STOCK' });
    if (row.max_per_player != null && row.redeemed_by_player >= row.max_per_player) {
      reasons.push({ code: 'LIMIT_REACHED' });
    }
    if (player.games < row.min_games_played) {
      reasons.push({ code: 'NOT_ENOUGH_GAMES', needs: row.min_games_played - player.games });
    }

    return {
      ...reward,
      redeemedByPlayer: row.redeemed_by_player,
      canRedeem: reasons.length === 0,
      blockedBy: reasons,
    };
  });
}

/**
 * Spend points on a reward.
 *
 * Race safety comes from locking the player row first: two tabs redeeming at once are
 * serialised by Postgres, the second re-reads the balance, and the CHECK on
 * players.points_balance is the seatbelt if any future code path forgets.
 *
 * `idempotencyKey` makes a double-tapped button charge once.
 */
export async function redeem({ playerId, rewardSlug, idempotencyKey = null, actorUserId }) {
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        `SELECT id, status, points_spent, discount_code FROM reward_redemptions
          WHERE player_id = $1 AND idempotency_key = $2`,
        [playerId, idempotencyKey]
      );
      if (existing.length > 0) {
        return { ...existing[0], deduplicated: true };
      }
    }

    // Lock the spender before reading their balance. Everything else follows from this.
    const { rows: playerRows } = await client.query(
      `SELECT id, user_id, points_balance FROM players WHERE id = $1 FOR UPDATE`,
      [playerId]
    );
    if (playerRows.length === 0) throw new NotFoundError('Player');
    const player = playerRows[0];

    const { rows: rewardRows } = await client.query(
      `SELECT * FROM reward_catalogue WHERE slug = $1 FOR UPDATE`, [rewardSlug]
    );
    if (rewardRows.length === 0) throw new NotFoundError('Reward');
    const reward = rewardRows[0];

    if (!reward.is_active) {
      throw new ConflictError('That reward is no longer available', 'REWARD_INACTIVE');
    }
    if (player.points_balance < reward.point_cost) {
      throw new ConflictError(
        `That costs ${reward.point_cost} points and you have ${player.points_balance}`,
        'INSUFFICIENT_POINTS',
        { required: reward.point_cost, balance: player.points_balance }
      );
    }
    if (reward.stock_remaining === 0) {
      throw new ConflictError('That reward is out of stock', 'OUT_OF_STOCK');
    }

    if (reward.max_per_player != null) {
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM reward_redemptions
          WHERE reward_id = $1 AND player_id = $2
            AND status NOT IN ('cancelled', 'refunded', 'failed')`,
        [reward.id, playerId]
      );
      if (countRows[0].n >= reward.max_per_player) {
        throw new ConflictError(
          `You have already claimed this ${reward.max_per_player} time(s)`, 'LIMIT_REACHED'
        );
      }
    }

    if (reward.min_games_played > 0) {
      const { rows: gameRows } = await client.query(
        `SELECT count(*)::int AS n FROM registrations
          WHERE player_id = $1 AND attendance IN ('attended', 'late')`,
        [playerId]
      );
      if (gameRows[0].n < reward.min_games_played) {
        throw new ConflictError(
          `Play ${reward.min_games_played} games to unlock this`, 'NOT_ENOUGH_GAMES',
          { needs: reward.min_games_played - gameRows[0].n }
        );
      }
    }

    // The spend. Negative delta; the trigger updates the cached balance and the CHECK
    // constraint refuses to let it go below zero.
    const { rows: txRows } = await client.query(
      `INSERT INTO point_transactions
         (player_id, delta, reason, reference_type, reference_id, liability_value, created_by)
       VALUES ($1, $2, 'redemption', 'reward', $3, $4, $5)
       RETURNING id`,
      [
        playerId, -reward.point_cost, reward.id,
        // Negative: redeeming reduces outstanding liability by the value of the points.
        reward.unit_cost == null ? null : -Number(reward.unit_cost),
        actorUserId ?? null,
      ]
    );

    if (reward.stock_remaining != null) {
      await client.query(
        `UPDATE reward_catalogue SET stock_remaining = stock_remaining - 1 WHERE id = $1`,
        [reward.id]
      );
    }

    const { rows: redemptionRows } = await client.query(
      `INSERT INTO reward_redemptions
         (player_id, reward_id, transaction_id, points_spent, status,
          idempotency_key, unit_cost_at_redemption, currency, code_expires_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7, now() + ($8 || ' days')::interval)
       RETURNING id, status, points_spent, created_at`,
      [
        playerId, reward.id, txRows[0].id, reward.point_cost,
        idempotencyKey, reward.unit_cost, reward.currency, CODE_VALIDITY_DAYS,
      ]
    );
    const redemption = redemptionRows[0];

    await publish(client, {
      eventType: EventTypes.RewardRedeemed,
      aggregateType: 'reward_redemption',
      aggregateId: redemption.id,
      actorUserId,
      payload: {
        redemptionId: redemption.id,
        playerId,
        rewardId: reward.id,
        rewardName: reward.name,
        pointsSpent: reward.point_cost,
      },
    });

    logger.info(
      { playerId, reward: reward.slug, points: reward.point_cost },
      'reward redeemed'
    );

    return {
      id: redemption.id,
      status: redemption.status,
      pointsSpent: redemption.points_spent,
      reward: shapeReward(reward),
      balanceAfter: player.points_balance - reward.point_cost,
      deduplicated: false,
    };
  });
}

/**
 * Fulfil pending redemptions. Called by the worker.
 *
 * Claim-call-settle, the same pattern as the notification sender and for the same reason:
 * a Shopify call cannot be rolled back, so the claim commits first and a crash leaves a
 * visible orphan rather than a silent double-issue.
 */
export async function fulfilPending({ batchSize = 10 } = {}) {
  const stats = { fulfilled: 0, retrying: 0, refunded: 0 };

  for (let i = 0; i < batchSize; i += 1) {
    const claimed = await claimOnePending();
    if (!claimed) break;

    try {
      const result = await issueReward(claimed);
      await settleFulfilled(claimed, result);
      stats.fulfilled += 1;
    } catch (err) {
      const outcome = await settleFailure(claimed, err);
      if (outcome === 'refunded') stats.refunded += 1;
      else stats.retrying += 1;
    }
  }

  return stats;
}

async function claimOnePending() {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `WITH claimed AS (
         SELECT id FROM reward_redemptions
          WHERE status = 'pending'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE reward_redemptions r
          SET status = 'fulfilling', attempts = r.attempts + 1
         FROM claimed
        WHERE r.id = claimed.id
       RETURNING r.id, r.player_id, r.reward_id, r.transaction_id, r.points_spent,
                 r.attempts, r.code_expires_at, r.currency`
    );
    if (rows.length === 0) return null;

    const { rows: rewardRows } = await client.query(
      `SELECT slug, name, fulfilment_type, discount_percent, value_amount,
              shopify_variant_id, currency
         FROM reward_catalogue WHERE id = $1`,
      [rows[0].reward_id]
    );

    return { ...rows[0], reward: rewardRows[0] };
  });
}

async function issueReward(redemption) {
  const { reward } = redemption;

  switch (reward.fulfilment_type) {
    case 'shopify_discount':
    case 'shopify_product': {
      const code = generateCode('SF');
      return createDiscountCode({
        code,
        percentage: reward.discount_percent == null ? undefined : Number(reward.discount_percent),
        amount: reward.value_amount == null ? undefined : Number(reward.value_amount),
        currency: reward.currency,
        expiresAt: redemption.code_expires_at,
        title: `${reward.name} (${redemption.id})`,
      });
    }

    case 'free_game':
    case 'manual':
      // Nothing external to call. An admin honours it, and the record is the instruction.
      return { code: null, discountId: null, dryRun: false };

    default:
      throw Object.assign(
        new Error(`Unknown fulfilment type: ${reward.fulfilment_type}`),
        { permanent: true }
      );
  }
}

async function settleFulfilled(redemption, result) {
  await query(
    `UPDATE reward_redemptions
        SET status = 'fulfilled', fulfilled_at = now(), discount_code = $2,
            shopify_order_id = $3, error = NULL
      WHERE id = $1`,
    [redemption.id, result.code ?? null, result.discountId ?? null]
  );
}

async function settleFailure(redemption, err) {
  const permanent = err.permanent === true || redemption.attempts >= MAX_FULFILMENT_ATTEMPTS;

  if (!permanent) {
    await query(
      `UPDATE reward_redemptions SET status = 'pending', error = $2 WHERE id = $1`,
      [redemption.id, String(err.message).slice(0, 2000)]
    );
    logger.warn({ redemptionId: redemption.id, err }, 'fulfilment failed; will retry');
    return 'retrying';
  }

  // Out of retries, or a failure that will never succeed. Give the points back rather
  // than leaving a player charged for nothing.
  await refundRedemption({
    redemptionId: redemption.id,
    reason: `fulfilment failed: ${String(err.message).slice(0, 300)}`,
    status: 'failed',
  });
  logger.error({ redemptionId: redemption.id, err }, 'fulfilment failed permanently; refunded');
  return 'refunded';
}

/**
 * Return the points and the stock.
 *
 * The original spend is never deleted. A refund is a new positive transaction, so the
 * ledger shows what happened: charged, then refunded, and why.
 */
export async function refundRedemption({
  redemptionId, reason, status = 'refunded', actorUserId = null,
}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, player_id, reward_id, points_spent, status, unit_cost_at_redemption,
              refund_transaction_id
         FROM reward_redemptions WHERE id = $1 FOR UPDATE`,
      [redemptionId]
    );
    if (rows.length === 0) throw new NotFoundError('Redemption');
    const redemption = rows[0];

    if (redemption.refund_transaction_id) {
      return { alreadyRefunded: true, redemptionId };
    }
    if (redemption.status === 'fulfilled') {
      throw new ConflictError(
        'That reward was already fulfilled; cancel the discount code in Shopify first',
        'ALREADY_FULFILLED'
      );
    }

    const { rows: txRows } = await client.query(
      `INSERT INTO point_transactions
         (player_id, delta, reason, reference_type, reference_id, liability_value, created_by)
       VALUES ($1, $2, 'refund', 'reward', $3, $4, $5)
       RETURNING id`,
      [
        redemption.player_id, redemption.points_spent, redemption.reward_id,
        redemption.unit_cost_at_redemption == null ? null : Number(redemption.unit_cost_at_redemption),
        actorUserId,
      ]
    );

    await client.query(
      `UPDATE reward_catalogue
          SET stock_remaining = stock_remaining + 1
        WHERE id = $1 AND stock_remaining IS NOT NULL`,
      [redemption.reward_id]
    );

    await client.query(
      `UPDATE reward_redemptions
          SET status = $2, refund_transaction_id = $3, error = $4
        WHERE id = $1`,
      [redemptionId, status, txRows[0].id, reason ?? null]
    );

    return { refunded: true, redemptionId, pointsReturned: redemption.points_spent };
  });
}

/** Return redemptions abandoned by a worker that died mid-call. */
export async function reclaimStaleFulfilments() {
  const { rowCount } = await query(
    `UPDATE reward_redemptions
        SET status = 'pending', error = 'reclaimed after worker restart'
      WHERE status = 'fulfilling'
        AND updated_at < now() - ($1 || ' minutes')::interval`,
    [STALE_FULFILLING_MINUTES]
  );
  if (rowCount > 0) logger.warn({ reclaimed: rowCount }, 'reclaimed stale fulfilments');
  return rowCount;
}

export async function listRedemptions({ playerId, status, limit = 50, offset = 0 }) {
  const params = [limit, offset];
  const conditions = [];

  if (playerId) { params.push(playerId); conditions.push(`rr.player_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`rr.status = $${params.length}`); }

  const { rows } = await query(
    `SELECT rr.id, rr.status, rr.points_spent, rr.discount_code, rr.created_at,
            rr.fulfilled_at, rr.code_expires_at, rr.error,
            rc.name AS reward_name, rc.slug AS reward_slug, rc.fulfilment_type,
            u.display_name AS player_name
       FROM reward_redemptions rr
       JOIN reward_catalogue rc ON rc.id = rr.reward_id
       JOIN players p ON p.id = rr.player_id
       JOIN users u ON u.id = p.user_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY rr.created_at DESC
      LIMIT $1 OFFSET $2`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    pointsSpent: r.points_spent,
    // A code is only shown once fulfilled, and never for a refunded one.
    discountCode: r.status === 'fulfilled' ? r.discount_code : null,
    rewardName: r.reward_name,
    rewardSlug: r.reward_slug,
    fulfilmentType: r.fulfilment_type,
    playerName: r.player_name,
    createdAt: r.created_at,
    fulfilledAt: r.fulfilled_at,
    expiresAt: r.code_expires_at,
    error: r.error,
  }));
}

// ---------------------------------------------------------------------------
// Catalogue management
// ---------------------------------------------------------------------------

export async function upsertReward({ slug, patch, actorUserId }) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT * FROM reward_catalogue WHERE slug = $1', [slug]
    );

    const columns = {
      name: patch.name,
      description: patch.description,
      point_cost: patch.pointCost,
      unit_cost: patch.unitCost,
      currency: patch.currency,
      fulfilment_type: patch.fulfilmentType,
      shopify_variant_id: patch.shopifyVariantId,
      discount_percent: patch.discountPercent,
      value_amount: patch.valueAmount,
      stock_remaining: patch.stockRemaining,
      max_per_player: patch.maxPerPlayer,
      min_games_played: patch.minGamesPlayed,
      is_active: patch.isActive,
      sort_order: patch.sortOrder,
    };

    let reward;
    if (existing.length === 0) {
      const keys = Object.keys(columns).filter((k) => columns[k] !== undefined);
      const values = keys.map((k) => columns[k]);
      const { rows } = await client.query(
        `INSERT INTO reward_catalogue (slug, ${keys.join(', ')})
         VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
         RETURNING *`,
        [slug, ...values]
      );
      reward = rows[0];
    } else {
      const sets = [];
      const params = [slug];
      for (const [column, value] of Object.entries(columns)) {
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) return { reward: shapeReward(existing[0]), economics: economicsFor(existing[0]) };

      const { rows } = await client.query(
        `UPDATE reward_catalogue SET ${sets.join(', ')} WHERE slug = $1 RETURNING *`, params
      );
      reward = rows[0];
    }

    await client.query(
      `INSERT INTO admin_actions (actor_user_id, action, entity_type, entity_id, before, after)
       VALUES ($1, $2, 'reward', $3, $4::jsonb, $5::jsonb)`,
      [
        actorUserId, existing.length === 0 ? 'create_reward' : 'update_reward', reward.id,
        JSON.stringify(existing[0] ?? null), JSON.stringify(reward),
      ]
    );

    return { reward: shapeReward(reward), economics: economicsFor(reward) };
  });
}

/**
 * What this reward actually implies about the value of a point.
 *
 * Returned on every catalogue write so the number is in front of whoever is setting the
 * price. `impliedPointValue` is what Sports Fusion pays per point when this reward is
 * redeemed; `gamesPerRedemption` is how often a regular player can claim it.
 */
export function economicsFor(reward) {
  const unitCost = reward.unit_cost == null ? null : Number(reward.unit_cost);
  const pointCost = reward.point_cost;

  return {
    pointCost,
    unitCost,
    impliedPointValue: unitCost == null ? null : Number((unitCost / pointCost).toFixed(6)),
    // A player earns 125 points for turning up on time to a game.
    gamesPerRedemption: Number((pointCost / 125).toFixed(1)),
  };
}

/**
 * The number the owners need: what do we owe, and how fast is it growing.
 *
 * Concentration matters as much as the total. 400,000 outstanding points spread across
 * 2,000 players is a marketing cost; the same total held by nine people is an ambush.
 */
export async function getLiabilityReport({ days = 90 } = {}) {
  const [totals, flow, concentration, pending] = await Promise.all([
    query('SELECT * FROM reward_liability'),
    query(
      `SELECT
         COALESCE(SUM(delta) FILTER (WHERE delta > 0), 0)::int      AS issued,
         COALESCE(ABS(SUM(delta) FILTER (WHERE delta < 0)), 0)::int AS spent,
         count(DISTINCT player_id) FILTER (WHERE delta > 0)::int    AS earners
       FROM point_transactions
        WHERE created_at > now() - ($1 || ' days')::interval`,
      [days]
    ),
    query(
      `SELECT player_id, display_name, points_balance
         FROM player_point_balances
        WHERE points_balance > 0
        ORDER BY points_balance DESC
        LIMIT 10`
    ),
    query(
      `SELECT count(*)::int AS n, COALESCE(SUM(points_spent), 0)::int AS points
         FROM reward_redemptions WHERE status IN ('pending', 'fulfilling')`
    ),
  ]);

  const outstanding = totals.rows[0];
  const window = flow.rows[0];
  const top = concentration.rows;

  const totalOutstanding = Number(outstanding.outstanding_points);
  const heldByTopTen = top.reduce((sum, r) => sum + r.points_balance, 0);

  return {
    windowDays: days,
    outstandingPoints: totalOutstanding,
    outstandingValue: Number(outstanding.outstanding_value ?? 0),
    playersHolding: Number(outstanding.players_holding),
    issuedInWindow: window.issued,
    spentInWindow: window.spent,
    // Above 1 the liability is growing. Sustained, that is a problem the catalogue has to
    // solve, not the earn rate.
    issueToSpendRatio: window.spent === 0
      ? null
      : Number((window.issued / window.spent).toFixed(2)),
    redemptionRate: window.issued === 0
      ? null
      : Number((window.spent / window.issued).toFixed(3)),
    concentration: {
      topTenPoints: heldByTopTen,
      topTenShare: totalOutstanding === 0
        ? null
        : Number((heldByTopTen / totalOutstanding).toFixed(3)),
      topHolders: top.map((r) => ({
        playerId: r.player_id, name: r.display_name, points: r.points_balance,
      })),
    },
    awaitingFulfilment: { count: pending.rows[0].n, points: pending.rows[0].points },
  };
}

/**
 * Everything the rewards screen needs, in one call.
 *
 * Balance, what it has been spent on, what has been earned, and the achievement list with
 * the player's progress marked on it. Four queries and one round trip, because the page
 * renders them as a single view and four separate fetches means four separate loading
 * states for one screen.
 *
 * The achievement list is the full catalogue, not just what the player has: the locked
 * ones are the point of the screen.
 */
export async function getRewardsOverview(playerId) {
  const [balance, history, redemptions, achievements] = await Promise.all([
    query(`SELECT points_balance FROM players WHERE id = $1`, [playerId]),
    query(
      `SELECT id, delta, reason, reference_type, reference_id, created_at
         FROM point_transactions
        WHERE player_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [playerId]
    ),
    query(
      `SELECT r.id, r.status, r.points_spent, r.created_at, r.fulfilled_at,
              c.slug, c.name
         FROM reward_redemptions r
         JOIN reward_catalogue c ON c.id = r.reward_id
        WHERE r.player_id = $1
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [playerId]
    ),
    query(
      `SELECT a.slug, a.name, a.description, a.icon, a.category, a.points_award,
              pa.earned_at
         FROM achievements a
         LEFT JOIN player_achievements pa
           ON pa.achievement_id = a.id AND pa.player_id = $1
        WHERE a.is_active
        ORDER BY pa.earned_at DESC NULLS LAST, a.name`,
      [playerId]
    ),
  ]);

  return {
    balance: balance.rows[0]?.points_balance ?? 0,
    history: history.rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      reason: r.reason,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      at: r.created_at,
    })),
    redemptions: redemptions.rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      pointsSpent: r.points_spent,
      createdAt: r.created_at,
      fulfilledAt: r.fulfilled_at,
    })),
    achievements: achievements.rows.map((a) => ({
      slug: a.slug,
      name: a.name,
      description: a.description,
      icon: a.icon,
      tier: a.category,
      pointsAward: a.points_award,
      earnedAt: a.earned_at,
    })),
  };
}
