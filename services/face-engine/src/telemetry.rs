use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct LatencySummary {
    pub count: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug)]
pub struct LatencyTracker {
    cap: usize,
    samples: VecDeque<f64>,
}

impl LatencyTracker {
    pub fn new(cap: usize) -> Self {
        let cap = cap.max(16);
        Self {
            cap,
            samples: VecDeque::with_capacity(cap),
        }
    }

    pub fn record(&mut self, ms: f64) {
        if !ms.is_finite() || ms < 0.0 {
            return;
        }
        if self.samples.len() >= self.cap {
            self.samples.pop_front();
        }
        self.samples.push_back(ms);
    }

    pub fn snapshot(&self) -> LatencySummary {
        if self.samples.is_empty() {
            return LatencySummary {
                count: 0,
                p50_ms: 0.0,
                p95_ms: 0.0,
                p99_ms: 0.0,
                max_ms: 0.0,
            };
        }
        let mut sorted: Vec<f64> = self.samples.iter().copied().collect();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let idx = |pct: f64| -> usize {
            let n = sorted.len();
            let pos = ((n as f64 - 1.0) * pct).round() as usize;
            pos.min(n - 1)
        };
        LatencySummary {
            count: sorted.len(),
            p50_ms: (sorted[idx(0.50)] * 1000.0).round() / 1000.0,
            p95_ms: (sorted[idx(0.95)] * 1000.0).round() / 1000.0,
            p99_ms: (sorted[idx(0.99)] * 1000.0).round() / 1000.0,
            max_ms: (*sorted.last().unwrap_or(&0.0) * 1000.0).round() / 1000.0,
        }
    }
}

pub fn read_process_rss_mb() -> f64 {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return 0.0;
    };
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: f64 = rest
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0);
            return ((kb / 1024.0) * 10.0).round() / 10.0;
        }
    }
    0.0
}

pub struct EngineTelemetry {
    pub detect: Mutex<LatencyTracker>,
    pub embed: Mutex<LatencyTracker>,
    pub match5000: Mutex<LatencyTracker>,
    pub pipeline: Mutex<LatencyTracker>,
    pub frames_processed: AtomicU64,
    pub frames_dropped: AtomicU64,
    pub snapshots_enqueued: AtomicU64,
    pub snapshots_dropped: AtomicU64,
    pub active_camera_workers: AtomicUsize,
    pub gallery_size: AtomicUsize,
    pub gallery_non_unit_count: AtomicUsize,
    pub gallery_legacy_count: AtomicUsize,
    pub backend_reachable: AtomicBool,
    pub backend_error: Mutex<Option<String>>,
    pub web_backend_url: Mutex<String>,
}

impl EngineTelemetry {
    pub fn new(initial_backend_url: String) -> Self {
        Self {
            detect: Mutex::new(LatencyTracker::new(512)),
            embed: Mutex::new(LatencyTracker::new(512)),
            match5000: Mutex::new(LatencyTracker::new(512)),
            pipeline: Mutex::new(LatencyTracker::new(512)),
            frames_processed: AtomicU64::new(0),
            frames_dropped: AtomicU64::new(0),
            snapshots_enqueued: AtomicU64::new(0),
            snapshots_dropped: AtomicU64::new(0),
            active_camera_workers: AtomicUsize::new(0),
            gallery_size: AtomicUsize::new(0),
            gallery_non_unit_count: AtomicUsize::new(0),
            gallery_legacy_count: AtomicUsize::new(0),
            backend_reachable: AtomicBool::new(false),
            backend_error: Mutex::new(None),
            web_backend_url: Mutex::new(initial_backend_url),
        }
    }
}
