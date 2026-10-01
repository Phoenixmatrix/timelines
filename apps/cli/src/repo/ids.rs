//! Change ids: stable names for a change across every rewrite of its commit.
//!
//! Like jj, they are written in "reverse hex" (z..k for 0..f), so they can
//! never be confused with a commit id, which only uses 0-9a-f.

use git2::Oid;

const ALPHABET: &[u8; 16] = b"zyxwvutsrqponmlk";

pub const CHANGE_ID_LEN: usize = 32;
/// Shortest prefix shown, grown when needed to stay unique.
pub const SHORT_CHANGE: usize = 8;
pub const SHORT_COMMIT: usize = 12;

fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(ALPHABET[(byte >> 4) as usize] as char);
        out.push(ALPHABET[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn new_change_id() -> String {
    encode(&rand::random::<[u8; 16]>())
}

/// Commits made outside gm (an imported history) have no change-id header;
/// derive a stable one from the commit id, the way jj does.
pub fn derived_change_id(oid: Oid) -> String {
    let mut bytes: Vec<u8> = oid.as_bytes().iter().rev().copied().collect();
    bytes.truncate(16);
    for byte in bytes.iter_mut() {
        *byte = byte.reverse_bits();
    }
    encode(&bytes)
}

pub fn is_change_id_prefix(s: &str) -> bool {
    !s.is_empty() && s.len() <= CHANGE_ID_LEN && s.bytes().all(|b| ALPHABET.contains(&b))
}

pub fn is_commit_prefix(s: &str) -> bool {
    s.len() >= 4 && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn short_commit(oid: Oid) -> String {
    oid.to_string()[..SHORT_COMMIT].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn change_ids_never_look_like_commit_ids() {
        let id = new_change_id();
        assert_eq!(id.len(), CHANGE_ID_LEN);
        assert!(is_change_id_prefix(&id));
        assert!(
            !id.bytes()
                .any(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }

    #[test]
    fn derived_ids_are_stable() {
        let oid = Oid::from_str("0123456789abcdef0123456789abcdef01234567").unwrap();
        assert_eq!(derived_change_id(oid), derived_change_id(oid));
        assert!(is_change_id_prefix(&derived_change_id(oid)));
    }
}
