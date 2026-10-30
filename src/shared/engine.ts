/** Pinned same-host browser engine. These settings make no Elo claim. */
export const STOCKFISH_BUILD = 'stockfish-19.0.1-lite-single';

export type EngineLevel = 'relaxed' | 'club' | 'strong' | 'maximum';

export const ENGINE_LEVELS = [
  { id: 'relaxed', name: 'Relaxed', skill: 0, moveTimeMs: 150 },
  { id: 'club', name: 'Club', skill: 6, moveTimeMs: 300 },
  { id: 'strong', name: 'Strong', skill: 12, moveTimeMs: 600 },
  { id: 'maximum', name: 'Maximum', skill: 20, moveTimeMs: 1_200 },
] as const;

export function getEngineLevel(value: unknown) {
  return ENGINE_LEVELS.find(level => level.id === value);
}
