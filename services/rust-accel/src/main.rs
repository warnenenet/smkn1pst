use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Deserialize)]
struct GalleryEntry {
    id: i64,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct MatchRequest {
    query: Vec<f32>,
    gallery: Vec<GalleryEntry>,
}

#[derive(Serialize)]
struct MatchResult {
    best_id: Option<i64>,
    similarity: f32,
    evaluated: usize,
}

#[inline]
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot: f32 = 0.0;
    let mut na: f32 = 0.0;
    let mut nb: f32 = 0.0;
    for (&x, &y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom <= 1e-12 {
        0.0
    } else {
        dot / denom
    }
}

fn find_best_match(req: &MatchRequest) -> MatchResult {
    let mut best_id: Option<i64> = None;
    let mut best_sim: f32 = -1.0;

    for entry in &req.gallery {
        let sim = cosine_similarity(&req.query, &entry.embedding);
        if sim > best_sim {
            best_sim = sim;
            best_id = Some(entry.id);
        }
    }

    MatchResult {
        best_id,
        similarity: if best_id.is_some() { best_sim } else { 0.0 },
        evaluated: req.gallery.len(),
    }
}

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("stdin error: {}", e);
        std::process::exit(1);
    }
    let req: MatchRequest = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("json parse error: {}", e);
            std::process::exit(1);
        }
    };
    let result = find_best_match(&req);
    println!("{}", serde_json::to_string(&result).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity_identical_and_orthogonal() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        let c = vec![0.0, 1.0, 0.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-5);
        assert!(cosine_similarity(&a, &c).abs() < 1e-5);
    }

    #[test]
    fn test_find_best_match() {
        let req = MatchRequest {
            query: vec![0.9, 0.1, 0.0],
            gallery: vec![
                GalleryEntry { id: 1, embedding: vec![0.0, 1.0, 0.0] },
                GalleryEntry { id: 2, embedding: vec![0.92, 0.08, 0.0] },
            ],
        };
        let res = find_best_match(&req);
        assert_eq!(res.best_id, Some(2));
        assert!(res.similarity > 0.99);
    }
}
