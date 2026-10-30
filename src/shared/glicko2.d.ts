declare module 'glicko2' {
  export interface Player {
    getRating(): number;
    getRd(): number;
    getVol(): number;
    setRating(rating: number): void;
  }
  export class Glicko2 {
    constructor(settings: { rating: number; rd: number; vol: number; tau: number });
    makePlayer(rating?: number, rd?: number, vol?: number): Player;
    updateRatings(matches?: Array<[Player, Player, number]>): void;
  }
}
