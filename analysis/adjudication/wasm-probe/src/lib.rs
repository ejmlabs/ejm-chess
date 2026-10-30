//! Experimental numeric fixture ABI only. No production caller imports this probe.
use std::str::FromStr;

use chasolver::{is_unwinnable_fast, winnability, Winnability};
use chess::{Board, Color};

const FENS: [&str; 8] = [
    "8/8/8/4k3/8/8/8/K7 w - - 0 1",
    "8/8/8/4k3/8/8/8/KB6 w - - 0 1",
    "8/8/8/4k3/8/8/8/KNN5 w - - 0 1",
    "8/8/8/4k3/8/8/7n/KB6 w - - 0 1",
    "2b1k3/8/8/1p1p1p1p/1P1P1P1P/8/8/2B1K3 w - - 0 1",
    "5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1",
    "bqn1KN2/rrk1pB2/nb1pPp1p/p1pP1PpP/PpP3P1/1P2N1R1/4Q3/1R4B1 w - - 0 1",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
];

#[no_mangle]
pub extern "C" fn classify_fixture(index: u32, black: u32, fast: u32) -> i32 {
    let Some(fen) = FENS.get(index as usize) else { return -2 };
    let Ok(board) = Board::from_str(fen) else { return -2 };
    let color = if black == 0 { Color::White } else { Color::Black };
    if fast != 0 {
        return if is_unwinnable_fast(&board, color) { 0 } else { -1 };
    }
    match winnability(&board, color) {
        Some(Winnability::Unwinnable) => 0,
        Some(Winnability::Winnable { .. }) => 1,
        None => -1,
    }
}
