// Grid decay / anti-turtling obstacle spawner: pentomino-shaped 5-cell wall
// pieces, a length-ramped cell budget, and the shrink/sweep that retires
// pieces early when the budget drops (players dying/shrinking) or their
// lifetime expires.
use crate::state::{Cell, Game, Wall};
use rand::Rng;
use std::collections::HashSet;

// The 12 free pentominoes, each as 5 (x,y) offsets normalized to a
// non-negative bounding box. Letter labels are a loose mnemonic, not a
// strict match to the canonical orientation -- any rotation/reflection of a
// pentomino is the same piece, and transform_pentomino() below covers all 8
// (see the leaderBias/wall-density prompt: user picked "rotations +
// reflections" for full shape variety).
#[rustfmt::skip]
const PENTOMINOES: [[(i32, i32); 5]; 12] = [
    [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4)],             // I
    [(0, 0), (1, 0), (2, 0), (3, 0), (3, 1)],             // L
    [(1, 0), (2, 0), (0, 1), (1, 1), (1, 2)],             // F
    [(0, 0), (1, 0), (1, 1), (2, 1), (3, 1)],             // N
    [(0, 0), (1, 0), (0, 1), (1, 1), (2, 0)],             // P
    [(0, 0), (0, 1), (0, 2), (1, 1), (2, 1)],             // T
    [(0, 0), (0, 1), (1, 1), (2, 1), (2, 0)],             // U
    [(0, 0), (1, 0), (2, 0), (2, 1), (2, 2)],             // V
    [(0, 0), (1, 0), (1, 1), (2, 1), (2, 2)],             // W
    [(1, 0), (0, 1), (1, 1), (2, 1), (1, 2)],             // X
    [(0, 0), (1, 0), (2, 0), (3, 0), (2, 1)],             // Y
    [(0, 0), (0, 1), (1, 1), (2, 1), (2, 2)],             // Z
];

// Applies one of 8 orientations (4 rotations x mirror-or-not) to a base
// pentomino and renormalizes to a non-negative bounding box. `variant` 0-3
// are the plain rotations, 4-7 are the same rotations of the mirrored piece.
fn transform_pentomino(shape: &[(i32, i32); 5], variant: u8) -> [(i32, i32); 5] {
    let mut pts = *shape;
    if variant & 4 != 0 {
        for p in pts.iter_mut() {
            p.0 = -p.0;
        }
    }
    for _ in 0..(variant & 3) {
        for p in pts.iter_mut() {
            *p = (p.1, -p.0);
        }
    }
    let min_x = pts.iter().map(|p| p.0).min().unwrap();
    let min_y = pts.iter().map(|p| p.1).min().unwrap();
    for p in pts.iter_mut() {
        p.0 -= min_x;
        p.1 -= min_y;
    }
    pts
}

// Length-ramped wall-cell budget (keeps people on their toes as the board
// fills up): every living snake adds +1 PIECE to `walls.maxConcurrent`'s
// base piece count for each 20 units of length past 40 (60 -> +1, 80 -> +2,
// 100 -> +3, ...), summed across all snakes. Capped so wall cells never
// outnumber the total space snakes occupy (sum of living body lengths) --
// otherwise a lobby of short/few snakes could get buried in obstacles, and
// as snakes die or shrink back down the budget shrinks with them. This is a
// cheap O(players) sum recomputed on demand (spawn attempts + every sim
// tick for the shrink check below), nowhere near CPU-heavy at these sizes.
pub(crate) fn wall_cell_budget(game: &Game) -> usize {
    let w = &game.cfg.walls;
    let total_snake_len: usize = game.slots.iter().flatten().filter(|s| s.alive).map(|s| s.body.len()).sum();
    let extra_pieces: usize = game
        .slots
        .iter()
        .flatten()
        .filter(|s| s.alive)
        .map(|s| s.body.len().saturating_sub(40) / 20)
        .sum();
    let target_pieces = w.max_concurrent + extra_pieces;
    (target_pieces * 5).min(total_snake_len)
}

// Retires whole wall PIECES (grouped by shared id) as soon as the budget
// drops below the current cell count -- e.g. players dying or shrinking --
// rather than waiting out each piece's full lifetime. A piece still in its
// telegraph ("warn") window is dropped outright (it was never a real hazard
// yet); a solid piece is expedited into its normal despawn-telegraph fade
// (not yanked instantly) so the disappearance still reads on screen. Returns
// true if anything changed (forces a broadcast).
pub(crate) fn shrink_walls_to_budget(game: &mut Game, now: i64) -> bool {
    if !game.cfg.walls.enabled || game.walls.is_empty() {
        return false;
    }
    let budget = wall_cell_budget(game);
    if game.walls.len() <= budget {
        return false;
    }
    let despawn_ms = game.cfg.walls.despawn_telegraph_ms;
    // Oldest piece first (ids are assigned in spawn order), retiring whole
    // pieces (5 cells) until back at/under budget -- never split a piece.
    let mut ids: Vec<i64> = game.walls.iter().map(|w| w.id).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut remaining = game.walls.len();
    let mut retiring: HashSet<i64> = HashSet::new();
    for id in ids {
        if remaining <= budget {
            break;
        }
        retiring.insert(id);
        remaining -= game.walls.iter().filter(|w| w.id == id).count();
    }
    if retiring.is_empty() {
        return false;
    }
    for w in game.walls.iter_mut() {
        if !retiring.contains(&w.id) {
            continue;
        }
        if now < w.telegraph_until {
            w.telegraph_until = now;
            w.solid_until = now;
        } else {
            w.solid_until = w.solid_until.min(now + despawn_ms);
        }
    }
    game.dlog(&format!("wall pieces retired early (budget shrank to {} cells): {:?}", budget, retiring));
    true
}

// Grid decay / anti-turtling obstacle spawner (v3.8.0; reworked to spawn
// pentomino-shaped 5-cell clusters, replacing the single-square
// obstacle for visual/gameplay variety). Returns true when a wall piece was
// telegraphed this call.
pub(crate) fn maybe_spawn_wall(game: &mut Game, now: i64) -> bool {
    let w = &game.cfg.walls;
    if !w.enabled {
        return false;
    }
    if game.last_wall_spawn_at.is_none() {
        game.last_wall_spawn_at = Some(now);
    }
    if game.player_seat_count() < w.min_players {
        game.last_wall_spawn_at = Some(now);
        return false;
    }
    if now - game.last_wall_spawn_at.unwrap() < w.spawn_interval_ms {
        return false;
    }
    // Pieces are atomic (5 cells or nothing) -- check headroom for the WHOLE
    // next piece, not just whether we're already over, or a short/empty
    // lobby could overshoot the snake-space cap on the very first spawn.
    if game.walls.len() + 5 > wall_cell_budget(game) {
        return false;
    }
    let target = game
        .current_leader_index()
        .map(|li| game.slots[li].as_ref().unwrap().head());
    let lb = &game.cfg.walls.leader_bias;
    let mut rng = rand::rng();
    let shape = transform_pentomino(
        &PENTOMINOES[rng.random_range(0..PENTOMINOES.len())],
        rng.random_range(0..8u8),
    );
    let shape_w = shape.iter().map(|p| p.0).max().unwrap() + 1;
    let shape_h = shape.iter().map(|p| p.1).max().unwrap() + 1;
    let mut chosen: Option<[Cell; 5]> = None;
    if shape_w <= game.cfg.grid.cols && shape_h <= game.cfg.grid.rows {
        for _ in 0..200 {
            if chosen.is_some() {
                break;
            }
            let ax = rng.random_range(0..=(game.cfg.grid.cols - shape_w));
            let ay = rng.random_range(0..=(game.cfg.grid.rows - shape_h));
            let cells = shape.map(|(dx, dy)| Cell { x: ax + dx, y: ay + dy });
            if cells
                .iter()
                .any(|c| !game.cell_free(c.x, c.y, None) || game.cell_has_entity(c.x, c.y))
            {
                continue;
            }
            // Anti-sealing guard: every cell of the new piece must keep at
            // least a 2-cell gap (Manhattan distance >= 3) from every cell
            // of an EXISTING wall piece -- adjacency within the new piece
            // itself is expected (that's what makes it a pentomino).
            if cells.iter().any(|c| {
                game.walls
                    .iter()
                    .any(|ow| (ow.x - c.x).abs() + (ow.y - c.y).abs() <= 2)
            }) {
                continue;
            }
            // Never within minHeadDistance of a living head, for any cell.
            let too_close = cells.iter().any(|c| {
                game.slots.iter().flatten().any(|s| {
                    s.alive && {
                        let h = s.head();
                        (h.x - c.x).abs().max((h.y - c.y).abs()) < w.min_head_distance
                    }
                })
            });
            if too_close {
                continue;
            }
            if let Some(t) = target {
                if lb.enabled {
                    // Bias off the piece's centroid rather than any single cell.
                    let cx = ax + (shape_w - 1) / 2;
                    let cy = ay + (shape_h - 1) / 2;
                    let d = (cx - t.x).abs().max((cy - t.y).abs());
                    if d > lb.radius && rng.random::<f64>() >= 1.0 / lb.strength {
                        continue;
                    }
                }
            }
            chosen = Some(cells);
        }
    }
    game.last_wall_spawn_at = Some(now);
    let Some(cells) = chosen else { return false };
    let id = game.next_powerup_id;
    game.next_powerup_id += 1;
    for c in cells {
        game.walls.push(Wall {
            id,
            x: c.x,
            y: c.y,
            telegraph_until: now + w.telegraph_ms,
            solid_until: now + w.telegraph_ms + w.lifetime_ms,
        });
    }
    game.dlog(&format!(
        "wall piece telegraphed at ({},{}) [{} cells]",
        cells[0].x, cells[0].y, cells.len()
    ));
    true
}

// Drops walls past their despawn time; true if any were removed.
pub(crate) fn sweep_walls(game: &mut Game, now: i64) -> bool {
    if game.walls.is_empty() {
        return false;
    }
    let before = game.walls.len();
    game.walls.retain(|w| now < w.solid_until);
    game.walls.len() != before
}
