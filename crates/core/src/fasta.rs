//! Incremental FASTA parsing without chromosome-scale JavaScript strings.

use crate::dna::PackedSequence;
use std::fmt;

/// Supported upper bound for one FASTA record.
pub const MAX_SEQUENCE_LENGTH: u64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    AwaitHeader,
    Header,
    Sequence,
    Comment,
}

/// A positional FASTA parsing error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FastaError {
    /// Human-readable description.
    pub message: String,
    /// Zero-based byte offset in the input stream.
    pub byte_offset: u64,
    /// One-based input line.
    pub line: u64,
}

impl fmt::Display for FastaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} at line {}, byte {}",
            self.message, self.line, self.byte_offset
        )
    }
}

impl std::error::Error for FastaError {}

/// Stateful streaming FASTA parser.
///
/// Completed records are returned as soon as the next header is encountered. Call
/// [`Self::finish`] once at end of input to obtain the final record.
#[derive(Debug)]
pub struct FastaParser {
    mode: Mode,
    return_mode: Mode,
    header: Vec<u8>,
    current: Option<PackedSequence>,
    at_line_start: bool,
    byte_offset: u64,
    line: u64,
    saw_record: bool,
    max_sequence_length: u64,
}

impl Default for FastaParser {
    fn default() -> Self {
        Self {
            mode: Mode::AwaitHeader,
            return_mode: Mode::AwaitHeader,
            header: Vec::new(),
            current: None,
            at_line_start: true,
            byte_offset: 0,
            line: 1,
            saw_record: false,
            max_sequence_length: MAX_SEQUENCE_LENGTH,
        }
    }
}

impl FastaParser {
    /// Creates a new parser.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a parser with a custom per-record limit.
    ///
    /// This is primarily useful for bounded embedding environments and tests. The web
    /// application uses [`MAX_SEQUENCE_LENGTH`].
    pub fn with_max_sequence_length(max_sequence_length: u64) -> Self {
        Self {
            max_sequence_length,
            ..Self::default()
        }
    }

    /// Consumes a byte chunk and returns records completed within it.
    ///
    /// # Errors
    ///
    /// Returns [`FastaError`] for malformed headers, invalid sequence bytes, sequence
    /// data before the first header, or an empty completed record.
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<Vec<PackedSequence>, FastaError> {
        let mut completed = Vec::new();
        let mut index = 0;
        while index < chunk.len() {
            let byte = chunk[index];
            let offset = self.byte_offset;

            if self.mode == Mode::Sequence
                && !byte.is_ascii_whitespace()
                && !(self.at_line_start && matches!(byte, b'>' | b';'))
            {
                let run_length = chunk[index..]
                    .iter()
                    .position(u8::is_ascii_whitespace)
                    .unwrap_or(chunk.len() - index);
                let run = &chunk[index..index + run_length];
                self.push_sequence_run(run, offset)?;
                index += run.len();
                continue;
            }

            self.byte_offset += 1;
            index += 1;

            if byte == b'\r' {
                continue;
            }
            if byte == b'\n' {
                self.end_line()?;
                continue;
            }

            if self.at_line_start && byte.is_ascii_whitespace() {
                continue;
            }

            if self.at_line_start && byte == b'>' {
                if self.mode == Mode::Sequence {
                    completed.push(self.take_current()?);
                } else if self.mode != Mode::AwaitHeader {
                    return Err(self.error_at("unexpected FASTA header", offset));
                }
                self.mode = Mode::Header;
                self.header.clear();
                self.at_line_start = false;
                continue;
            }

            if self.at_line_start && byte == b';' {
                self.return_mode = self.mode;
                self.mode = Mode::Comment;
                self.at_line_start = false;
                continue;
            }

            self.at_line_start = false;
            match self.mode {
                Mode::AwaitHeader => {
                    return Err(
                        self.error_at("sequence data appeared before a FASTA header", offset)
                    );
                }
                Mode::Header => self.header.push(byte),
                Mode::Sequence => {
                    if byte.is_ascii_whitespace() {
                        continue;
                    }
                    if is_iupac_or_gap(byte) {
                        let Some(current) = self.current.as_mut() else {
                            return Err(self.error_at("internal FASTA parser state error", offset));
                        };
                        if current.len() >= self.max_sequence_length {
                            return Err(self.error_at(
                                &format!(
                                    "FASTA record exceeds the supported {}-base limit",
                                    self.max_sequence_length
                                ),
                                offset,
                            ));
                        }
                        current.push_ascii(byte);
                    } else {
                        return Err(self.error_at(
                            &format!("invalid FASTA sequence byte 0x{byte:02x}"),
                            offset,
                        ));
                    }
                }
                Mode::Comment => {}
            }
        }
        Ok(completed)
    }

    fn push_sequence_run(&mut self, run: &[u8], offset: u64) -> Result<(), FastaError> {
        let Some(current) = self.current.as_mut() else {
            return Err(self.error_at("internal FASTA parser state error", offset));
        };
        let remaining = self.max_sequence_length.saturating_sub(current.len());
        let accepted = run
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        self.at_line_start = false;
        if let Err(relative) = current.push_iupac_chunk(&run[..accepted]) {
            self.byte_offset += u64::try_from(relative).unwrap_or(u64::MAX) + 1;
            let invalid = run[relative];
            return Err(self.error_at(
                &format!("invalid FASTA sequence byte 0x{invalid:02x}"),
                offset + u64::try_from(relative).unwrap_or(u64::MAX),
            ));
        }
        self.byte_offset += u64::try_from(accepted).unwrap_or(u64::MAX);
        if accepted < run.len() {
            self.byte_offset += 1;
            return Err(self.error_at(
                &format!(
                    "FASTA record exceeds the supported {}-base limit",
                    self.max_sequence_length
                ),
                offset + u64::try_from(accepted).unwrap_or(u64::MAX),
            ));
        }
        Ok(())
    }

    /// Finishes the stream and returns the final completed record.
    ///
    /// # Errors
    ///
    /// Returns [`FastaError`] for an empty header, empty final record, or input with no
    /// FASTA records.
    pub fn finish(mut self) -> Result<Vec<PackedSequence>, FastaError> {
        if self.mode == Mode::Header {
            self.finish_header()?;
        }

        let mut completed = Vec::new();
        if self.mode == Mode::Sequence {
            completed.push(self.take_current()?);
        }
        if !self.saw_record && completed.is_empty() {
            return Err(self.error_at("input contained no FASTA records", self.byte_offset));
        }
        Ok(completed)
    }

    fn end_line(&mut self) -> Result<(), FastaError> {
        match self.mode {
            Mode::Header => self.finish_header()?,
            Mode::Comment => self.mode = self.return_mode,
            Mode::AwaitHeader | Mode::Sequence => {}
        }
        self.line += 1;
        self.at_line_start = true;
        Ok(())
    }

    fn finish_header(&mut self) -> Result<(), FastaError> {
        let header = String::from_utf8_lossy(&self.header).trim().to_owned();
        if header.is_empty() {
            return Err(self.error_at("FASTA header is empty", self.byte_offset));
        }
        let (identifier, description) = header.find(char::is_whitespace).map_or_else(
            || (header.as_str(), ""),
            |boundary| (header[..boundary].trim(), header[boundary..].trim()),
        );
        if identifier.is_empty() {
            return Err(self.error_at("FASTA sequence identifier is empty", self.byte_offset));
        }
        self.current = Some(PackedSequence::with_description(identifier, description));
        self.header.clear();
        self.mode = Mode::Sequence;
        self.saw_record = true;
        Ok(())
    }

    fn take_current(&mut self) -> Result<PackedSequence, FastaError> {
        let mut sequence = self.current.take().expect("current record is present");
        if sequence.is_empty() {
            return Err(self.error_at(
                &format!("FASTA record '{}' contains no sequence", sequence.name()),
                self.byte_offset,
            ));
        }
        sequence.compact_storage();
        Ok(sequence)
    }

    fn error_at(&self, message: &str, byte_offset: u64) -> FastaError {
        FastaError {
            message: message.to_owned(),
            byte_offset,
            line: self.line,
        }
    }
}

fn is_iupac_or_gap(byte: u8) -> bool {
    matches!(
        byte.to_ascii_uppercase(),
        b'A' | b'C'
            | b'G'
            | b'T'
            | b'U'
            | b'R'
            | b'Y'
            | b'S'
            | b'W'
            | b'K'
            | b'M'
            | b'B'
            | b'D'
            | b'H'
            | b'V'
            | b'N'
            | b'-'
            | b'.'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_records_across_arbitrary_chunks() {
        let mut parser = FastaParser::new();
        let mut records = parser.push_chunk(b">chr").unwrap();
        records.extend(parser.push_chunk(b"1 description\nACG").unwrap());
        records.extend(parser.push_chunk(b"TN\n>chr2\ngg").unwrap());
        records.extend(parser.finish().unwrap());

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].name(), "chr1");
        assert_eq!(records[0].description(), "description");
        assert_eq!(records[0].len(), 5);
        assert_eq!(records[1].name(), "chr2");
        assert_eq!(records[1].description(), "");
        assert_eq!(records[1].len(), 2);
    }

    #[test]
    fn separates_identifier_from_tabbed_and_spaced_descriptions() {
        let mut parser = FastaParser::new();
        let records = parser
            .push_chunk(b">first\tlong description here\nAC\n>second   another description\nGT\n")
            .unwrap();
        let mut records = records;
        records.extend(parser.finish().unwrap());
        assert_eq!(records[0].name(), "first");
        assert_eq!(records[0].description(), "long description here");
        assert_eq!(records[1].name(), "second");
        assert_eq!(records[1].description(), "another description");
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let mut parser = FastaParser::new();
        let records = parser
            .push_chunk(b"; file comment\n\n>chr1\nAC\n; record comment\nGT\n")
            .unwrap();
        assert!(records.is_empty());
        let records = parser.finish().unwrap();
        assert_eq!(records[0].len(), 4);
    }

    #[test]
    fn reports_data_before_header() {
        let mut parser = FastaParser::new();
        let error = parser.push_chunk(b"ACGT\n").unwrap_err();
        assert_eq!(error.line, 1);
        assert!(error.message.contains("before"));
    }

    #[test]
    fn rejects_empty_records() {
        let mut parser = FastaParser::new();
        let error = parser.push_chunk(b">empty\n>next\nA\n").unwrap_err();
        assert!(error.message.contains("no sequence"));
    }

    #[test]
    fn rejects_a_record_before_exceeding_its_configured_limit() {
        let mut parser = FastaParser::with_max_sequence_length(4);
        let error = parser.push_chunk(b">too-long\nACGTA\n").unwrap_err();
        assert!(error.message.contains("4-base limit"));
        assert_eq!(error.line, 2);
    }

    #[test]
    fn streaming_fasta_normalizes_uracil_like_thymine() {
        let mut rna_parser = FastaParser::new();
        rna_parser.push_chunk(b">seq\nacU").unwrap();
        rna_parser.push_chunk(b"UGCuu\n").unwrap();
        let rna = rna_parser.finish().unwrap().remove(0);

        let mut dna_parser = FastaParser::new();
        dna_parser.push_chunk(b">seq\nACTTGCTT\n").unwrap();
        let dna = dna_parser.finish().unwrap().remove(0);

        assert_eq!(rna, dna);
    }
}
