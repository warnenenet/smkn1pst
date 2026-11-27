use face_engine::db::{
    audit_gallery_normalization, decode_f32_le_blob, encode_f32_le_blob, open_sqlite_wal,
    DbStore,
};
use face_engine::embedder::l2_normalize;
use rusqlite::params;
use tempfile::tempdir;

#[test]
fn sqlite_wal_busy_timeout_and_additive_columns_preserve_legacy_nulls() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("test.sqlite");

    // Pre-create a legacy students & face_update_history schema WITHOUT pipeline_version/model_sha256
    {
        let conn = open_sqlite_wal(&db_path).expect("open raw sqlite");
        conn.execute_batch(
            "
            CREATE TABLE students (
                id INTEGER PRIMARY KEY,
                nis TEXT NOT NULL,
                nisn TEXT NOT NULL,
                nama TEXT NOT NULL,
                nickname TEXT NOT NULL,
                kelas_id INTEGER NOT NULL,
                tanggal_lahir TEXT NOT NULL,
                status TEXT NOT NULL,
                embedding BLOB,
                embedding_quality_score REAL NOT NULL DEFAULT 0,
                embedding_updated_at TEXT,
                foto_ref TEXT,
                wa_ortu TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE face_update_history (
                id INTEGER PRIMARY KEY,
                student_id INTEGER NOT NULL,
                version INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                quality_score REAL NOT NULL,
                snapshot_path TEXT NOT NULL,
                approved_by TEXT,
                approved_at TEXT,
                is_canonical INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );
            ",
        )
        .expect("create legacy schema");

        let legacy_vec = l2_normalize(&vec![1.0f32; 512]);
        let legacy_blob = encode_f32_le_blob(&legacy_vec);
        conn.execute(
            "INSERT INTO students (id, nis, nisn, nama, nickname, kelas_id, tanggal_lahir, status, embedding, created_at)
             VALUES (?1, '1001', '9001', 'Anak Legacy', 'Legacy', 1, '2010-01-01', 'AKTIF', ?2, '2026-01-01T00:00:00Z')",
            params![1i64, legacy_blob],
        )
        .expect("insert legacy row");
        conn.execute(
            "INSERT INTO students (id, nis, nisn, nama, nickname, kelas_id, tanggal_lahir, status, embedding, created_at)
             VALUES (?1, '1002', '9002', 'Anak Kosong', 'Kosong', 1, '2010-01-02', 'AKTIF', NULL, '2026-01-01T00:00:00Z')",
            params![2i64],
        )
        .expect("insert null-emb row");
        conn.execute(
            "INSERT INTO settings (key, value_json) VALUES ('app_settings', '{\"threshold_recognition\":0.74,\"embed_min_face_px\":84}')",
            [],
        )
        .expect("insert settings");
    }

    let store = DbStore::open(&db_path).expect("DbStore::open");
    let pragmas = store.inspect_pragmas().expect("inspect pragmas");
    assert_eq!(pragmas.journal_mode.to_ascii_lowercase(), "wal");
    assert_eq!(pragmas.busy_timeout_ms, 5000);

    let cfg = store.load_thresholds().expect("load settings");
    assert!((cfg.threshold_recognition - 0.74).abs() < 1e-5);
    assert_eq!(cfg.embed_min_face_px, 84);

    let audit = store.audit_gallery().expect("audit gallery");
    assert_eq!(audit.total_active_students, 2);
    assert_eq!(audit.null_embedding_count, 1);
    assert_eq!(audit.legacy_pipeline_count, 1);
    assert_eq!(audit.non_unit_count, 0);
    assert!((audit.mean_norm - 1.0).abs() < 1e-4);

    let new_vec = l2_normalize(&vec![0.5f32; 512]);
    store
        .update_student_embedding(1, &new_vec, 0.92, "rust-scrfd-arcface-b1", "abc123sha")
        .expect("update student embedding");

    // Verify untouched row 2 remains legacy (NULL) while row 1 has updated metadata & blob
    let (pv1, sha1) = store.get_student_pipeline_meta(1).expect("meta 1");
    assert_eq!(pv1.as_deref(), Some("rust-scrfd-arcface-b1"));
    assert_eq!(sha1.as_deref(), Some("abc123sha"));

    let (pv2, sha2) = store.get_student_pipeline_meta(2).expect("meta 2");
    assert_eq!(pv2, None);
    assert_eq!(sha2, None);
}

#[test]
fn float32_le_blob_codec_and_normalization_audit_detect_mixed_vectors() {
    let mut vec_in = vec![0.0f32; 512];
    vec_in[0] = 0.25;
    vec_in[7] = -0.5;
    vec_in[511] = 0.8291562;

    let blob = encode_f32_le_blob(&vec_in);
    assert_eq!(blob.len(), 512 * 4);
    let decoded = decode_f32_le_blob(&blob).expect("decode valid 2048-byte blob");
    assert_eq!(decoded, vec_in);
    assert!(decode_f32_le_blob(&[1, 2, 3]).is_none());

    let unit = l2_normalize(&vec_in);
    let unnorm = vec![3.0f32; 512];
    let report = audit_gallery_normalization(&[&unit, &unnorm]);
    assert_eq!(report.embedded_count, 2);
    assert_eq!(report.non_unit_count, 1);
    assert!(report.mean_norm > 1.5);
}
