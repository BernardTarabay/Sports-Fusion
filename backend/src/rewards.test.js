// Rewards: redemption, fulfilment, refunds, and liability.
//
// This is the only part of the system where a bug costs real money, so the tests lean
// hard on the failure modes rather than the happy path: spending points you do not have,
// spending them twice, double-tapped buttons, exhausted stock, and fulfilment failing
// after the points are already gone.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createClient, grantRole } from './test-support/harness.js';

let ctx;
let admin;
let districtId;
let worker;
let rewards;
const players = [];

before(async () => {
  ctx = await startTestServer();

  admin = createClient(ctx.baseUrl);
  const signup = await admin.post('/api/auth/signup', {
    displayName: 'Rewards Admin',
    email: 'rewards-admin@sportsfusion.test',
    password: 'correct-horse-battery',
  });
  await grantRole(ctx.db, signup.body.user.id, 'owner');
  await admin.post('/api/auth/login', {
    identifier: 'rewards-admin@sportsfusion.test', password: 'correct-horse-battery',
  });

  const district = await admin.post('/api/districts', { slug: 'jbeil', name: 'Jbeil' });
  districtId = district.body.district.id;

  for (let i = 0; i < 6; i += 1) {
    const client = createClient(ctx.baseUrl);
    await client.post('/api/auth/signup', {
      displayName: `Spender ${i}`,
      email: `spender${i}@sportsfusion.test`,
      password: 'correct-horse-battery',
      districtId,
    });
    const me = await client.get('/api/players/me');
    players.push({ client, playerId: me.body.player.id });
  }

  worker = await import('../../worker/src/index.js');
  rewards = await import('./modules/rewards/service.js');
});

after(async () => { await ctx?.stop(); });

const grant = async (playerId, points) => {
  await ctx.db.query(
    `INSERT INTO point_transactions (player_id, delta, reason, liability_value)
     VALUES ($1, $2, 'manual_grant', $3)`,
    [playerId, points, points * 0.001]
  );
};

const balanceOf = async (playerId) => {
  const { rows } = await ctx.db.query('SELECT points_balance FROM players WHERE id = $1', [playerId]);
  return rows[0].points_balance;
};

const drain = async () => {
  for (let i = 0; i < 10; i += 1) {
    const r = await worker.dispatchEvents({ batchSize: 50 });
    if (r.processed === 0 && r.failed === 0) break;
  }
};

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

test('an admin creates a reward and is shown what it implies per point', async () => {
  const res = await admin.put('/api/rewards/shirt', {
    name: 'Sports Fusion shirt',
    description: 'Black, with the badge.',
    pointCost: 2500,
    unitCost: 12.5,
    fulfilmentType: 'shopify_discount',
    discountPercent: 100,
    stockRemaining: 3,
    maxPerPlayer: 1,
    isActive: true,
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.reward.pointCost, 2500);

  // 12.50 over 2500 points = half a cent per point, and 20 games to earn one.
  assert.equal(res.body.economics.impliedPointValue, 0.005);
  assert.equal(res.body.economics.gamesPerRedemption, 20);
});

test('a second reward for the discount path', async () => {
  const res = await admin.put('/api/rewards/ten-percent', {
    name: '10% off the store',
    pointCost: 1000,
    unitCost: 2.0,
    fulfilmentType: 'shopify_discount',
    discountPercent: 10,
    isActive: true,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.economics.impliedPointValue, 0.002);
});

test('a player cannot create a reward', async () => {
  const res = await players[0].client.put('/api/rewards/free-everything', {
    name: 'Free everything', pointCost: 1, fulfilmentType: 'manual',
  });
  assert.equal(res.status, 403);
});

test('the catalogue explains exactly why a reward is out of reach', async () => {
  const res = await players[0].client.get('/api/rewards');
  assert.equal(res.status, 200);

  const shirt = res.body.rewards.find((r) => r.slug === 'shirt');
  assert.equal(shirt.canRedeem, false);
  const reason = shirt.blockedBy.find((b) => b.code === 'INSUFFICIENT_POINTS');
  assert.ok(reason, 'a dead button with no explanation is worse than no button');
  assert.equal(reason.short, 2500);
});

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

test('a player with enough points redeems, and the points go immediately', async () => {
  await grant(players[0].playerId, 3000);
  assert.equal(await balanceOf(players[0].playerId), 3000);

  const res = await players[0].client.post('/api/rewards/shirt/redeem', {});
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.pointsSpent, 2500);
  assert.equal(res.body.balanceAfter, 500);

  assert.equal(await balanceOf(players[0].playerId), 500, 'the spend must not wait for fulfilment');
});

test('the spend is a ledger entry, not an edited balance', async () => {
  const { rows } = await ctx.db.query(
    `SELECT delta, reason, reference_type, liability_value FROM point_transactions
      WHERE player_id = $1 AND reason = 'redemption'`,
    [players[0].playerId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, -2500);
  assert.equal(rows[0].reference_type, 'reward');
  assert.ok(Number(rows[0].liability_value) < 0, 'redeeming reduces outstanding liability');
});

test('stock is reserved at redemption, not at fulfilment', async () => {
  const { rows } = await ctx.db.query(
    `SELECT stock_remaining FROM reward_catalogue WHERE slug = 'shirt'`
  );
  assert.equal(rows[0].stock_remaining, 2);
});

test('spending points you do not have is refused', async () => {
  const res = await players[1].client.post('/api/rewards/shirt/redeem', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INSUFFICIENT_POINTS');
  assert.equal(res.body.error.details.required, 2500);
  assert.equal(res.body.error.details.balance, 0);
});

test('the database refuses a negative balance even if the service is bypassed', async () => {
  await assert.rejects(
    ctx.db.query(
      `INSERT INTO point_transactions (player_id, delta, reason) VALUES ($1, -99999, 'redemption')`,
      [players[0].playerId]
    ),
    /players_points_non_negative/
  );
});

test('a double-tapped button with the same key charges once', async () => {
  await grant(players[2].playerId, 3000);
  const key = 'idem-key-double-tap-0001';

  const first = await players[2].client.post('/api/rewards/shirt/redeem', { idempotencyKey: key });
  const second = await players[2].client.post('/api/rewards/shirt/redeem', { idempotencyKey: key });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.deduplicated, true);
  assert.equal(second.body.id, first.body.id, 'the same redemption, not a new one');

  assert.equal(await balanceOf(players[2].playerId), 500, 'charged exactly once');
});

test('the per-player limit is enforced', async () => {
  await grant(players[2].playerId, 3000);
  const res = await players[2].client.post('/api/rewards/shirt/redeem', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'LIMIT_REACHED');
});

test('stock runs out and the last request is refused', async () => {
  await grant(players[3].playerId, 3000);
  const ok = await players[3].client.post('/api/rewards/shirt/redeem', {});
  assert.equal(ok.status, 201, ok.text);

  const { rows } = await ctx.db.query(
    `SELECT stock_remaining FROM reward_catalogue WHERE slug = 'shirt'`
  );
  assert.equal(rows[0].stock_remaining, 0);

  await grant(players[4].playerId, 3000);
  const soldOut = await players[4].client.post('/api/rewards/shirt/redeem', {});
  assert.equal(soldOut.status, 409);
  assert.equal(soldOut.body.error.code, 'OUT_OF_STOCK');
  assert.equal(await balanceOf(players[4].playerId), 3000, 'a refused redemption charges nothing');
});

test('the database refuses negative stock too', async () => {
  await assert.rejects(
    ctx.db.query(`UPDATE reward_catalogue SET stock_remaining = -1 WHERE slug = 'shirt'`),
    /reward_catalogue_stock_non_negative/
  );
});

test('an inactive reward cannot be redeemed', async () => {
  await admin.put('/api/rewards/retired', {
    name: 'Retired thing', pointCost: 100, fulfilmentType: 'manual', isActive: false,
  });
  const res = await players[4].client.post('/api/rewards/retired/redeem', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'REWARD_INACTIVE');
});

test('a games-played gate is enforced', async () => {
  await admin.put('/api/rewards/veteran', {
    name: 'Veteran jersey', pointCost: 100, unitCost: 5,
    fulfilmentType: 'manual', minGamesPlayed: 10, isActive: true,
  });
  const res = await players[4].client.post('/api/rewards/veteran/redeem', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'NOT_ENOUGH_GAMES');
  assert.equal(res.body.error.details.needs, 10);
});

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

test('the worker fulfils pending redemptions and issues a code', async () => {
  const stats = await rewards.fulfilPending({ batchSize: 20 });
  assert.ok(stats.fulfilled >= 3, `expected fulfilments, got ${JSON.stringify(stats)}`);
  assert.equal(stats.refunded, 0);

  const res = await players[0].client.get('/api/rewards/me/redemptions');
  const shirt = res.body.redemptions.find((r) => r.rewardSlug === 'shirt');
  assert.equal(shirt.status, 'fulfilled');
  assert.match(shirt.discountCode, /^SF-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.ok(shirt.expiresAt, 'a code should not be valid forever');
});

test('generated codes avoid characters people misread', async () => {
  const { rows } = await ctx.db.query(
    `SELECT discount_code FROM reward_redemptions WHERE discount_code IS NOT NULL`
  );
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.ok(!/[O0I1]/.test(row.discount_code.slice(3)), `ambiguous character in ${row.discount_code}`);
  }
});

test('two players are never issued the same code', async () => {
  const { rows } = await ctx.db.query(
    `SELECT discount_code, count(*)::int AS n FROM reward_redemptions
      WHERE discount_code IS NOT NULL GROUP BY discount_code HAVING count(*) > 1`
  );
  assert.equal(rows.length, 0);

  const existing = await ctx.db.query(
    `SELECT discount_code FROM reward_redemptions WHERE discount_code IS NOT NULL LIMIT 1`
  );
  await assert.rejects(
    ctx.db.query(
      `UPDATE reward_redemptions SET discount_code = $1
        WHERE discount_code IS NOT NULL AND discount_code <> $1`,
      [existing.rows[0].discount_code]
    ),
    /reward_redemptions_discount_code/
  );
});

test('a code is only revealed once the redemption is fulfilled', async () => {
  await grant(players[5].playerId, 1500);
  await players[5].client.post('/api/rewards/ten-percent/redeem', {});

  const pending = await players[5].client.get('/api/rewards/me/redemptions');
  const row = pending.body.redemptions[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.discountCode, null, 'nothing to show until it exists');

  await rewards.fulfilPending({ batchSize: 5 });

  const done = await players[5].client.get('/api/rewards/me/redemptions');
  assert.equal(done.body.redemptions[0].status, 'fulfilled');
  assert.ok(done.body.redemptions[0].discountCode);
});

test('redeeming notifies the player', async () => {
  await drain();
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE template_key = 'reward_redeemed'`
  );
  assert.ok(rows[0].n >= 4);
});

test('a fulfilment that permanently fails refunds the points and the stock', async () => {
  await admin.put('/api/rewards/broken', {
    name: 'Broken reward', pointCost: 200, unitCost: 1,
    // A fulfilment type the issuer does not know how to honour: permanent by definition.
    fulfilmentType: 'shopify_product', stockRemaining: 1, isActive: true,
  });
  // Remove both value fields so the discount call refuses permanently.
  await ctx.db.query(
    `UPDATE reward_catalogue SET discount_percent = NULL, value_amount = NULL WHERE slug = 'broken'`
  );

  await grant(players[4].playerId, 500);
  const before = await balanceOf(players[4].playerId);

  const redeemed = await players[4].client.post('/api/rewards/broken/redeem', {});
  assert.equal(redeemed.status, 201, redeemed.text);
  assert.equal(await balanceOf(players[4].playerId), before - 200, 'charged up front');

  const stats = await rewards.fulfilPending({ batchSize: 5 });
  assert.equal(stats.refunded, 1);

  assert.equal(await balanceOf(players[4].playerId), before, 'points returned in full');

  const { rows: stock } = await ctx.db.query(
    `SELECT stock_remaining FROM reward_catalogue WHERE slug = 'broken'`
  );
  assert.equal(stock.rows === undefined ? stock[0].stock_remaining : stock[0].stock_remaining, 1,
    'stock returned too');
});

test('the refund is recorded, not applied by deleting the charge', async () => {
  const { rows } = await ctx.db.query(
    `SELECT reason, delta FROM point_transactions
      WHERE player_id = $1 AND reference_type = 'reward' ORDER BY id`,
    [players[4].playerId]
  );
  assert.ok(rows.some((r) => r.reason === 'redemption' && r.delta === -200));
  assert.ok(rows.some((r) => r.reason === 'refund' && r.delta === 200));

  const { rows: redemption } = await ctx.db.query(
    `SELECT status, error, refund_transaction_id FROM reward_redemptions
      WHERE player_id = $1 AND status = 'failed'`,
    [players[4].playerId]
  );
  assert.equal(redemption.length, 1);
  assert.ok(redemption[0].refund_transaction_id, 'the refund must be linked to the redemption');
  assert.match(redemption[0].error, /fulfilment failed/);
});

test('a refund cannot be applied twice', async () => {
  const { rows } = await ctx.db.query(
    `SELECT id FROM reward_redemptions WHERE status = 'failed' LIMIT 1`
  );
  const result = await rewards.refundRedemption({
    redemptionId: rows[0].id, reason: 'trying again',
  });
  assert.equal(result.alreadyRefunded, true);
});

test('an admin cannot refund a reward that was already fulfilled', async () => {
  const { rows } = await ctx.db.query(
    `SELECT id FROM reward_redemptions WHERE status = 'fulfilled' LIMIT 1`
  );
  const res = await admin.post(`/api/rewards/admin/redemptions/${rows[0].id}/refund`, {
    reason: 'changed my mind',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ALREADY_FULFILLED');
});

test('a redemption abandoned mid-call is reclaimed, not lost', async () => {
  await grant(players[1].playerId, 1500);
  await players[1].client.post('/api/rewards/ten-percent/redeem', {});

  // Ageing the row with a plain UPDATE does not work: the set_updated_at trigger stamps
  // now() on every write, which is exactly what makes the reclaim correct in production
  // (the claim sets the timestamp, then nothing touches the row while the call is in
  // flight). Disabling the trigger is the only honest way to simulate a worker that died
  // half an hour ago.
  await ctx.db.query(`ALTER TABLE reward_redemptions DISABLE TRIGGER reward_redemptions_set_updated_at`);
  await ctx.db.query(
    `UPDATE reward_redemptions SET status = 'fulfilling', updated_at = now() - interval '30 minutes'
      WHERE player_id = $1 AND status = 'pending'`,
    [players[1].playerId]
  );
  await ctx.db.query(`ALTER TABLE reward_redemptions ENABLE TRIGGER reward_redemptions_set_updated_at`);

  const reclaimed = await rewards.reclaimStaleFulfilments();
  assert.equal(reclaimed, 1);

  const stats = await rewards.fulfilPending({ batchSize: 5 });
  assert.equal(stats.fulfilled, 1, 'the reclaimed redemption still gets delivered');
});

// ---------------------------------------------------------------------------
// Liability
// ---------------------------------------------------------------------------

test('the liability report answers what we owe', async () => {
  const res = await admin.get('/api/rewards/admin/liability?days=90');
  assert.equal(res.status, 200, res.text);

  const report = res.body;
  assert.equal(typeof report.outstandingPoints, 'number');
  assert.equal(typeof report.outstandingValue, 'number');
  assert.ok(report.issuedInWindow > 0);
  assert.ok(report.spentInWindow > 0);
  assert.ok(report.redemptionRate > 0 && report.redemptionRate <= 1);
});

test('the report surfaces concentration, not just the total', async () => {
  const res = await admin.get('/api/rewards/admin/liability');
  assert.ok(Array.isArray(res.body.concentration.topHolders));
  assert.ok(res.body.concentration.topTenShare > 0);
  // The same total held by nine people is a different risk from the same total spread
  // across two thousand, and the report has to say which.
  assert.ok(res.body.concentration.topTenPoints > 0);
});

test('outstanding liability matches the ledger exactly', async () => {
  const view = await ctx.db.query('SELECT * FROM reward_liability');
  const ledger = await ctx.db.query(
    `SELECT COALESCE(SUM(delta), 0)::int AS total FROM point_transactions WHERE expired_at IS NULL`
  );
  assert.equal(view.rows[0].outstanding_points, ledger.rows[0].total);
});

test('the liability report is not public', async () => {
  const res = await players[0].client.get('/api/rewards/admin/liability');
  assert.equal(res.status, 403);
});

test('cached balances match the ledger after every redemption and refund', async () => {
  const drift = await ctx.db.query('SELECT * FROM reconcile_player_points()');
  assert.equal(drift.rows.length, 0, JSON.stringify(drift.rows));
});

// ---------------------------------------------------------------------------
// Expiry, which the non-negative constraint makes sharp
// ---------------------------------------------------------------------------

test('points already spent do not also expire and drive the balance negative', async () => {
  const player = players[3].playerId;

  // Everything this player holds is expiring, but most of it has already been spent.
  await ctx.db.query(
    `UPDATE point_transactions SET expires_at = now() - interval '1 day'
      WHERE player_id = $1 AND delta > 0`,
    [player]
  );

  const before = await balanceOf(player);
  const { expirePoints } = await import('../../worker/src/jobs/index.js');
  await expirePoints();

  const after = await balanceOf(player);
  assert.ok(after >= 0, `balance must never go negative, got ${after}`);
  assert.ok(after <= before, 'expiry can only reduce a balance');
  assert.equal(after, 0, 'everything unspent should have expired');
});

test('expiry is recorded in the ledger like everything else', async () => {
  const { rows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM point_transactions WHERE reason = 'expiry'`
  );
  assert.ok(rows[0].n >= 1);

  const drift = await ctx.db.query('SELECT * FROM reconcile_player_points()');
  assert.equal(drift.rows.length, 0, JSON.stringify(drift.rows));
});
