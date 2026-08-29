// Domain event publishing, via the transactional outbox in `domain_events`.
//
// publish() REQUIRES a transaction client. That is not an inconvenience, it is the whole
// mechanism: the event row commits atomically with the state change that caused it.
// Either the player is promoted from the waitlist AND the notification is queued, or
// neither happened. There is no window in which one is true and the other is not.
//
// The worker (worker/src/index.js) polls unprocessed rows and dispatches to listeners.

export const EventTypes = Object.freeze({
  PlayerRegistered: 'PlayerRegistered',
  PlayerCancelled: 'PlayerCancelled',
  PlayerWaitlisted: 'PlayerWaitlisted',
  PlayerPromotedFromWaitlist: 'PlayerPromotedFromWaitlist',
  GameCreated: 'GameCreated',
  GameRegistrationOpened: 'GameRegistrationOpened',
  GameFilled: 'GameFilled',
  GameCancelled: 'GameCancelled',
  TeamsGenerated: 'TeamsGenerated',
  TeamsOverridden: 'TeamsOverridden',
  GameStarted: 'GameStarted',
  GameCompleted: 'GameCompleted',
  MatchResultSubmitted: 'MatchResultSubmitted',
  MatchResultCorrected: 'MatchResultCorrected',
  AttendanceRecorded: 'AttendanceRecorded',
  RatingsUpdated: 'RatingsUpdated',
  RewardIssued: 'RewardIssued',
  RewardRedeemed: 'RewardRedeemed',
  AchievementEarned: 'AchievementEarned',
});

/**
 * @param {import('pg').PoolClient} client  MUST be the caller's transaction client
 */
export async function publish(client, {
  eventType,
  aggregateType,
  aggregateId,
  payload = {},
  actorUserId = null,
  correlationId = null,
  availableAt = null,
}) {
  if (!client?.query) {
    throw new Error('publish() requires a transaction client, not the pool');
  }
  if (!EventTypes[eventType]) {
    throw new Error(`Unknown event type: ${eventType}`);
  }

  const { rows } = await client.query(
    `INSERT INTO domain_events
       (event_type, aggregate_type, aggregate_id, payload, actor_user_id, correlation_id, available_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, COALESCE($7, now()))
     RETURNING id, occurred_at`,
    [
      eventType,
      aggregateType,
      aggregateId,
      JSON.stringify(payload),
      actorUserId,
      correlationId,
      availableAt,
    ]
  );

  return rows[0];
}
