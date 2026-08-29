//! Reproducible Phase 0 scientific kernel benchmark.

mod backend_report;
mod config;
mod corpus;
mod kernel;
mod metrics;
mod report;

use backend_report::{AdaptiveBackendReport, AdaptivePerformanceReport, BackendReport};
use config::BenchmarkConfig;
use corpus::{ExpectedDirection, build_backend_corpus, build_corpus};
use kernel::{
    AdaptiveConfig, benchmark_hash_stream, exact_oracle, mashmap_oracle, run_adaptive_oph,
    run_bottom_s, run_densified_oph, run_minmer_postings, run_oph, run_oph_hash,
    run_setsketch_like,
};
use metrics::summarize;
use moddotplot_core::hash::HashAlgorithm;
use report::Report;
use std::env;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

type RealFixture = (
    String,
    moddotplot_core::PackedSequence,
    moddotplot_core::PackedSequence,
);

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let smoke = arguments.iter().any(|argument| argument == "--smoke");
    let backend = arguments.iter().any(|argument| argument == "--backend");
    let adaptive_backend = arguments
        .iter()
        .any(|argument| argument == "--adaptive-backend");
    let adaptive_performance = arguments
        .iter()
        .any(|argument| argument == "--adaptive-performance");
    let output = arguments
        .windows(2)
        .find(|pair| pair[0] == "--output")
        .map(|pair| PathBuf::from(&pair[1]));
    let mut config = if smoke {
        BenchmarkConfig::smoke()
    } else {
        BenchmarkConfig::default()
    };
    if adaptive_performance {
        return run_adaptive_performance_command(&arguments, config, output);
    }
    if adaptive_backend {
        return run_adaptive_backend_command(&arguments, config, output);
    }
    if backend {
        return run_backend_command(&arguments, config, output);
    }

    let mut report = Report::new();

    if let Some((fixture_name, x, y)) = load_real_fixture(&arguments, &mut config)? {
        run_fixture(
            &fixture_name,
            &x,
            &y,
            ExpectedDirection::MixedOrNone,
            config,
            &mut report,
        );
    } else {
        for fixture in build_corpus(config.sequence_length) {
            run_fixture(
                fixture.id,
                &fixture.x,
                &fixture.y,
                fixture.expected_direction,
                config,
                &mut report,
            );
        }
    }

    if let Some(path) = output {
        report.write(&path)?;
        eprintln!("phase0: wrote {}", path.display());
    } else {
        print!("{}", report.as_str());
    }
    Ok(())
}

fn run_adaptive_backend_command(
    arguments: &[String],
    mut config: BenchmarkConfig,
    output: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(resolution) = option(arguments, "--resolution") {
        config.resolution = resolution.parse()?;
    }
    if let Some(registers) = option(arguments, "--registers") {
        config.register_count = registers.parse()?;
    }
    let caps = option(arguments, "--sparse-cap").map_or_else(
        || Ok::<_, Box<dyn std::error::Error>>(vec![512, 1_024, 2_048, 4_096]),
        |value| Ok(vec![value.parse()?]),
    )?;
    let match_thresholds = option(arguments, "--min-expected-matches").map_or_else(
        || {
            Ok::<_, Box<dyn std::error::Error>>(vec![
                moddotplot_core::expected_matches_for_probability(
                    moddotplot_core::DEFAULT_MATCH_DETECTION_PROBABILITY,
                ),
            ])
        },
        |value| Ok(vec![value.parse()?]),
    )?;
    let mut report = AdaptiveBackendReport::new();
    if let Some((fixture_name, x, y)) = load_real_fixture(arguments, &mut config)? {
        run_adaptive_backend_fixture(
            &fixture_name,
            &x,
            &y,
            ExpectedDirection::MixedOrNone,
            config,
            &caps,
            &match_thresholds,
            &mut report,
        );
    } else {
        for fixture in build_backend_corpus(config.sequence_length) {
            run_adaptive_backend_fixture(
                fixture.id,
                &fixture.x,
                &fixture.y,
                fixture.expected_direction,
                config,
                &caps,
                &match_thresholds,
                &mut report,
            );
        }
    }
    if let Some(path) = output {
        report.write(&path)?;
        eprintln!("adaptive backend: wrote {}", path.display());
    } else {
        print!("{}", report.as_str());
    }
    Ok(())
}

fn run_adaptive_performance_command(
    arguments: &[String],
    mut config: BenchmarkConfig,
    output: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    config.register_count = option(arguments, "--registers").unwrap_or("2048").parse()?;
    config.resolution = option(arguments, "--resolution")
        .unwrap_or("1000")
        .parse()?;
    config.repetitions = option(arguments, "--repetitions").unwrap_or("3").parse()?;
    let adaptive = AdaptiveConfig {
        sparse_cap: option(arguments, "--sparse-cap")
            .unwrap_or("2048")
            .parse()?,
        min_expected_matches: option(arguments, "--min-expected-matches").map_or_else(
            || {
                Ok::<_, Box<dyn std::error::Error>>(
                    moddotplot_core::expected_matches_for_probability(
                        moddotplot_core::DEFAULT_MATCH_DETECTION_PROBABILITY,
                    ),
                )
            },
            |value| Ok(value.parse()?),
        )?,
        ani_floor: 0.80,
    };
    let Some((fixture, x, y)) = load_real_fixture(arguments, &mut config)? else {
        return Err("--adaptive-performance requires --fasta".into());
    };
    eprintln!("adaptive performance: {fixture}");
    let run = run_adaptive_oph(&x, &y, config, adaptive);
    let mut report = AdaptivePerformanceReport::new();
    report.push(&fixture, x.len(), y.len(), config, adaptive, &run);
    if let Some(path) = output {
        report.write(&path)?;
        eprintln!("adaptive performance: wrote {}", path.display());
    } else {
        print!("{}", report.as_str());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn run_adaptive_backend_fixture(
    name: &str,
    x: &moddotplot_core::PackedSequence,
    y: &moddotplot_core::PackedSequence,
    expected_direction: ExpectedDirection,
    config: BenchmarkConfig,
    caps: &[usize],
    match_thresholds: &[f64],
    report: &mut AdaptiveBackendReport,
) {
    eprintln!("adaptive backend: {name}");
    let exact = exact_oracle(x, y, config);
    let mashmap = mashmap_oracle(x, y, config);
    for &sparse_cap in caps {
        for &min_expected_matches in match_thresholds {
            let adaptive = AdaptiveConfig {
                sparse_cap,
                min_expected_matches,
                ani_floor: 0.80,
            };
            let run = run_adaptive_oph(x, y, config, adaptive);
            let metrics = summarize(
                &run,
                &exact,
                &mashmap,
                config.resolution,
                expected_direction,
            );
            report.push(name, x.len(), y.len(), config, adaptive, &run, &metrics);
        }
    }
}

fn run_backend_command(
    arguments: &[String],
    mut config: BenchmarkConfig,
    output: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut report = BackendReport::new();
    if let Some((fixture_name, x, y)) = load_real_fixture(arguments, &mut config)? {
        run_backend_fixture(
            &fixture_name,
            &x,
            &y,
            ExpectedDirection::MixedOrNone,
            config,
            &mut report,
        );
    } else {
        for fixture in build_backend_corpus(config.sequence_length) {
            run_backend_fixture(
                fixture.id,
                &fixture.x,
                &fixture.y,
                fixture.expected_direction,
                config,
                &mut report,
            );
        }
    }
    if let Some(path) = output {
        report.write(&path)?;
        eprintln!("backend: wrote {}", path.display());
    } else {
        print!("{}", report.as_str());
    }
    Ok(())
}

fn run_backend_fixture(
    name: &str,
    x: &moddotplot_core::PackedSequence,
    y: &moddotplot_core::PackedSequence,
    expected_direction: ExpectedDirection,
    config: BenchmarkConfig,
    report: &mut BackendReport,
) {
    eprintln!("backend: {name}");
    let exact = exact_oracle(x, y, config);
    let mashmap = mashmap_oracle(x, y, config);
    for algorithm in [
        HashAlgorithm::PackedFmix64,
        HashAlgorithm::NtHash2,
        HashAlgorithm::MashMapMurmur3,
    ] {
        let hash_run = benchmark_hash_stream(x, y, config, algorithm);
        for register_count in [512, 1_024, 2_048, 4_096] {
            let tier_config = BenchmarkConfig {
                register_count,
                ..config
            };
            let run = run_oph_hash(x, y, tier_config, algorithm);
            let metrics = summarize(
                &run,
                &exact,
                &mashmap,
                tier_config.resolution,
                expected_direction,
            );
            report.push(
                name,
                x.len(),
                y.len(),
                tier_config,
                hash_run,
                &run,
                &metrics,
            );
        }
    }
}

fn load_real_fixture(
    arguments: &[String],
    config: &mut BenchmarkConfig,
) -> Result<Option<RealFixture>, Box<dyn std::error::Error>> {
    let Some(fasta_path) = option(arguments, "--fasta") else {
        return Ok(None);
    };
    let sample_bases = option(arguments, "--sample-bases")
        .map(str::parse::<usize>)
        .transpose()?
        .unwrap_or(config.sequence_length);
    let x_start = option(arguments, "--sample-start-x")
        .map(str::parse::<u64>)
        .transpose()?
        .unwrap_or(0);
    let y_start = option(arguments, "--sample-start-y")
        .map(str::parse::<u64>)
        .transpose()?
        .unwrap_or(x_start);
    let fixture_name = option(arguments, "--fixture")
        .unwrap_or("real_sequence")
        .to_owned();
    let x_source = read_first_fasta(&PathBuf::from(fasta_path))?;
    let y_source = if let Some(y_path) = option(arguments, "--fasta-y") {
        read_first_fasta(&PathBuf::from(y_path))?
    } else {
        x_source.clone()
    };
    let sample_bases_u64 = u64::try_from(sample_bases)?;
    let x = x_source.subsequence(
        format!(
            "{}:{}-{}",
            x_source.name(),
            x_start,
            x_start + sample_bases_u64
        ),
        x_start,
        x_start + sample_bases_u64,
    );
    let y = y_source.subsequence(
        format!(
            "{}:{}-{}",
            y_source.name(),
            y_start,
            y_start + sample_bases_u64
        ),
        y_start,
        y_start + sample_bases_u64,
    );
    if x.len() != sample_bases_u64 || y.len() != sample_bases_u64 {
        return Err("requested sample extends beyond a FASTA record".into());
    }
    config.sequence_length = sample_bases;
    Ok(Some((fixture_name, x, y)))
}

fn run_fixture(
    name: &str,
    x: &moddotplot_core::PackedSequence,
    y: &moddotplot_core::PackedSequence,
    expected_direction: corpus::ExpectedDirection,
    config: BenchmarkConfig,
    report: &mut Report,
) {
    eprintln!("phase0: {name}");
    let exact = exact_oracle(x, y, config);
    let mashmap = mashmap_oracle(x, y, config);
    for run in [
        run_bottom_s(x, y, config),
        run_minmer_postings(x, y, config),
        run_oph(x, y, config),
        run_densified_oph(x, y, config),
        run_setsketch_like(x, y, config),
    ] {
        let metrics = summarize(
            &run,
            &exact,
            &mashmap,
            config.resolution,
            expected_direction,
        );
        report.push(name, config, &run, &metrics);
    }
}

fn option<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

fn read_first_fasta(
    path: &PathBuf,
) -> Result<moddotplot_core::PackedSequence, Box<dyn std::error::Error>> {
    let mut file = File::open(path)?;
    let mut parser = moddotplot_core::FastaParser::new();
    let mut first = None;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for sequence in parser.push_chunk(&buffer[..read])? {
            if first.is_none() {
                first = Some(sequence);
            }
        }
    }
    for sequence in parser.finish()? {
        if first.is_none() {
            first = Some(sequence);
        }
    }
    first.ok_or_else(|| "FASTA contained no sequence".into())
}
