export interface ChefCandidate {
  chefId: string;
  distanceM: number;
  acceptingOrders: boolean;
  certified: boolean;
  frozen: boolean;
  available: boolean;
}

export interface MatchRequest {
  urgent: boolean;
  radiusM?: number;
  maxCandidates?: number;
}

/** Filters and ranks candidates without mutating availability. Claiming a slot
 * must happen transactionally in the schedule/booking repository. */
export function recommendChefs(candidates: readonly ChefCandidate[], request: MatchRequest): ChefCandidate[] {
  const radius = request.radiusM ?? 3000;
  const max = request.maxCandidates ?? 3;
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('radiusM must be positive');
  if (!Number.isInteger(max) || max <= 0) throw new Error('maxCandidates must be positive');
  const eligible = candidates.filter((c) => c.distanceM >= 0 && c.distanceM <= radius && c.acceptingOrders && c.certified && !c.frozen && c.available);
  eligible.sort((a, b) => {
    if (request.urgent) {
      const aNear = a.distanceM <= 1000 ? 0 : 1;
      const bNear = b.distanceM <= 1000 ? 0 : 1;
      if (aNear !== bNear) return aNear - bNear;
    }
    return a.distanceM - b.distanceM;
  });
  return eligible.slice(0, max);
}
