use crate::config::EngineConfig;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupAssetError {
    MissingFile(PathBuf),
    Io { path: PathBuf, message: String },
    Sha256Mismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    InvalidConfig(String),
}

impl fmt::Display for StartupAssetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartupAssetError::MissingFile(p) => {
                write!(f, "Required startup asset missing: {}", p.display())
            }
            StartupAssetError::Io { path, message } => {
                write!(f, "Failed reading asset {}: {message}", path.display())
            }
            StartupAssetError::Sha256Mismatch { path, expected, actual } => {
                write!(
                    f,
                    "SHA256 mismatch for {}: expected {expected}, got {actual}",
                    path.display()
                )
            }
            StartupAssetError::InvalidConfig(msg) => write!(f, "Invalid configuration: {msg}"),
        }
    }
}

impl std::error::Error for StartupAssetError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAssets {
    pub det_sha256: String,
    pub rec_sha256: String,
    pub ort_sha256: String,
    pub combined_model_sha256: String,
}

pub fn compute_file_sha256_hex(path: &Path) -> Result<String, StartupAssetError> {
    if !path.is_file() {
        return Err(StartupAssetError::MissingFile(path.to_path_buf()));
    }
    let file = File::open(path).map_err(|e| StartupAssetError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| StartupAssetError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(bytes_to_lower_hex(&hasher.finalize()))
}

fn check_asset(path: &Path, expected: Option<&str>) -> Result<String, StartupAssetError> {
    let actual = compute_file_sha256_hex(path)?;
    if let Some(exp) = expected {
        let norm_exp = exp.trim().to_ascii_lowercase();
        if actual != norm_exp {
            return Err(StartupAssetError::Sha256Mismatch {
                path: path.to_path_buf(),
                expected: norm_exp,
                actual,
            });
        }
    }
    Ok(actual)
}

/// Verifies config constraints, required ONNX models (`det_10g.onnx`, `w600k_r50.onnx`),
/// and `libonnxruntime.so` before starting any worker. Fails fast on missing/corrupt files.
pub fn verify_startup_assets(cfg: &EngineConfig) -> Result<VerifiedAssets, StartupAssetError> {
    cfg.validate().map_err(StartupAssetError::InvalidConfig)?;

    let det_sha256 = check_asset(&cfg.det_model_path, cfg.expected_det_sha256.as_deref())?;
    let rec_sha256 = check_asset(&cfg.rec_model_path, cfg.expected_rec_sha256.as_deref())?;
    let ort_sha256 = check_asset(&cfg.ort_dylib_path, cfg.expected_ort_sha256.as_deref())?;

    let mut combined = Sha256::new();
    combined.update(det_sha256.as_bytes());
    combined.update(b":");
    combined.update(rec_sha256.as_bytes());
    let combined_model_sha256 = bytes_to_lower_hex(&combined.finalize());

    Ok(VerifiedAssets {
        det_sha256,
        rec_sha256,
        ort_sha256,
        combined_model_sha256,
    })
}

fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}
