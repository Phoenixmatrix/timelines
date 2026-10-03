//! The change graph `gm log` draws in text output, in the style of `jj log`.
//!
//! Rows run newest first. Each column is a lane waiting for a change further
//! down. A change takes the lane waiting for it (or opens one, as a head),
//! hands it to its first parent and opens or joins lanes for the others, so
//! forks join (`├─╯`) and merges split (`├─╮`) on the row after the change.
//! Parents the log doesn't show end their lane in `~`.

use std::collections::HashMap;

/// One change to draw.
pub struct Node<'a> {
    pub id: &'a str,
    pub parents: &'a [String],
    /// The change's mark: `@`, `◆` or `○`. Must be one column wide.
    pub glyph: &'a str,
    /// What follows the graph on the change's row.
    pub text: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Lane<'a> {
    Free,
    /// Waiting for the change with this id.
    Wait(&'a str),
    /// Leads to parents the log doesn't show; ends in `~` on the next row.
    Elided,
}

/// The rows of the graph, each change on one row followed by any connecting rows.
pub fn draw(nodes: &[Node]) -> Vec<String> {
    let mut position: HashMap<&str, usize> = HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        position.entry(node.id).or_insert(i);
    }
    let mut lanes: Vec<Lane> = Vec::new();
    let mut rows = Vec::new();
    for (i, node) in nodes.iter().enumerate() {
        let col = match lanes.iter().position(|l| *l == Lane::Wait(node.id)) {
            Some(c) => c,
            None => lanes
                .iter()
                .position(|l| *l == Lane::Free)
                .unwrap_or_else(|| {
                    lanes.push(Lane::Free);
                    lanes.len() - 1
                }),
        };
        let mut row = String::new();
        for (c, lane) in lanes.iter().enumerate() {
            row.push_str(if c == col {
                node.glyph
            } else if *lane == Lane::Free {
                " "
            } else {
                "│"
            });
            row.push(' ');
        }
        row.push(' ');
        row.push_str(&node.text);
        rows.push(row);

        // Only parents further down can be drawn; the rest are elided.
        let mut wanted: Vec<Lane> = Vec::new();
        let mut elided = false;
        for parent in node.parents {
            match position.get(parent.as_str()) {
                Some(&p) if p > i => {
                    if !wanted.contains(&Lane::Wait(parent)) {
                        wanted.push(Lane::Wait(parent));
                    }
                }
                _ => elided = true,
            }
        }
        if elided {
            wanted.push(Lane::Elided);
        }
        let above: Vec<bool> = (0..lanes.len())
            .map(|c| c == col || lanes[c] != Lane::Free)
            .collect();
        lanes[col] = Lane::Free;
        let mut targets: Vec<usize> = Vec::new();
        for lane in wanted {
            if let Some(j) = lanes
                .iter()
                .position(|l| *l == lane && lane != Lane::Elided)
            {
                // Another child already waits for this parent: join its lane,
                // taking it over when it sits to the right.
                if j > col && lanes[col] == Lane::Free {
                    lanes[j] = Lane::Free;
                    lanes[col] = lane;
                }
                targets.push(j);
            } else if lanes[col] == Lane::Free {
                lanes[col] = lane;
            } else {
                let j = (col + 1..lanes.len())
                    .find(|&j| lanes[j] == Lane::Free)
                    .unwrap_or_else(|| {
                        lanes.push(Lane::Free);
                        lanes.len() - 1
                    });
                lanes[j] = lane;
                targets.push(j);
            }
        }
        if !targets.is_empty() {
            let lo = targets.iter().copied().fold(col, usize::min);
            let hi = targets.iter().copied().fold(col, usize::max);
            let mut row = String::new();
            for (c, lane) in lanes.iter().enumerate() {
                let up = above.get(c).copied().unwrap_or(false);
                let down = *lane != Lane::Free;
                let inside = (lo..=hi).contains(&c);
                row.push(junction(up, down, inside && c > lo, inside && c < hi));
                row.push(if inside && c < hi { '─' } else { ' ' });
            }
            rows.push(row.trim_end().to_string());
        }
        if lanes.contains(&Lane::Elided) {
            let mut row = String::new();
            for lane in lanes.iter_mut() {
                row.push_str(match lane {
                    Lane::Free => "  ",
                    Lane::Wait(_) => "│ ",
                    Lane::Elided => "~ ",
                });
                if *lane == Lane::Elided {
                    *lane = Lane::Free;
                }
            }
            rows.push(row.trim_end().to_string());
        }
        while lanes.last() == Some(&Lane::Free) {
            lanes.pop();
        }
    }
    rows
}

/// The box-drawing character joining lines that leave a cell up, down, left and right.
fn junction(up: bool, down: bool, left: bool, right: bool) -> char {
    match (up, down, left, right) {
        (true, true, true, true) => '┼',
        (true, true, true, false) => '┤',
        (true, true, false, true) => '├',
        (true, false, true, true) => '┴',
        (true, false, true, false) => '╯',
        (true, false, false, true) => '╰',
        (false, true, true, true) => '┬',
        (false, true, true, false) => '╮',
        (false, true, false, true) => '╭',
        (false, false, true, _) | (false, false, _, true) => '─',
        (true, _, false, false) | (_, true, false, false) => '│',
        (false, false, false, false) => ' ',
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Draws `(id, parents)` pairs, marking each row with its id.
    fn render(changes: &[(&str, &[&str])]) -> String {
        let parents: Vec<Vec<String>> = changes
            .iter()
            .map(|(_, ps)| ps.iter().map(|p| p.to_string()).collect())
            .collect();
        let nodes: Vec<Node> = changes
            .iter()
            .zip(&parents)
            .map(|((id, _), parents)| Node {
                id,
                parents,
                glyph: if *id == "trunk" { "◆" } else { "○" },
                text: id.to_string(),
            })
            .collect();
        draw(&nodes).join("\n")
    }

    #[test]
    fn linear_stack_ends_in_elided_history() {
        assert_eq!(
            render(&[
                ("c", &["b"]),
                ("b", &["a"]),
                ("a", &["trunk"]),
                ("trunk", &["old"])
            ]),
            "○  c\n○  b\n○  a\n◆  trunk\n~"
        );
    }

    #[test]
    fn root_change_ends_its_lane() {
        assert_eq!(render(&[("b", &["a"]), ("a", &[])]), "○  b\n○  a");
    }

    #[test]
    fn fork_joins_lanes_at_the_shared_parent() {
        assert_eq!(
            render(&[
                ("x", &["b"]),
                ("y", &["trunk"]),
                ("b", &["trunk"]),
                ("trunk", &[])
            ]),
            "○  x\n│ ○  y\n○ │  b\n├─╯\n◆  trunk"
        );
    }

    #[test]
    fn fork_joins_right_after_the_second_child() {
        assert_eq!(
            render(&[("x", &["trunk"]), ("y", &["trunk"]), ("trunk", &[])]),
            "○  x\n│ ○  y\n├─╯\n◆  trunk"
        );
    }

    #[test]
    fn merge_splits_into_a_lane_per_parent() {
        assert_eq!(
            render(&[
                ("m", &["a", "b"]),
                ("b", &["trunk"]),
                ("a", &["trunk"]),
                ("trunk", &[]),
            ]),
            "○  m\n├─╮\n│ ○  b\n○ │  a\n├─╯\n◆  trunk"
        );
    }

    #[test]
    fn merge_joins_a_lane_already_waiting_for_its_parent() {
        assert_eq!(
            render(&[("x", &["a"]), ("m", &["b", "a"]), ("b", &["a"]), ("a", &[]),]),
            "○  x\n│ ○  m\n├─┤\n│ ○  b\n├─╯\n○  a"
        );
    }

    #[test]
    fn merge_with_a_parent_outside_the_log() {
        assert_eq!(
            render(&[("m", &["a", "elsewhere"]), ("a", &[])]),
            "○  m\n├─╮\n│ ~\n○  a"
        );
    }

    #[test]
    fn unrelated_heads_each_end_in_elided_history() {
        assert_eq!(render(&[("x", &["p"]), ("y", &["q"])]), "○  x\n~\n○  y\n~");
    }

    #[test]
    fn heads_on_separate_bases_keep_their_lanes() {
        assert_eq!(
            render(&[
                ("x", &["trunk"]),
                ("y", &["base"]),
                ("trunk", &["base"]),
                ("base", &["old"]),
            ]),
            "○  x\n│ ○  y\n◆ │  trunk\n├─╯\n○  base\n~"
        );
    }

    #[test]
    fn parents_listed_above_their_child_are_elided() {
        assert_eq!(render(&[("a", &[]), ("b", &["a"])]), "○  a\n○  b\n~");
    }
}
