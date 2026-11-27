use crate::config::ThresholdsConfig;
use crate::embedder::{l2_norm, EMBEDDING_DIM};
use crate::gallery::{GalleryEntry, GalleryIndex};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

pub fn encode_f32_le_blob(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for &x in vec {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    bytes
}

pub fn decode_f32_le_blob(blob: &[u8]) -> Option<Vec<f32>> {
    if blob.is_empty() || blob.len() % 4 != 0 {
        return None;
    }
    let count = blob.len() / 4;
    if count != EMBEDDING_DIM {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for chunk in blob.chunks_exact(4) {
        let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if !v.is_finite() {
            return None;
        }
        out.push(v);
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlitePragmas {
    pub journal_mode: String,
    pub busy_timeout_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormAuditSummary {
    pub embedded_count: usize,
    pub non_unit_count: usize,
    pub mean_norm: f64,
    pub min_norm: f64,
    pub max_norm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryAuditReport {
    pub total_active_students: usize,
    pub embedded_count: usize,
    pub null_embedding_count: usize,
    pub legacy_pipeline_count: usize,
    pub non_unit_count: usize,
    pub mean_norm: f64,
}

#[derive(Debug, Clone)]
pub struct ReindexCandidate {
    pub student_id: i64,
    pub foto_ref: Option<String>,
    pub pipeline_version: Option<String>,
}

pub fn audit_gallery_normalization(vectors: &[&[f32]]) -> NormAuditSummary {
    if vectors.is_empty() {
        return NormAuditSummary {
            embedded_count: 0,
            non_unit_count: 0,
            mean_norm: 0.0,
            min_norm: 0.0,
            max_norm: 0.0,
        };
    }
    let mut sum_norm = 0.0f64;
    let mut min_norm = f64::INFINITY;
    let mut max_norm = 0.0f64;
    let mut non_unit_count = 0usize;
    for v in vectors {
        let n = l2_norm(v) as f64;
        if (n - 1.0).abs() > 1e-3 {
            non_unit_count += 1;
        }
        sum_norm += n;
        if n < min_norm {
            min_norm = n;
        }
        if n > max_norm {
            max_norm = n;
        }
    }
    NormAuditSummary {
        embedded_count: vectors.len(),
        non_unit_count,
        mean_norm: sum_norm / (vectors.len() as f64),
        min_norm,
        max_norm,
    }
}

pub fn open_sqlite_wal(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {} failed: {e}", parent.display()))?;
        }
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE;
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|e| format!("sqlite open({}) failed: {e}", path.display()))?;
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(|e| format!("sqlite busy_timeout failed: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("sqlite journal_mode=WAL failed: {e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("sqlite synchronous=NORMAL failed: {e}"))?;
    Ok(conn)
}

pub fn ensure_additive_columns(conn: &Connection) -> Result<(), String> {
    let tables_cols = [
        ("students", "pipeline_version", "TEXT"),
        ("students", "model_sha256", "TEXT"),
        ("face_update_history", "pipeline_version", "TEXT"),
        ("face_update_history", "model_sha256", "TEXT"),
    ];
    for (table, column, ddl_type) in tables_cols {
        let table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                params![table],
                |row| row.get(0),
            )
            .map_err(|e| format!("check table {table} failed: {e}"))?;
        if !table_exists {
            continue;
        }
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| format!("PRAGMA table_info({table}) failed: {e}"))?;
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("read table_info({table}) failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect table_info({table}) failed: {e}"))?;

        if !cols.iter().any(|c| c == column) {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"),
                [],
            )
            .map_err(|e| format!("ALTER TABLE {table} ADD COLUMN {column} failed: {e}"))?;
        }
    }
    Ok(())
}

pub struct DbStore {
    conn: Connection,
}

impl DbStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = open_sqlite_wal(path)?;
        ensure_additive_columns(&conn)?;
        Ok(Self { conn })
    }

    pub fn inspect_pragmas(&self) -> Result<SqlitePragmas, String> {
        let journal_mode: String = self
            .conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|e| format!("query journal_mode failed: {e}"))?;
        let busy_timeout_ms: i64 = self
            .conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .map_err(|e| format!("query busy_timeout failed: {e}"))?;
        Ok(SqlitePragmas {
            journal_mode,
            busy_timeout_ms,
        })
    }

    pub fn load_thresholds(&self) -> Result<ThresholdsConfig, String> {
        let table_exists: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("check settings table failed: {e}"))?;
        if !table_exists {
            return Ok(ThresholdsConfig::conservative_defaults());
        }
        let raw_opt: Option<String> = match self.conn.query_row(
            "SELECT value_json FROM settings WHERE key = 'app_settings'",
            [],
            |row| row.get(0),
        ) {
            Ok(v) => Some(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(format!("read app_settings failed: {e}")),
        };
        let Some(raw) = raw_opt else {
            return Ok(ThresholdsConfig::conservative_defaults());
        };
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("parse app_settings JSON failed: {e}"))?;
        Ok(ThresholdsConfig::from_settings_json(&parsed))
    }

    pub fn load_gallery(&self) -> Result<GalleryIndex, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, embedding, pipeline_version
                 FROM students
                 WHERE status != 'LULUS' AND embedding IS NOT NULL",
            )
            .map_err(|e| format!("prepare load_gallery failed: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let blob: Vec<u8> = row.get(1)?;
                let pv: Option<String> = row.get(2)?;
                Ok((id, blob, pv))
            })
            .map_err(|e| format!("query load_gallery failed: {e}"))?;

        let mut entries = Vec::new();
        for item in rows {
            let (id, blob, pv) = item.map_err(|e| format!("read gallery row failed: {e}"))?;
            if let Some(vec) = decode_f32_le_blob(&blob) {
                entries.push(GalleryEntry {
                    student_id: id,
                    embedding: vec,
                    is_legacy: pv.is_none(),
                });
            }
        }
        Ok(GalleryIndex::from_entries(entries))
    }

    pub fn audit_gallery(&self) -> Result<GalleryAuditReport, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT embedding, pipeline_version
                 FROM students
                 WHERE status != 'LULUS'",
            )
            .map_err(|e| format!("prepare audit_gallery failed: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                let blob: Option<Vec<u8>> = row.get(0)?;
                let pv: Option<String> = row.get(1)?;
                Ok((blob, pv))
            })
            .map_err(|e| format!("query audit_gallery failed: {e}"))?;

        let mut total_active = 0usize;
        let mut null_count = 0usize;
        let mut legacy_count = 0usize;
        let mut decoded_vecs: Vec<Vec<f32>> = Vec::new();

        for item in rows {
            let (blob_opt, pv_opt) = item.map_err(|e| format!("read audit row failed: {e}"))?;
            total_active += 1;
            if pv_opt.is_none() {
                legacy_count += 1;
            }
            match blob_opt.and_then(|b| decode_f32_le_blob(&b)) {
                Some(v) => decoded_vecs.push(v),
                None => null_count += 1,
            }
        }

        let refs: Vec<&[f32]> = decoded_vecs.iter().map(|v| v.as_slice()).collect();
        let norm_summary = audit_gallery_normalization(&refs);

        Ok(GalleryAuditReport {
            total_active_students: total_active,
            embedded_count: norm_summary.embedded_count,
            null_embedding_count: null_count,
            legacy_pipeline_count: legacy_count,
            non_unit_count: norm_summary.non_unit_count,
            mean_norm: norm_summary.mean_norm,
        })
    }

    pub fn update_student_embedding(
        &self,
        student_id: i64,
        embedding: &[f32],
        quality_score: f32,
        pipeline_version: &str,
        model_sha256: &str,
    ) -> Result<(), String> {
        if embedding.len() != EMBEDDING_DIM {
            return Err(format!(
                "expected {EMBEDDING_DIM}-D embedding, got {}",
                embedding.len()
            ));
        }
        let blob = encode_f32_le_blob(embedding);
        let updated = self
            .conn
            .execute(
                "UPDATE students
                 SET embedding = ?1,
                     embedding_quality_score = ?2,
                     embedding_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     pipeline_version = ?3,
                     model_sha256 = ?4
                 WHERE id = ?5",
                params![blob, quality_score, pipeline_version, model_sha256, student_id],
            )
            .map_err(|e| format!("update_student_embedding failed: {e}"))?;
        if updated == 0 {
            return Err(format!("student id={student_id} not found"));
        }
        Ok(())
    }

    pub fn get_student_pipeline_meta(
        &self,
        student_id: i64,
    ) -> Result<(Option<String>, Option<String>), String> {
        self.conn
            .query_row(
                "SELECT pipeline_version, model_sha256 FROM students WHERE id = ?1",
                params![student_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("query student meta failed: {e}"))
    }

    pub fn list_reindex_candidates(&self, legacy_only: bool) -> Result<Vec<ReindexCandidate>, String> {
        let sql = if legacy_only {
            "SELECT id, foto_ref, pipeline_version FROM students
             WHERE status != 'LULUS' AND pipeline_version IS NULL AND foto_ref IS NOT NULL AND foto_ref != ''"
        } else {
            "SELECT id, foto_ref, pipeline_version FROM students
             WHERE status != 'LULUS' AND foto_ref IS NOT NULL AND foto_ref != ''"
        };
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| format!("prepare list_reindex_candidates failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ReindexCandidate {
                    student_id: row.get(0)?,
                    foto_ref: row.get(1)?,
                    pipeline_version: row.get(2)?,
                })
            })
            .map_err(|e| format!("query list_reindex_candidates failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect reindex candidates failed: {e}"))
    }
}
