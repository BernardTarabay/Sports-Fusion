// Shared hooks.

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  gameService, playerService, districtService, leaderboardService, rewardService, adminService,
  awardService, scheduleService, matchdayService,
} from '../api/services.js';
import { countdownParts } from '../lib/format.js';

/* ==========================================================================
   Server state.

   All query keys live here so a mutation can invalidate precisely what changed.
   Scattering useQuery across components is how you end up with a roster that says
   21/22 after you just joined.
   ========================================================================== */

export const keys = {
  games: (params) => ['games', params ?? {}],
  game: (id) => ['game', id],
  myGames: () => ['games', 'mine'],
  player: (id) => ['player', id],
  districts: () => ['districts'],
  district: (slug) => ['district', slug],
  leaderboard: (params) => ['leaderboard', params ?? {}],
  rewards: () => ['rewards'],
  adminOverview: () => ['admin', 'overview'],
};

export const useGames = (params) =>
  useQuery({ queryKey: keys.games(params), queryFn: () => gameService.list(params) });

export const useGame = (idOrSlug) =>
  useQuery({
    queryKey: keys.game(idOrSlug),
    queryFn: () => gameService.get(idOrSlug),
    enabled: !!idOrSlug,
  });

/**
 * The admin's view of a game: roster with payment and attendance, teams, the clock,
 * the live score.
 *
 * Same query key as useGame on purpose. The pitch and the manage screen both write the
 * updated game straight into the cache after every mutation, and sharing the key means
 * one projection backs all of it -- no second cache to fall out of step, and no refetch
 * cascade after a tap. The backend refuses this endpoint to anyone who is not an admin
 * for the district, which is why the player-facing screens keep useGame.
 */
export const useMatchday = (id, { admin = false } = {}) =>
  useQuery({
    queryKey: keys.game(id),
    // The matchday screen is shared: an admin gets the operational projection, a player
    // gets the public one folded into the same shape. Passing the flag rather than
    // reading the session here keeps this module free of a dependency on the provider,
    // and the server refuses the admin endpoint regardless of what the client claims.
    queryFn: () => (admin ? matchdayService.get(id) : gameService.get(id)),
    enabled: !!id,
  });

export const useMyGames = (enabled = true) =>
  useQuery({ queryKey: keys.myGames(), queryFn: () => gameService.mine(), enabled });

export const usePlayer = (id) =>
  useQuery({ queryKey: keys.player(id), queryFn: () => playerService.get(id), enabled: !!id });

export const useDistricts = () =>
  useQuery({ queryKey: keys.districts(), queryFn: () => districtService.list() });

export const useDistrict = (slug) =>
  useQuery({ queryKey: keys.district(slug), queryFn: () => districtService.get(slug), enabled: !!slug });

export const useLeaderboard = (params) =>
  useQuery({ queryKey: keys.leaderboard(params), queryFn: () => leaderboardService.get(params) });

export const useRewards = (enabled = true) =>
  useQuery({ queryKey: keys.rewards(), queryFn: () => rewardService.list(), enabled });

export const useManOfTheMonth = () =>
  useQuery({ queryKey: ['awards', 'motm'], queryFn: () => awardService.manOfTheMonth() });

/**
 * Venues in one district.
 *
 * Not a flat list. A pitch belongs to a district, and offering every venue in Lebanon
 * when creating a Metn game is both wrong and slower to use. The endpoint is
 * district-scoped, so this is too.
 */
export const useVenues = (districtId) =>
  useQuery({
    queryKey: ['venues', districtId],
    queryFn: () => districtService.venues(districtId),
    enabled: !!districtId,
    staleTime: 5 * 60 * 1000,
  });

export const useSchedules = (enabled = true) =>
  useQuery({ queryKey: ['schedules'], queryFn: () => scheduleService.list(), enabled });

export const useAdminOverview = (enabled = true) =>
  useQuery({
    queryKey: keys.adminOverview(),
    queryFn: () => adminService.overview(),
    enabled,
    refetchInterval: 60_000, // an admin dashboard that goes stale is worse than useless
  });

/* ==========================================================================
   Mutations.

   Every one of these reports its own outcome. A join that silently succeeds leaves the
   player wondering whether they are in the game, which is the exact anxiety this
   product exists to remove.
   ========================================================================== */

export function useJoinGame() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ gameId, allowWaitlist = true }) => gameService.join(gameId, { allowWaitlist }),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: keys.game(variables.gameId) });
      queryClient.invalidateQueries({ queryKey: ['games'] });

      if (data.status === 'waitlisted') {
        toast.success(`You're on the waiting list — number ${data.waitlistPosition}`, {
          description: 'If someone drops out you get the spot automatically. We will message you.',
        });
      } else {
        toast.success("You're in", { description: 'See you on the pitch.' });
      }
    },
    onError: (error) => {
      toast.error(error.message, {
        description: error.code === 'GAME_FULL' ? 'Try the waiting list instead.' : undefined,
      });
    },
  });
}

export function useLeaveGame() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ gameId }) => gameService.leave(gameId),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: keys.game(variables.gameId) });
      queryClient.invalidateQueries({ queryKey: ['games'] });
      toast.success('Spot released', {
        description: data.promoted
          ? `${data.promoted.name} has been moved off the waiting list.`
          : 'Thanks for letting us know early.',
      });
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useRedeemReward() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ slug }) => rewardService.redeem(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.rewards() });
      toast.success('Reward claimed', { description: 'Your code appears here as soon as it is ready.' });
    },
    onError: (error) => toast.error(error.message),
  });
}

/* ==========================================================================
   UI hooks
   ========================================================================== */

/** Live countdown to kickoff. Ticks once a second only while it matters. */
export function useCountdown(target) {
  const [parts, setParts] = useState(() => countdownParts(target));

  useEffect(() => {
    if (!target) return undefined;
    const update = () => setParts(countdownParts(target));
    update();

    // Under an hour, seconds matter. Beyond that, a minute tick is plenty and saves
    // 3,599 renders an hour on a phone in someone's pocket.
    const soon = new Date(target).getTime() - Date.now() < 3_600_000;
    const id = setInterval(update, soon ? 1000 : 60_000);
    return () => clearInterval(id);
  }, [target]);

  return parts;
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    setMatches(list.matches);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export const usePrefersReducedMotion = () =>
  useMediaQuery('(prefers-reduced-motion: reduce)');

/** Animate a number from its previous value. Used on stat tiles and score changes. */
export function useCountUp(value, { duration = 700, enabled = true } = {}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    // requestAnimationFrame does not fire in a hidden or non-composited tab, so a
    // page opened in a background tab would sit on the starting value forever.
    // Anything that cannot animate gets the final number immediately.
    if (!enabled || reduced || typeof value !== 'number' || document.hidden) {
      setDisplay(value);
      fromRef.current = value;
      return undefined;
    }

    const from = fromRef.current ?? 0;
    const start = performance.now();
    let frame;

    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 4;
      setDisplay(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else fromRef.current = value;
    };

    frame = requestAnimationFrame(step);

    // Belt and braces: if the animation has not finished by the time it should have,
    // snap to the value. Covers throttled tabs and slow devices.
    const guard = setTimeout(() => {
      setDisplay(value);
      fromRef.current = value;
      cancelAnimationFrame(frame);
    }, duration + 250);

    return () => { cancelAnimationFrame(frame); clearTimeout(guard); };
  }, [value, duration, enabled, reduced]);

  return display;
}

/** Copy to clipboard with feedback. Used heavily by the admin announcement composer. */
export function useCopy(resetAfter = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), resetAfter);
      return true;
    } catch {
      toast.error('Could not copy — select the text and copy manually.');
      return false;
    }
  }, [resetAfter]);

  return { copied, copy };
}

/** Lock body scroll behind an open overlay without the iOS jump. */
export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, [active]);
}
