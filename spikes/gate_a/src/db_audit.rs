use crate::math::{l2_norm, l2_normalize};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct StudentGalleryEntry {
    pub id: i64,
    pub nama: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DbAuditReport {
    pub db_path: String,
    pub exists: bool,
    pub total_students: usize,
    pub null_embedding_rows: usize,
    pub invalid_blob_rows: usize,
    pub valid_512d_rows: usize,
    pub non_finite_rows: usize,
    pub norm_min: Option<f64>,
    pub norm_mean: Option<f64>,
    pub norm_max: Option<f64>,
    pub normalized_fraction: f64,
    pub is_l2_normalized: bool,
    pub cameras_count: usize,
}

pub fn decode_f32_blob_512(blob: &[u8]) -> Option<Vec<f32>> {
    if blob.len() != 512 * 4 {
        return None;
    }
    let mut out = Vec::with_capacity(512);
    for chunk in blob.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Some(out)
}

pub fn open_readonly_with_timeout(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("failed to open sqlite {}: {e}", path.display()))?;
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(|e| format!("failed to set busy_timeout: {e}"))?;
    Ok(conn)
}

pub fn audit_students_db(path: &Path) -> Result<(DbAuditReport, Vec<StudentGalleryEntry>), String> {
    if !path.exists() {
        return Ok((
            DbAuditReport {
                db_path: path.display().to_string(),
                exists: false,
                total_students: 0,
                null_embedding_rows: 0,
                invalid_blob_rows: 0,
                valid_512d_rows: 0,
                non_finite_rows: 0,
                norm_min: None,
                norm_mean: None,
                norm_max: None,
                normalized_fraction: 0.0,
                is_l2_normalized: false,
                cameras_count: 0,
            },
            Vec::new(),
        ));
    }

    let conn = open_readonly_with_timeout(path)?;
    let cameras_count: usize = conn
        .query_row("SELECT COUNT(*) FROM cameras", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;

    let mut stmt = conn
        .prepare("SELECT id, nama, embedding FROM students ORDER BY id ASC")
        .map_err(|e| format!("failed to prepare students query: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("failed to query students: {e}"))?;

    let mut total_students = 0usize;
    let mut null_embedding_rows = 0usize;
    let mut invalid_blob_rows = 0usize;
    let mut non_finite_rows = 0usize;
    let mut norms: Vec<f64> = Vec::new();
    let mut normalized_count = 0usize;
    let mut gallery = Vec::new();

    while let Some(row) = rows
        .next()
        .map_err(|e| format!("row iteration error: {e}"))?
    {
        total_students += 1;
        let id: i64 = row.get(0).map_err(|e| format!("id read error: {e}"))?;
        let nama: String = row.get(1).unwrap_or_else(|_| format!("student_{id}"));
        let blob_opt: Option<Vec<u8>> = row.get(2).map_err(|e| format!("embedding read error: {e}"))?;
        match blob_opt {
            None => {
                null_embedding_rows += 1;
            }
            Some(blob) => match decode_f32_blob_512(&blob) {
                None => {
                    invalid_blob_rows += 1;
                }
                Some(vec) => {
                    if vec.iter().any(|x| !x.is_finite()) {
                        non_finite_rows += 1;
                        continue;
                    }
                    let n = l2_norm(&vec) as f64;
                    norms.push(n);
                    if (n - 1.0).abs() <= 0.02 {
                        normalized_count += 1;
                    }
                    gallery.push(StudentGalleryEntry {
                        id,
                        nama,
                        embedding: l2_normalize(&vec),
                    });
                }
            },
        }
    }

    let valid_512d_rows = norms.len();
    let (norm_min, norm_mean, norm_max, normalized_fraction, is_l2_normalized) = if norms.is_empty() {
        (None, None, None, 0.0, false)
    } else {
        let min_v = norms.iter().copied().fold(f64::INFINITY, f64::min);
        let max_v = norms.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let mean_v = norms.iter().sum::<f64>() / norms.len() as f64;
        let frac = normalized_count as f64 / norms.len() as f64;
        (Some(min_v), Some(mean_v), Some(max_v), frac, frac >= 0.99)
    };

    Ok((
        DbAuditReport {
            db_path: path.display().to_string(),
            exists: true,
            total_students,
            null_embedding_rows,
            invalid_blob_rows,
            valid_512d_rows,
            non_finite_rows,
            norm_min,
            norm_mean,
            norm_max,
            normalized_fraction,
            is_l2_normalized,
            cameras_count,
        },
        gallery,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_decode_requires_2048_bytes() {
        assert!(decode_f32_blob_512(&[0u8; 2047]).is_none());
        let mut bytes = Vec::with_capacity(2048);
        for i in 0..512 {
            bytes.extend_from_slice(&(i as f32).to_le_bytes());
        }
        let v = decode_f32_blob_512(&bytes).unwrap();
        assert_eq!(v.len(), 512);
        assert_eq!(v[42], 42.0);
    }
}
