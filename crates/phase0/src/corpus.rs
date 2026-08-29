//! Deterministic synthetic genomic comparison corpus.

use moddotplot_core::PackedSequence;

/// A named pair and the expected dominant orientation along its corresponding cells.
#[derive(Clone, Debug)]
pub struct Fixture {
    /// Stable fixture identifier used by reports.
    pub id: &'static str,
    /// Left sequence.
    pub x: PackedSequence,
    /// Right sequence.
    pub y: PackedSequence,
    /// Expected dominant orientation for diagonal comparisons.
    pub expected_direction: ExpectedDirection,
}

/// Expected diagonal direction used only as an independent validation label.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExpectedDirection {
    /// Same-strand correspondence.
    Forward,
    /// Reverse-complement correspondence.
    Reverse,
    /// No single direction should be asserted.
    MixedOrNone,
}

/// Builds every required synthetic case from a deterministic pseudorandom reference.
pub fn build_corpus(length: usize) -> Vec<Fixture> {
    assert!(length >= 4_096);
    let reference = random_dna(length, 0x243f_6a88_85a3_08d3);
    let low_complexity = low_complexity_sequence(length);
    let tandem = tandem_repeat_sequence(length);

    vec![
        pair(
            "identity",
            &reference,
            &reference,
            ExpectedDirection::Forward,
        ),
        pair(
            "substitution_01pct",
            &reference,
            &substitute(&reference, 1, 100),
            ExpectedDirection::Forward,
        ),
        pair(
            "substitution_05pct",
            &reference,
            &substitute(&reference, 1, 20),
            ExpectedDirection::Forward,
        ),
        pair(
            "substitution_10pct",
            &reference,
            &substitute(&reference, 1, 10),
            ExpectedDirection::Forward,
        ),
        pair(
            "indel_05pct",
            &reference,
            &deterministic_indels(&reference, 20),
            ExpectedDirection::Forward,
        ),
        pair(
            "offset_1kb",
            &reference,
            &offset(&reference, 1_024),
            ExpectedDirection::Forward,
        ),
        pair(
            "central_inversion",
            &reference,
            &invert_central_half(&reference),
            ExpectedDirection::MixedOrNone,
        ),
        pair(
            "reverse_complement",
            &reference,
            &reverse_complement(&reference),
            ExpectedDirection::Reverse,
        ),
        pair(
            "low_complexity",
            &low_complexity,
            &substitute(&low_complexity, 1, 40),
            ExpectedDirection::Forward,
        ),
        pair(
            "tandem_repeat",
            &tandem,
            &offset(&tandem, 137),
            ExpectedDirection::MixedOrNone,
        ),
        pair(
            "unrelated",
            &reference,
            &random_dna(length, 0x9e37_79b9_7f4a_7c15),
            ExpectedDirection::MixedOrNone,
        ),
    ]
}

/// Extends the frozen Phase 0 corpus with sparse, ambiguous, and padded contexts.
pub fn build_backend_corpus(length: usize) -> Vec<Fixture> {
    let mut fixtures = build_corpus(length);
    let reference = random_dna(length, 0x243f_6a88_85a3_08d3);
    let ambiguous = ambiguity_blocks(&reference);
    let sparse = sparse_valid_islands(length);
    let alternating = alternating_context_sequence(length);
    fixtures.extend([
        pair(
            "ambiguity_blocks",
            &ambiguous,
            &ambiguous,
            ExpectedDirection::Forward,
        ),
        pair(
            "sparse_valid_islands",
            &sparse,
            &sparse,
            ExpectedDirection::Forward,
        ),
        pair(
            "alternating_context",
            &alternating,
            &substitute(&alternating, 1, 40),
            ExpectedDirection::Forward,
        ),
        unequal_pair(
            "unequal_length_padding",
            &reference,
            &reference[..length * 3 / 4],
            ExpectedDirection::Forward,
        ),
    ]);
    fixtures
}

fn pair(
    id: &'static str,
    left: &[u8],
    right: &[u8],
    expected_direction: ExpectedDirection,
) -> Fixture {
    Fixture {
        id,
        x: PackedSequence::from_ascii(format!("{id}-x"), left),
        y: PackedSequence::from_ascii(format!("{id}-y"), right),
        expected_direction,
    }
}

fn unequal_pair(
    id: &'static str,
    left: &[u8],
    right: &[u8],
    expected_direction: ExpectedDirection,
) -> Fixture {
    Fixture {
        id,
        x: PackedSequence::from_ascii(format!("{id}-x"), left),
        y: PackedSequence::from_ascii(format!("{id}-y"), right),
        expected_direction,
    }
}

fn random_dna(length: usize, mut state: u64) -> Vec<u8> {
    let mut sequence = Vec::with_capacity(length);
    for _ in 0..length {
        state = state
            .wrapping_mul(2_862_933_555_777_941_757)
            .wrapping_add(3_037_000_493);
        sequence.push(b"ACGT"[((state >> 61) & 3) as usize]);
    }
    sequence
}

fn substitute(sequence: &[u8], numerator: usize, denominator: usize) -> Vec<u8> {
    sequence
        .iter()
        .enumerate()
        .map(|(index, &base)| {
            if usize::try_from(mix_index(index) % denominator as u64)
                .expect("a reduced index fits usize")
                < numerator
            {
                mutate(base)
            } else {
                base
            }
        })
        .collect()
}

fn mix_index(index: usize) -> u64 {
    let mut value = index as u64 ^ 0x9e37_79b9_7f4a_7c15;
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn deterministic_indels(sequence: &[u8], period: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(sequence.len());
    for (index, &base) in sequence.iter().enumerate() {
        if index % (period * 2) == period - 1 {
            continue;
        }
        output.push(base);
        if index % (period * 2) == period * 2 - 1 {
            output.push(complement(base));
        }
    }
    output.truncate(sequence.len());
    while output.len() < sequence.len() {
        output.push(b'A');
    }
    output
}

fn offset(sequence: &[u8], distance: usize) -> Vec<u8> {
    let distance = distance % sequence.len();
    sequence[distance..]
        .iter()
        .chain(&sequence[..distance])
        .copied()
        .collect()
}

fn invert_central_half(sequence: &[u8]) -> Vec<u8> {
    let first = sequence.len() / 4;
    let end = sequence.len() * 3 / 4;
    let mut result = sequence.to_vec();
    let inverted = reverse_complement(&sequence[first..end]);
    result[first..end].copy_from_slice(&inverted);
    result
}

fn reverse_complement(sequence: &[u8]) -> Vec<u8> {
    sequence
        .iter()
        .rev()
        .map(|&base| complement(base))
        .collect()
}

fn low_complexity_sequence(length: usize) -> Vec<u8> {
    let motifs: [&[u8]; 4] = [b"AAAAAAAA", b"ATATATAT", b"ACACACAC", b"AAAACCCC"];
    (0..length)
        .map(|index| {
            let block = index / 4_096;
            motifs[block % motifs.len()][index % 8]
        })
        .collect()
}

fn tandem_repeat_sequence(length: usize) -> Vec<u8> {
    let motif = b"ACGTTGCAACCTGGTATGCACTGAAGCT";
    (0..length)
        .map(|index| motif[index % motif.len()])
        .collect()
}

fn ambiguity_blocks(sequence: &[u8]) -> Vec<u8> {
    sequence
        .iter()
        .enumerate()
        .map(|(index, &base)| {
            let within = index % 4_096;
            if (1_337..1_849).contains(&within) {
                b'N'
            } else {
                base
            }
        })
        .collect()
}

fn sparse_valid_islands(length: usize) -> Vec<u8> {
    let source = random_dna(length, 0xd131_0ba6_98df_b5ac);
    (0..length)
        .map(|index| {
            let within = index % 4_096;
            if (1_900..2_028).contains(&within) {
                source[index]
            } else {
                b'N'
            }
        })
        .collect()
}

fn alternating_context_sequence(length: usize) -> Vec<u8> {
    let random = random_dna(length, 0x2ffd_72db_d01a_dfb7);
    let tandem = tandem_repeat_sequence(length);
    (0..length)
        .map(|index| match (index / 4_096) % 4 {
            0 => random[index],
            1 => b'A',
            2 => tandem[index],
            _ => b"ACACACGT"[index % 8],
        })
        .collect()
}

fn mutate(base: u8) -> u8 {
    match base {
        b'A' => b'C',
        b'C' => b'G',
        b'G' => b'T',
        _ => b'A',
    }
}

fn complement(base: u8) -> u8 {
    match base {
        b'A' => b'T',
        b'C' => b'G',
        b'G' => b'C',
        _ => b'A',
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpus_is_reproducible_and_length_preserving() {
        let left = build_corpus(8_192);
        let right = build_corpus(8_192);
        assert_eq!(left.len(), 11);
        for (a, b) in left.iter().zip(right) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.x, b.x);
            assert_eq!(a.y, b.y);
            assert_eq!(a.x.len(), 8_192);
            assert_eq!(a.y.len(), 8_192);
        }

        let backend = build_backend_corpus(8_192);
        assert_eq!(backend.len(), 15);
        assert_eq!(backend.last().unwrap().x.len(), 8_192);
        assert_eq!(backend.last().unwrap().y.len(), 6_144);
    }
}
